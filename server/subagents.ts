/**
 * zcode-acp → Paseo bridge for sub-agent activity.
 *
 * `zcode-acp` publishes a VENDOR notification per sub-agent snapshot:
 *
 *     { jsonrpc: "2.0", method: "_zcode/subagent", params: { …snapshot… } }
 *
 * Paseo's ACP shim routes every notification whose method is not part of the
 * ACP client method set to the provider's `AcpTransformer.notification` hook
 * (`@getpaseo/plugin` → server/acp-internal/connection.ts, routeVendorNotifications),
 * and a transformer may return `{ type: "timeline", item }` to inject an
 * arbitrary timeline row.
 *
 * In addition to the card, the transformer forwards every snapshot to the
 * subsession hub (`server/subsessions.ts`), which drives Paseo's NATIVE
 * sub-agent tabs: the wrapped registration negotiates `session.subsession`
 * and the hub synthesizes the child `session.opened` / `timeline.item` /
 * `session.turn` / `session.closed` protocol the daemon translates into
 * `provider_subagent` events. The card stays as the inline summary inside the
 * parent's `Agent` dispatch row; the tab holds the full sub-agent view.
 *
 * The item below uses `detail.type:"sub_agent"` — Paseo's built-in renderer
 * (bot icon, "<type>: <description>" title, expandable activity log) — and
 * reuses the parent tool call id (`parentToolCallId`) as `callId`, so the row
 * MERGES with the `Agent`/`Task` tool card the ACP stream already created for
 * the dispatch instead of adding a second card. Paseo keeps a non-`unknown`
 * tool detail when a later update arrives for the same callId
 * (app/src/types/stream.ts mergeToolCallDetail), so the merge is stable in
 * both arrival orders.
 */

import type { AcpTransformer, AcpVendorUpdate } from "@getpaseo/plugin/server/acp";

/** Vendor notification method emitted by zcode-acp (handlers/subagents.ts). */
export const ZCODE_SUBAGENT_METHOD = "_zcode/subagent";

/** Shape of the payload zcode-acp sends (mirrors SubagentNotificationPayload). */
interface ZcodeSubagentSnapshot {
  sessionId?: string;
  acpSessionId?: string;
  agentId?: string;
  agentType?: string;
  childSessionId?: string;
  parentToolCallId?: string;
  title?: string;
  status?: string;
  background?: boolean;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  errorMessage?: string;
  log?: unknown;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  revision?: number;
}

/** Paseo tool-call status → the card status. */
type CardStatus = "running" | "completed" | "failed" | "canceled";

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = readTrimmedString(entry);
    return text ? [text] : [];
  });
}

/** Map zcode's card status onto Paseo's tool-call status union. */
export function mapSubagentCardStatus(status: unknown): CardStatus {
  switch (readTrimmedString(status)) {
    case "completed":
    case "success":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "running";
  }
}

/**
 * Last-resort identity when zcode could not bind the dispatch call id (a
 * directory entry that arrived before any mirrored event): keying by agentId
 * gives the sub-agent its own row rather than dropping the update.
 */
export function subagentCallId(snapshot: ZcodeSubagentSnapshot): string | undefined {
  return readTrimmedString(snapshot.parentToolCallId) ?? readTrimmedString(snapshot.agentId);
}

/** Compose the log block Paseo renders inside the sub-agent card. */
export function buildSubagentLog(snapshot: ZcodeSubagentSnapshot): string {
  const lines = readStringArray(snapshot.log);
  const usage = formatUsage(snapshot);
  if (usage) lines.push(usage);
  return lines.join("\n");
}

/** "<n> tools · <n> tokens · <s>s" — only the parts zcode reported. */
function formatUsage(snapshot: ZcodeSubagentSnapshot): string | undefined {
  const parts: string[] = [];
  if (typeof snapshot.toolUses === "number") parts.push(`${snapshot.toolUses} tools`);
  if (typeof snapshot.tokens === "number") parts.push(`${snapshot.tokens} tokens`);
  if (typeof snapshot.durationMs === "number") {
    parts.push(`${(snapshot.durationMs / 1000).toFixed(1)}s`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** The human-facing description: the task text, falling back to the type. */
function subagentDescription(snapshot: ZcodeSubagentSnapshot): string | undefined {
  return readTrimmedString(snapshot.title) ?? readTrimmedString(snapshot.summary);
}

/**
 * Build the `timeline.item` vendor update for one sub-agent snapshot. Returns
 * null when the snapshot carries no usable identity.
 */
export function subagentTimelineUpdate(
  snapshot: ZcodeSubagentSnapshot,
): AcpVendorUpdate | null {
  const callId = subagentCallId(snapshot);
  if (!callId) return null;

  const status = mapSubagentCardStatus(snapshot.status);
  const failure = readTrimmedString(snapshot.errorMessage) ?? "sub-agent failed";
  const agentType = readTrimmedString(snapshot.agentType);
  const description = subagentDescription(snapshot);

  const item = {
    id: callId,
    callId,
    type: "tool_call" as const,
    name: agentType ? `Agent (${agentType})` : "Agent",
    detail: {
      type: "sub_agent" as const,
      ...(agentType ? { subAgentType: agentType } : {}),
      ...(description ? { description } : {}),
      ...(readTrimmedString(snapshot.childSessionId)
        ? { childSessionId: readTrimmedString(snapshot.childSessionId)! }
        : {}),
      log: buildSubagentLog(snapshot),
    },
    // Paseo's ProviderToolCallItem contract: `failed` carries the error value,
    // every other status requires an explicit null.
    ...(status === "failed"
      ? { status, error: failure }
      : { status, error: null }),
  };

  return { type: "timeline", item };
}

/**
 * Build the transformer registered with `runAcpProvider`. Pure with respect to
 * the card: unknown notifications return null and are left untouched for other
 * consumers. Snapshots for the `_zcode/subagent` method are additionally
 * forwarded to the subsession hub, which drives the native sub-agent tabs.
 */
export function createZcodeSubagentTransformer(
  forwardSnapshot: (boundarySessionId: string, snapshot: unknown) => void,
): AcpTransformer {
  return {
    notification(notification, context) {
      if (notification.method !== ZCODE_SUBAGENT_METHOD) return null;
      if (!notification.params || typeof notification.params !== "object") return null;
      try {
        forwardSnapshot(context.sessionId, notification.params);
      } catch {
        // Tab wiring must never break the card (see AGENTS.md).
      }
      return subagentTimelineUpdate(notification.params as ZcodeSubagentSnapshot);
    },
  };
}
