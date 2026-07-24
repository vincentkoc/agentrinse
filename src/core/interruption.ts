export class CommandInterruptedError extends Error {
  override readonly name = "CommandInterruptedError";
  readonly exitCode = 130;
}
