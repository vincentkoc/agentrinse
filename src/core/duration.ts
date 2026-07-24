const DURATION_PATTERN = /^([1-9]\d*)(ms|s|m|h|d)$/;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

export function parseDurationMs(input: string): number {
  const match = DURATION_PATTERN.exec(input.trim());
  if (match === null) {
    throw new Error(`invalid duration ${JSON.stringify(input)}; use a positive value like 30d`);
  }

  const amount = Number.parseInt(match[1]!, 10);
  const result = amount * UNIT_MS[match[2]!]!;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`duration ${JSON.stringify(input)} is too large`);
  }
  return result;
}
