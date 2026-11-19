# Quote `?ref=main` URLs in zsh — an unquoted `?` glob aborts the whole command

- **Trap:** Fetching a file's content on main with the GitHub REST API, as in
  `gh api repos/OWNER/REPO/contents/path?ref=main`, failed immediately in zsh
  with `zsh: no matches found: repos/OWNER/REPO/contents/path?ref=main` before
  `gh` ever ran, so the check looked like an API failure but was only the shell.
- **Root Cause:** In zsh, an unquoted `?` is a glob character; when it matches
  nothing in the working directory, the default `NOMATCH` behavior aborts the
  entire command line (the same rule that bites unmatched `*` globs in cleanup
  commands).
- **Rule:** Quote every URL that carries query syntax — put
  `'path?ref=main'` (or the whole URL) in single quotes in zsh and in any
  scripted check that runs under the user's shell. Rule from the Phase 8 S5
  lane; applies to every `gh api` / `curl` call with `?` or `*` in it.
