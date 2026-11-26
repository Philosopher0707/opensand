// Plain version label for the legacy renderer. Kept pure so node:test can drive it.
// Mirrors versionLabel in src/shell/version-model.ts; the legacy app cannot import TS sources.
export function versionLabel(report) {
  const raw = report && report.app;
  const app = typeof raw === 'string'
    ? raw.trim()
    : raw && typeof raw === 'object' && typeof raw.version === 'string'
      ? raw.version.trim()
      : '';
  return app ? `OpenSand v${app}` : 'Version unavailable';
}
