import type { inventoryStorage } from "./storage.js";

type StorageReport = Awaited<ReturnType<typeof inventoryStorage>>;

function formatNativeVolume(
  volume: NonNullable<StorageReport["data"]["nativeVolumeEvidence"]>[number],
) {
  const label = `Native volume ${volume.path}  ${volume.filesystem ?? "unknown"}  ${volume.status}`;
  if (!("data" in volume) || !volume.data) return label;
  const data = volume.data;
  if ("snapshots" in data)
    return `${label}  ${data.snapshots} snapshots (${data.purgeable} purgeable, ${data.nonPurgeable} non-purgeable, ${data.purgeabilityUnknown} unknown), container bytes ${data.containerFreeBytes ?? "unknown"} free / ${data.containerBytes ?? "unknown"} total`;
  return `${label}  device bytes ${data.allocatedBytes} allocated / ${data.unallocatedBytes} unallocated / ${data.deviceBytes} total`;
}

export function formatStorageReport(view: StorageReport["data"], status: StorageReport["status"]) {
  const present = view.areas.filter((a) => a.coverage !== "missing");
  return (
    [
      "Storage inventory (" +
        status +
        "). " +
        present.length +
        " observed/withheld locations, " +
        (view.areas.length - present.length) +
        " missing. Physical reclaim is unknown.",
      ...view.reportedMounts.map((m) => m.filesystem + "  " + m.access + "  " + m.path),
      ...(view.omittedMounts ? ["Additional mount records omitted: " + view.omittedMounts] : []),
      ...view.volumeEvidence.map(
        (v) =>
          "Volume " + v.path + "  " + (v.coveringMount?.filesystem ?? "unknown") + " (mount table)",
      ),
      ...(view.nativeVolumeEvidence ?? []).map(formatNativeVolume),
      ...view.gitPacks.repositories.map((r) => "Git pack store  " + r.coverage + "  " + r.path),
      ...Object.entries(view.gitPacks.byKind).map(
        ([kind, g]) =>
          "Git " +
          kind +
          ": " +
          g.files +
          " files, " +
          g.logicalBytes +
          " logical / " +
          g.allocatedBytes +
          " allocated bytes",
      ),
      ...view.crabbox.flatMap((r) => [
        "Crabbox staging  " +
          r.coverage +
          "  " +
          r.root +
          "  mirror index: " +
          r.mirrorIndex +
          "; receipts omitted: " +
          r.receiptsOmitted +
          "; withheld entries: " +
          r.excluded,
        ...r.entries.map(
          (e) =>
            "  " +
            e.classification +
            "  " +
            e.path +
            "  directory mtime: " +
            e.directoryMtimeReview +
            ("lastUseReview" in e && e.lastUseReview ? "  " + e.lastUseReview : "") +
            (e.measurement
              ? "  " +
                e.measurement.extent +
                ("fileBytes" in e.measurement && e.measurement.fileBytes
                  ? "  " + e.measurement.fileBytes.allocatedBytes + " observed allocated bytes"
                  : " bytes unknown")
              : ""),
        ),
      ]),
      ...(view.prDependencies?.namespaces.flatMap((ns) => [
        "OpenClaw PR dependencies  " +
          ns.coverage +
          "  " +
          ns.path +
          "  live lane holds unverified; " +
          ns.otherEntries +
          " other entries, " +
          ns.excluded +
          " excluded",
        ...ns.entries.map(
          (entry) =>
            "  " +
            entry.kind +
            "  " +
            entry.path +
            "  directory mtime: " +
            entry.directoryMtimeReview +
            (entry.measurement
              ? "  " +
                entry.measurement.extent +
                (entry.measurement.fileBytes
                  ? "  " + entry.measurement.fileBytes.allocatedBytes + " observed allocated bytes"
                  : " bytes unknown")
              : ""),
        ),
      ]) ?? []),
      ...present.map(
        (a) =>
          a.rule +
          "  " +
          a.coverage +
          "  " +
          a.path +
          (a.directExtent === "unknown" ? "  direct bytes unknown" : "") +
          (a.directDirectories === undefined
            ? ""
            : `  ${a.directDirectories} direct directories, ${a.excluded} excluded`) +
          (a.directExtent === "lower-bound" ? "  lower bound" : "") +
          (a.fileBytes
            ? "  " +
              a.fileBytes.logicalBytes +
              " logical / " +
              a.fileBytes.allocatedBytes +
              " allocated bytes on observed files"
            : ""),
      ),
      ...present
        .filter((a) => a.measurement)
        .map(
          (a) =>
            "Measured " +
            a.rule +
            "  " +
            a.measurement!.extent +
            "  " +
            (a.measurement!.fileBytes
              ? a.measurement!.fileBytes!.logicalBytes +
                " logical / " +
                a.measurement!.fileBytes!.allocatedBytes +
                " observed allocated bytes"
              : "bytes unknown"),
        ),
      "Default directory observations cover direct children. Snapshots, clones, hardlinks and guest allocation can share bytes.",
    ].join("\n") + "\n"
  );
}
