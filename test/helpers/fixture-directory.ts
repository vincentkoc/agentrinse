import { afterAll } from "vitest";
import { createOwnedFixture } from "../../scripts/owned-fixture.mjs";

const fixtures: ReturnType<typeof createOwnedFixture>[] = [];
afterAll(() => {
  const errors: unknown[] = [];
  for (const fixture of fixtures.splice(0).reverse()) {
    try {
      fixture.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Fixture teardown failed");
});

export function createFixtureDirectory(prefix: string): string {
  const fixture = createOwnedFixture(prefix);
  fixtures.push(fixture);
  return fixture.path;
}
