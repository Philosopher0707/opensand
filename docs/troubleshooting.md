# Troubleshooting & Diagnostics

## OpenSand Doctor

Run the built-in diagnostic suite to verify daemon health, local model availability, and permissions:

```bash
opensand doctor
```

Or generate a structured JSON report for bug filing:

```bash
opensand doctor --json
```

## Common Issues & Fixes

### 1. "Ollama Unreachable (ECONNREFUSED 127.0.0.1:11434)"
- **Cause:** Local Ollama daemon is stopped.
- **Fix:** Launch Ollama from Applications or run `ollama serve` in a terminal window.

### 2. "Authentication Failed (401 Unauthorized)"
- **Cause:** The provider API key is missing or expired.
- **Fix:** Navigate to Settings in OpenSand and re-enter your API key.

### 3. "Execution Timeout"
- **Cause:** A long-running command (e.g. large build or test suite) exceeded the per-turn limit.
- **Fix:** Run large builds in a separate terminal or specify a timeout option.

### 4. "State Schema Downgrade Refused"
- **Cause:** The state directory was updated by a newer version of OpenSand.
- **Fix:** Update your OpenSand installation to match or exceed the version that created the state.
