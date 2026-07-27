import { describe, expect, it } from "vitest";

import { resolveProviderRoot } from "../../src/adapters/provider-root.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";

describe("resolveProviderRoot", () => {
  it("prefers an explicit root over the Claude environment", () => {
    expect(
      resolveProviderRoot(PROVIDER_SPECS.claude, "/fixture/home", {
        root: "/fixture/configured-claude",
        environment: { CLAUDE_CONFIG_DIR: "/fixture/environment-claude" },
      }),
    ).toBe("/fixture/configured-claude");
  });

  it("uses an absolute CLAUDE_CONFIG_DIR before the default", () => {
    expect(
      resolveProviderRoot(PROVIDER_SPECS.claude, "/fixture/home", {
        environment: { CLAUDE_CONFIG_DIR: "/fixture/environment-claude" },
      }),
    ).toBe("/fixture/environment-claude");
  });

  it("falls back to the Claude directory under the audited home", () => {
    expect(
      resolveProviderRoot(PROVIDER_SPECS.claude, "/fixture/home", {
        environment: {},
      }),
    ).toBe("/fixture/home/.claude");
  });

  it("rejects a relative CLAUDE_CONFIG_DIR", () => {
    expect(() =>
      resolveProviderRoot(PROVIDER_SPECS.claude, "/fixture/home", {
        environment: { CLAUDE_CONFIG_DIR: "relative/claude" },
      }),
    ).toThrow("CLAUDE_CONFIG_DIR must be an absolute path");
  });

  it("prefers an explicit root over COPILOT_HOME", () => {
    expect(
      resolveProviderRoot(PROVIDER_SPECS.copilot, "/fixture/home", {
        root: "/fixture/configured-copilot",
        environment: { COPILOT_HOME: "/fixture/environment-copilot" },
      }),
    ).toBe("/fixture/configured-copilot");
  });

  it("uses an absolute COPILOT_HOME before the default", () => {
    expect(
      resolveProviderRoot(PROVIDER_SPECS.copilot, "/fixture/home", {
        environment: { COPILOT_HOME: "/fixture/environment-copilot" },
      }),
    ).toBe("/fixture/environment-copilot");
  });

  it("falls back to the Copilot directory under the audited home", () => {
    expect(
      resolveProviderRoot(PROVIDER_SPECS.copilot, "/fixture/home", {
        environment: {},
      }),
    ).toBe("/fixture/home/.copilot");
  });

  it("rejects a relative COPILOT_HOME", () => {
    expect(() =>
      resolveProviderRoot(PROVIDER_SPECS.copilot, "/fixture/home", {
        environment: { COPILOT_HOME: "relative/copilot" },
      }),
    ).toThrow("COPILOT_HOME must be an absolute path");
  });
});
