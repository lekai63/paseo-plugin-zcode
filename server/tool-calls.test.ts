/**
 * Failed-tool-call normalization tests: a `failed` zcode tool call without
 * output must not reach Paseo's timeline as `error: null`.
 *
 * Runs on Node's built-in test runner with type stripping (Node >= 22.18):
 *   npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";

import {
  TOOL_CALL_FAILED_WITHOUT_OUTPUT,
  createZcodeToolCallTransformer,
  normalizeFailedToolCall,
} from "./tool-calls.ts";

function snapshot(overrides: Partial<AcpToolCallSnapshot> = {}): AcpToolCallSnapshot {
  return {
    id: "call_1",
    name: "Bash",
    title: "pnpm test",
    status: "pending",
    input: { command: "pnpm test" },
    output: null,
    locations: [],
    ...overrides,
  };
}

test("a failed call without output gets the non-null fallback error", () => {
  const normalized = normalizeFailedToolCall(snapshot({ status: "failed" }));
  assert.equal(normalized.output, TOOL_CALL_FAILED_WITHOUT_OUTPUT);
  assert.equal(normalized.status, "failed");
});

test("a runtime-undefined output is treated like null", () => {
  const normalized = normalizeFailedToolCall(snapshot({ status: "failed", output: undefined }));
  assert.equal(normalized.output, TOOL_CALL_FAILED_WITHOUT_OUTPUT);
});

test("a failed call keeps the output it reported", () => {
  const normalized = normalizeFailedToolCall(
    snapshot({ status: "failed", output: { message: "exit code 1" } }),
  );
  assert.deepEqual(normalized.output, { message: "exit code 1" });
});

test("non-failed calls keep their null output", () => {
  for (const status of ["pending", "in_progress", "completed"] as const) {
    const original = snapshot({ status });
    assert.equal(normalizeFailedToolCall(original), original);
  }
});

test("the transformer exposes the normalization as its toolCall hook", () => {
  const transformer = createZcodeToolCallTransformer();
  const normalized = transformer.toolCall?.(
    snapshot({ status: "failed" }),
    { sessionId: "acp_1" },
  );
  assert.equal(normalized?.output, TOOL_CALL_FAILED_WITHOUT_OUTPUT);
});
