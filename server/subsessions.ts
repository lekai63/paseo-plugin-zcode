/**
 * zcode sub-agents → Paseo NATIVE sub-agent tabs (provider subsessions).
 *
 * Paseo renders provider sub-agents as tabs beside the parent agent from
 * `provider_subagent` stream events. Those events are not emitted directly by
 * plugins — the daemon DERIVES them in `plugin-provider.ts`: a provider may
 * negotiate the `session.subsession` capability and then emit a
 * `session.opened` carrying `parentSessionId`; the runtime attaches that child
 * session to the parent (`attachChild`) and translates its `timeline.item` /
 * `session.turn` / `session.closed` events into the sub-agent tab (upsert +
 * mirrored timeline).
 *
 * The stock ACP shim (`runAcpProvider`) never negotiates `session.subsession`
 * and cannot emit child sessions, so this module wraps the registration it
 * produces:
 *
 *   - the wrapper adds `session.subsession` to the connection capabilities
 *     and rewrites the parent's `session.opened` to select it (the shim
 *     computes session capabilities from its own narrower adapter list);
 *   - the transformer (`server/subagents.ts`) forwards every
 *     `_zcode/subagent` snapshot to the hub below, which synthesizes the
 *     child-session event protocol the daemon expects.
 *
 * Per child session the hub emits:
 *   1. `session.opened`  { parentSessionId, restoration: "parent" } — opens
 *      the tab (status running, title/description from the zcode snapshot);
 *   2. `timeline.item`   — one plain-text "Activity" tool-call row, updated
 *      IN PLACE on every snapshot (Paseo merges tool calls by call id), so
 *      the log grows without spamming the tab;
 *   3. `session.turn`    { state: completed | failed | canceled } — flips the
 *      tab status;
 *   4. `session.closed`  — ends the child session for completed/failed (its
 *      derived status agrees with the turn above; for canceled the derived
 *      status would wrongly read "completed", so the session is left for
 *      connection teardown instead).
 *
 * Everything is best-effort: any unknown parent, stale revision, or missing
 * identity is a silent no-op, and failures never throw into the event loop
 * (per AGENTS.md).
 */

