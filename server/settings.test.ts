/**
 * Settings-screen data tests: the pure parsers behind the Runtime and
 * Diagnostics screens (lockfile commit, ZCode CLI plugin state, agent-log
 * scans, process-tree aggregation, credential presence).
 *
 * Runs on Node's built-in test runner with type stripping (Node >= 22.18):
 *   npm test
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  DESKTOP_ONLY_PLUGINS,
  commitFromLock,
  credentialsFrom,
  desktopOnlyPluginsEnabled,
  latestSigningGate,
  recentErrors,
  summarizeSessions,
  zcodeHome,
  type ProcInfo,
} from "./settings.ts";

test("commitFromLock: short sha from the bridge's resolved git URL", () => {
  const lock = {
    packages: {
      "node_modules/zcode-acp-server": {
        resolved: "git+https://github.com/lekai63/zcode-acp.git#39a8018e8202c35c49c5c2e346ba58e1d056254a",
      },
    },
  };
  assert.equal(commitFromLock(lock), "39a8018");
  assert.equal(commitFromLock({ packages: {} }), null);
  assert.equal(commitFromLock(null), null);
  assert.equal(
    commitFromLock({ packages: { "node_modules/zcode-acp-server": { resolved: "https://registry/x.tgz" } } }),
    null,
  );
});

test("desktopOnlyPluginsEnabled: ZCode's default (absent) counts as enabled", () => {
  assert.equal(desktopOnlyPluginsEnabled(null), true);
  assert.equal(desktopOnlyPluginsEnabled({ provider: {} }), true);
  const off = Object.fromEntries(DESKTOP_ONLY_PLUGINS.map((key) => [key, false]));
  assert.equal(desktopOnlyPluginsEnabled({ plugins: { enabledPlugins: off } }), false);
  // One still on keeps the node_repl helper running.
  assert.equal(
    desktopOnlyPluginsEnabled({
      plugins: { enabledPlugins: { [DESKTOP_ONLY_PLUGINS[0]]: false } },
    }),
    true,
  );
});

function logLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

test("latestSigningGate: newest feature-gate verdict wins", () => {
  const lines = [
    logLine({
      timestamp: "2026-10-10T16:00:00.000Z",
      event: "model.client_signing.feature_gate",
      context: { enabled: false, httpStatus: 503, failure: "http_status" },
    }),
    logLine({ timestamp: "2026-10-10T16:01:00.000Z", event: "tool.call.started" }),
    logLine({
      timestamp: "2026-10-10T16:02:00.000Z",
      event: "model.client_signing.feature_gate",
      context: { enabled: true, httpStatus: 200 },
    }),
  ];
  assert.deepEqual(latestSigningGate(lines), {
    state: "enabled",
    at: "2026-10-10T16:02:00.000Z",
    detail: "HTTP 200",
  });
  assert.deepEqual(latestSigningGate(lines.slice(0, 2)), {
    state: "disabled",
    at: "2026-10-10T16:00:00.000Z",
    detail: "HTTP 503, http_status",
  });
  assert.equal(latestSigningGate([]).state, "unknown");
});

test("recentErrors: only error-level entries inside the window, newest first", () => {
  const now = new Date("2026-10-10T17:00:00.000Z");
  const lines = [
    logLine({ timestamp: "2026-10-10T15:30:00.000Z", level: "error", event: "old", message: "too old" }),
    logLine({ timestamp: "2026-10-10T16:30:00.000Z", level: "error", event: "turn.failed", message: "a" }),
    logLine({ timestamp: "2026-10-10T16:40:00.000Z", level: "info", event: "turn.completed" }),
    logLine({ timestamp: "2026-10-10T16:50:00.000Z", level: "error", event: "tool.call.failed", message: "b" }),
    "not json",
  ];
  const result = recentErrors(lines, now, 60);
  assert.equal(result.count, 2);
  assert.deepEqual(
    result.latest.map((entry) => entry.event),
    ["tool.call.failed", "turn.failed"],
  );
});

function proc(pid: number, ppid: number, comm: string, cmdline: string[], rssMb: number): ProcInfo {
  return { pid, ppid, comm, cmdline, rssKb: rssMb * 1024, startTicks: 100_000 };
}

test("summarizeSessions: one entry per bridge with its whole process tree", () => {
  const cli = "/home/u/.paseo/plugins/paseo-plugin-zcode/x/checkout/node_modules/zcode-acp-server/dist/cli.js";
  const procs = [
    proc(10, 1, "node", ["node", "paseo", "daemon"], 300),
    // session A: bridge + agent + node_repl helper + watchdog
    proc(20, 10, "MainThread", ["node", cli], 100),
    proc(21, 20, "zcode-cli", ["zcode-cli"], 330),
    proc(22, 21, "zcode-node-repl", ["zcode-node-repl-mcp"], 230),
    proc(23, 20, "MainThread", ["node", "-e", "watchdog"], 45),
    // session B: bridge re-exec'd into Bun — the nested match must not double count
    proc(30, 10, "MainThread", ["node", cli], 50),
    proc(31, 30, "bun", ["bun", "--smol", cli], 40),
    proc(32, 31, "zcode-cli", ["zcode-cli"], 300),
    // another daemon's bridge (different checkout) is ignored
    proc(40, 1, "MainThread", ["node", "/other/checkout/node_modules/zcode-acp-server/dist/cli.js"], 100),
  ];
  const result = summarizeSessions(procs, cli, 2_000, 100);
  assert.equal(result.supported, true);
  assert.deepEqual(
    result.items.map(({ pid, rssMb, nodeRepl }) => ({ pid, rssMb, nodeRepl })),
    [
      { pid: 20, rssMb: 705, nodeRepl: true },
      { pid: 30, rssMb: 390, nodeRepl: false },
    ],
  );
  assert.equal(result.totalMb, 1095);
  assert.equal(result.items[0]!.ageSeconds, 1_000);
  assert.equal(summarizeSessions(procs, cli, null).items[0]!.ageSeconds, null);
});

test("credentialsFrom: reports key presence, never the key", () => {
  const config = {
    provider: {
      "builtin:bigmodel-coding-plan": { enabled: true, options: { apiKey: "secret-value" } },
      "builtin:zai": { enabled: false },
      "builtin:bigmodel": {},
    },
  };
  const result = credentialsFrom(config, "builtin:bigmodel-coding-plan");
  assert.deepEqual(result, {
    pinnedProvider: "builtin:bigmodel-coding-plan",
    providers: [{ id: "builtin:bigmodel-coding-plan", enabled: true, hasKey: true }],
  });
  assert.ok(!JSON.stringify(result).includes("secret-value"));
  assert.deepEqual(credentialsFrom(null, null), { pinnedProvider: null, providers: [] });
});

test("zcodeHome: ZCODE_HOME replaces ~/.zcode", () => {
  assert.equal(zcodeHome({ ZCODE_HOME: "/data/zc" }), "/data/zc");
  assert.equal(zcodeHome({ HOME: "/home/u" }), path.join("/home/u", ".zcode"));
});
