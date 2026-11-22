// Pure model for the Vault view and its add modals (Phase 5 Row 16).
// A stored value never enters this model: the view types carry metadata only.

export interface VaultSecret {
  id: string;
  name: string;
  description?: string;
  preview?: string;
}

export interface VaultCredential {
  id: string;
  title: string;
  username?: string;
  sites?: string[] | string;
}

export interface SecretInput {
  name: string;
  value: string;
  description?: string;
}

export interface CredentialInput {
  title: string;
  username: string;
  password?: string;
  sites?: string[];
}

export interface SecretCardView {
  name: string;
  description: string;
  mask: string;
}

export interface CredentialCardView {
  title: string;
  username: string;
  sites: string;
  mask: string;
}

export const SECRET_MASK = "••••••••";
export const SECRET_VALIDATION_MESSAGE = "Please provide secret name and value.";
export const CREDENTIAL_VALIDATION_MESSAGE = "Please provide account title and username.";
export const SECRET_EMPTY_STATE = "No encrypted secrets stored.";
export const CREDENTIAL_EMPTY_STATE = "No account credentials stored.";

/** Matches the server's `if (!body.name || !body.value)` guard. */
export function validateSecretInput(input: SecretInput): string | null {
  if (!input.name?.trim() || !input.value?.trim()) return SECRET_VALIDATION_MESSAGE;
  return null;
}

/** Matches the server's `if (!body.title || !body.username)` guard. */
export function validateCredentialInput(input: CredentialInput): string | null {
  if (!input.title?.trim() || !input.username?.trim()) return CREDENTIAL_VALIDATION_MESSAGE;
  return null;
}

export function parseSites(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The mask is constant: neither `preview` nor any other field may expose a stored value. */
export function secretCardView(secret: VaultSecret): SecretCardView {
  return {
    name: secret.name?.trim() || secret.id,
    description: secret.description?.trim() || "Environment secret token",
    mask: SECRET_MASK,
  };
}

export function credentialCardView(credential: VaultCredential): CredentialCardView {
  const sites = Array.isArray(credential.sites)
    ? credential.sites
    : typeof credential.sites === "string"
      ? parseSites(credential.sites)
      : [];
  return {
    title: credential.title?.trim() || credential.id,
    username: credential.username?.trim() || "user",
    sites: sites.join(", ") || "Any",
    mask: SECRET_MASK,
  };
}
