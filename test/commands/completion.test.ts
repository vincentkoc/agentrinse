import { describe, expect, it } from "vitest";

import { renderCompletion } from "../../src/commands/completion.js";

describe("completion command", () => {
  it.each([
    ["bash", "complete -F _agentrinse_completion agentrinse", "--no-state", "--providers"],
    ["zsh", "#compdef agentrinse", "--no-state", "--providers"],
    ["fish", "complete -c agentrinse", "-l no-state", "-l providers"],
  ])("generates %s completion", (shell, marker, noState, providers) => {
    const output = renderCompletion(shell);

    expect(output).toContain(marker);
    expect(output).toContain("audit");
    expect(output).toContain("clean");
    expect(output).toContain("doctor");
    expect(output).toContain("recover");
    expect(output).toContain("resource");
    expect(output).toContain(noState);
    expect(output).toContain(providers);
    expect(output).toContain("cursor");
    expect(output).toContain("copilot");
    expect(output).toContain("opencode");
  });

  it("rejects unsupported shells", () => {
    expect(() => renderCompletion("powershell")).toThrow("expected bash, zsh, or fish");
  });

  it("keeps stateful bash audit flags and scopes provider values to their option", () => {
    const output = renderCompletion("bash");
    const auditCase = output.split("\n").find((line) => line.trimStart().startsWith("audit)"));

    expect(auditCase).toContain("--output");
    expect(auditCase).toContain("--state-dir");
    expect(auditCase).not.toContain("cursor");
    expect(output).toContain('"${previous}" == "--providers"');
  });
});
