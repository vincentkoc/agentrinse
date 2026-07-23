#!/usr/bin/env node

import { main } from "./main.js";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agentrinse: ${message}\n`);
  process.exitCode = 1;
});

