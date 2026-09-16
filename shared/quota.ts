import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Normalised GLM Coding Plan quota snapshot.
 *
 * Mirrors the data the ZCode desktop app shows in its context circle: one
 * entry per limit window (5-hour, weekly, MCP), with the used/remaining
 * percentages already derived by the server module.
 */
export const zcodeQuotaSnapshotSchema = z.object({
  status: z.enum(["ok", "auth_error", "rate_limited", "unavailable"]),
  level: z.string(),
  fetchedAt: z.string(),
  sourceHost: z.string(),
  items: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      usedPercent: z.number(),
      leftPercent: z.number(),
      nextResetTime: z.number().nullable(),
    }),
  ),
  error: z.string().nullable(),
});

export type ZcodeQuotaSnapshot = z.output<typeof zcodeQuotaSnapshotSchema>;

export const zcodeQuotaRpc = defineRpc({
  name: "zcode.quota",
  input: z.object({ force: z.boolean().optional() }),
  output: zcodeQuotaSnapshotSchema,
});
