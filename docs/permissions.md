# Permissions, Policies, and Safety Gates

OpenSand operates with strict fail-closed safety semantics.

## The Approval Gate

Every potentially consequential tool execution passes through the local execution daemon:

1. **Read-Only Tools:** Safe inspection tools (`read_file`, `list_directory`, `get_env`) execute automatically without interrupting the user.
2. **Mutating Tools:** Operations that modify local files (`write_file`, `edit_file`) trigger an inline diff review card with approval options.
3. **Execution Tools:** Shell commands (`exec_command`) are analyzed by the AST validator. Dangerous or destructive commands (`rm -rf`, piped curl/bash, sudo) always require explicit confirmation.
4. **Network & Connectors:** Outbound API calls to external services (GitHub, Slack, Linear) require user authorization.

## Standing Allowlist

Users can mark safe directories or command prefixes as standing allowlists in Settings. However, chained commands (`&&`, `;`, `|`) are never automatically allowed by prefix.

## Workspace Undo

Every turn that mutates workspace files automatically creates a snapshot manifest in `.opensand-snapshots/`. Clicking **Undo** restores deleted and modified files to their exact pre-turn state and deletes any untracked files generated during the turn.
