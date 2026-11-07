# OpenSand Changelog

All notable changes to OpenSand will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.1.0] - 2026-11-07

### Added
- Native Electron desktop shell with ephemeral port allocation and single-instance locking.
- Self-contained packaging via `electron-builder` producing signed `.dmg` and `.zip` distribution bundles.
- Zero-config first run with local Ollama detection and graceful fallback onboarding form.
- Vault-backed API key storage with automatic redaction in transcripts and logs.
- Automatic versioning and ordered migrations for `~/.opensand/state` with backup-before-migrate safety.
- Comprehensive diagnostic suite (`opensand doctor --json`) and clean uninstall path (`opensand uninstall`).
- Error taxonomy mapping provider and system errors to user-actionable causes and next steps.
- Per-turn workspace undo snapshots with byte-identical restoration.
- Session management: full-text search, rename, and export to Markdown or JSON.
- Automated 20-scenario chaos suite verifying resilient error handling and crash safety.
- Complete documentation suite (Install, Quickstart, Permissions, Connectors, Troubleshooting, Privacy, Security).

### Security
- Loopback binding (`127.0.0.1`) with HttpOnly session cookies and origin verification.
- Content Security Policy (CSP) blocking inline scripts and unauthorized external network origins.
- AST-level validation on bash commands requiring explicit approvals for dangerous shell constructs.
