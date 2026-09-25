/**
 * zcode-acp `_zcode/subagent` → Paseo sub_agent card mapping tests.
 *
 * Runs on Node's built-in test runner with type stripping (Node >= 22.18):
 *   npm test
 * The module under test has only type-only SDK imports, so no build step is
 * needed — the same property that lets Paseo bundle it from source.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

import {
  ZCODE_SUBAGENT_METHOD,
  buildSubagentLog,
  createZcodeSubagentTransformer,
  mapSubagentCardStatus,
  subagentCallId,
  subagentTimelineUpdate,
} from "./subagents.ts";

/**
 * Narrow an AcpVendorUpdate union to its timeline item. `Array.isArray` cannot
 * discriminate a `readonly T[]` member, so the shape is checked explicitly.
 */
function asTimelineItem(update: unknown): ProviderTimelineItem | null {
  if (!update || typeof update !== "object") return null;
  const candidate = update as { type?: unknown; item?: unknown };
  if (candidate.type !== "timeline" || !candidate.item) return null;
  return candidate.item as ProviderTimelineItem;
}

test("maps every zcode card status onto Paseo's union", () => {
  assert.equal(mapSubagentCardStatus("running"), "running");
  assert.equal(mapSubagentCardStatus("completed"), "completed");
  assert.equal(mapSubagentCardStatus("success"), "completed");
  assert.equal(mapSubagentCardStatus("failed"), "failed");
  assert.equal(mapSubagentCardStatus("canceled"), "canceled");
  assert.equal(mapSubagentCardStatus("cancelled"), "canceled");
  assert.equal(mapSubagentCardStatus(undefined), "running");
});

test("keys the card by the dispatch tool call id so it merges with the Agent row", () => {
  assert.equal(
    subagentCallId({ parentToolCallId: "call_dispatch", agentId: "agent_a1" }),
    "call_dispatch",
  );
  // A directory-only entry has no dispatch id yet: fall back to the agent id
  // rather than dropping the update.
  assert.equal(subagentCallId({ agentId: "agent_a1" }), "agent_a1");
  assert.equal(subagentCallId({}), undefined);
});

test("builds the log block with the usage summary appended", () => {
  const log = buildSubagentLog({
    log: ["[Read] src/index.ts", "[Bash] pnpm test"],
    toolUses: 2,
    tokens: 40904,
    durationMs: 10559,
  });
  assert.equal(
    log,
    ["[Read] src/index.ts", "[Bash] pnpm test", "2 tools · 40904 tokens · 10.6s"].join("\n"),
  );
});

test("builds an inline sub_agent timeline card for a running sub-agent", () => {
  const update = subagentTimelineUpdate({
    parentToolCallId: "call_dispatch",
    agentId: "agent_a1",
    agentType: "Explore",
    childSessionId: "sess_subagent_agent_a1",
    title: "search the repo",
    status: "running",
    log: ["[Read] src/index.ts"],
  });

  assert.deepEqual(update, {
    type: "timeline",
    item: {
      id: "call_dispatch",
      callId: "call_dispatch",
      type: "tool_call",
      name: "Agent (Explore)",
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "search the repo",
        childSessionId: "sess_subagent_agent_a1",
        log: "[Read] src/index.ts",
      },
      status: "running",
      error: null,
    },
  });
});

test("a failed sub-agent carries the error value, never null", () => {
  const update = subagentTimelineUpdate({
    parentToolCallId: "call_dispatch",
    agentId: "agent_a1",
    status: "failed",
    errorMessage: "spawn_error",
  });
  const item = asTimelineItem(update);
  assert.ok(item && item.type === "tool_call");
  assert.equal(item.status, "failed");
  assert.equal(item.error, "spawn_error");
});

test("a snapshot without identity produces no update", () => {
  assert.equal(subagentTimelineUpdate({ status: "running" }), null);
});

test("the transformer only claims its own vendor method", () => {
  const forwarded: Array<[string, unknown]> = [];
  const transformer = createZcodeSubagentTransformer((boundarySessionId, snapshot) => {
    forwarded.push([boundarySessionId, snapshot]);
  });
  const claimed = transformer.notification?.(
    {
      method: ZCODE_SUBAGENT_METHOD,
      params: { parentToolCallId: "call_dispatch", agentId: "agent_a1", status: "running" },
    },
    { sessionId: "acp_1" },
  );
  assert.ok(asTimelineItem(claimed));
  assert.deepEqual(forwarded, [
    ["acp_1", { parentToolCallId: "call_dispatch", agentId: "agent_a1", status: "running" }],
  ]);

  // Foreign (real ACP) notifications must pass through untouched.
  assert.equal(
    transformer.notification?.(
      { method: "session/update", params: { sessionId: "acp_1" } },
      { sessionId: "acp_1" },
    ),
    null,
  );
  assert.equal(
    transformer.notification?.(
      { method: ZCODE_SUBAGENT_METHOD, params: null },
      { sessionId: "acp_1" },
    ),
    null,
  );
  assert.deepEqual(
    forwarded.filter(([method]) => method !== "acp_1"),
    [],
  );
});
