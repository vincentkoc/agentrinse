import { parsePrGcPreview, prGcMaxLines, type PreviewRow } from "./pr-gc-preview.js";

const applyOwnerPrefix = "agentrinse-openclaw-pr-apply-v1 ";
const exitLine = /^agentrinse-openclaw-pr-apply-exit (0|[1-9][0-9]{0,2})$/u;
const branchPattern = /^(temp\/pr-([1-9][0-9]*)|pr-([1-9][0-9]*)(-prep)?)$/u;

type BranchEvent = {
  branch: string;
  result: "reported-deleted" | "refused-unmerged" | "refused-checked-out" | "deletion-unconfirmed";
};

function branchId(name: string) {
  const match = branchPattern.exec(name);
  return match?.[2] ?? match?.[3];
}

function applyOutput(value: string, owner: string) {
  const lines = value.split("\n");
  let invalidLines = lines.pop() === "" ? 0 : 1;
  if (lines.length > prGcMaxLines) throw new Error("OpenClaw PR GC apply log exceeds 20000 lines");
  const framed = lines[0]?.startsWith(applyOwnerPrefix);
  let exitCode: number | null = null;
  if (framed) {
    if (lines.shift() !== applyOwnerPrefix + owner) invalidLines++;
    const exit = exitLine.exec(lines.at(-1) ?? "");
    if (exit && Number(exit[1]) <= 255) {
      exitCode = Number(exit[1]);
      lines.pop();
    } else invalidLines++;
  }

  const rowLines: string[] = [];
  const branches = new Map<string, BranchEvent[]>();
  // The native apply and preview share row/diagnostic grammar. Translate only
  // the two apply-specific row spellings before passing them to that parser.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 4096) {
      invalidLines++;
      continue;
    }
    if (line.startsWith("removed .worktrees/")) {
      rowLines.push("would remove " + line.slice("removed ".length));
      continue;
    }
    if (line === "No merged/closed PR worktrees removed.") {
      rowLines.push("No merged/closed PR worktrees eligible for removal.");
      continue;
    }
    if (
      line.startsWith("skipping ") ||
      line.startsWith("Preserving ") ||
      line.startsWith("After verifying ") ||
      line.startsWith("  scripts/pr lock-recover ")
    ) {
      rowLines.push(line);
      continue;
    }
    const deleted = /^Deleted branch (\S+) \(was [a-f0-9]{4,64}\)\.$/u.exec(line);
    const refused = /^error: the branch '(\S+)' is not fully merged$/u.exec(line);
    const occupied =
      /^Skipping local branch delete for (\S+); checked out in worktree [^\p{Cc}]+$/u.exec(line);
    const warning = /^warning: deleting branch '(\S+)' that has been merged to$/u.exec(line);
    const branch = (deleted ?? refused ?? occupied ?? warning)?.[1];
    const pr = branch && branchId(branch);
    if (!branch || !pr) {
      invalidLines++;
      continue;
    }
    const events = branches.get(pr) ?? [];
    if (warning) {
      if (
        lines[i + 1] !==
        "         'refs/openclaw/pr-merge-outcomes/" + pr + "', but not yet merged to HEAD"
      )
        invalidLines++;
      else i++;
      if (lines[i + 1]?.startsWith("Deleted branch " + branch + " (was ")) continue;
    }
    if (
      refused &&
      lines[i + 1] ===
        "hint: If you are sure you want to delete it, run 'git branch -D " + branch + "'"
    ) {
      i++;
      if (
        lines[i + 1] ===
        'hint: Disable this message with "git config set advice.forceDeleteBranch false"'
      )
        i++;
    }
    if (events.some((event) => event.branch === branch)) invalidLines++;
    events.push({
      branch,
      result: deleted
        ? "reported-deleted"
        : refused
          ? "refused-unmerged"
          : occupied
            ? "refused-checked-out"
            : "deletion-unconfirmed",
    });
    branches.set(pr, events);
  }
  const parsed = parsePrGcPreview(rowLines.join("\n") + "\n", owner);
  invalidLines += parsed.invalidLines + parsed.duplicateRows;
  if (
    framed &&
    exitCode === 0 &&
    !rowLines.some(
      (line) =>
        line.startsWith("would remove ") ||
        line === "No merged/closed PR worktrees eligible for removal.",
    )
  )
    invalidLines++;
  for (const [pr, events] of branches) {
    const row = parsed.rows.get(pr);
    const terminal =
      row?.native === "would-remove" ||
      (row?.native === "skipped" && row.reason === "cleanup-incomplete");
    if (
      !terminal ||
      (row?.native === "skipped" && row.reportedHold) ||
      (row?.native === "would-remove" && events.some((e) => e.result !== "reported-deleted"))
    )
      invalidLines++;
  }
  const source = invalidLines ? "invalid" : framed ? "owner-framed" : "supplied-output";
  return { source, exitCode, invalidLines, branches, rows: parsed.rows };
}

