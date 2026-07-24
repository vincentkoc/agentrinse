import { describe, expect, it } from "vitest";

import { renderCompletion } from "../../src/commands/completion.js";

describe("completion command", () => {
  it.each([
    ["bash", "complete -F _agentrinse_completion agentrinse"],
    ["zsh", "#compdef agentrinse"],
    ["fish", "complete -c agentrinse"],
  ])("generates %s completion", (shell, marker) => {
    const output = renderCompletion(shell);

    expect(output).toContain(marker);
    expect(output).toContain("audit");
    expect(output).toContain("clean");
    expect(output).toContain("doctor");
    expect(output).toContain("recover");
    expect(output).toContain("resource");
  });

  it("rejects unsupported shells", () => {
    expect(() => renderCompletion("powershell")).toThrow("expected bash, zsh, or fish");
  });
});
