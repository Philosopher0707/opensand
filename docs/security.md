# Security Architecture & Threat Model

OpenSand follows a defense-in-depth model for running AI agent software locally.

## Local Server Threat Model

1. **Loopback Only (`127.0.0.1`):** The desktop server binds strictly to the loopback interface on an ephemeral port. It rejects all non-loopback connections.
2. **Session Authentication:** All REST and SSE endpoints require authentication via an ephemeral token or an `HttpOnly`, `SameSite=Strict` cookie.
3. **Content Security Policy (CSP):** The renderer enforces strict CSP restricting scripts to trusted origins and preventing inline script injection.
4. **Secret Redaction:** The vault automatically redacts API keys and tokens from transcripts, SSE streams, and logs before rendering.
5. **Fail-Closed Execution Gate:** Shell execution and mutating file operations must be approved before execution.