import type {
  ProviderEvent,
  ProviderRegistration,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";

import { buildSubagentLog } from "./subagents.ts";

/** Capability that lets a provider session open child (sub-agent) sessions. */
export const SUBSESSION_CAPABILITY = "session.subsession";

/** Shape of the `_zcode/subagent` payload (mirrors zcode-acp's tracker). */
export interface ZcodeSubagentSnapshot {
  agentId?: string;
  agentType?: string;
  title?: string;
  status?: string;
  summary?: string;
  errorMessage?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  log?: unknown;
  revision?: number;
}

type SubagentStatus = "running" | "completed" | "failed" | "canceled";

interface ChildRecord {
  sessionId: string;
  activityCallId: string;
  status: SubagentStatus;
  /** Set once the session has been ended (or abandoned) — blocks further events. */
  closed: boolean;
  revision: number;
}

interface ParentRecord {
  /** The boundary session id child events must reference as parentSessionId. */
  boundaryId: string;
  cwd: string;
  children: Map<string, ChildRecord>;
  emit(event: ProviderEvent): void;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Map zcode's sub-agent status onto Paseo's tab status union. */
export function mapSubagentTabStatus(status: unknown): SubagentStatus {
  switch (readTrimmedString(status)) {
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
    case "errored":
    case "lost":
    case "timed_out":
    case "spawn_error":
      return "failed";
    case "canceled":
    case "cancelled":
    case "stopped":
    case "aborted":
      return "canceled";
    default:
      return "running";
  }
}

/**
 * Accumulates parent sessions and drives the child-session protocol.
 * One hub per plugin process; keyed by the boundary session id the ACP shim
 * uses (unique per open Paseo session), so concurrent sessions don't mix.
 */
export class SubagentSubsessionHub {
  private readonly parents = new Map<string, ParentRecord>();

  /** Number of tracked parents (test introspection). */
  get parentCount(): number {
    return this.parents.size;
  }

  /** Record a parent session opened on the wrapped connection. */
  noteParentOpened(emit: (event: ProviderEvent) => void, sessionId: string, cwd: string): void {
    this.parents.set(sessionId, { boundaryId: sessionId, cwd, children: new Map(), emit });
  }

  /** Drop a parent and terminate its still-running children as canceled. */
  noteParentClosed(sessionId: string): void {
    const parent = this.parents.get(sessionId);
    if (!parent) return;
    this.parents.delete(sessionId);
    for (const child of parent.children.values()) {
      if (child.closed) continue;
      child.closed = true;
      if (child.status !== "running") continue;
      this.emitTurn(parent, child, "canceled", undefined);
    }
  }

  /**
   * Fold one `_zcode/subagent` snapshot into the child-session protocol.
   * No-op unless the parent session is tracked (e.g. when the host did not
   * offer `session.subsession`).
   */
  handleSnapshot(boundarySessionId: string, raw: unknown): void {
    try {
      const parent = this.parents.get(boundarySessionId);
      if (!parent) return;
      if (!raw || typeof raw !== "object") return;
      const snapshot = raw as ZcodeSubagentSnapshot;
      const agentId = readTrimmedString(snapshot.agentId);
      if (!agentId) return;

      const status = mapSubagentTabStatus(snapshot.status);
      const revision = typeof snapshot.revision === "number" ? snapshot.revision : 0;

      let child = parent.children.get(agentId);
      if (!child) {
        if (revision <= 0) return;
        child = {
          sessionId: `zcsub-${agentId}`,
          activityCallId: `zcsub-activity-${agentId}`,
          status: "running",
          closed: false,
          revision,
        };
        parent.children.set(agentId, child);
        parent.emit(this.childOpened(parent, agentId, snapshot));
      } else {
        if (child.closed || revision <= child.revision) return;
        child.revision = revision;
      }

      parent.emit(this.activityItem(snapshot, child, status));

      if (status === "running") return;
      child.status = status;
      this.emitTurn(parent, child, status, snapshot);
      const summary = readTrimmedString(snapshot.summary);
      if (summary) {
        parent.emit({
          type: "timeline.item",
          sessionId: child.sessionId,
          item: {
            id: `zcsub-result-${agentId}`,
            type: "assistant_message",
            text: summary,
          },
        });
      }
      // `session.closed` derives its own status (completed / failed-with-error),
      // so only end the session where that agrees with the turn status above.
      child.closed = true;
      if (status === "canceled") return;
      parent.emit(
        status === "failed"
          ? {
              type: "session.closed",
              sessionId: child.sessionId,
              error: {
                message: readTrimmedString(snapshot.errorMessage) ?? "sub-agent failed",
              },
            }
          : { type: "session.closed", sessionId: child.sessionId },
      );
    } catch {
      // Never throw into the ACP stream transform (see AGENTS.md).
    }
  }

  private childOpened(
    parent: ParentRecord,
    agentId: string,
    snapshot: ZcodeSubagentSnapshot,
  ): ProviderEvent {
    const agentType = readTrimmedString(snapshot.agentType);
    return {
      type: "session.opened",
      sessionId: `zcsub-${agentId}`,
      parentSessionId: parent.boundaryId,
      capabilities: [SUBSESSION_CAPABILITY],
      restoration: "parent",
      title: agentType ? `Agent (${agentType})` : "Agent",
      description: readTrimmedString(snapshot.title) ?? readTrimmedString(snapshot.summary),
      cwd: parent.cwd,
    };
  }

  private activityItem(
    snapshot: ZcodeSubagentSnapshot,
    child: ChildRecord,
    status: SubagentStatus,
  ): ProviderEvent {
    const item: ProviderTimelineItem = {
      id: child.activityCallId,
      callId: child.activityCallId,
      type: "tool_call",
      name: "Activity",
      detail: { type: "plain_text", label: "Sub-agent activity", text: buildSubagentLog(snapshot) },
      ...(status === "failed"
        ? { status, error: readTrimmedString(snapshot.errorMessage) ?? "sub-agent failed" }
        : { status: status === "running" ? "running" : "completed", error: null }),
    };
    return { type: "timeline.item", sessionId: child.sessionId, item };
  }

  private emitTurn(
    parent: ParentRecord,
    child: ChildRecord,
    state: "completed" | "failed" | "canceled",
    snapshot: ZcodeSubagentSnapshot | undefined,
  ): void {
    parent.emit({
      type: "session.turn",
      sessionId: child.sessionId,
      turnId: `zcsub-turn-${child.sessionId}`,
      state,
      ...(state === "failed" && snapshot
        ? { error: { message: readTrimmedString(snapshot.errorMessage) ?? "sub-agent failed" } }
        : {}),
    });
  }
}

/** Process-wide hub; the wrapper registers parents, the transformer feeds it. */
export const zcodeSubagentHub = new SubagentSubsessionHub();

/**
 * Wrap a provider registration so its connections negotiate
 * `session.subsession` and feed the hub. When the host did not offer the
 * capability (older Paseo), the base connection is returned untouched and
 * the plugin degrades to the timeline-card-only behavior.
 */
export function wrapWithSubsessions(
  base: ProviderRegistration,
  hub: SubagentSubsessionHub = zcodeSubagentHub,
): ProviderRegistration {
  return {
    ...base,
    async connect(request) {
      const connection = await base.connect(request);
      if (!request.capabilities.includes(SUBSESSION_CAPABILITY)) return connection;

      const listeners = new Set<(event: ProviderEvent) => void>();
      const forward = (event: ProviderEvent) => {
        for (const listener of listeners) listener(event);
      };

      return {
        version: connection.version,
        capabilities: [...connection.capabilities, SUBSESSION_CAPABILITY],
        send: (input) => connection.send(input),
        close: () => connection.close(),
        onEvent(listener) {
          listeners.add(listener);
          return connection.onEvent((event) => {
            try {
              if (event.type === "session.opened" && !event.parentSessionId) {
                // Re-select the capability for the session itself: the daemon
                // validates a child's parentSessionId against the parent's
                // negotiated per-session capabilities.
                hub.noteParentOpened(forward, event.sessionId, event.cwd);
                forward({ ...event, capabilities: [...event.capabilities, SUBSESSION_CAPABILITY] });
                return;
              }
              if (
                (event.type === "session.closed" || event.type === "session.runtime_failed") &&
                "sessionId" in event
              ) {
                hub.noteParentClosed(event.sessionId);
              }
            } catch {
              // Bookkeeping must never break the base event flow.
            }
            forward(event);
          });
        },
      };
    },
  };
}
