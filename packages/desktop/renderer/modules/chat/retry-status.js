// Plain retry countdown for the legacy renderer. Kept pure so node:test can drive it.
// Mirrors rateLimitRetryLabel in the Preact shell; the legacy app cannot import TS sources.
export function formatRetryStatus(info, now = Date.now()) {
  const retryAt = Number(info && info.retryAt) || now;
  const secs = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const attempt = Math.max(1, Number(info && info.attempt) || 1);
  const maxRetries = Math.max(1, Number(info && info.maxRetries) || 1);
  return `Rate limited, retrying in ${secs}s (attempt ${attempt}/${maxRetries})`;
}
