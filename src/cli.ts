#!/usr/bin/env node

import { main } from "./main.js";
import { CommandInterruptedError } from "./core/interruption.js";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agentrinse: ${message}\n`);
  process.exitCode = error instanceof CommandInterruptedError ? error.exitCode : 1;
});
