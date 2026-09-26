/**
 * Steer tests for the vendored ACP adapter (server/acp-adapter/). The fake
 * agent below mimics the zcode-acp-server bridge's preempt semantics: a
 * session/prompt landing mid-turn stops the superseded request (it settles
 * stopReason "cancelled") and the new one runs to end_turn.
 *
 * Runs on Node's built-in test runner with type stripping (Node >= 22.18):
 *   npm test
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ProviderConnection, ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";

import { runAcpProvider } from "./acp-adapter/acp.ts";

/**
 * Fake ACP agent. Prompt-text scripting:
 *   - "HOLD"    → request stays pending (a running turn)
 *   - "STEER"   → settle every earlier pending prompt as cancelled, stream a
 *                 chunk, then settle itself with end_turn
 *   - "ASK"     → send a session/request_permission server request, keep the
 *                 prompt pending; when the permission response arrives, echo
 *                 its outcome as a `_test/permissionOutcome` notification
 * Anything else → generic empty result.
 */
const FAKE_AGENT = `
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let nextServerId = 100;
const pendingPrompts = [];
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: [] } });
  } else if (message.method === "session/prompt") {
    pendingPrompts.push(message.id);
    const text = (message.params.prompt || []).map((block) => block.text || "").join("");
    if (text === "STEER") {
      for (const earlier of pendingPrompts.splice(0, pendingPrompts.length - 1)) {
        send({ jsonrpc: "2.0", id: earlier, result: { stopReason: "cancelled" } });
      }
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "steered reply" } } } });
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }, 15);
    } else if (text === "ASK") {
      send({
        jsonrpc: "2.0",
        id: nextServerId++,
        method: "session/request_permission",
        params: {
          sessionId: "native-1",
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
          toolCall: { toolCallId: "tool-1", title: "Dangerous tool", kind: "other", rawInput: {} },
        },
      });
    }
  } else if (message.method === "session/cancel") {
    for (const id of pendingPrompts.splice(0)) {
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
  } else if (message.id !== undefined && !message.method) {
    // Response to one of our server requests — a permission outcome.
    send({ jsonrpc: "2.0", method: "_test/permissionOutcome", params: message.result ?? null });
    for (const id of pendingPrompts.splice(0)) {
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
  }
});
`;

interface Harness {
  connection: ProviderConnection;
  events: ProviderEvent[];
  vendorNotifications: Array<{ method: string; params: unknown }>;
  waitFor(predicate: (event: ProviderEvent) => boolean, label: string): Promise<ProviderEvent>;
  send(input: ProviderInput): Promise<void>;
  close(): Promise<void>;
}

