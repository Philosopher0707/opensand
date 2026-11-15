# Permissions, Policies, and Safety Gates

OpenSand operates with strict fail-closed safety semantics.

## The Approval Gate

Every potentially consequential tool execution passes through the local execution daemon:

1. **Read-Only Tools:** Safe inspection tools (`read_file`, `list_directory`, `get_env`) execute automatically without interrupting the user.
2. **Mutating Tools:** Operations that modify local files (`write_file`, `edit_file`) trigger an inline diff review card with approval options.
3. **Execution Tools:** Shell commands (`exec_command`) are analyzed by the AST validator. Dangerous or destructive commands (`rm -rf`, piped curl/bash, sudo) always require explicit confirmation.
4. **Network & Connectors:** Outbound API calls to external services (GitHub, Slack, Linear) require user authorization.

## Standing Grants

Standing permission lives only in `~/.opensand/grants.json`, managed by `GrantsStore`. Each grant is one tool plus a scope (a path prefix, a command prefix such as `git *`, or a domain), a lifetime (`once`, `mission`, `folder` or `always`) and the epoch it was created at.

Answering **Always allow** on a shell approval writes an `exec_command` grant: `<binary> *` for an ordinary binary, the exact command for an interpreter or high-privilege binary (`bash`, `node`, `python`, `sudo`, `rm`, `curl`, …), so those never become blanket grants. Chained commands (`&&`, `;`, `|`, backticks, `$(`) are never allowed by scope.

Revoking a grant removes it and raises the epoch by one. An approval answered with an older epoch is rejected with code `4001` and grants nothing.

A pre-existing `standing-allowlist.json` is migrated once, on the daemon's first permission read: its patterns become `always` `exec_command` grants and the file is renamed aside, never deleted. If the epoch shows a revoke already happened, the file is archived without importing, because it cannot say which entries were revoked.

## Workspace Undo

Every turn that mutates workspace files automatically creates a snapshot manifest in `.opensand-snapshots/`. Clicking **Undo** restores deleted and modified files to their exact pre-turn state and deletes any untracked files generated during the turn.

## Auto-Approve Mode and Persistent Safety Gates

Running OpenSand with `-y` or `--auto-approve` enables non-interactive auto-approval for ordinary tool calls (`exec_command`, local edits). However, **persistent changes that survive the session require explicit human approval**:

1. **Skill Writes and Mounts:** `add_skill` and `mount_skill` turn text into standing instructions obeyed in every future turn. `-y` does not auto-approve them. In interactive sessions, OpenSand prompts the user. When no human approver is present (piped or non-interactive execution), persistent writes are refused.
2. **Memory Writes:** `update_memory` (user/agent scope) and `import_memory` persist memories across future sessions. `-y` does not auto-approve them.

### Explicit Opt-In: `--auto-approve-persistent`

To auto-approve persistent state modifications in automated or scripted environments, an explicit opt-in must be provided:

```bash
opensand -y --auto-approve-persistent "your query"
```

This flag is off by default and must never be enabled implicitly. It ensures an AI model cannot plant lasting prompt instructions or persistent memories merely because a session runs with `-y`.
