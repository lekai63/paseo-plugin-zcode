import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * GLM Coding Plan quota reader for the `zcode` usage source (server/usage.ts).
 *
 * The data source is the same one the ZCode desktop app and `zcode-acp quota`
 * use: the active provider's apiKey from `~/.zcode/v2/config.json` against the
 * deployment's `/api/monitor/usage/quota/limit` endpoint. Keeping the lookup
 * here (rather than importing zcode-acp-server internals) keeps the plugin
 * bundle independent of the bridge's dist layout.
 */

const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const HOST_CN = "https://open.bigmodel.cn";
const HOST_INTL = "https://api.z.ai";

const REQUEST_TIMEOUT_MS = 8_000;

const AUTH_FAILURE_RE = /authorization|auth|token|鉴权|授权|未登录/i;
const RATE_LIMITED_RE = /rate\s*limit|too many requests|too frequent|frequency|限流|频率|过于频繁|稍后再试/i;

interface ZcodeProviderEntry {
  enabled?: boolean;
  options?: { baseURL?: string; apiKey?: string };
}

interface ZcodeConfig {
  provider?: Record<string, ZcodeProviderEntry>;
}

/**
 * Normalised GLM Coding Plan quota snapshot: one entry per limit window
 * (5-hour, weekly, MCP), with the used/remaining percentages already derived.
 */
export interface ZcodeQuotaSnapshot {
  status: "ok" | "auth_error" | "rate_limited" | "unavailable";
  level: string;
  fetchedAt: string;
  sourceHost: string;
  items: Array<{
    key: string;
    label: string;
    usedPercent: number;
    leftPercent: number;
    nextResetTime: number | null;
  }>;
  error: string | null;
}

export interface ActiveProvider {
  id: string;
  baseURL: string;
  apiKey: string;
}

/** Where a ZCode login lives: a store locator, never a credential. */
export interface ZcodeLogin {
  /** `<ZCODE_HOME>/v2/config.json`. */
  configPath: string;
  /** Provider id pinned by `ZCODE_PROVIDER`; otherwise the first enabled provider wins. */
  provider?: string;
}

/** A quota snapshot plus the upstream HTTP status, for usage-report mapping. */
export interface QuotaReading {
  snapshot: ZcodeQuotaSnapshot;
  httpStatus: number | null;
}

interface RawLimit {
  type?: unknown;
  number?: unknown;
  unit?: unknown;
  usage?: unknown;
  remaining?: unknown;
  currentValue?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

/**
 * The login a bridge started with `env` reads: `ZCODE_HOME` replaces
 * `~/.zcode` outright and `ZCODE_PROVIDER` pins a provider, as in zcode-acp.
 */
export function zcodeLoginFromEnv(env: Readonly<Record<string, string | undefined>>): ZcodeLogin {
  const home = env.ZCODE_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".zcode");
  const provider = env.ZCODE_PROVIDER?.trim();
  return { configPath: path.join(home, "v2", "config.json"), ...(provider ? { provider } : {}) };
}

/**
 * Select the active provider like the bridge does: `ZCODE_PROVIDER` pins one
 * by id; otherwise the first enabled provider wins.
 */
export function loadActiveProvider(login: ZcodeLogin): ActiveProvider | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(login.configPath, "utf8")) as ZcodeConfig;
    for (const [id, entry] of Object.entries(cfg.provider ?? {})) {
      if (entry?.enabled && (!login.provider || id === login.provider)) {
        return {
          id,
          baseURL: entry.options?.baseURL ?? "",
          apiKey: entry.options?.apiKey ?? "",
        };
      }
    }
  } catch {
    // Missing or unreadable config — reported as unavailable below.
  }
  return null;
}

/** Intl deployments answer on api.z.ai; everything else uses the CN host. */
function quotaHost(baseURL: string): string {
  return baseURL.includes("api.z.ai") ? HOST_INTL : HOST_CN;
}

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Derive used/left percentages from whichever counters the limit carries:
 * remaining+currentValue, currentValue/usage, or the legacy `percentage`
 * field (which the API reports as *used* percent).
 */
function percentagesOf(limit: RawLimit): { usedPercent: number; leftPercent: number } | null {
  const usage = asFiniteNumber(limit.usage);
  const remaining = asFiniteNumber(limit.remaining);
  const currentValue = asFiniteNumber(limit.currentValue);

  const totalFromParts = remaining !== null && currentValue !== null ? remaining + currentValue : null;
  const total = totalFromParts !== null && totalFromParts > 0 ? totalFromParts : usage;

  if (total !== null && total > 0) {
    if (remaining !== null && remaining >= 0 && remaining <= total) {
      const leftPercent = clampPercent((remaining / total) * 100);
      return { leftPercent, usedPercent: 100 - leftPercent };
    }
    if (currentValue !== null && currentValue >= 0 && currentValue <= total) {
      const usedPercent = clampPercent((currentValue / total) * 100);
      return { usedPercent, leftPercent: 100 - usedPercent };
    }
  }

  const legacyUsed = asFiniteNumber(limit.percentage);
  if (legacyUsed === null) return null;
  const usedPercent = clampPercent(legacyUsed);
  return { usedPercent, leftPercent: 100 - usedPercent };
}