async function connectFakeAgent(): Promise<Harness> {
  const script = path.join(
    os.tmpdir(),
    `paseo-plugin-zcode-fake-acp-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`,
  );
  fs.writeFileSync(script, FAKE_AGENT);
  const vendorNotifications: Array<{ method: string; params: unknown }> = [];
  const registration = runAcpProvider({
    id: "fake",
    label: "Fake",
    command: [process.execPath, script],
    transformers: [
      {
        notification(notification) {
          vendorNotifications.push({ method: notification.method, params: notification.params });
          return null;
        },
      },
    ],
  });
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message", "prompt.steer", "session.configure", "permission"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const harness: Harness = {
    connection,
    events,
    vendorNotifications,
    async waitFor(predicate, label) {
      const already = events.find(predicate);
      if (already) return already;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}`)),
          5_000,
        );
        const stop = connection.onEvent((event) => {
          // events are recorded by the harness-level listener; only match here
          if (predicate(event)) {
            clearTimeout(timeout);
            stop();
            resolve(event);
          }
        });
      });
    },
    async send(input) {
      await connection.send(input);
    },
    async close() {
      await connection.close();
      fs.rmSync(script, { force: true });
    },
  };
  await harness.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "session-1",
    history: "skip",
    config: { cwd: os.tmpdir(), env: {}, mcpServers: {}, settings: {}, persist: false },
  });
  await harness.waitFor(
    (event) => event.type === "session.ready",
    "session.ready",
  );
  return harness;
}

function textPrompt(clientMessageId: string, text: string, delivery?: "steer") {
  return {
    type: "session.prompt" as const,
    sessionId: "session-1",
    prompt: {
      clientMessageId,
      ...(delivery ? { delivery } : { delivery: "auto" as const }),
      input: { type: "message" as const, content: [{ type: "text" as const, text }] },
    },
  };
}

test("negotiates prompt.steer when the daemon offers it", async () => {
  const harness = await connectFakeAgent();
  try {
    assert.ok(harness.connection.capabilities.includes("prompt.steer"));
  } finally {
    await harness.close();
  }
});

test("steer keeps the turn identity and hides the superseded cancellation", async () => {
  const harness = await connectFakeAgent();
  try {
    await harness.send(textPrompt("m1", "HOLD"));
    const turnResult = await harness.waitFor(
      (event) => event.type === "session.prompt_result" && event.result.type === "turn",
      "first prompt turn result",
    );
    assert.equal(turnResult.type, "session.prompt_result");
    if (turnResult.type !== "session.prompt_result") return;
    const turnId = turnResult.result.type === "turn" ? turnResult.result.turnId : "";
    await harness.waitFor(
      (event) => event.type === "session.turn" && event.state === "started",
      "turn started",
    );

    await harness.send(textPrompt("m2", "STEER", "steer"));
    // The steer reports the SAME turn id — the daemon only accepts a steer
    // whose turnId matches its active turn.
    const steerResult = await harness.waitFor(
      (event) => event.type === "session.prompt_result" && event.result.type === "steer",
      "steer result",
    );
    assert.equal(steerResult.type, "session.prompt_result");
    if (steerResult.type === "session.prompt_result" && steerResult.result.type === "steer") {
      assert.equal(steerResult.result.turnId, turnId);
    }

    // The fake settles m1 as cancelled (preempt), streams, ends m2. The
    // generation guard must swallow m1's cancellation: the turn completes
    // once and is never marked canceled.
    await harness.waitFor(
      (event) => event.type === "session.turn" && event.state === "completed",
      "turn completed",
    );
    const turnStates = harness.events
      .filter(
        (event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
          event.type === "session.turn" && event.turnId === turnId,
      )
      .map((event) => event.state);
    assert.deepEqual(turnStates, ["started", "completed"]);
    const chunk = harness.events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.text === "steered reply",
    );
    assert.ok(chunk, "steered reply chunk reached the timeline");
  } finally {
    await harness.close();
  }
});

test("repeated steers chain onto the same turn", async () => {
  const harness = await connectFakeAgent();
  try {
    await harness.send(textPrompt("m1", "HOLD"));
    await harness.waitFor(
      (event) => event.type === "session.turn" && event.state === "started",
      "turn started",
    );
    await harness.send(textPrompt("m2", "HOLD", "steer"));
    await harness.send(textPrompt("m3", "STEER", "steer"));
    await harness.waitFor(
      (event) => event.type === "session.turn" && event.state === "completed",
      "turn completed",
    );
    const byTurn = new Map<string, string[]>();
    for (const event of harness.events) {
      if (event.type !== "session.turn") continue;
      byTurn.set(event.turnId, [...(byTurn.get(event.turnId) ?? []), event.state]);
    }
    assert.equal(byTurn.size, 1, "one turn only");
    assert.deepEqual([...byTurn.values()][0], ["started", "completed"]);
  } finally {
    await harness.close();
  }
});

test("steer with no active turn completes without side effects", async () => {
  const harness = await connectFakeAgent();
  try {
    await harness.send(textPrompt("m1", "STEER", "steer"));
    const result = await harness.waitFor(
      (event) => event.type === "session.prompt_result",
      "prompt result",
    );
    assert.equal(result.type, "session.prompt_result");
    if (result.type === "session.prompt_result") {
      assert.equal(result.result.type, "completed");
    }
    assert.equal(
      harness.events.filter((event) => event.type === "session.turn").length,
      0,
      "no turn lifecycle events",
    );
  } finally {
    await harness.close();
  }
});

test("clearPendingPermissions denies outstanding permissions before steering", async () => {
  const harness = await connectFakeAgent();
  try {
    await harness.send(textPrompt("m1", "ASK"));
    await harness.waitFor(
      (event) => event.type === "session.permission",
      "permission request",
    );
    await harness.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "m2",
        delivery: "steer",
        clearPendingPermissions: true,
        input: { type: "message", content: [{ type: "text", text: "STEER" }] },
      },
    });
    await harness.waitFor(
      (event) => event.type === "session.permission_resolved",
      "permission resolved",
    );
    // The cancelled outcome reached the agent over the wire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const outcome = harness.vendorNotifications.find(
      (notification) => notification.method === "_test/permissionOutcome",
    );
    assert.ok(outcome, "agent echoed the permission outcome");
    assert.deepEqual(outcome.params, { outcome: { outcome: "cancelled" } });
  } finally {
    await harness.close();
  }
});
