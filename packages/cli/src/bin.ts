#!/usr/bin/env node

import { runCli } from "./cli-app.js";

runCli(process.argv.slice(2)).catch((err) => {
  if (err?.code === "ABORT_ERR" || err?.name === "AbortError") {
    process.exit(0);
  }
  console.error(`\x1b[31mOpenSand fatal error: ${err?.message || err}\x1b[0m`);
  process.exit(1);
});
