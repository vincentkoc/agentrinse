import { expect, it, vi } from "vitest";
import { describeProjectRegistration } from "../../src/rules/claude/project-registration.js";

// Exercise native Windows equality and containment on every CI host.
vi.mock("node:path", async (original) => {
  const path = await original<typeof import("node:path")>();
  return { ...path, ...path.win32 };
});

it("recognizes equivalent Windows registrations and distinguishes containing directories", () => {
  const root = "C:/Work/Repo";
  expect(describeProjectRegistration(root, "c:/work/repo").code).toBe("registered-project");
  expect(describeProjectRegistration(root, "c:/work/repo/task").code).toBe(
    "registered-project-ancestor",
  );
  expect(describeProjectRegistration("C:/WORK/Repo/Task", "c:/work/repo").code).toBe(
    "registered-project-descendant",
  );
});
