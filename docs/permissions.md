# Permissions, Policies, and Safety Gates

OpenSand operates with strict fail-closed safety semantics. Every tool call is judged by what it does — its declared **effect** — not by the tool's name. A request with no effect, or an effect OpenSand does not recognise, is always asked, in every mode.

## Approval Modes

Three modes decide what runs without a prompt. `ask` is the default.

| Mode | UI label | Runs without asking |
| --- | --- | --- |
| `ask` (default) | Ask every time | Nothing that changes state. Every mutating tool asks. **Always allow this effect in this task** still works. |
| `auto_edit` | Auto-edit | File edits, sandboxed shell commands, sub-agents, and sandboxed engine runs. Unsandboxed shell, network, browser, memory, connectors and git commits still ask. |
| `auto` | Auto-approve | Everything above, plus unsandboxed shell, network, browser, memory, connectors and git commits. Sandbox network is on by default. The hard stops below still ask. |

`-y` / `--auto-approve` selects `auto` when no explicit mode is set. The mode lives in the session and settings; the Stop button remains the kill switch. There are no time-bound grants, typed confirmations or separate audit stores — approvals are recorded in the normal session events.

## Declared Effects

Tools and engine drivers name one of these effects. The mode is applied to the effect, so renaming a tool does not change the decision.

| Effect | Meaning |
| --- | --- |
| `read` | Reads only. |
| `edit` | Edits files in the workspace. Recorded and undoable. |
| `shell` | Runs a command in the sandbox. Writes only in the workspace. |
| `delegate` | Starts sub-agents in their own git worktree. |
| `engine_run` | Lets an engine work on this task. In `auto_edit`, only when the engine is sandboxed. |
| `shell_outside` | Runs a command outside the sandbox, as your user. See the escape hatch below. |
| `network` | Opens a web address or sends a search. |
| `browser` | Acts in the browser window. |
| `memory` | Changes long-term memory. |
| `external` | Acts through a connector, outside this computer. |
| `vcs` | Commits in git. |
| `control` | Controls the Mac: screen, mouse and keyboard. |
| `spend` | Spends money. |
| `self` | Changes OpenSand itself: skills, connectors and automations. |

## Hard Stops — Prompt in Every Mode

These always ask, even in `auto`:

- **Control** (`control`) — controlling the Mac through accessibility: screen, mouse and keyboard.
- **Spend** (`spend`) — financial transactions and anything that spends money.
- **Self** (`self`) — modifying OpenSand core, persistent skills or the daemon.
- **Tainted shell** — any shell command run after the task read untrusted external content from the web or a connector. The approval card says web content was read earlier in the run and hides **Always Allow** for that request.

Two other gates stay in every mode: destructive shell commands (`rm -rf /`, raw disks, fork bombs) and any tool the policy engine marks `REQUIRE_APPROVAL` always prompt. Skill writes and mounts, and memory writes, also need a human yes unless `--auto-approve-persistent` is set.

## Escape Hatch: `shell_outside`

`exec_command` declares `shell_outside` when it runs with `unsandboxed: true`, executing the command outside the sandbox as your user. This is a separate permission, named and keyed separately from `shell`. It needs its own approval in every mode, including `auto`, and **Always Allow** can never grant it: the button is hidden on the card and the daemon refuses to write such a grant. An "always" grant for ordinary `shell` does not cover `shell_outside`.

The sandbox allows network access by default. Writes are confined to the workspace, temp directories and tool caches, and secret paths stay denied. Network is denied only for a tainted or unattended run.

## Standing Grants

Standing permission lives only in `~/.opensand/grants.json`, managed by `GrantsStore`. Each grant is one tool and a scope (a path prefix, a command prefix such as `git *`, or a domain), a lifetime (`once`, `mission`, `folder` or `always`) and the epoch it was created at. New grants also carry the declared effect, and that is what the mode matches on.

Answering **Always allow** on a shell approval writes an `exec_command` grant: `<binary> *` for an ordinary binary, the exact command for an interpreter or high-privilege binary (`bash`, `node`, `python`, `sudo`, `rm`, `curl`, …), so those never become blanket grants. Chained commands (`&&`, `;`, `|`, backticks, `$(`) are never allowed by scope. `shell_outside` and the hard-stop effects are never granted this way.

Revoking a grant removes it and raises the epoch by one. An approval answered with an older epoch is rejected with code `4001` and grants nothing.

A pre-existing `standing-allowlist.json` is migrated once, on the daemon's first permission read: its patterns become `always` `exec_command` grants and the file is renamed aside, never deleted. If the epoch shows a revoke already happened, the file is archived without importing, because it cannot say which entries were revoked.

## Workspace Undo

Every turn that mutates workspace files automatically creates a snapshot manifest in `.opensand-snapshots/`. Clicking **Undo** restores deleted and modified files to their exact pre-turn state and deletes any untracked files generated during the turn.

## Settings & UI

Open **Settings → Approval Mode** and pick one of:

- **Ask every time** (`ask`)
- **Auto-edit files & sandboxed shell** (`auto_edit`)
- **Auto-approve all actions with network** (`auto`)

The current mode is shown as a three-state badge in the header and as text in the composer: **Safe Mode** for `ask`, **Auto-Edit** for `auto_edit`, **Auto-Approve** for `auto`. The header badge button cycles through the three modes in that order.

For scripted runs, `opensand -y --auto-approve-persistent "your query"` auto-approves persistent changes too. That flag is off by default and must never be enabled implicitly, so a model cannot plant lasting prompt instructions or memories just because a session runs with `-y`.
