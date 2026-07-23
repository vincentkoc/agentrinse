import type { AgentRinseConfig } from "../config/schema.js";
import { cleanupPlanSchema, type CleanupPlan } from "../contracts/plan.js";
import { sha256Json } from "./digest.js";
import { cleanupPlanId } from "./plan.js";

export type PlanVerificationCode =
  | "PLAN_INVALID"
  | "PLAN_TAMPERED"
  | "PLAN_CONFIG_CHANGED"
  | "PLAN_EXPIRED"
  | "PLAN_TIME_INVALID";

export class PlanVerificationError extends Error {
  override readonly name = "PlanVerificationError";

  constructor(
    readonly code: PlanVerificationCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function verifyCleanupPlan(
  input: unknown,
  config: AgentRinseConfig,
  now = new Date(),
): CleanupPlan {
  const parsed = cleanupPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new PlanVerificationError(
      "PLAN_INVALID",
      "cleanup plan does not match the supported schema",
      { cause: parsed.error },
    );
  }

  const plan = parsed.data;
  const { planId, ...content } = plan;
  if (cleanupPlanId(content) !== planId) {
    throw new PlanVerificationError(
      "PLAN_TAMPERED",
      "cleanup plan content does not match its planId",
    );
  }

  if (sha256Json(config) !== plan.configDigest) {
    throw new PlanVerificationError(
      "PLAN_CONFIG_CHANGED",
      "configuration changed after this cleanup plan was created",
    );
  }

  const createdAt = Date.parse(plan.createdAt);
  const expiresAt = Date.parse(plan.expiresAt);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    createdAt > expiresAt ||
    createdAt > now.getTime()
  ) {
    throw new PlanVerificationError(
      "PLAN_TIME_INVALID",
      "cleanup plan has an invalid authorization window",
    );
  }

  if (now.getTime() >= expiresAt) {
    throw new PlanVerificationError("PLAN_EXPIRED", `cleanup plan expired at ${plan.expiresAt}`);
  }

  return plan;
}
