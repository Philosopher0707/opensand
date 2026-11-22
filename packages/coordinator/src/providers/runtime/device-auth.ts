/**
 * Generic device-code / browser-login flow for CLI providers.
 *
 * Credentials stay in a per-instance home directory (never in OpenSand config),
 * CLI output is capped and only allowlisted URLs/codes are surfaced, and every
 * flow is bounded by a deadline. Provider-specific endpoints live in the driver
 * spec, not in this runtime.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "@opensand/shared";

export interface DeviceAuthSpec {
  provider: string;
  homeEnv: string;
  homeDir: string;
  loginArgs: string[];
  statusArgs?: string[];
  logoutArgs?: string[];
  /** Credential file inside the per-instance home, checked before starting a flow. */
  signedInFile?: string;
  /** Only URLs matching this pattern are returned to the UI. */
  urlPattern: RegExp;
  /** Only short numeric/alphanumeric codes matching this pattern are returned. */
  codePattern: RegExp;
  /** Link-only flows (e.g. GitHub Copilot) have no short code to enter. */
  requiresCode?: boolean;
  failureMessage: string;
}

interface Flow {
  id: string;
  child: ChildProcess | null;
  status: ProviderAuthenticationStatus;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Stable, instance-independent credential directory for a provider spec. */
export function credentialHome(spec: DeviceAuthSpec): string {
  return path.join(os.homedir(), ".opensand", "providers", spec.provider, spec.homeDir.replace(/^\./, ""));
}

/** Environment passed to both login and session CLIs for a provider spec. */
export function credentialEnv(spec: DeviceAuthSpec, environment: Record<string, string>): Record<string, string> {
  return { ...environment, [spec.homeEnv]: credentialHome(spec) };
}

const START_TIMEOUT_MS = 30_000;
const FLOW_LIFETIME_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

export interface DeviceAuthController {
  start(): Promise<ProviderAuthenticationStart>;
  get(flowId: string): Promise<ProviderAuthenticationStatus>;
  isSignedIn(): Promise<boolean>;
  cancel(): Promise<void>;
  signOut(): Promise<void>;
  dispose(): Promise<void>;
}

/** Build a bounded, fail-closed auth controller for one provider instance. */
export function createDeviceAuthController(
  spec: DeviceAuthSpec,
  instanceId: string,
  environment: Record<string, string>,
  configCli: string
): DeviceAuthController {
  const env = credentialEnv(spec, { ...(process.env as Record<string, string>), ...environment });
  let flow: Flow | null = null;
  let lastStatus: ProviderAuthenticationStatus | null = null;
  let disposed = false;

  const home = credentialHome(spec);
  const isSignedIn = (): boolean => {
    if (!spec.signedInFile) return false;
    try {
      return fs.statSync(path.join(home, spec.signedInFile)).size > 0;
    } catch {
      return false;
    }
  };

  const finish = (status: ProviderAuthenticationStatus): void => {
    if (!flow) return;
    clearTimeout(flow.timer);
    flow.status = status;
    lastStatus = status;
    if (flow.child && !flow.child.killed) flow.child.kill("SIGKILL");
    flow = null;
  };

  const run = (
    args: string[],
    onLine?: (line: string) => void,
    isReady?: () => boolean,
    onSpawn?: (child: ChildProcess) => void,
    onExit?: () => void
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(configCli, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      onSpawn?.(child);
      let output = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          reject(new Error(spec.failureMessage));
        }
      }, START_TIMEOUT_MS);
      timer.unref?.();
      const consume = (chunk: Buffer | string) => {
        output += chunk.toString();
        if (output.length > MAX_OUTPUT_BYTES) {
          output = output.slice(0, MAX_OUTPUT_BYTES);
          child.kill("SIGKILL");
        }
        if (onLine) {
          for (const line of output.split("\n")) onLine(line.trim());
        }
        if (!settled && isReady?.()) {
          settled = true;
          clearTimeout(timer);
          resolve(output);
        }
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      child.on("error", (error) => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(error); }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        onExit?.();
        if (!settled) { settled = true; resolve(output); }
      });
    });

  return {
    async start(): Promise<ProviderAuthenticationStart> {
      if (disposed) throw new Error("Auth controller disposed");
      if (flow) throw new Error("An authentication flow is already active");
      if (isSignedIn()) {
        return { flowId: null, authorizationUrl: null, expiresAt: null };
      }

      const id = randomUUID();
      const status: ProviderAuthenticationStatus = { status: "pending", flowId: id, authorizationUrl: null, expiresAt: null };
      const timer = setTimeout(() => {
        finish({ status: "failed", flowId: id, authorizationUrl: null, expiresAt: null, message: "Authentication timed out" });
      }, FLOW_LIFETIME_MS);
      timer.unref?.();
      const pending: Flow = { id, child: null, status, expiresAt: Date.now() + FLOW_LIFETIME_MS, timer };
      flow = pending;

      try {
        const ready = () =>
          Boolean(pending.status.authorizationUrl) &&
          (spec.requiresCode === false || pending.status.userCode !== undefined);
        const output = await run(spec.loginArgs, (line) => {
          if (!pending.status.authorizationUrl && line.length < 4096 && spec.urlPattern.test(line)) {
            const match = line.match(spec.urlPattern);
            if (match) pending.status = { ...pending.status, authorizationUrl: match[0] };
          }
          const code = line.match(spec.codePattern)?.[0];
          if (code && code.length <= 32 && pending.status.userCode === undefined) {
            pending.status = { ...pending.status, userCode: code };
          }
        }, ready, (child) => { pending.child = child; }, () => finish(isSignedIn()
          ? { status: "authorized", flowId: id, authorizationUrl: null, expiresAt: null }
          : { status: "failed", flowId: id, authorizationUrl: null, expiresAt: null, message: spec.failureMessage }));
        void output;
      } catch (error) {
        finish({
          status: "failed", flowId: id, authorizationUrl: null, expiresAt: null,
          message: spec.failureMessage,
        });
        throw error;
      }

      return {
        flowId: id,
        authorizationUrl: pending.status.authorizationUrl ?? null,
        expiresAt: new Date(pending.expiresAt).toISOString(),
        ...(pending.status.userCode ? { userCode: pending.status.userCode } : {}),
      };
    },

    async get(flowId) {
      if (!flow || flow.id !== flowId) {
        if (lastStatus && lastStatus.flowId === flowId) return { ...lastStatus };
        return { status: "cancelled", flowId, authorizationUrl: null, expiresAt: null };
      }
      return { ...flow.status };
    },

    isSignedIn: async () => isSignedIn(),

    async cancel() {
      if (flow) {
        finish({ status: "cancelled", flowId: flow.id, authorizationUrl: null, expiresAt: null });
      }
    },

    async signOut() {
      if (spec.logoutArgs?.length) {
        try { await run(spec.logoutArgs); } catch { /* local sign-out is best effort */ }
      }
      if (flow) finish({ status: "cancelled", flowId: flow.id, authorizationUrl: null, expiresAt: null });
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* nothing to remove */ }
    },

    async dispose() {
      disposed = true;
      await this.cancel();
    },
  };
}