function reportedOutcome(row: PreviewRow | undefined, hasBranches: boolean) {
  if (row?.native === "would-remove") return "reported-removed";
  if (row?.native === "failed-template") return "reported-failed-template-removal";
  if (row?.native === "conflict") return "conflicting";
  if (row?.native === "skipped" && row.reason === "cleanup-incomplete") {
    if (hasBranches) return "partial-branch-cleanup";
    return row.reportedHold ? "reported-preserved" : "cleanup-incomplete";
  }
  if (row?.native === "skipped") return "reported-skipped";
  return hasBranches ? "branch-events-only" : "unreported";
}

export function reconcilePrGc(owner: string, previewText: string, applyText: string) {
  const preview = parsePrGcPreview(previewText, owner),
    apply = applyOutput(applyText, owner);
  const ids = new Set([...preview.rows.keys(), ...apply.rows.keys(), ...apply.branches.keys()]);
  const rows = [...ids]
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .map((pr) => {
      const before = preview.rows.get(pr),
        after = apply.rows.get(pr);
      const branches = apply.branches.get(pr) ?? [];
      const outcome = reportedOutcome(after, branches.length > 0);
      const inPreview = before?.native === "would-remove";
      const actionKindDrift =
        (inPreview && after?.native === "failed-template") ||
        (before?.native === "failed-template" && after?.native === "would-remove");
      let outsidePreview: "observed-attempt" | "possible-attempt" | null = null;
      if (!inPreview) {
        if (
          outcome === "reported-removed" ||
          outcome === "reported-failed-template-removal" ||
          branches.length
        )
          outsidePreview = "observed-attempt";
        else if (outcome === "cleanup-incomplete" || outcome === "conflicting")
          outsidePreview = "possible-attempt";
      }
      return {
        pr,
        preview: before ?? null,
        outcome,
        ...(after?.native === "would-remove" ? { reportedPrState: after.prState } : {}),
        ...(after?.native === "skipped" ? { skipReason: after.reason } : {}),
        ...(after?.native === "skipped" && after.reportedHold && !branches.length
          ? { reportedHold: after.reportedHold }
          : {}),
        branches,
        outsidePreview,
        actionKindDrift,
      };
    });
  const complete =
    preview.source === "owner-bound-complete" &&
    apply.source === "owner-framed" &&
    apply.exitCode === 0;
  const outsideAttempts = rows
    .filter((r) => r.outsidePreview === "observed-attempt")
    .map((r) => r.pr);
  const possibleOutsideAttempts = rows
    .filter((r) => r.outsidePreview === "possible-attempt")
    .map((r) => r.pr);
  return {
    previewSource: preview.source,
    applySource: apply.source,
    applyExit: apply.exitCode,
    previewInvalidLines: preview.invalidLines,
    previewDuplicateRows: preview.duplicateRows,
    applyInvalidLines: apply.invalidLines,
    coverage: complete ? "framed-complete" : "unverified",
    currentFilesystem: "not-observed",
    reportedRemoved: rows.filter((row) => row.outcome === "reported-removed").length,
    reportedFailedTemplateRemovals: rows.filter(
      (row) => row.outcome === "reported-failed-template-removal",
    ).length,
    selectedUnreported: rows.filter(
      (row) => row.preview?.native === "would-remove" && row.outcome === "unreported",
    ).length,
    actionKindDrift: rows.filter((row) => row.actionKindDrift).map((row) => row.pr),
    incompleteOutcomes: rows.filter((row) =>
      [
        "cleanup-incomplete",
        "partial-branch-cleanup",
        "branch-events-only",
        "conflicting",
      ].includes(row.outcome),
    ).length,
    outsideAttempts,
    possibleOutsideAttempts,
    rows,
  };
}
