/**
 * Production entry point for provider sign-in flows.
 *
 * Keeps one auth instance per registered driver kind and bounds every flow via
 * the driver's controller. No credentials are ever returned to the UI — only
 * allowlisted authorization URLs and short user codes.
 */

import type { AnyProviderDriver, ProviderInstance, ProviderAuthenticationStart, ProviderAuthenticationStatus } from "@opensand/shared";
import { providerRegistry } from "./provider-registry.js";

interface AuthSession {
  instance: ProviderInstance;
  driver: AnyProviderDriver;
  flowId: string | null;
}

const sessions = new Map<string, AuthSession>();

async function ensureSession(kind: string): Promise<AuthSession | null> {
  const driver = providerRegistry.getDriver(kind);
  if (!driver) return null;
  const existing = sessions.get(kind);
  if (existing) {
    if (existing.driver === driver) return existing;
    // A driver was replaced at runtime (e.g. a test CLI); the cached instance
    // would still spawn the old CLI, so rebuild the session for this driver.
    await existing.instance.dispose();
    sessions.delete(kind);
  }

  const instanceId = `auth:${kind}`;
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
  const session: AuthSession = { instance, driver, flowId: null };
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

/** Sign-in state for a provider kind; null when the kind has no auth controller. */
export async function getProviderAuthState(kind: string): Promise<{ signedIn: boolean; flowId: string | null } | null> {
  const session = await ensureSession(kind);
  if (!session) return null;
  return {
    signedIn: (await session.instance.isSignedIn?.()) ?? false,
    flowId: session.flowId,
  };
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
