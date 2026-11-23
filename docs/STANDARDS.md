# OpenSand Development Standards

Every bot reads this before a job. It gathers rules that already exist in the repo, plus standards the CTO set.
Sources: `docs/lessons/INDEX.md`, `scripts/README.md`, `AGENTS_LEARNING.md`.
Build dimensions: `~/SKILLS/engineering-workflow/references/build-dimensions.md` (outside the repo).
CTO standards set 2026-11-23.

---

## 1. Definition of done

A brief's **Done when** must answer all 14 build dimensions. Each answer is a test, a check, or a written
"n/a because …". "It builds" is not an answer.

| # | Dimension | Proof |
|---|---|---|
| 1 | Happy path in the shipped artifact | e2e or packaged-app check |
| 2 | Failure paths: provider 401/402/403/404/429/5xx, offline, timeout, bad input | stub server through the real client; plain message plus next step |
| 3 | Recovery after a failure, crash or restart; state stays consistent | test: error, then a second action succeeds |
| 4 | Cancel, retries, backoff, timeouts, size and rate caps | real signal or abort test |
| 5 | UI states: empty, loading, progress, disabled, error; keyboard and accessibility | screenshot or DOM test per state |
| 6 | Wiring: every new export called and reachable | dead-export check; click-through |
| 7 | Security and privacy: no logged or committed secrets, fail closed, untrusted input stays data | secret scan; deny-path test |
| 8 | Data safety: migrations, backups, no deletion of committed data | migration test on a copy |
| 9 | Performance and cost: latency, tokens, disk, memory, budget | measured number before and after |
| 10 | Compatibility: macOS/Linux, versions, old data, upgrade path | CI parity run |
| 11 | Observability: logs explain what happened without secrets | log line asserted in a test |
| 12 | Tests and gates: a regression test or gate stops this coming back | test name; mutation probe |
| 13 | Docs and wording: plain words, no CLI flags in the desktop app, changelog | review |
| 14 | Release: version, packaging, install, health check, rollback | `release.sh` plus install check |

Failure paths are part of done, not follow-up work. Cover provider errors, offline, timeout, cancel, empty
and loading states, and recovery. Every new export is wired and reachable: an uncalled function is unfinished.

---

## 2. Workflow

- One job per PR. Never mix unrelated changes.
- Work in a worktree created by `scripts/worktree.sh new <job-name>`, under `~/dev/_scratch/`. Never in the
  owner checkout (`~/dev/opensand`) or the base clone.
- While coding, test only the packages you touched.
- Once before the PR, run the full gate, with output captured to a file and the exit code printed:
  `TMPDIR=$(mktemp -d) SKIP_INSTALL=1 bash scripts/verify.sh > log 2>&1; echo $?`
  Do not pipe it through `tail` and do not re-run a passing check.
- Never use `--no-verify`. If a hook is flaky, fix or narrow it in the same change.
- No lockfile or `.github/` changes without the owner: `scripts/pr-gate.sh` refuses them unless overridden.
- Never touch `~/dev/opensand`, `~/.opensand` or real chats. Use isolated state and test accounts.
- Save with `scripts/worktree.sh save "<message>"`: it stages explicit paths, scans for secrets, commits with
  hooks on, pushes, and opens a draft PR on the first push. Run `gh pr ready <N>` when the work is ready;
  `pr-gate.sh` refuses drafts.

---

## 3. Evidence

A report lists each changed file with line ranges and the symbols changed, plus real command output. Paste
the actual `echo $?` and test output, not a summary of it.

A claim is not proof: Rigel re-runs the tests on the PR head before merge (CTO standard, 2026-11-23).
Any mismatch between the report and the code is a failed job. Prove a new or changed gate twice — it passes on good input and fails on
deliberately broken input — on the same Node major CI uses. A test that has never failed is not proven.

---

## 4. Review

- Rigel does the final verification: `scripts/pr-gate.sh` checks CI, base freshness, diff hygiene, a checkpoint
  tag, then merges. Local green is not CI green; read the actual CI run.
- Vega reviews security for anything touching IPC, the local API, shell or tool execution, approvals, keys or
  vendored code (CTO standard, 2026-11-23). Permission checks fail closed: a command runs only with a standing
  grant or an explicit approval, never silently.

---

## 5. Learning

- Every bug the owner finds that the tests missed becomes a regression test or gate in the same PR.
- Log each hurdle the same day in `AGENTS_LEARNING.md`: what happened, the cause, and the rule that prevents it.
  New lessons are one file per entry in `docs/lessons/`; regenerate the index with `scripts/lessons-index.sh`.
- A rule that repeats becomes a script or automatic check, not a line someone must remember.

---

## 6. Errors users see

Show a plain cause and a next step — never a stack trace or raw JSON. Route errors through `classifyError`
in `packages/coordinator/src/errors.ts`, which returns `cause` and `nextAction` (CTO standard, 2026-11-23).
It is not wired in yet; the provider-error PR is wiring it. Never show CLI flags inside the desktop app:
describe the action in Settings, not a command to type.
