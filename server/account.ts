/**
 * Data and actions behind Settings → Plugins → ZCode (ACP) → Account.
 *
 * Sign-in itself stays with ZCode Desktop (OAuth needs its UI); this screen
 * reports what the stored credentials allow, shows Desktop's plan verdicts,
 * spends Coding Plan reset cards, and manages the providers the bridge's
 * model picker offers. Everything that touches ZCode's own stores goes through
 * the bridge's `dist/settings` modules (`coding-plan`, `provider-config`), so
 * file locking, canonical bytes and the app's on-disk shapes stay theirs.
 *
 * Reset cards are the one irreversible action. The guard mirrors the bridge's
 * own HTTP route (remote/settings-endpoint.ts): every status read issues a
 * nonce, a spend must present the latest one, a provider has at most one spend
 * in flight, and the idempotency key is derived from the nonce and reset type,
 * so a retry of the same tap answers the same outcome instead of burning a
 * second card.
 */

import fs from "node:fs";
import path from "node:path";

import type {
  ZcodeAccountView,
  ZcodeProviderTemplate,
  ZcodeResetCards,
  ZcodeResetType,
} from "../shared/account.ts";
import { runBridgeScript, type Bridge, type Env } from "./bridge-script.ts";
import { resolveBridge } from "./launch.ts";
import { readZcodeQuota, zcodeLoginFromEnv } from "./quota.ts";
import { credentialsFrom, zcodeHome } from "./settings.ts";

const PLAN_LABELS: Record<string, string> = {
  "builtin:bigmodel-coding-plan": "BigModel Coding Plan",
  "builtin:bigmodel-start-plan": "BigModel Start Plan",
  "builtin:zai-coding-plan": "Z.ai Coding Plan",
  "builtin:zai-start-plan": "Z.ai Start Plan",
};

/** Plans whose cards live on an account registry id. */
const RESET_CARD_ACCOUNTS: Record<string, string> = {
  "builtin:bigmodel-coding-plan": "account:bigmodel-individual-coding-plan",
  "builtin:zai-coding-plan": "account:zai-individual-coding-plan",
};

