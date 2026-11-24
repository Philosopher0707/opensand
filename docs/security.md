# Security Architecture & Threat Model

OpenSand follows a defense-in-depth model for running AI agent software locally.

## Local Server Threat Model

1. **Loopback Only (`127.0.0.1`):** The desktop server binds strictly to the loopback interface on an ephemeral port. It rejects all non-loopback connections.
2. **Session Authentication:** All REST and SSE endpoints require authentication via an ephemeral token or an `HttpOnly`, `SameSite=Strict` cookie.
3. **Content Security Policy (CSP):** The renderer enforces strict CSP restricting scripts to trusted origins and preventing inline script injection.
4. **Secret Redaction:** The vault automatically redacts API keys and tokens from transcripts, SSE streams, and logs before rendering.
5. **Fail-Closed Execution Gate:** Shell execution and mutating file operations must be approved before execution.

## CI security gates and local scans

`ci.yml`'s `security-gates` job runs on every PR in parallel with the build jobs: `pnpm audit --audit-level=high --prod` (blocking) and a full-history gitleaks scan. Re-run both locally before pushing:

```bash
pnpm audit --audit-level=high --prod

# gitleaks v8.30.1 — Apple Silicon (Linux x64: replace darwin_arm64 with linux_x64)
curl -fsSLO https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz
echo "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5  gitleaks_8.30.1_darwin_arm64.tar.gz" | shasum -a 256 -c -
tar -xzf gitleaks_8.30.1_darwin_arm64.tar.gz
./gitleaks detect --no-banner --redact --config .gitleaks.toml
```

The CI job uses `gitleaks_8.30.1_linux_x64.tar.gz` with checksum `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`. Synthetic fixtures are ignored **per finding** in `.gitleaksignore`: 12 exact commit/file/rule/line fingerprints, each with a comment. There is no whole-file allowlist, so a new secret planted in one of those fixture files gets a new fingerprint and fails the scan.
