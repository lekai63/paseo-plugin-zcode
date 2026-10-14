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

import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderLaunch,
  ProviderPersistence,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";

import { runAcpProvider } from "./acp-adapter/acp.ts";
import { RESUME_PURPOSE_ENV } from "./acp-adapter/connection.ts";

/**
 * Fake ACP agent. Prompt-text scripting:
 *   - "HOLD"    → request stays pending (a running turn)
 *   - "STEER"   → settle every earlier pending prompt as cancelled, stream a
 *                 chunk, then settle itself with end_turn
 *   - "ASK"     → send a session/request_permission server request, keep the
 *                 prompt pending; when the permission response arrives, echo
 *                 its outcome as a `_test/permissionOutcome` notification
 *   - "ECHO"    → send a live user_message_chunk (the bridge's echo of a
 *                 prompt from another client), then end the turn
 * Anything else → generic empty result. Every session/prompt is echoed as a
 * `_test/prompt` notification.
 *
 * session/load replays a short conversation like the bridge does: every
 * session/update first, the load response last — all in one stdout write,
 * the tightest the response can follow the replay. One update in the middle
 * carries a foreign session id. A leading `_test/pid` notification reports
 * the agent process, so tests can tell a fresh process from the first one.
 *
 * With FAKE_GUIDE=1 in the session env the agent also advertises
 * `_meta.zcode.guide` and answers `_zcode/guide` like the bridge: "STEER" is
 * declined (the adapter must fall back to the preempting steer), anything
 * else is guided — it streams "guided reply" and ends the pending prompt.
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
    const agentCapabilities = { loadSession: true, ...(process.env.FAKE_GUIDE === "1" ? { _meta: { zcode: { guide: true } } } : {}) };
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities } });
  } else if (message.method === "_zcode/guide") {
    const text = (message.params.prompt || []).map((block) => block.text || "").join("");
    send({ jsonrpc: "2.0", method: "_test/guide", params: { text, sessionId: message.params.sessionId } });
    if (text === "STEER") {
      send({ jsonrpc: "2.0", id: message.id, result: { outcome: "unavailable", reason: "declined" } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: { outcome: "guided", inputId: "g1", delivery: "queue" } });
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "guided reply" } } } });
        for (const id of pendingPrompts.splice(0)) {
          send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
        }
      }, 15);
    }
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", method: "_test/env", params: { launch: process.env.FAKE_LAUNCH_MARK ?? null, session: process.env.FAKE_SESSION_MARK ?? null } });
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: [] } });
  } else if (message.method === "session/load") {
    const sid = message.params.sessionId;
    const update = (sessionId, update) =>
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
    const text = (text) => ({ type: "text", text });
    process.stdout.write([
      JSON.stringify({ jsonrpc: "2.0", method: "_test/pid", params: { pid: process.pid } }),
      update(sid, { sessionUpdate: "user_message_chunk", content: text("run "), messageId: "u1" }),
      update(sid, { sessionUpdate: "user_message_chunk", content: text("the schedule"), messageId: "u1" }),
      update(sid, { sessionUpdate: "agent_thought_chunk", content: text("thinking"), messageId: "r1" }),
      update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", status: "completed" }),
      update("someone-else", { sessionUpdate: "agent_message_chunk", content: text("foreign") }),
      update(sid, { sessionUpdate: "agent_message_chunk", content: text("done"), messageId: "a1" }),
      update(sid, { sessionUpdate: "user_message_chunk", content: text("again") }),
      update(sid, { sessionUpdate: "agent_message_chunk", content: text("ok") }),
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { modes: null, configOptions: [] } }),
    ].join("\\n") + "\\n");
  } else if (message.method === "session/prompt") {
    pendingPrompts.push(message.id);
    const text = (message.params.prompt || []).map((block) => block.text || "").join("");
    send({ jsonrpc: "2.0", method: "_test/prompt", params: { text } });
    if (text === "STEER") {
      for (const earlier of pendingPrompts.splice(0, pendingPrompts.length - 1)) {
        send({ jsonrpc: "2.0", id: earlier, result: { stopReason: "cancelled" } });
      }
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "steered reply" } } } });
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }, 15);
    } else if (text === "ECHO") {
      pendingPrompts.pop();
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "from another client" }, messageId: "uprompt_1" } } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
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

interface ConnectOptions {
  /** Registration default; the fake agent script when omitted. */
  command?: readonly [string, ...string[]];
  /** Daemon-resolved launch; receives the fake agent script as its last arg. */
  launch?: (script: string) => ProviderLaunch;
  sessionEnv?: Record<string, string>;
  /** Resume this native session (session/load) instead of session/new. */
  persistence?: ProviderPersistence;
}

