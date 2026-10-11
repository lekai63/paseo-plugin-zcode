/**
 * Account-screen tests: plan verdicts, the personal-provider view (template
 * resolution), reset-card counts and the spend guard.
 *
 * Runs on Node's built-in test runner with type stripping (Node >= 22.18):
 *   npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ResetNonces,
  idempotencyKeyFor,
  personalProvidersView,
  plansFromCache,
  resetCardProvidersFor,
  resetCardsView,
} from "./account.ts";

test("plansFromCache: Desktop's verdicts with labels; reset cards only for available Coding Plans", () => {
  const { plans, updatedAt } = plansFromCache({
    version: 1,
    entryStatus: {
      updatedAt: 1789708701057,
      items: {
        "builtin:zai-coding-plan": { status: "unavailable", reason: "coding_plan_not_authenticated" },
        "builtin:bigmodel-coding-plan": { status: "available" },
        "builtin:bigmodel-start-plan": { status: "available" },
      },
    },
  });
  assert.deepEqual(plans, [
    { id: "builtin:zai-coding-plan", label: "Z.ai Coding Plan", available: false, reason: "coding_plan_not_authenticated" },
    { id: "builtin:bigmodel-coding-plan", label: "BigModel Coding Plan", available: true, reason: null },
    { id: "builtin:bigmodel-start-plan", label: "BigModel Start Plan", available: true, reason: null },
  ]);
  assert.equal(updatedAt, new Date(1789708701057).toISOString());
  assert.deepEqual(resetCardProvidersFor(plans), [
    { providerId: "account:bigmodel-individual-coding-plan", label: "BigModel Coding Plan" },
  ]);
  assert.deepEqual(plansFromCache(null), { plans: [], updatedAt: null });
});

test("personalProvidersView: template endpoint and models, own additions, disabled models removed", () => {
  const templates = [
    {
      templateId: "bigmodel-api",
      name: "BigModel Coding Plan",
      nameZh: null,
      accessType: "zhipu-coding-plan-api-key",
      apiKeyManagementUrl: null,
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiType: "anthropic-messages",
      modelIds: ["GLM-5.3", "GLM-5.3-Flash"],
    },
  ];
  const view = personalProvidersView(
    [
      {
        providerId: "bigmodel-api",
        providerName: "My plan",
        templateId: "bigmodel-api",
        enabled: true,
        hasKey: true,
        baseUrl: null,
        apiType: null,
        personalModelIds: ["GLM-own"],
      },
      {
        providerId: "custom-1",
        providerName: null,
        templateId: null,
        enabled: false,
        hasKey: false,
        baseUrl: "http://localhost:9/v1",
        apiType: "openai-chat-completions",
        personalModelIds: [],
      },
    ],
    [
      { providerId: "bigmodel-api", modelId: "GLM-5.3-Flash", enabled: false },
      { providerId: "bigmodel-api", modelId: "GLM-rule", enabled: true },
    ],
    templates,
  );
  assert.deepEqual(view, [
    {
      providerId: "bigmodel-api",
      name: "My plan",
      templateId: "bigmodel-api",
      templateName: "BigModel Coding Plan",
      enabled: true,
      hasKey: true,
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiType: "anthropic-messages",
      models: ["GLM-5.3", "GLM-own", "GLM-rule"],
    },
    {
      providerId: "custom-1",
      name: "custom-1",
      templateId: null,
      templateName: null,
      enabled: false,
      hasKey: false,
      baseUrl: "http://localhost:9/v1",
      apiType: "openai-chat-completions",
      models: [],
    },
  ]);
});

test("resetCardsView: counts, the soonest future expiry, last use", () => {
  const now = new Date("2026-10-10T17:00:00.000Z");
  const past = now.getTime() - 1_000;
  const soon = now.getTime() + 60_000;
  const later = now.getTime() + 600_000;
  const view = resetCardsView(
    "account:bigmodel-individual-coding-plan",
    {
      availableFiveHour: [{ expireAt: later }, { expireAt: soon }, { expireAt: past }],
      availableWeek: [],
      latestFiveHour: null,
      latestWeek: { usedAt: 1789802902000 },
      nonce: "n-1",
    },
    [{ key: "token_5h", label: "5h", usedPercent: 37, resetAt: later }],
    now,
  );
  assert.deepEqual(view.fiveHour, { available: 3, nextExpireAt: soon, lastUsedAt: null });
  assert.deepEqual(view.week, { available: 0, nextExpireAt: null, lastUsedAt: 1789802902000 });
  assert.equal(view.nonce, "n-1");
  assert.equal(view.windows.length, 1);
});

test("ResetNonces: a spend needs the latest nonce, one at a time; the nonce burns only after it lands", () => {
  const nonces = new ResetNonces();
  const plan = "account:bigmodel-individual-coding-plan";
  assert.throws(() => nonces.begin(plan, "n-1"), /out of date/);
  nonces.issue(plan, "n-1");
  nonces.issue(plan, "n-2");
  assert.throws(() => nonces.begin(plan, "n-1"), /out of date/);
  nonces.begin(plan, "n-2");
  assert.throws(() => nonces.begin(plan, "n-2"), /already in progress/);
  // A failed call keeps the nonce: retrying the same tap is allowed.
  nonces.settle(plan, "n-2", false);
  nonces.begin(plan, "n-2");
  nonces.settle(plan, "n-2", true);
  assert.throws(() => nonces.begin(plan, "n-2"), /out of date/);
});

test("idempotencyKeyFor: one key per nonce and reset type, within 64 characters", () => {
  const nonce = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(idempotencyKeyFor(nonce, "FIVE_HOUR"), `${nonce}:FIVE_HOUR`);
  assert.notEqual(idempotencyKeyFor(nonce, "FIVE_HOUR"), idempotencyKeyFor(nonce, "WEEK"));
  assert.ok(idempotencyKeyFor("x".repeat(80), "WEEK").length <= 64);
});
