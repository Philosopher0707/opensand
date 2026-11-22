import test from "node:test";
import assert from "node:assert";
import {
  AUTH_TOKEN_KEY,
  EMPTY_TOKEN_ERROR,
  INVALID_TOKEN_ERROR,
  authFailed,
  authStarted,
  authSucceeded,
  closeAuthModal,
  createInitialAuthState,
  isAuthSubmitKey,
  normalizeToken,
  openAuthModal,
  persistToken,
  readStoredToken,
  setAuthInput,
  validateToken,
  type AuthState,
  type ShellStorage,
} from "../src/shell/auth-model.js";

function fakeStorage(seed: Record<string, string> = {}): ShellStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const closed: AuthState = { isOpen: false, input: "", token: "", status: "idle", error: null };

test("auth-model: initial state restores the token from sessionStorage", () => {
  const storage = fakeStorage({ [AUTH_TOKEN_KEY]: "stored-token" });
  assert.deepStrictEqual(createInitialAuthState(storage), { ...closed, token: "stored-token" });
  assert.deepStrictEqual(createInitialAuthState(null), closed);
  assert.strictEqual(readStoredToken(fakeStorage({ other: "x" })), "");
});

test("auth-model: storage failures degrade to empty state without throwing", () => {
  const broken: ShellStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.strictEqual(readStoredToken(broken), "");
  assert.strictEqual(readStoredToken(undefined), "");
  assert.doesNotThrow(() => persistToken(broken, "token"));
  assert.doesNotThrow(() => persistToken(null, "token"));
});

test("auth-model: only blank input is invalid; tokens are trimmed", () => {
  assert.strictEqual(normalizeToken("  abc123  "), "abc123");
  assert.strictEqual(validateToken("  abc123  "), null);
  assert.strictEqual(validateToken(""), EMPTY_TOKEN_ERROR);
  assert.strictEqual(validateToken("   \t\n "), EMPTY_TOKEN_ERROR);
});

test("auth-model: opening clears the previous input and error, closing resets the lifecycle", () => {
  const dirty: AuthState = { isOpen: false, input: "old", token: "kept", status: "idle", error: "old error" };
  assert.deepStrictEqual(openAuthModal(dirty), { ...dirty, isOpen: true, input: "", error: null });
  const submitting: AuthState = { ...dirty, isOpen: true, status: "submitting" };
  assert.deepStrictEqual(closeAuthModal(submitting), { ...dirty, isOpen: false, input: "", status: "idle", error: null });
  assert.deepStrictEqual(setAuthInput(closed, "typed"), { ...closed, input: "typed" });
});

test("auth-model: submit lifecycle disables, clears errors, stores on success and restores on failure", () => {
  const withInput = setAuthInput(openAuthModal(closed), " new-token ");
  assert.deepStrictEqual(authStarted({ ...withInput, error: "old" }), { ...withInput, status: "submitting", error: null });

  const storage = fakeStorage();
  const ok = authSucceeded(authStarted(withInput), " new-token ", storage);
  assert.deepStrictEqual(ok, { isOpen: false, input: "", token: "new-token", status: "idle", error: null });
  assert.strictEqual(storage.data[AUTH_TOKEN_KEY], "new-token", "the trimmed token is persisted under the legacy key");

  const failed = authFailed(authStarted(withInput), "Unauthorized: invalid token");
  assert.deepStrictEqual(failed, { ...withInput, status: "idle", error: "Unauthorized: invalid token" });
  assert.strictEqual(authFailed(authStarted(withInput)).error, INVALID_TOKEN_ERROR, "a blank server error still explains the failure");
  assert.strictEqual(storage.data[AUTH_TOKEN_KEY], "new-token", "a failure does not overwrite a stored token");
});

test("auth-model: Enter submits the token field", () => {
  assert.strictEqual(isAuthSubmitKey({ key: "Enter" }), true);
  assert.strictEqual(isAuthSubmitKey({ key: "enter" }), false);
  assert.strictEqual(isAuthSubmitKey({ key: "Tab" }), false);
});
