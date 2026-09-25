/**
 * zcode-acp tool calls → Paseo timeline items: failure-shape normalization.
 *
 * Paseo's ACP shim materializes every tool-call snapshot into a `tool_call`
 * timeline item and, for a `failed` call, takes the item's `error` verbatim
 * from `snapshot.output` (`toolTimelineItem` in `@getpaseo/plugin`'s
 * acp-internal/connection). The wire protocol, however, requires a NON-null
 * `error` on failed tool calls, so a backend that reports `failed` with no
 * output — zcode does, the ACP update carries no `rawOutput` — produces
 * `error: null`. Clients validate responses strictly, reject the WHOLE
 * timeline page, and surface "Couldn't refresh agent history"
 * (无法刷新代理历史记录); retries keep failing because the item stays in the
 * session's timeline (observed 2026-09 on a long zcode session).
 *
 * This transformer runs before the shim builds the item and substitutes a
 * non-null placeholder for that one case. Failed calls that do carry output
 * and every non-failed call pass through untouched; the item's detail and
 * status still render the failure.
 *
 * Scope: per-update snapshots only. A turn failure terminalizes still-pending
 * calls inside the shim without a transformer pass, so that path can still
 * emit `failed` + null output; this hook covers the common update path.
 */

import type { AcpTransformer, AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";

/** Fallback error text when zcode reports a failed call with no output. */
export const TOOL_CALL_FAILED_WITHOUT_OUTPUT = "tool call failed without output";

/** The wire protocol's `failed` items need a non-null error; keep it non-null. */
export function normalizeFailedToolCall(toolCall: AcpToolCallSnapshot): AcpToolCallSnapshot {
  if (toolCall.status !== "failed") return toolCall;
  if (toolCall.output !== null && toolCall.output !== undefined) return toolCall;
  return { ...toolCall, output: TOOL_CALL_FAILED_WITHOUT_OUTPUT };
}

export function createZcodeToolCallTransformer(): AcpTransformer {
  return {
    toolCall: normalizeFailedToolCall,
  };
}
