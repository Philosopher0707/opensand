# A test-name skip pattern cannot keep real-window files from launching locally

**Trap:** The pre-commit command `node --test --test-skip-pattern='[Rr]eal-[Ww]indow|[Rr]eal-[Ee]lectron' 'dist/test/**/*.test.js'` passed the composer file in 128 ms (skipped) but still launched `chat-real-window.test.js`: its tests are named `Chat turn ... in the real window` and `Chat turn shows the stopped state ...` — "real window" with a space or no marker at all. On this Mac, without a windows harness, both failed and blocked the commit.

**Root Cause:** `--test-skip-pattern` filters test *names*, not file paths. The pattern covered `real-window` and `real-Electron` names but not `real window` (space), `real Preact window/renderer`, or test names with no real-window wording inside a real-window file. A case-tolerant name pattern still cannot express "every test in these files".

**Rule:** For a local pre-commit run that must not open windows, exclude by file path, not by test name: `cd packages/desktop && node --test --test-skip-pattern="..." $(find dist/test -name "*.test.js" ! -name "*real*" | sort)`. Keep `--test-skip-pattern` before the file list as defence in depth, and prove the exclusion with a `grep -i real` check on the expanded file list before relying on it. Never use `--no-verify` to get around a test that launches a window.