async function connectFakeAgent(options: ConnectOptions = {}): Promise<Harness> {
  const script = path.join(
    os.tmpdir(),
    `paseo-plugin-zcode-fake-acp-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`,
  );
  fs.writeFileSync(script, FAKE_AGENT);
  const vendorNotifications: Array<{ method: string; params: unknown }> = [];
  const registration = runAcpProvider({
    id: "fake",
    label: "Fake",
    command: options.command ?? [process.execPath, script],
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
    launch: options.launch?.(script),
    versions: [1],
    capabilities: [
      "prompt.message",
      "prompt.steer",
      "session.configure",
      "session.persistence",
      "permission",
    ],
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
    history: options.persistence ? "replay" : "skip",
    ...(options.persistence ? { persistence: options.persistence } : {}),
    config: {
      cwd: os.tmpdir(),
      env: options.sessionEnv ?? {},
      mcpServers: {},
      settings: {},
      persist: false,
    },
  });
  await harness.waitFor(
    (event) => event.type === "session.ready",
    "session.ready",
  );
  return harness;
}

/** Latest snapshot per timeline item id, in first-seen order. */
function timelineItems(events: readonly ProviderEvent[]): ProviderTimelineItem[] {
  const items = new Map<string, ProviderTimelineItem>();
  for (const event of events) {
    if (event.type === "timeline.item") items.set(event.item.id, event.item);
  }
  return [...items.values()];
}

function agentPids(harness: Harness): number[] {
  return harness.vendorNotifications
    .filter((entry) => entry.method === "_test/pid")
    .map((entry) => (entry.params as { pid: number }).pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const SAVED_SESSION = { version: 1, data: { sessionId: "native-saved" } } as const;
const HISTORY_ENV = { [RESUME_PURPOSE_ENV]: "history" };

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

test("the registration declares its command for daemon launch resolution", () => {
  const registration = runAcpProvider({ id: "fake", label: "Fake", command: ["zcode-acp-server"] });
  assert.deepEqual(registration.command, ["zcode-acp-server"]);
});

test("spawns the daemon-resolved launch with the session env overlaid", async () => {
  const harness = await connectFakeAgent({
    // Unspawnable on purpose: only the launch can start the agent.
    command: [path.join(os.tmpdir(), "paseo-plugin-zcode-missing-bridge")],
    launch: (script) => ({
      command: process.execPath,
      args: [script],
      env: { PATH: process.env.PATH ?? "", FAKE_LAUNCH_MARK: "launch", FAKE_SESSION_MARK: "launch" },
    }),
    sessionEnv: { FAKE_SESSION_MARK: "session" },
  });
  try {
    const env = harness.vendorNotifications.find((entry) => entry.method === "_test/env");
    assert.deepEqual(env?.params, { launch: "launch", session: "session" });
  } finally {
    await harness.close();
  }
});

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

test("native guide hands the steer to the running request", async () => {
  const harness = await connectFakeAgent({ sessionEnv: { FAKE_GUIDE: "1" } });
  try {
    await harness.send(textPrompt("m1", "HOLD"));
    const turnResult = await harness.waitFor(
      (event) => event.type === "session.prompt_result" && event.result.type === "turn",
      "first prompt turn result",
    );
    const turnId =
      turnResult.type === "session.prompt_result" && turnResult.result.type === "turn"
        ? turnResult.result.turnId
        : "";
    await harness.send(textPrompt("m2", "also do X", "steer"));
    const steerResult = await harness.waitFor(
      (event) => event.type === "session.prompt_result" && event.result.type === "steer",
      "steer result",
    );
    if (steerResult.type === "session.prompt_result" && steerResult.result.type === "steer") {
      assert.equal(steerResult.result.turnId, turnId);
    }
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
    assert.ok(
      harness.events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "guided reply",
      ),
      "guided reply reached the timeline",
    );
    const guides = harness.vendorNotifications.filter((entry) => entry.method === "_test/guide");
    assert.deepEqual(guides.map((entry) => entry.params), [
      { text: "also do X", sessionId: "native-1" },
    ]);
    // No second session/prompt: the guide rode on the running request.
    const prompts = harness.vendorNotifications.filter((entry) => entry.method === "_test/prompt");
    assert.deepEqual(prompts.map((entry) => entry.params), [{ text: "HOLD" }]);
  } finally {
    await harness.close();
  }
});

test("a declined guide falls back to the preempting steer", async () => {
  const harness = await connectFakeAgent({ sessionEnv: { FAKE_GUIDE: "1" } });
  try {
    await harness.send(textPrompt("m1", "HOLD"));
    await harness.waitFor(
      (event) => event.type === "session.turn" && event.state === "started",
      "turn started",
    );
    await harness.send(textPrompt("m2", "STEER", "steer"));
    await harness.waitFor(
      (event) => event.type === "session.turn" && event.state === "completed",
      "turn completed",
    );
    assert.ok(
      harness.events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "steered reply",
      ),
      "steered reply reached the timeline",
    );
    const prompts = harness.vendorNotifications.filter((entry) => entry.method === "_test/prompt");
    assert.deepEqual(prompts.map((entry) => entry.params), [{ text: "HOLD" }, { text: "STEER" }]);
  } finally {
    await harness.close();
  }
});

