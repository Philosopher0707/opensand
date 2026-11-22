// Local encrypted vault view (Phase 5 Row 16).
// Stored values are never rendered: the data layer strips them and cards show a fixed mask.
import { useEffect, useState } from "preact/hooks";
import type {
  ShellData,
  VaultSecret,
  VaultCredential,
  SecretInput,
  CredentialInput,
} from "../data";
import {
  SECRET_EMPTY_STATE,
  CREDENTIAL_EMPTY_STATE,
  validateSecretInput,
  validateCredentialInput,
  parseSites,
  secretCardView,
  credentialCardView,
} from "../../../src/shell/vault-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface VaultViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

type Modal = "secret" | "credential" | null;
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function VaultView({ data, active, onSelect, refreshKey }: VaultViewProps) {
  const [secrets, setSecrets] = useState<VaultSecret[]>([]);
  const [credentials, setCredentials] = useState<VaultCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [title, setTitle] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sites, setSites] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Password inputs are the only place a typed value lives; clear them on every close.
  const clearSecretsFromState = () => {
    setValue("");
    setPassword("");
  };
  const closeModal = () => {
    clearSecretsFromState();
    setSecretError(null);
    setCredentialError(null);
    setModal(null);
  };
  const openSecret = () => {
    setName("");
    clearSecretsFromState();
    setDescription("");
    setSecretError(null);
    setModal("secret");
  };
  const openCredential = () => {
    setTitle("");
    setUsername("");
    clearSecretsFromState();
    setSites("");
    setCredentialError(null);
    setModal("credential");
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [secretList, credentialList] = await Promise.all([data.getSecrets(), data.getCredentials()]);
        if (cancelled) return;
        setSecrets(Array.isArray(secretList) ? secretList : []);
        setCredentials(Array.isArray(credentialList) ? credentialList : []);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, refreshKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === "Escape" || event.key === "Esc") && modal) closeModal();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const reload = async () => {
    try {
      const [secretList, credentialList] = await Promise.all([data.getSecrets(), data.getCredentials()]);
      setSecrets(Array.isArray(secretList) ? secretList : []);
      setCredentials(Array.isArray(credentialList) ? credentialList : []);
    } catch {
      // Keep the last successful lists on a refresh failure.
    }
  };

  const saveSecret = async () => {
    const input: SecretInput = { name, value, description };
    const validation = validateSecretInput(input);
    if (validation) {
      setSecretError(validation);
      return;
    }
    setSaving(true);
    setSecretError(null);
    try {
      await data.createSecret(input);
      closeModal();
      await reload();
    } catch (err) {
      setSecretError(errorMessage(err));
      clearSecretsFromState();
    } finally {
      setSaving(false);
    }
  };

  const saveCredential = async () => {
    const input: CredentialInput = { title, username, password, sites: parseSites(sites) };
    const validation = validateCredentialInput(input);
    if (validation) {
      setCredentialError(validation);
      return;
    }
    setSaving(true);
    setCredentialError(null);
    try {
      await data.createCredential(input);
      closeModal();
      await reload();
    } catch (err) {
      setCredentialError(errorMessage(err));
      clearSecretsFromState();
    } finally {
      setSaving(false);
    }
  };

  const deleteSecret = async (secret: VaultSecret) => {
    if (!window.confirm(`Delete secret "${secret.name}"?`)) return;
    try {
      await data.deleteSecret(secret.id);
      await reload();
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  };

  const deleteCredential = async (credential: VaultCredential) => {
    if (!window.confirm(`Delete credential "${credential.title}"?`)) return;
    try {
      await data.deleteCredential(credential.id);
      await reload();
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  };

  const capabilities = NAV_GROUPS.find((group) => group.id === "capabilities");

  return (
    <div id={viewPanelId("vault")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container vault-view-container">
        {capabilities && (
          <nav class="subnav-tabs" data-group={capabilities.id} aria-label="Capabilities views">
            {capabilities.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "vault" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "vault" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">Local Encrypted Secrets Vault</div>
            <div class="dashboard-subtitle">Encrypted at rest. Stored values are never displayed.</div>
          </div>
          <div class="vault-header-actions">
            <button id="btnOpenAddSecret" type="button" class="btn btn-primary" onClick={openSecret}>+ Add Secret</button>
            <button id="btnOpenAddCredential" type="button" class="btn btn-secondary" onClick={openCredential}>+ Add Credential</button>
          </div>
        </div>

        {loadError && (
          <div class="vault-error" role="alert">
            <span>Could not load vault: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}

        <h3 class="vault-section-title">Encrypted Secrets</h3>
        <div class="card-grid" id="secretsGrid">
          {loading ? (
            <div class="vault-loading">Loading secrets…</div>
          ) : secrets.length === 0 ? (
            <div class="vault-empty">{SECRET_EMPTY_STATE}</div>
          ) : (
            secrets.map((secret) => {
              const card = secretCardView(secret);
              return (
                <div class="dashboard-card vault-card" key={secret.id}>
                  <div class="card-top">
                    <div class="card-title">{card.name}</div>
                    <span class="badge badge-success">Encrypted</span>
                  </div>
                  <div class="card-desc">{card.description}</div>
                  <div class="card-meta"><span class="vault-value-mask">{card.mask}</span></div>
                  <div class="card-footer">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-del-sec"
                      onClick={() => void deleteSecret(secret)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <h3 class="vault-section-title">Account Credentials</h3>
        <div class="card-grid" id="credentialsGrid">
          {loading ? (
            <div class="vault-loading">Loading credentials…</div>
          ) : credentials.length === 0 ? (
            <div class="vault-empty">{CREDENTIAL_EMPTY_STATE}</div>
          ) : (
            credentials.map((credential) => {
              const card = credentialCardView(credential);
              return (
                <div class="dashboard-card vault-card" key={credential.id}>
                  <div class="card-top">
                    <div class="card-title">{card.title}</div>
                    <span class="badge">{card.username}</span>
                  </div>
                  <div class="card-desc"><strong>Sites:</strong> {card.sites}</div>
                  <div class="card-meta"><span class="vault-value-mask">{card.mask}</span></div>
                  <div class="card-footer">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-del-cred"
                      onClick={() => void deleteCredential(credential)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="addSecretModal"
        class={`modal-overlay${modal === "secret" ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="addSecretModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="addSecretModalTitle">Store Secret in Encrypted Vault</h3>
            <button type="button" class="btn-close" aria-label="Close add secret dialog" onClick={closeModal}>&times;</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="secretName">Secret Name</label>
              <input
                type="text"
                id="secretName"
                class="form-control"
                placeholder="e.g. GITHUB_TOKEN"
                value={name}
                onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="secretValue">Secret Value</label>
              <input
                type="password"
                id="secretValue"
                class="form-control"
                autocomplete="new-password"
                placeholder="••••••••"
                value={value}
                onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="secretDescription">Description (optional)</label>
              <input
                type="text"
                id="secretDescription"
                class="form-control"
                placeholder="Production deployment token"
                value={description}
                onInput={(e) => setDescription((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div id="vaultSecretFormError" class="vault-form-error" role={secretError ? "alert" : undefined}>
              {secretError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button id="btnSaveSecret" type="button" class="btn btn-primary" disabled={saving} onClick={() => void saveSecret()}>
              {saving ? "Saving..." : "Encrypt & Save"}
            </button>
          </div>
        </div>
      </div>

      <div
        id="addCredentialModal"
        class={`modal-overlay${modal === "credential" ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="addCredentialModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="addCredentialModalTitle">Store Account Credential</h3>
            <button type="button" class="btn-close" aria-label="Close add credential dialog" onClick={closeModal}>&times;</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="credTitle">Account Title</label>
              <input
                type="text"
                id="credTitle"
                class="form-control"
                placeholder="e.g. AWS Production Console"
                value={title}
                onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="credUsername">Username / Email</label>
              <input
                type="text"
                id="credUsername"
                class="form-control"
                value={username}
                onInput={(e) => setUsername((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="credPassword">Password / Secret Key</label>
              <input
                type="password"
                id="credPassword"
                class="form-control"
                autocomplete="new-password"
                placeholder="••••••••"
                value={password}
                onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="credSites">Websites / Domains (comma-separated)</label>
              <input
                type="text"
                id="credSites"
                class="form-control"
                value={sites}
                onInput={(e) => setSites((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div id="vaultCredentialFormError" class="vault-form-error" role={credentialError ? "alert" : undefined}>
              {credentialError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button id="btnSaveCredential" type="button" class="btn btn-primary" disabled={saving} onClick={() => void saveCredential()}>
              {saving ? "Saving..." : "Save Credential"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
