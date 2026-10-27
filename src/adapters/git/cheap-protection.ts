/**
 * Cheap worktree protection gates that can exclude a target before expensive
 * process-ownership (lsof) proof. Keep fail-closed: callers must still prove
 * ownership before selecting a real cleanup candidate.
 */

export type CheapWorktreeProtectionInput = {
  isMain: boolean;
  platform: string;
  bare: boolean;
  locked: string | undefined;
  prunable: string | undefined;
  dirty: boolean;
  ageMinutes: number | undefined;
  minAgeMinutes: number;
};

export type CheapWorktreeProtection = {
  code: string;
  detail: string;
};

export function cheapWorktreeProtections(
  input: CheapWorktreeProtectionInput,
): CheapWorktreeProtection[] {
  const protections: CheapWorktreeProtection[] = [];
  if (input.isMain) {
    protections.push({
      code: "main-worktree",
      detail: "The main worktree is always protected.",
    });
  }
  if (!["darwin", "linux"].includes(input.platform)) {
    protections.push({
      code: "worktree-mutation-unsupported",
      detail: "Recoverable worktree quarantine is supported only on macOS and Linux.",
    });
  }
  if (input.bare || input.prunable !== undefined) {
    protections.push({
      code: "worktree-registration-unsafe",
      detail: "Bare or prunable worktree registrations are not quarantine candidates.",
    });
  }
  if (input.locked !== undefined) {
    protections.push({
      code: "git-lock",
      detail: "Git reports this worktree as locked.",
    });
  }
  if (input.dirty) {
    protections.push({
      code: "dirty-worktree",
      detail: "Git reports staged, modified, conflicted, untracked, or ignored work.",
    });
  }
  if (typeof input.ageMinutes === "number" && input.ageMinutes < input.minAgeMinutes) {
    protections.push({
      code: "recent-resource",
      detail: `Worktree is newer than ${input.minAgeMinutes} minutes.`,
    });
  }
  return protections;
}

export function shouldDeferProcessOwnership(input: CheapWorktreeProtectionInput): boolean {
  return cheapWorktreeProtections(input).length > 0;
}
