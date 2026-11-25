// Plain version label for the legacy renderer. Kept pure so node:test can drive it.
// Mirrors versionLabel in src/shell/version-model.ts; the legacy app cannot import TS sources.
export function versionLabel(report) {
  const app = report && typeof report.app === 'string' ? report.app.trim() : '';
  return app ? `OpenSand v${app}` : 'Version unavailable';
}
