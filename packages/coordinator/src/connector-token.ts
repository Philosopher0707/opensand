const PLACEHOLDER_OAUTH_TOKEN = /^oauth_(?:slack|linear|github)_[0-9a-f]{24}$/;

/** Tokens minted by the old OAuth stub never represented a provider sign-in. */
export function isPlaceholderConnectorToken(token: string | null | undefined): boolean {
  return typeof token === "string" && PLACEHOLDER_OAUTH_TOKEN.test(token.trim());
}
