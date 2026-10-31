#!/usr/bin/env node

import { runCli } from "./cli-app.js";

runCli(process.argv.slice(2)).catch((err) => {
  console.error("OpenSand fatal error:", err);
  process.exit(1);
});
