// scripts/pr gc --dry-run writes relative paths and has no success marker.
// Optional framing binds the operator-supplied owner and successful command exit.
export const previewOwnerPrefix = "agentrinse-openclaw-pr-gc-v1 ";
export const previewComplete = "agentrinse-openclaw-pr-gc-complete";
const noCandidates = "No merged/closed PR worktrees eligible for removal.";
export const prGcMaxBytes = 4 * 1024 * 1024;
export const prGcMaxLines = 20_000;

type ReportedHold = "dirty-or-locked" | "cwd-scan-unavailable" | "live-process-cwd";

export type PreviewRow =
  | { native: "would-remove"; prState: "MERGED" | "CLOSED" }
  | { native: "failed-template" }
  | { native: "skipped"; reason: string; reportedHold?: ReportedHold }
  | { native: "conflict" };

export type Preview = {
  source: "supplied-stdout" | "owner-bound-complete" | "invalid";
  rows: Map<string, PreviewRow>;
  invalidLines: number;
  duplicateRows: number;
  excludedNonPrNames: number;
  preservationDiagnostics: number;
  lockRecoveryDiagnostics: number;
};

// The dirty check prints the relative gc path. The native lsof check prints
// the literal registered path; accept only a direct checkout of this owner.
function parsePreservation(
  line: string,
  owner: string,
): { pr: string; reason: ReportedHold } | undefined {
  const dirty =
    /^Preserving \.worktrees\/pr-([1-9][0-9]*): worktree has local changes or is locked\. Review its contents and ownership before cleanup\.$/u.exec(
      line,
    );
  if (dirty) return { pr: dirty[1]!, reason: "dirty-or-locked" };
  const prefix = "Preserving " + owner + "/.worktrees/pr-";
  if (!line.startsWith(prefix)) return;
  const match = /^([1-9][0-9]*): (.+)$/u.exec(line.slice(prefix.length));
  if (!match) return;
  const [, pr, detail] = match;
  if (
    detail ===
    "unable to inspect process working directories. Retry cleanup after checking lsof and session ownership."
  )
    return { pr: pr!, reason: "cwd-scan-unavailable" };
  if (
    /^live process [1-9][0-9]* has its cwd in this worktree\. Defer cleanup until the owning session exits or releases its cwd\.$/u.test(
      detail!,
    )
  )
    return { pr: pr!, reason: "live-process-cwd" };
}

function parseRow(line: string): [string, PreviewRow] | undefined {
  const parts = /^(would remove|skipping) \.worktrees\/pr-([1-9][0-9]*) \(([^()]+)\)$/u.exec(line);
  if (!parts) return;
  const [, verb, pr, detail] = parts;
  if (verb === "would remove") {
    if (detail === "failed template clone") return [pr!, { native: "failed-template" }];
    for (const prState of ["MERGED", "CLOSED"] as const)
      if (detail === "PR #" + pr + " state=" + prState)
        return [pr!, { native: "would-remove", prState }];
  } else {
    const reasons: Record<string, string> = {
      "merge evidence preserved": "merge-evidence-preserved",
      "cleanup incomplete": "cleanup-incomplete",
      ["PR #" + pr + " has an active scripts/pr operation"]: "active-operation",
      ["PR #" + pr + " operation lock state is indeterminate"]: "indeterminate-operation-lock",
    };
    if (Object.hasOwn(reasons, detail!))
      return [pr!, { native: "skipped", reason: reasons[detail!]! }];
    for (const reason of [
      "not reported to its supervisor",
      "unreadable",
      "orphaned",
      "indeterminate",
    ])
      if (detail === "PR #" + pr + " operation lock is " + reason)
        return [
          pr!,
          { native: "skipped", reason: "operation-lock-" + reason.replaceAll(" ", "-") },
        ];
  }
}

