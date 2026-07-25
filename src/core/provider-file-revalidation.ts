import type { ProviderFileQuarantineAction } from "../contracts/action.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import { inspectProviderFile, providerFileIdentityMatches } from "./provider-file-identity.js";
import { inspectProviderProcesses, type ProviderProcessResult } from "./provider-processes.js";
import {
  findProcessesUsingFile,
  type ProcessOwnershipResult,
} from "./process-ownership.js";

export type ProviderFileRevalidationResult =
  | { status: "ready" }
  | { status: "stale"; diagnostic: Diagnostic };

export type ProviderFileRevalidationDependencies = {
  inspectProcesses?: (provider: ProviderFileQuarantineAction["adapter"]) => Promise<ProviderProcessResult>;
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
  dependencies: ProviderFileRevalidationDependencies = {},
): Promise<ProviderFileRevalidationResult> {
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
  if (handles.status !== "idle") {
    return stale(
      action,
      handles.status === "busy"
        ? "PROVIDER_FILE_DESCRIPTOR_ACTIVE"
        : "PROVIDER_FILE_DESCRIPTOR_STATE_UNKNOWN",
      handles.status === "busy"
        ? "a process has the provider file open"
        : `provider file descriptor state is unknown: ${handles.reason}`,
    );
  }
  return { status: "ready" };
}