test("a bridge without native guide never receives _zcode/guide", async () => {
  const harness = await connectFakeAgent();
  try {
    await harness.send(textPrompt("m1", "HOLD"));
    await harness.waitFor(
      (event) => event.type === "session.turn" && event.state === "started",
      "turn started",
    );
    await harness.send(textPrompt("m2", "STEER", "steer"));
    await harness.waitFor(
      (event) => event.type === "session.turn" && event.state === "completed",
      "turn completed",
    );
    assert.equal(
      harness.vendorNotifications.filter((entry) => entry.method === "_test/guide").length,
      0,
    );
  } finally {
    await harness.close();
  }
});

test("a resumed session replays its history before session.ready", async () => {
  const harness = await connectFakeAgent({
    persistence: { version: 1, data: { sessionId: "native-saved" } },
  });
  try {
    const opened = harness.events.find((event) => event.type === "session.opened");
    assert.ok(opened?.type === "session.opened");
    assert.deepEqual(opened.persistence, { version: 1, data: { sessionId: "native-saved" } });
    // The whole replay arrived ahead of the load response; none of it may be
    // dropped, and the foreign-session update stays out.
    assert.deepEqual(
      timelineItems(harness.events).map((item) =>
        "text" in item ? `${item.type}: ${item.text}` : item.type,
      ),
      [
        "user_message: run the schedule",
        "reasoning: thinking",
        "tool_call",
        "assistant_message: done",
        "user_message: again",
        "assistant_message: ok",
      ],
    );
    const ready = harness.events.findIndex((event) => event.type === "session.ready");
    const lastItem = harness.events.findLastIndex((event) => event.type === "timeline.item");
    assert.ok(lastItem < ready, "replay is complete before the session is ready");
  } finally {
    await harness.close();
  }
});

test("a live user_message_chunk stays out of the timeline", async () => {
  const harness = await connectFakeAgent({
    persistence: { version: 1, data: { sessionId: "native-saved" } },
  });
  try {
    const replayed = harness.events.length;
    await harness.send(textPrompt("m1", "ECHO"));
    await harness.waitFor(
      (event) => event.type === "session.turn" && event.state === "completed",
      "turn completed",
    );
    const userMessages = timelineItems(harness.events.slice(replayed)).filter(
      (item) => item.type === "user_message",
    );
    assert.deepEqual(
      userMessages.map((item) => item.id),
      ["m1"],
      "only the adapter's own prompt item",
    );
  } finally {
    await harness.close();
  }
});

test("a history open releases the agent process once the replay is in", async () => {
  const harness = await connectFakeAgent({ persistence: SAVED_SESSION, sessionEnv: HISTORY_ENV });
  try {
    const [pid] = agentPids(harness);
    assert.ok(pid, "the agent reported its pid");
    await waitUntil(() => !isAlive(pid), "the history process to exit");
    assert.equal(timelineItems(harness.events).length, 6, "the replay still reached the timeline");
    assert.equal(
      harness.events.filter((event) => event.type === "session.runtime_failed").length,
      0,
      "the release is not reported as a failure",
    );
  } finally {
    await harness.close();
  }
});

test("a parked session re-attaches on its first prompt without replaying again", async () => {
  const harness = await connectFakeAgent({ persistence: SAVED_SESSION, sessionEnv: HISTORY_ENV });
  try {
    const [first] = agentPids(harness);
    await waitUntil(() => !isAlive(first), "the history process to exit");
    const replayed = harness.events.length;

    await harness.send(textPrompt("m1", "ECHO"));
    await harness.waitFor(
      (event) => event.type === "session.turn" && event.state === "completed",
      "turn completed",
    );
    const pids = agentPids(harness);
    assert.equal(pids.length, 2, "one fresh process loaded the session");
    assert.notEqual(pids[1], first);
    const prompts = harness.vendorNotifications.filter((entry) => entry.method === "_test/prompt");
    assert.deepEqual(prompts.map((entry) => entry.params), [{ text: "ECHO" }]);
    // The second load replays the conversation again; the daemon already has
    // it, so only the new turn reaches the timeline.
    assert.deepEqual(
      timelineItems(harness.events.slice(replayed)).map((item) => item.id),
      ["m1"],
    );
    assert.ok(isAlive(pids[1]), "the re-attached process stays for the live session");
  } finally {
    await harness.close();
  }
});

test("interrupting or closing a parked session spawns nothing", async () => {
  const harness = await connectFakeAgent({ persistence: SAVED_SESSION, sessionEnv: HISTORY_ENV });
  try {
    const [pid] = agentPids(harness);
    await waitUntil(() => !isAlive(pid), "the history process to exit");
    await harness.send({ type: "session.interrupt", requestId: "interrupt-1", sessionId: "session-1" });
    await harness.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "interrupt-1",
      "interrupt completed",
    );
    await harness.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await harness.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-1",
      "close completed",
    );
    assert.equal(agentPids(harness).length, 1, "no process was started");
  } finally {
    await harness.close();
  }
});

test("an interactive resume keeps its agent process", async () => {
  const harness = await connectFakeAgent({ persistence: SAVED_SESSION });
  try {
    const [pid] = agentPids(harness);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(isAlive(pid));
  } finally {
    await harness.close();
  }
});
