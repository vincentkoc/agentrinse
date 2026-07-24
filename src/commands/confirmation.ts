import { createInterface } from "node:readline/promises";

export type ConfirmationDependencies = {
  isInteractive?: () => boolean;
  question?: (prompt: string) => Promise<string>;
};

async function defaultQuestion(promptText: string): Promise<string> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await prompt.question(promptText);
  } finally {
    prompt.close();
  }
}

export async function confirmMutation(
  prompt: string,
  dependencies: ConfirmationDependencies = {},
): Promise<boolean> {
  if (!(dependencies.isInteractive ?? (() => process.stdin.isTTY && process.stdout.isTTY))()) {
    throw new Error("mutation requires --yes when stdin or stdout is not an interactive terminal");
  }
  const answer = await (dependencies.question ?? defaultQuestion)(prompt);
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}
