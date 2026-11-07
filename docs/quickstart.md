# OpenSand Quickstart Guide

Get up and running with OpenSand in under two minutes.

## 1. First Run & Model Setup

When you first launch OpenSand, it performs an automatic local check:

- **Local Ollama (Zero Config):** If Ollama is running on your Mac (`127.0.0.1:11434`), OpenSand connects immediately with zero configuration.
- **Custom Endpoint / Cloud Key:** If no local model is found, OpenSand displays the setup screen asking for:
  - Provider endpoint (e.g. OpenAI, OpenRouter, Anthropic, or custom local server).
  - Model name (e.g. `llama3.2`, `claude-3-5-sonnet`, `gpt-4o`).
  - API Key (stored directly into OpenSand's encrypted local vault, never in plaintext).

## 2. Your First Turn

OpenSand opens into your workspace view. Try typing:

> "Scan the current workspace and summarize the project structure."

OpenSand will read directory contents and describe the files.

## 3. Tool Approvals & Safety

When OpenSand needs to run shell commands or edit files:
- An **Approval Card** appears in the conversation showing the exact command or file diff.
- Click **Approve Once** to allow that single step, or **Reject** to stop execution.
- If an action was unexpected, click the **Undo** button in the canvas to restore your workspace byte-for-byte.

## 4. Next Steps

- Explore specialized agent templates in the **Template Gallery**.
- Set up autonomous background checks in **Routines**.
- Review long-term facts learned by the agent in **Memory**.
