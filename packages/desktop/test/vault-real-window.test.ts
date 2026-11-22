import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) return "Electron binary not found";
  if (!fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"))) return "dist/renderer-next is not built";
  return undefined;
}

const RUNNER_SCRIPT = String.raw`
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const shotDir = process.env.OPENSAND_VAULT_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_VAULT_TIMEOUT_MS || 120000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const nativeSet = (sel, proto, value, eventName) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(" + proto + ".prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event(" + JSON.stringify(eventName) + ", { bubbles: true })); return true; })()";
const setInput = (sel, value) => nativeSet(sel, "HTMLInputElement", value, "input");

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const measure = () => js("(() => {\n" +
  "const q = (s) => document.querySelector(s);\n" +
  "const panel = q('#viewVault');\n" +
  "const pr = panel ? panel.getBoundingClientRect() : null;\n" +
  "const tabs = Array.from(document.querySelectorAll('#viewVault .subnav-tab'));\n" +
  "const grid = q('#secretsGrid') ? q('#secretsGrid').getBoundingClientRect() : null;\n" +
  "const card = q('#secretsGrid .dashboard-card') ? q('#secretsGrid .dashboard-card').getBoundingClientRect() : null;\n" +
  "const modal = q('#addSecretModal');\n" +
  "const openModal = modal && !modal.classList.contains('hidden');\n" +
  "const mr = openModal && modal.querySelector('.modal-card') ? modal.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "return {\n" +
    "innerWidth: window.innerWidth,\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "tabCount: tabs.length,\n" +
    "tabsFitPanel: pr ? tabs.every((t) => { const r = t.getBoundingClientRect(); return r.left >= pr.left - 1 && r.right <= pr.right + 1; }) : false,\n" +
    "gridFits: grid ? (grid.left >= -1 && grid.right <= window.innerWidth + 1) : false,\n" +
    "cardFits: card ? (card.left >= -1 && card.right <= window.innerWidth + 1) : false,\n" +
    "modalOpen: Boolean(openModal),\n" +
    "modalCardFits: mr ? (mr.left >= -1 && mr.right <= window.innerWidth + 1 && mr.top >= -1 && mr.bottom <= window.innerHeight + 1) : false,\n" +
  "};\n" +
"})()");

const result = { emptyState: null, initialCards: null, resetFields: null, validation: null, created: null,
  canary: null, credValidation: null, credentialCreated: null, afterEsc: null, remaining: null,
  sizes: { grid: {}, modal: {} } };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#secretsGrid') && document.body.classList.contains('is-electron')");
      await js("window.location.hash = '#vault'");
      await wait("document.querySelector('#viewVault') && !document.querySelector('#viewVault').classList.contains('hidden')");
      await wait("!document.querySelector('#secretsGrid .vault-loading')");

      // 1. Fresh vault renders both legacy empty states.
      result.emptyState = await js("({ secrets: document.querySelector('#secretsGrid .vault-empty') ? document.querySelector('#secretsGrid .vault-empty').textContent.trim() : '', credentials: document.querySelector('#credentialsGrid .vault-empty') ? document.querySelector('#credentialsGrid .vault-empty').textContent.trim() : '' })");
      result.initialCards = await js("({ secrets: document.querySelectorAll('#secretsGrid .dashboard-card').length, credentials: document.querySelectorAll('#credentialsGrid .dashboard-card').length })");
      await shot("vault-empty-960x740");

      // 2. Stub only the vault routes. The mock GET deliberately returns the stored value and
      // its preview, so the DOM check proves the view strips them rather than merely receiving none.
      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__vaultSecrets = []; window.__vaultCredentials = []; window.__lastSecretGet = ''; window.__lastCredentialGet = '';\n" +
        "window.confirm = () => true;\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (!url.includes('/api/vault/')) return orig(input, init);\n" +
          "if (url.includes('/api/vault/secrets')) {\n" +
            "if (method === 'GET') { window.__lastSecretGet = JSON.stringify(window.__vaultSecrets); return json(window.__vaultSecrets); }\n" +
            "if (method === 'POST') { const body = JSON.parse((init && init.body) || '{}'); const s = { id: 'sec_' + (window.__vaultSecrets.length + 1), preview: body.value.slice(0,3) + '...' + body.value.slice(-3), ...body }; window.__vaultSecrets = [...window.__vaultSecrets, s]; return json(s, 201); }\n" +
            "if (method === 'DELETE') { const id = decodeURIComponent(url.split('/').slice(-1)[0]); window.__vaultSecrets = window.__vaultSecrets.filter((s) => s.id !== id && s.name !== id); return json({ success: true }); }\n" +
          "}\n" +
          "if (url.includes('/api/vault/credentials')) {\n" +
            "if (method === 'GET') { window.__lastCredentialGet = JSON.stringify(window.__vaultCredentials); return json(window.__vaultCredentials); }\n" +
            "if (method === 'POST') { const body = JSON.parse((init && init.body) || '{}'); const c = { id: 'cred_' + (window.__vaultCredentials.length + 1), ...body }; window.__vaultCredentials = [...window.__vaultCredentials, c]; return json(c, 201); }\n" +
            "if (method === 'DELETE') { const id = decodeURIComponent(url.split('/').slice(-1)[0]); window.__vaultCredentials = window.__vaultCredentials.filter((c) => c.id !== id && c.title !== id); return json({ success: true }); }\n" +
          "}\n" +
          "return json([]);\n" +
        "};\n" +
      "return true;\n" +
    "})()");

      // 3. Secret modal resets, validates inline, then creates a canary secret.
      await js("document.querySelector('#btnOpenAddSecret').click()");
      await wait("!document.querySelector('#addSecretModal').classList.contains('hidden')");
      result.resetFields = await js("({ name: document.querySelector('#secretName').value, value: document.querySelector('#secretValue').value, description: document.querySelector('#secretDescription').value, type: document.querySelector('#secretValue').type })");
      await js("document.querySelector('#btnSaveSecret').click()");
      await wait("document.querySelector('#vaultSecretFormError').textContent.includes('Please provide secret name and value')");
      result.validation = await js("document.querySelector('#vaultSecretFormError').textContent.trim()");
      await shot("vault-validation-960x740");

      await js(setInput('#secretName', 'GITHUB_TOKEN'));
      await js(setInput('#secretValue', 'S3CRET-CANARY'));
      await js(setInput('#secretDescription', 'deploy token'));
      await js("document.querySelector('#btnSaveSecret').click()");
      await wait("document.querySelectorAll('#secretsGrid .dashboard-card').length === 1");
      await wait("document.querySelector('#addSecretModal').classList.contains('hidden')");
      result.created = await js("({ title: document.querySelector('#secretsGrid .card-title').textContent.trim(), badge: document.querySelector('#secretsGrid .badge').textContent.trim(), mask: document.querySelector('#secretsGrid .vault-value-mask').textContent.trim(), valueAfterSave: document.querySelector('#secretValue').value })");
      result.canary = await js("({ served: window.__lastSecretGet.includes('S3CRET-CANARY'), previewServed: window.__lastSecretGet.includes('S3C...ARY'), inDom: document.body.innerHTML.includes('S3CRET-CANARY'), previewInDom: document.body.innerHTML.includes('S3C...ARY') })");
      await shot("vault-secret-created-960x740");

      // 4. Credential modal requires a username too, and clears its password field after save.
      await js("document.querySelector('#btnOpenAddCredential').click()");
      await wait("!document.querySelector('#addCredentialModal').classList.contains('hidden')");
      await js(setInput('#credTitle', 'AWS Production'));
      await js("document.querySelector('#btnSaveCredential').click()");
      await wait("document.querySelector('#vaultCredentialFormError').textContent.includes('account title and username')");
      result.credValidation = await js("document.querySelector('#vaultCredentialFormError').textContent.trim()");
      await js(setInput('#credUsername', 'admin@example.com'));
      await js(setInput('#credPassword', 'CRED-CANARY-PW'));
      await js(setInput('#credSites', 'aws.amazon.com, console.aws'));
      await js("document.querySelector('#btnSaveCredential').click()");
      await wait("document.querySelectorAll('#credentialsGrid .dashboard-card').length === 1");
      await wait("document.querySelector('#addCredentialModal').classList.contains('hidden')");
      result.credentialCreated = await js("({ title: document.querySelector('#credentialsGrid .card-title').textContent.trim(), username: document.querySelector('#credentialsGrid .badge').textContent.trim(), sites: document.querySelector('#credentialsGrid .card-desc').textContent.trim(), passwordAfterSave: document.querySelector('#credPassword').value, inDom: document.body.innerHTML.includes('CRED-CANARY-PW') })");
      await shot("vault-credential-created-960x740");

      // 5. Esc closes an open modal and wipes a typed value without saving.
      await js("document.querySelector('#btnOpenAddSecret').click()");
      await wait("!document.querySelector('#addSecretModal').classList.contains('hidden')");
      await js(setInput('#secretValue', 'TYPED-BUT-NEVER-SAVED'));
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#addSecretModal').classList.contains('hidden')");
      await js("document.querySelector('#btnOpenAddSecret').click()");
      await wait("!document.querySelector('#addSecretModal').classList.contains('hidden')");
      result.afterEsc = await js("({ value: document.querySelector('#secretValue').value, inDom: document.body.innerHTML.includes('TYPED-BUT-NEVER-SAVED') })");
      await js("document.querySelector('#addSecretModal .btn-close').click()");

      // 6. Delete both items with confirm, then refresh the grids.
      await js("document.querySelector('#secretsGrid .btn-del-sec').click()");
      await wait("document.querySelectorAll('#secretsGrid .dashboard-card').length === 0");
      await js("document.querySelector('#credentialsGrid .btn-del-cred').click()");
      await wait("document.querySelectorAll('#credentialsGrid .dashboard-card').length === 0");
      result.remaining = await js("({ secrets: document.querySelectorAll('#secretsGrid .dashboard-card').length, credentials: document.querySelectorAll('#credentialsGrid .dashboard-card').length, secretEmpty: document.querySelector('#secretsGrid .vault-empty') ? document.querySelector('#secretsGrid .vault-empty').textContent.trim() : '' })");

      // A card must be present while measuring the grid, so the card bounds are meaningful.
      await js("document.querySelector('#btnOpenAddSecret').click()");
      await wait("!document.querySelector('#addSecretModal').classList.contains('hidden')");
      await js(setInput('#secretName', 'LAYOUT_TOKEN'));
      await js(setInput('#secretValue', 'layout-only-value'));
      await js("document.querySelector('#btnSaveSecret').click()");
      await wait("document.querySelectorAll('#secretsGrid .dashboard-card').length === 1");

      // 7. Responsive checks, done between (never inside) the size loops.
      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        await shot("vault-grid-" + tag + "-" + width + "x" + height);
      }
      await js("document.querySelector('#btnOpenAddSecret').click()");
      await wait("!document.querySelector('#addSecretModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.modal[tag] = await measure();
        await shot("vault-modal-" + tag + "-" + width + "x" + height);
      }

      console.log("__VAULT_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[vault runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact vault view, modals, canary safety and layout at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-vault-home-");
  const ws = makeTempHome("opensand-vault-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Vault Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-vault-harness-"));
  const runner = path.join(tmpDir, "runner-vault.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = process.env.OPENSAND_VAULT_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-vault-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_VAULT_SHOT_DIR = proofDir;

  let stdout = "";
  let stderr = "";

  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], {
        cwd: ws,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (err) => { stderr += String(err); });
      return new Promise<number>((resolve) => {
        const watchdog = setTimeout(() => { child.kill("SIGKILL"); resolve(124); }, 180_000);
        child.on("close", (c) => { clearTimeout(watchdog); resolve(c ?? 0); });
      });
    });

    assert.strictEqual(code, 0, `vault runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__VAULT_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.strictEqual(res.emptyState.secrets, "No encrypted secrets stored.", "secrets empty state renders");
    assert.strictEqual(res.emptyState.credentials, "No account credentials stored.", "credentials empty state renders");
    assert.deepStrictEqual(res.initialCards, { secrets: 0, credentials: 0 }, "fresh vault has no cards");
    assert.deepStrictEqual(res.resetFields, { name: "", value: "", description: "", type: "password" }, "secret modal opens reset with a password field");
    assert.strictEqual(res.validation, "Please provide secret name and value.", "empty secret is rejected inline");
    assert.strictEqual(res.created.title, "GITHUB_TOKEN", "created secret card shows the name");
    assert.strictEqual(res.created.badge, "Encrypted", "created secret card has the Encrypted badge");
    assert.strictEqual(res.created.mask, "••••••••", "secret card shows the constant mask");
    assert.strictEqual(res.created.valueAfterSave, "", "secret value is cleared from state after save");
    assert.strictEqual(res.canary.served, true, `GET response really contained the canary value (${JSON.stringify(res.canary)})`);
    assert.strictEqual(res.canary.previewServed, true, "GET response really contained a leaked preview");
    assert.strictEqual(res.canary.inDom, false, "canary value never appears in the DOM");
    assert.strictEqual(res.canary.previewInDom, false, "leaked preview never appears in the DOM");
    assert.strictEqual(res.credValidation, "Please provide account title and username.", "credential requires a username");
    assert.ok(res.credentialCreated.title.includes("AWS Production"), "credential card shows the title");
    assert.strictEqual(res.credentialCreated.username, "admin@example.com", "credential card shows the username");
    assert.ok(res.credentialCreated.sites.includes("aws.amazon.com, console.aws"), "credential card shows parsed sites");
    assert.strictEqual(res.credentialCreated.passwordAfterSave, "", "credential password is cleared from state after save");
    assert.strictEqual(res.credentialCreated.inDom, false, "credential password never appears in the DOM");
    assert.deepStrictEqual(res.afterEsc, { value: "", inDom: false }, "Esc closes the modal and wipes a typed value");
    assert.deepStrictEqual(res.remaining, { secrets: 0, credentials: 0, secretEmpty: "No encrypted secrets stored." }, "delete refreshes both grids");

    for (const kind of ["grid", "modal"] as const) {
      for (const [tag, width, height] of [["compact", 960, 740], ["wide", 1920, 1080]] as const) {
        const size = res.sizes[kind][tag];
        assert.ok(size, `${kind} ${tag} ${width}x${height} metrics present`);
        assert.strictEqual(size.noOverflow, true, `${kind} ${tag}: zero horizontal overflow (${size.scrollWidth} <= ${size.innerWidth})`);
        assert.strictEqual(size.tabCount, 4, `${kind} ${tag}: all four Capabilities tabs render`);
        assert.strictEqual(size.tabsFitPanel, true, `${kind} ${tag}: subnav tabs stay inside their panel`);
        assert.strictEqual(size.gridFits, true, `${kind} ${tag}: secrets grid fits the window`);
        if (kind === "grid") {
          assert.strictEqual(size.cardFits, true, `${kind} ${tag}: secret card fits the window`);
        } else {
          assert.strictEqual(size.modalOpen, true, `${kind} ${tag}: add secret modal is open`);
          assert.strictEqual(size.modalCardFits, true, `${kind} ${tag}: modal card fits the window`);
        }
      }
    }

    console.log("[proof] vault real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
