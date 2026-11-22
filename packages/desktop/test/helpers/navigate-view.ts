// Injected into Electron real-window runners: they own the `js` and `sleep` handles, so the helper
// takes them as a page-like object rather than importing Electron into the test process.
export type NavPage = {
  js: (code: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
};

// A DOM node appearing is not proof that its hashchange subscriber has mounted. Re-dispatch with a
// bounded retry until the target view is visible, instead of losing the one-shot event.
export async function navigateToView(
  page: NavPage,
  hash: string,
  selector: string,
  timeoutMs = 5000,
): Promise<void> {
  const visible = "Boolean((() => { const el = document.querySelector(" + JSON.stringify(selector) + "); return Boolean(el && !el.classList.contains('hidden')); })())";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.js(visible)) return;
    await page.js("window.location.hash = " + JSON.stringify(hash) + "; window.dispatchEvent(new Event('hashchange'));");
    await page.sleep(100);
  }
  throw new Error(`navigateToView timed out waiting for ${selector} after ${hash}`);
}