function requireBridge(): Bridge {
  const bridge = resolveBridge();
  if (!bridge) throw new Error("zcode-acp-server bridge not found");
  return bridge;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------- pure views ----------

/** Desktop's plan verdicts from `coding-plan-cache.json`. */
export function plansFromCache(cache: unknown): {
  plans: ZcodeAccountView["plans"];
  updatedAt: string | null;
} {
  const entry = (cache as { entryStatus?: { updatedAt?: unknown; items?: Record<string, unknown> } } | null)
    ?.entryStatus;
  const plans = Object.entries(entry?.items ?? {}).map(([id, value]) => {
    const item = (value ?? {}) as { status?: unknown; reason?: unknown };
    return {
      id,
      label: PLAN_LABELS[id] ?? id,
      available: item.status === "available",
      reason: typeof item.reason === "string" ? item.reason : null,
    };
  });
  const updatedAt =
    typeof entry?.updatedAt === "number" ? new Date(entry.updatedAt).toISOString() : null;
  return { plans, updatedAt };
}

export function resetCardProvidersFor(plans: ZcodeAccountView["plans"]): ZcodeAccountView["resetCardProviders"] {
  return plans
    .filter((plan) => plan.available && RESET_CARD_ACCOUNTS[plan.id])
    .map((plan) => ({ providerId: RESET_CARD_ACCOUNTS[plan.id]!, label: plan.label }));
}

interface RawRule {
  providerId: string;
  providerName: string | null;
  templateId: string | null;
  enabled: boolean;
  hasKey: boolean;
  baseUrl: string | null;
  apiType: string | null;
  personalModelIds: string[];
}

interface RawModelRule {
  providerId: string;
  modelId: string;
  enabled: boolean;
}

/** Personal providers as the app resolves them: template endpoint/models + the rule's own. */
export function personalProvidersView(
  rules: readonly RawRule[],
  modelRules: readonly RawModelRule[],
  templates: readonly ZcodeProviderTemplate[],
): ZcodeAccountView["personalProviders"] {
  return rules.map((rule) => {
    const template = rule.templateId ? templates.find((t) => t.templateId === rule.templateId) : undefined;
    const disabled = new Set(
      modelRules.filter((m) => m.providerId === rule.providerId && !m.enabled).map((m) => m.modelId),
    );
    const extra = modelRules.filter((m) => m.providerId === rule.providerId && m.enabled).map((m) => m.modelId);
    const models = [...new Set([...(template?.modelIds ?? []), ...rule.personalModelIds, ...extra])].filter(
      (id) => !disabled.has(id),
    );
    return {
      providerId: rule.providerId,
      name: rule.providerName ?? template?.name ?? rule.providerId,
      templateId: rule.templateId,
      templateName: template?.name ?? null,
      enabled: rule.enabled,
      hasKey: rule.hasKey,
      baseUrl: rule.baseUrl ?? template?.baseUrl ?? null,
      apiType: rule.apiType ?? template?.apiType ?? null,
      models,
    };
  });
}

interface RawResetStatus {
  availableFiveHour: Array<{ expireAt: number }>;
  availableWeek: Array<{ expireAt: number }>;
  latestFiveHour: { usedAt: number } | null;
  latestWeek: { usedAt: number } | null;
  nonce: string;
}

export function resetCardsView(
  providerId: string,
  status: RawResetStatus,
  windows: ZcodeResetCards["windows"],
  now: Date,
): ZcodeResetCards {
  const nextExpiry = (cards: Array<{ expireAt: number }>): number | null => {
    const future = cards.map((c) => c.expireAt).filter((t) => t > now.getTime());
    return future.length ? Math.min(...future) : null;
  };
  return {
    providerId,
    checkedAt: now.toISOString(),
    fiveHour: {
      available: status.availableFiveHour.length,
      nextExpireAt: nextExpiry(status.availableFiveHour),
      lastUsedAt: status.latestFiveHour?.usedAt ?? null,
    },
    week: {
      available: status.availableWeek.length,
      nextExpireAt: nextExpiry(status.availableWeek),
      lastUsedAt: status.latestWeek?.usedAt ?? null,
    },
    windows,
    nonce: status.nonce,
  };
}

/** Nonce bookkeeping for reset-card spends (see the module comment). */
export class ResetNonces {
  readonly #issued = new Map<string, string>();
  readonly #inFlight = new Set<string>();

  issue(providerId: string, nonce: string): void {
    this.#issued.set(providerId, nonce);
  }

  /** Throws unless `nonce` is the latest one issued and no spend is in flight. */
  begin(providerId: string, nonce: string): void {
    if (this.#issued.get(providerId) !== nonce) {
      throw new Error("The reset card status is out of date. Refresh it and try again.");
    }
    if (this.#inFlight.has(providerId)) {
      throw new Error("A reset for this plan is already in progress.");
    }
    this.#inFlight.add(providerId);
  }

  /** Burn the nonce only once the outcome is known, and only if no newer read replaced it. */
  settle(providerId: string, nonce: string, burned: boolean): void {
    this.#inFlight.delete(providerId);
    if (burned && this.#issued.get(providerId) === nonce) this.#issued.delete(providerId);
  }
}

/** Retries of one tap reuse the key; a fresh status read (new nonce) gets a new one. */
export function idempotencyKeyFor(nonce: string, resetType: ZcodeResetType): string {
  return `${nonce}:${resetType}`.slice(0, 64);
}

// ---------- handlers ----------

interface AccountProbe {
  templates: ZcodeProviderTemplate[];
  rules: RawRule[];
  modelRules: RawModelRule[];
  signIn: ZcodeAccountView["signIn"];
}

const ACCOUNT_PROBE = `
  const pc = await load("settings/provider-config.js");
  const cp = await load("settings/coding-plan.js");
  const tablePath = pc.builtinProviderTablePath();
  const templates = tablePath
    ? pc.listProviderTemplates(tablePath).map((t) => ({
        templateId: t.templateId, name: t.name, nameZh: t.nameZh ?? null, accessType: t.accessType,
        apiKeyManagementUrl: t.apiKeyManagementUrl ?? null, baseUrl: t.baseUrl ?? null,
        apiType: t.apiType ?? null, modelIds: t.modelIds,
      }))
    : [];
  const doc = await pc.readProviderConfig();
  const rules = doc.config.providerConfigRules.providerRules.map((r) => ({
    providerId: r.providerId, providerName: r.providerName ?? null, templateId: r.templateId ?? null,
    enabled: r.enabled !== false, hasKey: Boolean(r.config?.access?.apiKey),
    baseUrl: r.config?.api?.baseUrl ?? null, apiType: r.config?.api?.type ?? null,
    personalModelIds: r.config?.personalModelIds ?? [],
  }));
  const models = doc.config.modelConfigRules;
  const modelRules = [...models.providerModelRules, ...models.manualProviderModelRules].map((m) => ({
    providerId: m.providerId, modelId: m.modelId, enabled: m.config?.enabled !== false,
  }));
  let signIn = { state: "signed-in", detail: null };
  const failures = [];
  for (const id of ["account:bigmodel-individual-coding-plan", "account:zai-individual-coding-plan"]) {
    try { await cp.resolveResetAuthorization(id); failures.length = 0; break; }
    catch (error) { failures.push(String(error?.message ?? error)); }
  }
  if (failures.length) {
    signIn = failures.includes("credentials_unavailable")
      ? { state: "no-credentials", detail: "credentials_unavailable" }
      : { state: "incomplete", detail: failures[0] };
  }
  return { templates, rules, modelRules, signIn };
`;

export async function collectAccountView(env: Env = process.env): Promise<ZcodeAccountView> {
  const home = zcodeHome(env);
  const { plans, updatedAt } = plansFromCache(readJson(path.join(home, "v2", "coding-plan-cache.json")));
  const builtinProviders = credentialsFrom(readJson(path.join(home, "v2", "config.json")), null).providers;
  const view: ZcodeAccountView = {
    signIn: { state: "incomplete", detail: null },
    plans,
    plansUpdatedAt: updatedAt,
    resetCardProviders: resetCardProvidersFor(plans),
    builtinProviders,
    personalProviders: [],
    templates: [],
    error: null,
  };
  try {
    const probe = await runBridgeScript<AccountProbe>(requireBridge(), ACCOUNT_PROBE, null, env);
    view.signIn = probe.signIn;
    view.templates = probe.templates;
    view.personalProviders = personalProvidersView(probe.rules, probe.modelRules, probe.templates);
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
  }
  return view;
}

const nonces = new ResetNonces();

function assertResetProvider(providerId: string): void {
  if (!Object.values(RESET_CARD_ACCOUNTS).includes(providerId)) {
    throw new Error(`${providerId} is not a Coding Plan with reset cards`);
  }
}

async function quotaWindows(env: Env): Promise<ZcodeResetCards["windows"]> {
  try {
    const { snapshot } = await readZcodeQuota(zcodeLoginFromEnv(env));
    return snapshot.items
      .filter((item) => item.key === "token_5h" || item.key === "token_week")
      .map((item) => ({
        key: item.key,
        label: item.label,
        usedPercent: item.usedPercent,
        resetAt: item.nextResetTime,
      }));
  } catch {
    return [];
  }
}

export async function readResetCards(providerId: string, env: Env = process.env): Promise<ZcodeResetCards> {
  assertResetProvider(providerId);
  const [status, windows] = await Promise.all([
    runBridgeScript<RawResetStatus>(
      requireBridge(),
      `const cp = await load("settings/coding-plan.js"); return await cp.readResetStatus(ARGS.providerId);`,
      { providerId },
      env,
    ),
    quotaWindows(env),
  ]);
  nonces.issue(providerId, status.nonce);
  return resetCardsView(providerId, status, windows, new Date());
}

export async function useResetCard(
  input: { providerId: string; resetType: ZcodeResetType; nonce: string },
  env: Env = process.env,
): Promise<{ used: boolean; nextTryAt: number | null; cards: ZcodeResetCards }> {
  assertResetProvider(input.providerId);
  nonces.begin(input.providerId, input.nonce);
  let burned = false;
  try {
    const result = await runBridgeScript<{ used: boolean; nextTryAt?: number }>(
      requireBridge(),
      `const cp = await load("settings/coding-plan.js");
       return await cp.useResetCard(ARGS.providerId, ARGS.resetType, ARGS.idempotencyKey);`,
      {
        providerId: input.providerId,
        resetType: input.resetType,
        idempotencyKey: idempotencyKeyFor(input.nonce, input.resetType),
      },
      env,
    );
    burned = true;
    return {
      used: result.used,
      nextTryAt: result.nextTryAt ?? null,
      cards: await readResetCards(input.providerId, env),
    };
  } finally {
    nonces.settle(input.providerId, input.nonce, burned);
  }
}

export async function createProvider(
  input: { templateId: string; apiKey: string; providerName?: string },
  env: Env = process.env,
): Promise<ZcodeAccountView> {
  await runBridgeScript<string>(
    requireBridge(),
    `const pc = await load("settings/provider-config.js");
     const { providerId } = await pc.createProviderFromTemplate(ARGS);
     return providerId;`,
    {
      templateId: input.templateId,
      apiKey: input.apiKey,
      ...(input.providerName?.trim() ? { providerName: input.providerName.trim() } : {}),
    },
    env,
  );
  return collectAccountView(env);
}

export async function updateProvider(
  input: { providerId: string; enabled?: boolean; providerName?: string; apiKey?: string },
  env: Env = process.env,
): Promise<ZcodeAccountView> {
  await runBridgeScript<boolean>(
    requireBridge(),
    `const pc = await load("settings/provider-config.js");
     const patch = {};
     if (ARGS.enabled !== undefined) patch.enabled = ARGS.enabled;
     if (ARGS.providerName !== undefined) patch.providerName = ARGS.providerName;
     if (Object.keys(patch).length) await pc.updateProvider(ARGS.providerId, patch);
     if (ARGS.apiKey) await pc.setProviderApiKey(ARGS.providerId, ARGS.apiKey);
     return true;`,
    {
      providerId: input.providerId,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.providerName?.trim() ? { providerName: input.providerName.trim() } : {}),
      ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
    },
    env,
  );
  return collectAccountView(env);
}

export async function deleteProvider(providerId: string, env: Env = process.env): Promise<ZcodeAccountView> {
  await runBridgeScript<boolean>(
    requireBridge(),
    `const pc = await load("settings/provider-config.js"); await pc.deleteProvider(ARGS.providerId); return true;`,
    { providerId },
    env,
  );
  return collectAccountView(env);
}
