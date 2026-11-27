import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import { readProjectFile } from "../core/project-file.js";
import { protectedStorageName } from "../core/storage-measurement.js";
import { readStorageMounts, type StorageMount } from "../core/storage-mounts.js";
import { observeStoragePath, sameFileObservation } from "../core/storage-observation.js";
import { createCommandEnvelope, jsonDocument } from "../machine-output.js";
import { prGcMaxBytes } from "../rules/openclaw/pr-gc-preview.js";
import { reconcilePrGc } from "../rules/openclaw/pr-gc-reconciliation.js";

async function readLog(operand: string, mounts: StorageMount[] | undefined) {
  const path = resolve(operand);
  if (path.split(sep).some(protectedStorageName))
    throw new Error("Choose a log outside protected storage");
  const before = (await observeStoragePath(path, mounts)).stats;
  if (!before?.isFile() || before.nlink !== 1n || before.size > BigInt(prGcMaxBytes))
    throw new Error("Expected a local, regular, single-link GC log of at most 4 MiB");
  const data = await readProjectFile(path, Number(before.dev), { maxBytes: prGcMaxBytes });
  const after = (await observeStoragePath(path, mounts)).stats;
  if (!data || !after || !sameFileObservation(before, after))
    throw new Error("GC log unavailable or changed during read");
  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(data),
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

export async function executePrGcDiff(
  options: { repo: string; preview: string; applyLog: string; json?: boolean },
  readMounts = () => readStorageMounts(process.platform),
) {
  if (
    !isAbsolute(options.repo) ||
    resolve(options.repo) !== options.repo ||
    /\p{Cc}/u.test(options.repo)
  )
    throw new Error("Use the canonical absolute repository path recorded with the logs");
  if (resolve(options.preview) === resolve(options.applyLog))
    throw new Error("Provide distinct preview and apply logs");
  const startedAt = new Date().toISOString();
  const mounts = await readMounts();
  const preview = await readLog(options.preview, mounts);
  const apply = await readLog(options.applyLog, mounts);
  const data = {
    ...reconcilePrGc(options.repo, preview.text, apply.text),
    previewSha256: preview.sha256,
    applySha256: apply.sha256,
  };
  if (options.json)
    return jsonDocument(
      createCommandEnvelope({
        command: "openclaw-pr-gc-diff",
        startedAt,
        completedAt: new Date().toISOString(),
        data,
        status:
          data.coverage === "framed-complete" &&
          !data.outsideAttempts.length &&
          !data.possibleOutsideAttempts.length &&
          !data.incompleteOutcomes &&
          !data.actionKindDrift.length &&
          !data.selectedUnreported
            ? "ok"
            : "degraded",
      }),
    );
  return (
    [
      "OpenClaw PR GC log comparison (" + data.coverage + ")",
      "Attempts outside the frozen preview: " +
        (data.outsideAttempts.join(", ") || "none observed"),
      "Possible outside attempts: " + (data.possibleOutsideAttempts.join(", ") || "none observed"),
      "Selected MERGED/CLOSED PRs unreported in this apply log: " + data.selectedUnreported,
      "PRs with changed cleanup kind: " + (data.actionKindDrift.join(", ") || "none observed"),
      ...data.rows.map(
        (row) =>
          "#" +
          row.pr +
          "  " +
          (row.preview?.native ?? "absent-from-preview") +
          "  " +
          row.outcome +
          (row.reportedHold ? "  " + row.reportedHold : "") +
          row.branches.map((event) => "  " + event.branch + " " + event.result).join(""),
      ),
      "Current checkout, registration and branch refs were not observed.",
    ].join("\n") + "\n"
  );
}
