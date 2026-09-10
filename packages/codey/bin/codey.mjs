#!/usr/bin/env node
import { runCli } from "../lib/cli.mjs";

runCli().catch((error) => {
  console.error(`codey: ${error.message}`);
  process.exitCode = 1;
});
