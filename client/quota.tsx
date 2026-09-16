import type { PluginTheme } from "@getpaseo/plugin";
import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";

import { zcodeQuotaRpc, type ZcodeQuotaSnapshot } from "../shared/quota";

/**
 * ZCode composer pill: shows the GLM Coding Plan remaining quota next to the
 * context meter, sourced from the plugin server's `zcode.quota` RPC.
 *
 * The pill label tracks the 5-hour window (the one that runs out first); the
 * popover lists every window the API reports (5h, weekly, MCP).
 */

const POLL_INTERVAL_MS = 60_000;
const AGENT_PAGE_LIMIT = 200;

interface QuotaStoreState {
  snapshot: ZcodeQuotaSnapshot | null;
  refreshing: boolean;
  error: string | null;
}

let state: QuotaStoreState = { snapshot: null, refreshing: false, error: null };
const listeners = new Set<() => void>();
let rpcClient: PluginClientContext | null = null;
let inFlight: Promise<void> | null = null;

function setState(patch: Partial<QuotaStoreState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useQuotaState(): QuotaStoreState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

async function refreshQuota(force = false): Promise<void> {
  const client = rpcClient;
  if (!client) return;
  if (inFlight) return inFlight;
  setState({ refreshing: true });
  inFlight = client
    .rpc(zcodeQuotaRpc, force ? { force: true } : {})
    .then((snapshot) => {
      setState({ snapshot, error: null });
    })
    .catch((error: unknown) => {
      setState({ error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      inFlight = null;
      setState({ refreshing: false });
    });
  return inFlight;
}

const PRIMARY_WINDOW_KEY = "token_5h";

function pillLabel(snapshot: ZcodeQuotaSnapshot | null): string {
  const fiveHour = snapshot?.items.find((item) => item.key === PRIMARY_WINDOW_KEY);
  if (!fiveHour) return "Quota";
  return `5h ${Math.round(fiveHour.leftPercent)}%`;
}

function toneColor(usedPercent: number, theme: PluginTheme): string {
  if (usedPercent > 90) return theme.colors.statusDanger;
  if (usedPercent >= 70) return theme.colors.statusWarning;
  return theme.colors.statusSuccess;
}

/** Compact countdown for a reset timestamp ("2h 13m", "6d 4h"). */
function formatReset(timestampMs: number): string {
  const diff = timestampMs - Date.now();
  if (!Number.isFinite(diff)) return "";
  if (diff <= 0) return "resetting";
  const totalMinutes = Math.round(diff / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusMessage(snapshot: ZcodeQuotaSnapshot, error: string | null): string {
  if (snapshot.status === "auth_error") {
    return "No valid ZCode API key — check the ZCode provider config.";
  }
  if (snapshot.status === "rate_limited") return "GLM quota API is rate limited — try again shortly.";
  if (snapshot.status === "unavailable") return snapshot.error ?? error ?? "Quota unavailable.";
  return "";
}

function QuotaRow({
  label,
  usedPercent,
  leftPercent,
  nextResetTime,
  theme,
}: {
  label: string;
  usedPercent: number;
  leftPercent: number;
  nextResetTime: number | null;
  theme: PluginTheme;
}) {
  const styles = useMemo(
    () => ({
      row: { gap: 4 },
      head: { flexDirection: "row" as const, justifyContent: "space-between" as const },
      label: { color: theme.colors.foreground, fontSize: 14 },
      left: { color: theme.colors.foregroundMuted, fontSize: 12 },
      track: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden" as const,
      },
      fill: {
        height: 6,
        borderRadius: 3,
        width: `${Math.max(0, Math.min(100, usedPercent))}%` as `${number}%`,
        backgroundColor: toneColor(usedPercent, theme),
      },
      reset: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme, usedPercent],
  );
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.left}>{Math.round(leftPercent)}% left</Text>
      </View>
      <View style={styles.track}>
        <View style={styles.fill} />
      </View>
      {nextResetTime !== null ? (
        <Text style={styles.reset}>Resets in {formatReset(nextResetTime)}</Text>
      ) : null}
    </View>
  );
}

function QuotaPopover({ theme, close }: PluginButtonContentProps) {
  const quota = useQuotaState();
  useEffect(() => {
    void refreshQuota();
  }, []);

  const styles = useMemo(
    () => ({
      body: { gap: 12, minWidth: 220 },
      head: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      title: { color: theme.colors.foreground, fontSize: 16 },
      level: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        textTransform: "uppercase" as const,
      },
      sections: { gap: 10 },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 17 },
      actions: { flexDirection: "row" as const, gap: 8, justifyContent: "flex-end" as const },
      button: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      buttonText: { color: theme.colors.foreground, fontSize: 13 },
    }),
    [theme],
  );

  const { snapshot, refreshing, error } = quota;
  const message = snapshot && snapshot.status !== "ok" ? statusMessage(snapshot, error) : null;

  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <Text style={styles.title}>ZCode quota</Text>
        {snapshot?.level ? <Text style={styles.level}>{snapshot.level}</Text> : null}
      </View>

      {snapshot && snapshot.items.length > 0 ? (
        <View style={styles.sections}>
          {snapshot.items.map((item) => (
            <QuotaRow
              key={item.key}
              label={item.label}
              usedPercent={item.usedPercent}
              leftPercent={item.leftPercent}
              nextResetTime={item.nextResetTime}
              theme={theme}
            />
          ))}
        </View>
      ) : message ? (
        <Text style={styles.error}>{message}</Text>
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <Text style={styles.detail}>{refreshing ? "Loading quota…" : "No quota data yet."}</Text>
      )}

      {snapshot?.sourceHost ? <Text style={styles.detail}>{snapshot.sourceHost}</Text> : null}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh ZCode quota"
          disabled={refreshing}
          onPress={() => void refreshQuota(true)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{refreshing ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close ZCode quota"
          onPress={close}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface ObservedAgent {
  id: string;
  provider: string;
  workspaceId?: string | null;
}

export function contributeZcodeQuota(client: PluginClientContext): () => void {
  rpcClient = client;
  const pills = new Map<string, PluginButtonRegistration>();
  let stopped = false;

  const unsubscribeStore = subscribe(() => {
    const label = pillLabel(state.snapshot);
    for (const pill of pills.values()) pill.update({ label });
  });

  const register = (agent: ObservedAgent): void => {
    if (stopped || agent.provider !== "zcode" || !agent.workspaceId) return;
    if (pills.has(agent.id)) return;
    const registration = client.addComposerPill({
      id: "quota",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "ZCode quota",
        icon: "Gauge",
        label: pillLabel(state.snapshot),
        behavior: { kind: "popover", Content: QuotaPopover },
      },
    });
    pills.set(agent.id, registration);
    if (pills.size === 1) void refreshQuota();
  };

  const remove = (agentId: string): void => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  /** Poll-based reconciliation so pills never depend on the event stream. */
  const reconcile = async (): Promise<void> => {
    let entries;
    try {
      ({ entries } = await client.paseo.agents.list({ page: { limit: AGENT_PAGE_LIMIT } }));
    } catch (error) {
      console.error("zcode quota: agent list failed", error);
      return;
    }
    if (stopped) return;
    const zcodeAgents = new Set<string>();
    for (const { agent } of entries) {
      if (agent.provider !== "zcode" || !agent.workspaceId) continue;
      zcodeAgents.add(agent.id);
      register(agent);
    }
    for (const agentId of [...pills.keys()]) {
      if (!zcodeAgents.has(agentId)) remove(agentId);
    }
  };

  // Free local listener: instant registration/removal whenever the daemon
  // streams agent updates to this client, with the poll above as backstop.
  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") remove(update.agentId);
    else register(update.agent);
  });

  void reconcile();

  const interval = setInterval(() => {
    void reconcile();
    if (pills.size > 0) void refreshQuota();
  }, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
    unsubscribeAgents();
    unsubscribeStore();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    if (rpcClient === client) rpcClient = null;
  };
}
