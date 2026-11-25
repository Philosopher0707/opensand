/** Plain version label shared by the Preact Settings view; never render a raw error to the owner. */
export function versionLabel(report: { app?: unknown } | null | undefined): string {
  const raw = report?.app;
  const app = typeof raw === 'string'
    ? raw.trim()
    : raw && typeof raw === 'object' && typeof (raw as { version?: unknown }).version === 'string'
      ? (raw as { version: string }).version.trim()
      : '';
  return app ? `OpenSand v${app}` : 'Version unavailable';
}
