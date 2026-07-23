import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { CleanupPlan } from "../../src/contracts/plan.js";
import { sha256Json } from "../../src/core/digest.js";
import { PlanVerificationError, verifyCleanupPlan } from "../../src/core/plan-verification.js";
import { cleanupPlanId } from "../../src/core/plan.js";

function fixturePlan(): CleanupPlan {
  const content: Omit<CleanupPlan, "planId"> = {
    schemaVersion: 1,
    auditId: "audit-1",
    home: "/tmp/fixture",
    createdAt: "2026-07-23T00:00:00.000Z",
    expiresAt: "2026-07-23T00:30:00.000Z",
    policyVersion: 1,
    riskCeiling: "safe",
    configDigest: sha256Json(DEFAULT_CONFIG),
    auditDigest: "audit",
    actions: [],
    expectedReclaimBytes: 0,
  };
  return { ...content, planId: cleanupPlanId(content) };
}

describe("verifyCleanupPlan", () => {
  it("accepts an intact unexpired plan for the current config", () => {
    const plan = fixturePlan();

    expect(verifyCleanupPlan(plan, DEFAULT_CONFIG, new Date("2026-07-23T00:15:00.000Z"))).toEqual(
      plan,
    );
  });

  it("rejects modified plan content", () => {
    const plan = { ...fixturePlan(), auditDigest: "modified" };

    expect(() =>
      verifyCleanupPlan(plan, DEFAULT_CONFIG, new Date("2026-07-23T00:15:00.000Z")),
    ).toThrowError(
      expect.objectContaining<Partial<PlanVerificationError>>({
        code: "PLAN_TAMPERED",
      }),
    );
  });

  it("rejects plans after their authorization window", () => {
    expect(() =>
      verifyCleanupPlan(fixturePlan(), DEFAULT_CONFIG, new Date("2026-07-23T00:30:00.000Z")),
    ).toThrowError(
      expect.objectContaining<Partial<PlanVerificationError>>({
        code: "PLAN_EXPIRED",
      }),
    );
  });

  it("rejects plans whose authorization window starts in the future", () => {
    expect(() =>
      verifyCleanupPlan(fixturePlan(), DEFAULT_CONFIG, new Date("2026-07-22T23:59:59.000Z")),
    ).toThrowError(
      expect.objectContaining<Partial<PlanVerificationError>>({
        code: "PLAN_TIME_INVALID",
      }),
    );
  });

  it("rejects authorization windows longer than the configured TTL", () => {
    const plan = fixturePlan();
    const content: Omit<CleanupPlan, "planId"> = {
      ...plan,
      expiresAt: "2026-07-23T00:30:00.001Z",
    };
    delete (content as Partial<CleanupPlan>).planId;
    const extended = { ...content, planId: cleanupPlanId(content) };

    expect(() =>
      verifyCleanupPlan(extended, DEFAULT_CONFIG, new Date("2026-07-23T00:15:00.000Z")),
    ).toThrowError(
      expect.objectContaining<Partial<PlanVerificationError>>({
        code: "PLAN_TIME_INVALID",
      }),
    );
  });

  it("rejects plans created from a different configuration", () => {
    expect(() =>
      verifyCleanupPlan(
        fixturePlan(),
        { ...DEFAULT_CONFIG, audit: { ...DEFAULT_CONFIG.audit, maxEntries: 1 } },
        new Date("2026-07-23T00:15:00.000Z"),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<PlanVerificationError>>({
        code: "PLAN_CONFIG_CHANGED",
      }),
    );
  });
});
