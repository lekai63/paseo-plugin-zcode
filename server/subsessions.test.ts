/**
 * Subsession wrapper + hub tests: `_zcode/subagent` snapshots → the child
 * session.opened / timeline.item / session.turn / session.closed protocol the
 * daemon translates into native sub-agent tabs.
 *
 * Runs on Node's built-in test runner with type stripping (Node >= 22.18):
 *   npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ProviderConnection,
  ProviderEvent,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

import {
  SUBSESSION_CAPABILITY,
  SubagentSubsessionHub,
  mapSubagentTabStatus,
  wrapWithSubsessions,
} from "./subsessions.ts";

const RUNNING = {
  agentId: "agent_a1",
  agentType: "general-purpose",
  title: "probe the workspace",
  status: "running",
  log: ["[Bash] pwd", "[Bash] ls"],
  revision: 1,
};

/** A hub with one tracked parent session; events land in `events`. */
function hubWithParent(cwd = "/repo"): { hub: SubagentSubsessionHub; events: ProviderEvent[] } {
  const hub = new SubagentSubsessionHub();
  const events: ProviderEvent[] = [];
  hub.noteParentOpened((event) => events.push(event), "boundary_1", cwd);
  return { hub, events };
}

function toolCallOf(event: ProviderEvent | undefined) {
  if (!event || event.type !== "timeline.item" || event.item.type !== "tool_call") return null;
  return event.item;
}

test("maps every zcode status onto the tab status union", () => {
  assert.equal(mapSubagentTabStatus("running"), "running");
  assert.equal(mapSubagentTabStatus("waiting"), "running");
  assert.equal(mapSubagentTabStatus("completed"), "completed");
  assert.equal(mapSubagentTabStatus("success"), "completed");
  assert.equal(mapSubagentTabStatus("failed"), "failed");
  assert.equal(mapSubagentTabStatus("timed_out"), "failed");
  assert.equal(mapSubagentTabStatus("canceled"), "canceled");
  assert.equal(mapSubagentTabStatus("cancelled"), "canceled");
  assert.equal(mapSubagentTabStatus(undefined), "running");
});

test("a first snapshot opens the child session and starts the activity row", () => {
  const { hub, events } = hubWithParent();
  hub.handleSnapshot("boundary_1", RUNNING);

  assert.equal(events.length, 2);
  const [opened, item] = events;
  assert.ok(opened.type === "session.opened");
  if (opened.type === "session.opened") {
    assert.equal(opened.sessionId, "zcsub-agent_a1");
    assert.equal(opened.parentSessionId, "boundary_1");
    assert.deepEqual(opened.capabilities, [SUBSESSION_CAPABILITY]);
    assert.equal(opened.restoration, "parent");
    assert.equal(opened.cwd, "/repo");
    assert.equal(opened.title, "Agent (general-purpose)");
    assert.equal(opened.description, "probe the workspace");
  }

  const call = toolCallOf(item);
  assert.ok(call);
  assert.equal(call.id, "zcsub-activity-agent_a1");
  assert.equal(call.status, "running");
  assert.deepEqual(call.detail, {
    type: "plain_text",
    label: "Sub-agent activity",
    text: "[Bash] pwd\n[Bash] ls",
  });
});

test("follow-up snapshots update the activity row in place, not append", () => {
  const { hub, events } = hubWithParent();
  hub.handleSnapshot("boundary_1", RUNNING);
  hub.handleSnapshot("boundary_1", {
    ...RUNNING,
    log: ["[Bash] pwd", "[Bash] ls", "[Bash] git status"],
    revision: 2,
  });

  assert.equal(events.length, 3); // opened + two updates of the SAME row
  const call = toolCallOf(events[2]);
  assert.ok(call && call.detail.type === "plain_text");
  if (call.detail.type === "plain_text") assert.match(call.detail.text ?? "", /git status/);
});

test("a completed snapshot flips the status and ends the child session", () => {
  const { hub, events } = hubWithParent();
  hub.handleSnapshot("boundary_1", RUNNING);
  hub.handleSnapshot("boundary_1", {
    ...RUNNING,
    status: "completed",
    summary: "the workspace looks fine",
    toolUses: 3,
    tokens: 1234,
    durationMs: 5000,
    revision: 2,
  });

  // events: opened, activity(running), activity(completed), turn, result, closed
  const [opened, , , turn, result, closed] = events;
  assert.ok(opened.type === "session.opened");

  assert.ok(result.type === "timeline.item" && result.item.type === "assistant_message");
  if (result.type === "timeline.item" && result.item.type === "assistant_message") {
    assert.equal(result.item.text, "the workspace looks fine");
  }

  assert.ok(turn.type === "session.turn");
  if (turn.type === "session.turn") {
    assert.equal(turn.sessionId, "zcsub-agent_a1");
    assert.equal(turn.state, "completed");
  }

  assert.ok(closed.type === "session.closed");
  if (closed.type === "session.closed") {
    assert.equal(closed.sessionId, "zcsub-agent_a1");
    assert.equal(closed.error, undefined);
  }

  const call = toolCallOf(events[1]);
  assert.ok(call);
});

