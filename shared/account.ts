import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * RPC contracts behind Settings → Plugins → ZCode (ACP) → Account: sign-in
 * and plan status, Coding Plan reset cards, and model providers. Keys travel
 * client → server only; no response ever carries one.
 */

const providerTemplateSchema = z.object({
  templateId: z.string(),
  name: z.string(),
  nameZh: z.string().nullable(),
  accessType: z.string(),
  apiKeyManagementUrl: z.string().nullable(),
  baseUrl: z.string().nullable(),
  apiType: z.string().nullable(),
  modelIds: z.array(z.string()),
});
export type ZcodeProviderTemplate = z.output<typeof providerTemplateSchema>;

export const zcodeAccountViewSchema = z.object({
  signIn: z.object({
    state: z.enum(["signed-in", "no-credentials", "incomplete"]),
    detail: z.string().nullable(),
  }),
  plans: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      available: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  plansUpdatedAt: z.string().nullable(),
  /** Coding Plan providers that can spend reset cards (account registry ids). */
  resetCardProviders: z.array(z.object({ providerId: z.string(), label: z.string() })),
  /** Providers from the legacy `config.json` table, managed by ZCode Desktop (read-only here). */
  builtinProviders: z.array(z.object({ id: z.string(), enabled: z.boolean(), hasKey: z.boolean() })),
  /** User-added providers from `provider_config.json`. */
  personalProviders: z.array(
    z.object({
      providerId: z.string(),
      name: z.string(),
      templateId: z.string().nullable(),
      templateName: z.string().nullable(),
      enabled: z.boolean(),
      hasKey: z.boolean(),
      baseUrl: z.string().nullable(),
      apiType: z.string().nullable(),
      models: z.array(z.string()),
    }),
  ),
  templates: z.array(providerTemplateSchema),
  error: z.string().nullable(),
});
export type ZcodeAccountView = z.output<typeof zcodeAccountViewSchema>;

const resetTypeSchema = z.enum(["FIVE_HOUR", "WEEK"]);
export type ZcodeResetType = z.output<typeof resetTypeSchema>;

export const zcodeResetCardsSchema = z.object({
  providerId: z.string(),
  checkedAt: z.string(),
  fiveHour: z.object({ available: z.number(), nextExpireAt: z.number().nullable(), lastUsedAt: z.number().nullable() }),
  week: z.object({ available: z.number(), nextExpireAt: z.number().nullable(), lastUsedAt: z.number().nullable() }),
  /** Current windows for context (5-hour, weekly), from the GLM quota API. */
  windows: z.array(
    z.object({ key: z.string(), label: z.string(), usedPercent: z.number(), resetAt: z.number().nullable() }),
  ),
  /** Must be sent back to spend a card; issued by this read only. */
  nonce: z.string(),
});
export type ZcodeResetCards = z.output<typeof zcodeResetCardsSchema>;

export const zcodeAccountViewRpc = defineRpc({
  name: "zcode-acp.account",
  input: z.object({}),
  output: zcodeAccountViewSchema,
});

export const zcodeResetCardsRpc = defineRpc({
  name: "zcode-acp.reset-cards",
  input: z.object({ providerId: z.string() }),
  output: zcodeResetCardsSchema,
});

export const zcodeUseResetCardRpc = defineRpc({
  name: "zcode-acp.reset-cards.use",
  input: z.object({ providerId: z.string(), resetType: resetTypeSchema, nonce: z.string() }),
  output: z.object({
    used: z.boolean(),
    nextTryAt: z.number().nullable(),
    cards: zcodeResetCardsSchema,
  }),
});

export const zcodeCreateProviderRpc = defineRpc({
  name: "zcode-acp.providers.create",
  input: z.object({
    templateId: z.string().min(1),
    apiKey: z.string().min(1),
    providerName: z.string().optional(),
  }),
  output: zcodeAccountViewSchema,
});

export const zcodeUpdateProviderRpc = defineRpc({
  name: "zcode-acp.providers.update",
  input: z.object({
    providerId: z.string().min(1),
    enabled: z.boolean().optional(),
    providerName: z.string().optional(),
    apiKey: z.string().optional(),
  }),
  output: zcodeAccountViewSchema,
});

export const zcodeDeleteProviderRpc = defineRpc({
  name: "zcode-acp.providers.delete",
  input: z.object({ providerId: z.string().min(1) }),
  output: zcodeAccountViewSchema,
});
