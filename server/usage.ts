/**
 * GLM Coding Plan quota as a Paseo usage source (Paseo 0.11+).
 *
 * Paseo's host-wide Usage modal and sidebar usage list every registered
 * usage source. This one reports the windows server/quota.ts reads from the
 * quota API (5-hour, weekly, MCP):
 *
 *   - global discovery lists the login the plugin process sees
 *     (`ZCODE_HOME` / `ZCODE_PROVIDER`, else `~/.zcode` + first enabled
 *     provider);
 *   - session discovery resolves the login from the zcode session's own
 *     launch environment, and returns nothing for other providers.
 *
 * Inputs carry only the store locator (config path + provider id); `fetch`
 * re-reads the apiKey from that store on every call and never writes it.
 */

import path from "node:path";

import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromReportedDuration,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";

import {
  loadActiveProvider,
  NO_QUOTA_WINDOWS,
  readZcodeQuota,
  zcodeLoginFromEnv,
  type QuotaReading,
  type ZcodeLogin,
  type ZcodeQuotaSnapshot,
} from "./quota.ts";

const inputSchema = z
  .object({ configPath: z.string().min(1), provider: z.string().min(1) })
  .strict();

/**
 * Window lengths the quota API reports for the token windows server/quota.ts
 * recognises (5h: `number=5 unit=3`; weekly: `number=1 unit=6`, or the legacy
 * `number=7`). Other windows keep the API's own name.
 */
const WINDOW_SECONDS: Readonly<Record<string, number>> = {
  token_5h: 5 * 3_600,
  token_week: 7 * 86_400,
};

/** No account id is available, so the store locator is the identity. */
function accountKey(configPath: string, provider: string): string {
  return hashAccountKey(`${path.resolve(configPath)}#${provider}`);
}

function discoverLogin(login: ZcodeLogin): UsageAccount[] {
  const active = loadActiveProvider(login);
  if (!active?.apiKey) return [];
  return [
    {
      key: accountKey(login.configPath, active.id),
      label: `ZCode · ${active.id.replace(/^builtin:/, "")}`,
      harness: "ZCode",
      input: { configPath: login.configPath, provider: active.id },
    },
  ];
}

function isoOrNull(timestampMs: number | null): string | null {
  if (timestampMs === null) return null;
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toUsageWindow(item: ZcodeQuotaSnapshot["items"][number]): UsageWindow {
  const resetsAt = isoOrNull(item.nextResetTime);
  const tone = toneFromUsedPct(item.usedPercent);
  const durationSeconds = WINDOW_SECONDS[item.key];
  if (durationSeconds !== undefined) {
    return windowFromReportedDuration({
      durationSeconds,
      unknown: { id: item.key, label: item.label, shortLabel: "" },
      utilizationPct: item.usedPercent,
      resetsAt,
      summary: true,
      tone,
    });
  }
  return windowFromUsedPct({
    id: item.key,
    label: item.label,
    utilizationPct: item.usedPercent,
    resetsAt,
    tone,
  });
}

export function toUsageReport({ snapshot, httpStatus }: QuotaReading): UsageReport {
  switch (snapshot.status) {
    case "ok":
      return {
        status: "available",
        ...(snapshot.level
          ? { planLabel: snapshot.level.charAt(0).toUpperCase() + snapshot.level.slice(1) }
          : {}),
        windows: snapshot.items.map(toUsageWindow),
        details: snapshot.sourceHost
          ? [{ id: "endpoint", label: "Endpoint", value: snapshot.sourceHost }]
          : [],
      };
    case "auth_error":
      // Envelope-level auth failures arrive with HTTP 200; report them as 401.
      return unavailable({
        kind: "rejected",
        status: httpStatus === 401 || httpStatus === 403 ? httpStatus : 401,
      });
    case "rate_limited":
      return { status: "error", error: "GLM quota API is rate limited" };
    default:
      if (snapshot.error === NO_QUOTA_WINDOWS) {
        return unavailable({ kind: "no_quota", detail: "No GLM Coding Plan quota reported" });
      }
      return { status: "error", error: snapshot.error ?? "GLM quota unavailable" };
  }
}

export function createZcodeUsageSource(providerId: string): UsageSourceRegistration {
  return {
    // Usage-source ids are daemon-wide, not per plugin: `zcode` belongs to the
    // Services Server provider (supermomonga/zcode-provider) on the same daemon.
    id: "zcode-acp",
    label: "ZCode (ACP)",
    icon: "icon.svg",
    input: inputSchema,
    async discover(scope) {
      if (scope.kind === "session") {
        return scope.provider === providerId ? discoverLogin(zcodeLoginFromEnv(scope.env)) : [];
      }
      return discoverLogin(zcodeLoginFromEnv(process.env));
    },
    async fetch(input) {
      const login = inputSchema.parse(input);
      if (!loadActiveProvider(login)?.apiKey) throw new Error("ZCode login no longer exists");
      return toUsageReport(await readZcodeQuota(login));
    },
  };
}
