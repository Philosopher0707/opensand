#!/usr/bin/env node
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { EngineServer } from "./server.js";
import type { EngineConnection } from "./types.js";

const SHUTDOWN_GRACE_MS = 1_900;

export interface CliOptions {
  stdio: boolean;
  stateDir: string;
}

export function parseArgs(argv: string[]): CliOptions {
  let stdio = false;
  let stateDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdio") {
      stdio = true;
    } else if (arg === "--state-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--state-dir needs a path");
      stateDir = value;
      index += 1;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  if (!stdio) fail("--stdio is required");
  return { stdio, stateDir: stateDir ?? path.join(os.homedir(), ".opensand") };
}

function fail(message: string): never {
  process.stderr.write(`opensand-engine: ${message}\n`);
  process.exit(2);
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const connection: EngineConnection = {
    write: (line) =>
      new Promise<void>((resolve) => {
        if (!process.stdout.write(line)) {
          process.stdout.once("drain", () => resolve());
        } else {
          resolve();
        }
      }),
    bufferedBytes: () => process.stdout.writableLength,
  };

  const server = new EngineServer({
    stateDir: options.stateDir,
    version: readVersion(),
    connection,
    stderr: (message) => process.stderr.write(`${message}\n`),
    onShutdown: () => {
      // Stop accepting new requests while the in-flight response flushes.
      process.stdin.pause();
    },
    onExit: (code) => process.exit(code),
  });

  const shutdown = (): void => {
    process.stdin.pause();
    const hardStop = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    hardStop.unref();
    void server.close().then(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => server.handleChunk(chunk));
  process.stdin.on("end", shutdown);
  server.start();
}

main();
