import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";

// Preserve the caller's native temp and socket placement. Only dispose of this allocation.
export function createOwnedFixture(prefix) {
  const path = mkdtempSync(prefix);
  const physical = realpathSync(path);
  const original = lstatSync(physical, { bigint: true });
  let disposed = false;
  return {
    path,
    dispose() {
      if (disposed) return;
      const current = lstatSync(physical, { bigint: true, throwIfNoEntry: false });
      if (
        current &&
        (!current.isDirectory() ||
          current.dev !== original.dev ||
          current.ino !== original.ino ||
          current.birthtimeNs !== original.birthtimeNs)
      ) {
        throw new Error("Test fixture was replaced; its replacement was retained: " + physical);
      }
      if (current) rmSync(physical, { recursive: true, maxRetries: 3, retryDelay: 30 });
      disposed = true;
    },
  };
}

export function createScriptFixture(prefix) {
  const fixture = createOwnedFixture(prefix);
  process.once("exit", () => fixture.dispose());
  return fixture.path;
}
