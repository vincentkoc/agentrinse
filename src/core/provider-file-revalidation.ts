import type { ProviderFileQuarantineAction } from "../contracts/action.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import type { AgentRinseConfig } from "../config/schema.js";
import { inspectProviderFile, providerFileIdentityMatches } from "./provider-file-identity.js";
import { authorizeProviderFileAction } from "./provider-file-policy.js";
import { inspectProviderProcesses, type ProviderProcessResult } from "./provider-processes.js";
import { findProcessesUsingFile, type ProcessOwnershipResult } from "./process-ownership.js";

export type ProviderFileRevalidationResult =
  | { status: "ready" }
  | { status: "stale"; diagnostic: Diagnostic };

export type ProviderFileRevalidationDependencies = {
  clock?: () => Date;
  authorizeTarget?: (action: ProviderFileQuarantineAction) => Promise<void>;
  allowedHandlePids?: ReadonlySet<number>;
  inspectProcesses?: (
    provider: ProviderFileQuarantineAction["adapter"],
  ) => Promise<ProviderProcessResult>;
  inspectOpenHandles?: (path: string) => Promise<ProcessOwnershipResult>;
};

function stale(
  action: ProviderFileQuarantineAction,
  code: string,
  message: string,
): ProviderFileRevalidationResult {
  return {
    status: "stale",
    diagnostic: {
      severity: "warning",
      code,
      message,
      adapter: action.adapter,
      resourceId: action.resourceId,
    },
  };
}

export async function revalidateProviderFileQuarantine(
  action: ProviderFileQuarantineAction,
  home?: string,
  config?: AgentRinseConfig,
  dependencies: ProviderFileRevalidationDependencies = {},
): Promise<ProviderFileRevalidationResult> {
  try {
    const authorizeTarget =
      dependencies.authorizeTarget ??
      (home !== undefined && config !== undefined
        ? (selectedAction: ProviderFileQuarantineAction) =>
            authorizeProviderFileAction(
              selectedAction,
              home,
              config,
              process.platform,
              process.env,
              (dependencies.clock ?? (() => new Date()))(),
            )
        : undefined);
    if (authorizeTarget === undefined) {
      throw new Error("provider-file execution requires an approved provider policy");
    }
    await authorizeTarget(action);
  } catch (error) {
    return stale(
      action,
      "PROVIDER_FILE_POLICY_REFUSED",
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    const actual = await inspectProviderFile(
      action.target.path,
      action.target.ownerRoot,
      action.target.provider,
    );
    if (!providerFileIdentityMatches(actual, action.target)) {
      return stale(action, "PROVIDER_FILE_IDENTITY_CHANGED", "provider file identity changed");
    }
  } catch (error) {
    return stale(
      action,
      "PROVIDER_FILE_IDENTITY_CHANGED",
      error instanceof Error ? error.message : String(error),
    );
  }

  const processes = await (dependencies.inspectProcesses ?? inspectProviderProcesses)(
    action.adapter,
  );
  if (processes.status !== "idle") {
    return stale(
      action,
      processes.status === "busy" ? "PROVIDER_ACTIVE" : "PROVIDER_STATE_UNKNOWN",
      processes.status === "busy"
        ? `${action.adapter} is running`
        : `${action.adapter} process state is unknown: ${processes.reason}`,
    );
  }

  const handles = await (dependencies.inspectOpenHandles ?? findProcessesUsingFile)(
    action.target.path,
  );
  const externalMatches =
    handles.status === "busy"
      ? handles.matches.filter((match) => !dependencies.allowedHandlePids?.has(match.pid))
      : [];
  if (handles.status === "unknown" || externalMatches.length > 0) {
    const message =
      handles.status === "unknown"
        ? `provider file descriptor state is unknown: ${handles.reason}`
        : "a process has the provider file open";
    return stale(
      action,
      externalMatches.length > 0
        ? "PROVIDER_FILE_DESCRIPTOR_ACTIVE"
        : "PROVIDER_FILE_DESCRIPTOR_STATE_UNKNOWN",
      message,
    );
  }
  return { status: "ready" };
}
