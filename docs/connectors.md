# Service Connectors

OpenSand integrates with external developer and team productivity tools via OAuth and personal access tokens.

## Supported Connectors

### 1. GitHub
- **Capabilities:** Read repository issues, open pull requests, comment on PRs, review code changes.
- **Setup:** Connect via OAuth or supply a Personal Access Token (`ghp_...`) with `repo` scope.

### 2. Linear
- **Capabilities:** List active sprint issues, create bug reports, update ticket status, assign teammates.
- **Setup:** Connect via OAuth or Personal API Key (`lin_api_...`).

### 3. Slack
- **Capabilities:** Search public channel messages, post status updates, draft discussion threads.
- **Setup:** Connect using user OAuth token (`xoxp-...`).

## Security & Storage

All connector tokens are encrypted using AES-256-GCM via the local Vault store (`~/.opensand/vault/`). Tokens are decrypted only in memory when making authenticated HTTPS requests and are never written to transcripts or logs.
