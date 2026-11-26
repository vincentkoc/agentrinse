// Select immediate database families by filename only. Session directories and all other children stay opaque.
export function isCodexDatabaseName(name: string): boolean {
  return /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/iu.test(name);
}