export async function readPrGcPreview(
  input: AsyncIterable<Uint8Array>,
  owner: string,
): Promise<Preview> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.byteLength;
    if (bytes > prGcMaxBytes) throw new Error("OpenClaw PR GC preview exceeds 4 MiB");
    chunks.push(chunk);
  }
  const value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return parsePrGcPreview(value, owner);
}

export function parsePrGcPreview(value: string, owner: string): Preview {
  const lines = value.split("\n");
  const terminated = lines.pop() === "";
  if (lines.length > prGcMaxLines) throw new Error("OpenClaw PR GC preview exceeds 20000 lines");
  const result: Preview = {
    source: "supplied-stdout",
    rows: new Map(),
    invalidLines: 0,
    duplicateRows: 0,
    excludedNonPrNames: 0,
    preservationDiagnostics: 0,
    lockRecoveryDiagnostics: 0,
  };
  const framed = lines[0]?.startsWith(previewOwnerPrefix);
  if (framed) {
    if (lines.shift() !== previewOwnerPrefix + owner) result.invalidLines++;
    if (lines.at(-1) === previewComplete) lines.pop();
    else result.invalidLines++;
  }
  if (!terminated || !lines.length) result.invalidLines++;
  let summary = false;
  const preservation = new Map<string, ReportedHold | null>(),
    recovery = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === noCandidates && !summary && index === lines.length - 1) {
      summary = true;
      continue;
    }
    // Native stderr may be captured with stdout. Recognize only diagnostics
    // attributable to an actual skip row; never retain or execute recovery commands.
    const hold = parsePreservation(line, owner);
    if (hold) {
      if (preservation.has(hold.pr)) {
        result.invalidLines++;
        preservation.set(hold.pr, null);
      } else preservation.set(hold.pr, hold.reason);
      continue;
    }
    const help =
      /^After verifying that no PR #([1-9][0-9]*) tools remain, recover the exact owner with:$/u.exec(
        line,
      );
    if (help) {
      const command =
        /^  scripts\/pr lock-recover ([1-9][0-9]*) (?:[a-f0-9]{40}|[a-f0-9]{64}) --confirmed-no-running-tools$/u.exec(
          lines[index + 1] ?? "",
        );
      if (command?.[1] !== help[1] || recovery.has(help[1]!)) result.invalidLines++;
      else {
        recovery.add(help[1]!);
        index++;
      }
      continue;
    }
    const excluded =
      /^skipping \.worktrees\/(pr-[A-Za-z0-9._-]*) \(could not parse PR number\)$/u.exec(line);
    if (excluded && !/^pr-[1-9][0-9]*$/u.test(excluded[1]!)) {
      result.excludedNonPrNames++;
      continue;
    }
    const row = line.length <= 4096 && parseRow(line);
    if (!row) {
      result.invalidLines++;
      continue;
    }
    const [pr, claim] = row;
    if (result.rows.has(pr)) {
      result.rows.set(pr, { native: "conflict" });
      result.duplicateRows++;
    } else result.rows.set(pr, claim);
  }
  for (const [pr, reason] of preservation) {
    const claim = result.rows.get(pr);
    if (claim?.native !== "skipped" || claim.reason !== "cleanup-incomplete") result.invalidLines++;
    else if (reason) claim.reportedHold = reason;
  }
  for (const pr of recovery) {
    const claim = result.rows.get(pr);
    if (claim?.native !== "skipped" || !claim.reason.startsWith("operation-lock-"))
      result.invalidLines++;
  }
  result.preservationDiagnostics = preservation.size;
  result.lockRecoveryDiagnostics = recovery.size;
  const wouldRemove = [...result.rows.values()].some(
    (r) => r.native === "would-remove" || r.native === "failed-template",
  );
  if (summary && wouldRemove) result.invalidLines++;
  if (framed && !summary && !wouldRemove) result.invalidLines++;
  result.source =
    result.invalidLines || result.duplicateRows
      ? "invalid"
      : framed
        ? "owner-bound-complete"
        : "supplied-stdout";
  return result;
}
