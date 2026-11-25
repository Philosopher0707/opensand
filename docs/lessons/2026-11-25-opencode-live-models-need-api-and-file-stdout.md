# OpenCode live model discovery needs its API command and file-backed stdout

- **Trap:** `opencode models --verbose` is rejected by OpenCode v2, while `opencode models` prints nothing without a TTY. Piping `opencode api model.list` through Node also truncated the JSON around 128–256 KiB, so discovery silently used the fallback.
- **Root Cause:** The human-oriented `models` command is TTY-sensitive, and this Bun-compiled CLI does not reliably flush large stdout pipes in Node child processes.
- **Rule:** Use `opencode api model.list` as the non-interactive live listing, redirect child stdout to a temporary file, and parse only `providerID` + `modelID` + `name`. Keep the fallback minimal and use it only when the live command fails.
