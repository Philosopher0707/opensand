/** Plain version label shared by the Preact Settings view; never render a raw error to the owner. */
export function versionLabel(report: { app?: unknown } | null | undefined): string {
  const app = typeof report?.app === 'string' ? report.app.trim() : '';
  return app ? `OpenSand v${app}` : 'Version unavailable';
}