test("a failed snapshot carries the error through turn and close", () => {
  const { hub, events } = hubWithParent();
  hub.handleSnapshot("boundary_1", { ...RUNNING, revision: 2 });
  hub.handleSnapshot("boundary_1", {
    ...RUNNING,
    status: "failed",
    errorMessage: "spawn_error",
    revision: 3,
  });

  const turn = events.at(-2);
  const closed = events.at(-1);
  assert.ok(turn && turn.type === "session.turn" && turn.state === "failed");
  assert.ok(closed && closed.type === "session.closed" && closed.error?.message === "spawn_error");
});

test("a canceled snapshot flips the status but leaves the session for teardown", () => {
  const { hub, events } = hubWithParent();
  hub.handleSnapshot("boundary_1", { ...RUNNING, revision: 2 });
  hub.handleSnapshot("boundary_1", { ...RUNNING, status: "canceled", revision: 3 });

  const last = events.at(-1);
  assert.ok(last && last.type === "session.turn" && last.state === "canceled");
});

test("stale revisions and unknown identities are ignored", () => {
  const { hub, events } = hubWithParent();
  hub.handleSnapshot("boundary_1", { ...RUNNING, revision: 5 });
  hub.handleSnapshot("boundary_1", { ...RUNNING, revision: 4 }); // stale
  hub.handleSnapshot("boundary_1", { agentId: "agent_a1", status: "running" }); // no revision
  hub.handleSnapshot("other_boundary", RUNNING); // unknown parent
  hub.handleSnapshot("boundary_1", { status: "running", revision: 6 }); // no agentId

  assert.equal(events.length, 2); // opened + one activity row
});

test("closing the parent cancels still-running children", () => {
  const { hub, events } = hubWithParent();
  hub.handleSnapshot("boundary_1", { ...RUNNING, revision: 2 });
  hub.noteParentClosed("boundary_1");

  const turn = events.at(-1);
  assert.ok(turn && turn.type === "session.turn" && turn.state === "canceled");
  assert.equal(hub.parentCount, 0);
  // A late snapshot for the dropped parent is a no-op.
  hub.handleSnapshot("boundary_1", { ...RUNNING, status: "completed", revision: 9 });
  assert.equal(events.length, 3);
});

// ---------- the registration wrapper ----------

interface FakeBaseConnection extends ProviderConnection {
  emitFromBase(event: ProviderEvent): void;
}

/** Minimal ProviderRegistration double whose connection records subscriptions. */
function fakeRegistration(): { registration: ProviderRegistration; base: FakeBaseConnection } {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const base: FakeBaseConnection = {
    version: 1,
    capabilities: ["prompt.message"],
    send: async () => undefined,
    close: async () => undefined,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitFromBase(event) {
      for (const listener of listeners) listener(event);
    },
  };
  const registration: ProviderRegistration = {
    id: "zcode",
    label: "ZCode",
    connect: async () => base,
  };
  return { registration, base };
}

function parentOpened(cwd = "/repo"): ProviderEvent {
  return {
    type: "session.opened",
    sessionId: "boundary_1",
    capabilities: ["prompt.message"],
    restoration: "core",
    cwd,
  };
}

async function wrappedConnection(offered: string[]) {
  const hub = new SubagentSubsessionHub();
  const { registration, base } = fakeRegistration();
  const wrapped = wrapWithSubsessions(registration, hub).connect;
  const connection = await wrapped({ versions: [1], capabilities: offered });
  const seen: ProviderEvent[] = [];
  connection.onEvent((event) => seen.push(event));
  return { hub, base, connection, seen };
}

test("the wrapper passes through untouched when the host does not offer subsessions", async () => {
  const { connection } = await wrappedConnection(["prompt.message"]);
  assert.deepEqual([...connection.capabilities], ["prompt.message"]);
});

test("the wrapper selects the capability for the connection and the parent session", async () => {
  const { hub, base, connection, seen } = await wrappedConnection([
    "prompt.message",
    SUBSESSION_CAPABILITY,
  ]);
  assert.deepEqual([...connection.capabilities], ["prompt.message", SUBSESSION_CAPABILITY]);

  base.emitFromBase(parentOpened());
  const opened = seen[0];
  assert.ok(opened.type === "session.opened");
  assert.deepEqual([...opened.capabilities], ["prompt.message", SUBSESSION_CAPABILITY]);
  assert.equal(hub.parentCount, 1);
});

test("snapshots flow from a tracked parent through the wrapped connection", async () => {
  const { hub, base, seen } = await wrappedConnection([
    "prompt.message",
    SUBSESSION_CAPABILITY,
  ]);
  base.emitFromBase(parentOpened());

  // What the transformer does on a _zcode/subagent notification.
  hub.handleSnapshot("boundary_1", {
    agentId: "agent_a1",
    status: "completed",
    title: "done deal",
    revision: 1,
  });

  const opened = seen.find(
    (event) => event.type === "session.opened" && event.sessionId === "zcsub-agent_a1",
  );
  assert.ok(opened && opened.type === "session.opened");
  if (opened.type === "session.opened") {
    assert.equal(opened.parentSessionId, "boundary_1");
    assert.equal(opened.cwd, "/repo");
    assert.equal(opened.description, "done deal");
  }
  assert.ok(seen.some((event) => event.type === "session.turn"));
  assert.ok(seen.some((event) => event.type === "session.closed"));
});
