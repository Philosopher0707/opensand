# A bundled-artifact preflight that tests only an existing file fails open

- **Trap:** `scripts/engine-smoke.sh` refused a legacy bundle with
  `if [[ -f "$UNPACKED_MAIN_JS" ]] && ! grep -q "OPENSAND_STATE_DIR" ...; then
  exit 2; fi`. A bundle missing `Contents/Resources/app/dist/src/main.js`
  skipped the guard entirely, wrote config into the host state and launched the
  executable. Vega found it on PR #256 head `d0adee9`.
- **Root Cause:** the guard encoded "if the file exists and is old, reject" but
  the property it protects is "the bundle must prove it supports isolated
  state". A missing file proves nothing, so the condition must reject it too.
  Testing only the shapes seen so far turns an unknown artifact into a pass.
- **Rule:** a preflight for a required artifact fails closed: missing and
  invalid are both a rejection with the same non-zero exit, and its test asserts
  the exit code *and* that no launch side effect happened (a marker file the
  mock executable would write). A test that checks only the exit code can miss
  the app starting behind it.