/**
 * Stable key + label for a limit entry.
 *
 * The current API emits `CREDIT_LIMIT` entries (5h: `number=5 unit=3`,
 * weekly: `number=1 unit=6`); older backends used `TOKENS_LIMIT` with
 * `number=5/7`. Both are recognised, and anything unknown still renders under
 * its raw type instead of disappearing.
 */
function windowSpec(limit: RawLimit): { key: string; label: string } {
  const type = typeof limit.type === "string" ? limit.type : "Quota";
  const number = asFiniteNumber(limit.number);
  const unit = asFiniteNumber(limit.unit);

  if (type === "MCP_LIMIT" || type === "TIME_LIMIT") return { key: "mcp", label: "MCP" };
  if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
    if (number === 5 && (unit === null || unit === 3)) return { key: "token_5h", label: "5h" };
    if (number === 7 || unit === 6) return { key: "token_week", label: "Weekly" };
    if (number !== null) return { key: `token_${number}`, label: `Window ${number}` };
    return { key: "token", label: "Tokens" };
  }
  return { key: type.toLowerCase(), label: type };
}

/** 5h first, then weekly, then other token windows, MCP, unknown types. */
function rankOf(key: string): number {
  if (key === "token_5h") return 0;
  if (key === "token_week") return 1;
  if (key.startsWith("token")) return 2;
  if (key === "mcp") return 3;
  return 4;
}

function parseItems(payload: { data?: { limits?: unknown } }): ZcodeQuotaSnapshot["items"] {
  const limits = Array.isArray(payload.data?.limits) ? (payload.data.limits as RawLimit[]) : [];
  const taken = new Set<string>();
  const items: ZcodeQuotaSnapshot["items"] = [];
  for (const limit of limits) {
    const percentages = percentagesOf(limit);
    if (!percentages) continue;
    const spec = windowSpec(limit);
    let key = spec.key;
    for (let suffix = 2; taken.has(key); suffix += 1) key = `${spec.key}_${suffix}`;
    taken.add(key);
    items.push({
      key,
      label: spec.label,
      usedPercent: percentages.usedPercent,
      leftPercent: percentages.leftPercent,
      nextResetTime: asFiniteNumber(limit.nextResetTime),
    });
  }
  return items.sort((a, b) => rankOf(a.key) - rankOf(b.key) || a.key.localeCompare(b.key));
}

interface QuotaEnvelope {
  success?: boolean;
  code?: number;
  msg?: string;
  data?: { level?: string; limits?: unknown };
}

/** `error` of an `unavailable` snapshot whose plan reports no quota windows. */
export const NO_QUOTA_WINDOWS = "quota API returned no usable windows";

export async function readZcodeQuota(login: ZcodeLogin): Promise<QuotaReading> {
  const base: ZcodeQuotaSnapshot = {
    status: "unavailable",
    level: "",
    fetchedAt: new Date().toISOString(),
    sourceHost: "",
    items: [],
    error: null,
  };

  const provider = loadActiveProvider(login);
  if (!provider?.apiKey) {
    return { snapshot: { ...base, error: `no apiKey found in ${login.configPath}` }, httpStatus: null };
  }

  const host = quotaHost(provider.baseURL);
  let status: number;
  let text: string;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(host + QUOTA_PATH, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      signal: controller.signal,
    });
    status = resp.status;
    text = await resp.text();
  } catch (error) {
    return {
      snapshot: {
        ...base,
        sourceHost: host,
        error: error instanceof Error ? error.message : String(error),
      },
      httpStatus: null,
    };
  } finally {
    clearTimeout(timer);
  }

  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — classified as unavailable below.
  }

  const reading = (snapshot: ZcodeQuotaSnapshot): QuotaReading => ({ snapshot, httpStatus: status });

  if (status === 429 || RATE_LIMITED_RE.test(text)) {
    return reading({ ...base, status: "rate_limited", sourceHost: host });
  }
  if (status === 401 || status === 403) {
    return reading({ ...base, status: "auth_error", sourceHost: host });
  }
  if (status < 200 || status >= 300) {
    return reading({ ...base, sourceHost: host, error: `GLM quota API returned HTTP ${status}` });
  }

  const payload = json as QuotaEnvelope | null;
  if (!payload || typeof payload !== "object" || payload.success !== true) {
    const message = payload?.msg ?? "";
    if (payload?.code === 1001 || payload?.code === 401 || AUTH_FAILURE_RE.test(message)) {
      return reading({ ...base, status: "auth_error", sourceHost: host, error: message || null });
    }
    if (RATE_LIMITED_RE.test(message)) {
      return reading({ ...base, status: "rate_limited", sourceHost: host, error: message || null });
    }
    return reading({ ...base, sourceHost: host, error: message || "quota API rejected the request" });
  }

  const items = parseItems(payload);
  if (items.length === 0) {
    return reading({ ...base, sourceHost: host, error: NO_QUOTA_WINDOWS });
  }

  return reading({
    ...base,
    status: "ok",
    level: typeof payload.data?.level === "string" ? payload.data.level : "",
    sourceHost: host,
    items,
  });
}
