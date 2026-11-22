// packages/desktop/src/shell/auth-model.ts
// Pure state logic for the Preact shell auth modal and token exchange (Phase 5, Row 12).
// Mirrors legacy renderer/app.js L960-1027 and the client token interceptor L25-100.

import type { ShellStorage } from "./account-model.js";

export type { ShellStorage };

export const AUTH_TOKEN_KEY = "opensand_token";
export const EMPTY_TOKEN_ERROR = "Please enter an authentication token.";
export const INVALID_TOKEN_ERROR = "Invalid authentication token.";

export type AuthStatus = "idle" | "submitting";

export interface AuthState {
  isOpen: boolean;
  input: string;
  token: string;
  status: AuthStatus;
  error: string | null;
}

export function readStoredToken(storage: ShellStorage | null | undefined): string {
  try {
    return storage?.getItem(AUTH_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function persistToken(storage: ShellStorage | null | undefined, token: string): void {
  try {
    storage?.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // Blocked storage must not stop the in-memory success path.
  }
}

export function createInitialAuthState(storage: ShellStorage | null | undefined): AuthState {
  return { isOpen: false, input: "", token: readStoredToken(storage), status: "idle", error: null };
}

export function normalizeToken(raw: string): string {
  return String(raw ?? "").trim();
}

/** Empty/whitespace input is the only client-side rule; the server rejects bad values. */
export function validateToken(raw: string): string | null {
  return normalizeToken(raw) ? null : EMPTY_TOKEN_ERROR;
}

export function setAuthInput(state: AuthState, input: string): AuthState {
  return { ...state, input };
}

/** Opening clears the previous attempt, like legacy showAuthModal(). */
export function openAuthModal(state: AuthState): AuthState {
  return { ...state, isOpen: true, input: "", status: "idle", error: null };
}

export function closeAuthModal(state: AuthState): AuthState {
  return { ...state, isOpen: false, input: "", status: "idle", error: null };
}

export function authStarted(state: AuthState): AuthState {
  return { ...state, status: "submitting", error: null };
}

export function authSucceeded(state: AuthState, token: string, storage: ShellStorage | null | undefined): AuthState {
  const normalized = normalizeToken(token);
  persistToken(storage, normalized);
  return { ...state, isOpen: false, input: "", token: normalized, status: "idle", error: null };
}

export function authFailed(state: AuthState, message?: string): AuthState {
  return { ...state, status: "idle", error: message || INVALID_TOKEN_ERROR };
}

/** Enter in the token field submits, matching the legacy input's onkeydown. */
export function isAuthSubmitKey(event: { key: string }): boolean {
  return event.key === "Enter";
}
