/**
 * Tests for the `zcode` usage source (server/usage.ts): login discovery from
 * a temporary ZCode home and the quota-snapshot → UsageReport mapping. No
 * test reaches the network.
 *
 * Runs on Node's built-in test runner with type stripping (Node >= 22.18):
 *   npm test
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ZcodeQuotaSnapshot } from "../shared/quota.ts";
import { NO_QUOTA_WINDOWS } from "./quota.ts";
import { createZcodeUsageSource, toUsageReport } from "./usage.ts";

function zcodeHome(providers: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-plugin-zcode-usage-"));
  fs.mkdirSync(path.join(home, "v2"));
  fs.writeFileSync(path.join(home, "v2", "config.json"), JSON.stringify({ provider: providers }));
  return home;
}

const PROVIDERS = {
  "builtin:zai": { enabled: false, options: { apiKey: "off-key" } },
  "builtin:bigmodel-coding-plan": {
    enabled: true,
    options: { baseURL: "https://open.bigmodel.cn/api/anthropic", apiKey: "secret-key" },
  },
  "builtin:zai-coding-plan": {
    enabled: true,
    options: { baseURL: "https://api.z.ai/api/anthropic", apiKey: "other-key" },
  },
};

function snapshot(patch: Partial<ZcodeQuotaSnapshot>): ZcodeQuotaSnapshot {
  return {
    status: "ok",
    level: "pro",
    fetchedAt: "2026-10-10T00:00:00.000Z",
    sourceHost: "https://open.bigmodel.cn",
    items: [],
    error: null,
    ...patch,
  };
}

test("session discovery reads the session's own ZCode home and pinned provider", async () => {
  const home = zcodeHome(PROVIDERS);
  try {
    const source = createZcodeUsageSource("zcode");
    const accounts = await source.discover({
      kind: "session",
      provider: "zcode",
      env: { ZCODE_HOME: home, ZCODE_PROVIDER: "builtin:zai-coding-plan" },
    });
    assert.equal(accounts.length, 1);
    const [account] = accounts;
    assert.deepEqual(account.input, {
      configPath: path.join(home, "v2", "config.json"),
      provider: "builtin:zai-coding-plan",
    });
    assert.equal(account.label, "ZCode · zai-coding-plan");
    assert.match(account.key, /^[A-Za-z0-9._-]{1,128}$/);
    assert.ok(!JSON.stringify(account).includes("other-key"), "no credential in the account");
    assert.ok(source.input.safeParse(account.input).success);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("without a pinned provider the first enabled one wins, with a stable key", async () => {
  const home = zcodeHome(PROVIDERS);
  try {
    const source = createZcodeUsageSource("zcode");
    const scope = { kind: "session" as const, provider: "zcode", env: { ZCODE_HOME: home } };
    const [first] = await source.discover(scope);
    const [second] = await source.discover(scope);
    assert.equal((first.input as { provider: string }).provider, "builtin:bigmodel-coding-plan");
    assert.equal(first.key, second.key);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session discovery ignores other providers and logins without an apiKey", async () => {
  const home = zcodeHome({ "builtin:zai": { enabled: true, options: {} } });
  try {
    const source = createZcodeUsageSource("zcode");
    assert.deepEqual(
      await source.discover({ kind: "session", provider: "claude", env: { ZCODE_HOME: home } }),
      [],
    );
    assert.deepEqual(
      await source.discover({ kind: "session", provider: "zcode", env: { ZCODE_HOME: home } }),
      [],
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fetch throws once the discovered login is gone", async () => {
  const home = zcodeHome(PROVIDERS);
  try {
    const source = createZcodeUsageSource("zcode");
    await assert.rejects(
      source.fetch({ configPath: path.join(home, "v2", "config.json"), provider: "builtin:zai" }),
      /no longer exists/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an ok snapshot maps to duration-named windows, ordered as reported", () => {
  const resetAt = Date.parse("2026-10-10T05:00:00.000Z");
  const report = toUsageReport({
    httpStatus: 200,
    snapshot: snapshot({
      items: [
        { key: "token_5h", label: "5h", usedPercent: 20, leftPercent: 80, nextResetTime: resetAt },
        { key: "token_week", label: "Weekly", usedPercent: 75, leftPercent: 25, nextResetTime: null },
        { key: "mcp", label: "MCP", usedPercent: 95, leftPercent: 5, nextResetTime: null },
      ],
    }),
  });
  assert.equal(report.status, "available");
  if (report.status !== "available") return;
  assert.equal(report.planLabel, "Pro");
  assert.deepEqual(
    report.windows.map(({ id, shortLabel, summary, usedPct, remainingPct, resetsAt, tone }) => ({
      id,
      shortLabel,
      summary,
      usedPct,
      remainingPct,
      resetsAt,
      tone,
    })),
    [
      {
        id: "five_hour",
        shortLabel: "5h",
        summary: true,
        usedPct: 20,
        remainingPct: 80,
        resetsAt: "2026-10-10T05:00:00.000Z",
        tone: "ok",
      },
      {
        id: "weekly",
        shortLabel: "wk",
        summary: true,
        usedPct: 75,
        remainingPct: 25,
        resetsAt: null,
        tone: "warning",
      },
      {
        id: "mcp",
        shortLabel: undefined,
        summary: undefined,
        usedPct: 95,
        remainingPct: 5,
        resetsAt: null,
        tone: "danger",
      },
    ],
  );
  assert.deepEqual(report.details, [
    { id: "endpoint", label: "Endpoint", value: "https://open.bigmodel.cn" },
  ]);
});

test("failure snapshots map to usage problems and errors", () => {
  assert.deepEqual(
    toUsageReport({ httpStatus: 403, snapshot: snapshot({ status: "auth_error" }) }),
    { status: "unavailable", problem: { kind: "rejected", status: 403 } },
  );
  // Envelope-level auth failures come back with HTTP 200.
  assert.deepEqual(
    toUsageReport({ httpStatus: 200, snapshot: snapshot({ status: "auth_error" }) }),
    { status: "unavailable", problem: { kind: "rejected", status: 401 } },
  );
  assert.deepEqual(
    toUsageReport({ httpStatus: 429, snapshot: snapshot({ status: "rate_limited" }) }),
    { status: "error", error: "GLM quota API is rate limited" },
  );
  assert.deepEqual(
    toUsageReport({
      httpStatus: 200,
      snapshot: snapshot({ status: "unavailable", error: NO_QUOTA_WINDOWS }),
    }),
    { status: "unavailable", problem: { kind: "no_quota", detail: "No GLM Coding Plan quota reported" } },
  );
  assert.deepEqual(
    toUsageReport({
      httpStatus: null,
      snapshot: snapshot({ status: "unavailable", error: "socket hang up" }),
    }),
    { status: "error", error: "socket hang up" },
  );
});
