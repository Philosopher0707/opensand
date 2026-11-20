/**
 * Production entry point for provider sign-in flows.
 *
 * Keeps one auth instance per registered driver kind and bounds every flow via
 * the driver's controller. No credentials are ever returned to the UI — only
 * allowlisted authorization URLs and short user codes.
 */

import { randomUUID } from "node:crypto";
import type { ProviderInstance, ProviderAuthenticationStart, ProviderAuthenticationStatus } from "@opensand/shared";
import { providerRegistry } from "./provider-registry.js";

interface AuthSession {
  instance: ProviderInstance;
  flowId: string | null;
}

const sessions = new Map<string, AuthSession>();

/** Driver kinds whose instances expose a sign-in controller. */
export const AUTH_PROVIDER_KINDS: ReadonlySet<string> = new Set([
  "grokAgent",
  "kimiAgent",
  "copilotAgent",
]);

async function ensureSession(kind: string): Promise<AuthSession | null> {
  const driver = providerRegistry.getDriver(kind);
  if (!driver) return null;
  let session = sessions.get(kind);
  if (session) return session;

  const instanceId = `auth:${kind}:${randomUUID()}`;
  const { instance } = await providerRegistry.createInstance(instanceId, {
    driver: kind,
    displayName: driver.metadata.displayName,
    enabled: true,
    config: driver.defaultConfig(),
  });
  if (!instance.startAuthentication) {
    await instance.dispose();
    return null;
  }
  session = { instance, flowId: null };
  sessions.set(kind, session);
  return session;
}

function toStartResult(start: ProviderAuthenticationStart, flowId: string | null): Record<string, unknown> {
  return {
    flowId: start.flowId ?? flowId,
    authorizationUrl: start.authorizationUrl,
    userCode: start.userCode ?? null,
    expiresAt: start.expiresAt ?? null,
  };
}

/** Start (or return the already-started) sign-in flow for a provider kind. */
export async function startProviderAuth(kind: string): Promise<Record<string, unknown> | null> {
  const session = await ensureSession(kind);
  if (!session) return null;
  if (session.flowId) {
    const status = await session.instance.getAuthentication?.(session.flowId);
    if (status?.status === "pending") {
      return {
        flowId: session.flowId,
        authorizationUrl: status.authorizationUrl ?? null,
        userCode: status.userCode ?? null,
        expiresAt: status.expiresAt ?? null,
      };
    }
  }
  const start = await session.instance.startAuthentication?.();
  if (!start) return null;
  session.flowId = start.flowId;
  return toStartResult(start, session.flowId);
}

/** Poll a flow; a missing or foreign flow is reported as cancelled. */
export async function getProviderAuthStatus(kind: string, flowId: string): Promise<ProviderAuthenticationStatus | null> {
  const session = sessions.get(kind);
  if (!session || session.flowId !== flowId) {
    return { status: "cancelled", flowId, authorizationUrl: null, expiresAt: null };
  }
  const status = await session.instance.getAuthentication?.(flowId);
  if (status && (status.status === "authorized" || status.status === "failed")) {
    session.flowId = null;
  }
  return status ?? { status: "cancelled", flowId, authorizationUrl: null, expiresAt: null };
}

export async function cancelProviderAuth(kind: string): Promise<boolean> {
  const session = sessions.get(kind);
  if (!session) return false;
  await session.instance.cancelAuthentication?.();
  session.flowId = null;
  return true;
}

export async function signOutProvider(kind: string): Promise<boolean> {
  const session = await ensureSession(kind);
  if (!session?.instance.signOut) return false;
  await session.instance.signOut();
  session.flowId = null;
  return true;
}

/** Dispose all auth instances (shutdown). */
export async function disposeProviderAuth(): Promise<void> {
  for (const [kind, session] of sessions) {
    await session.instance.dispose();
    sessions.delete(kind);
  }
}
