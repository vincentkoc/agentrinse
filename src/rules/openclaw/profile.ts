// OpenClaw uses this bounded name for OPENCLAW_PROFILE and its .openclaw-<profile> storage.
export function isOpenClawProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(name);
}
