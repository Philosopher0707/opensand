# Renderer proof harnesses resolve CSS imports from the harness entry, not from `src`

- **Trap:** A temporary Vite proof page failed twice because its stylesheet imports were copied from `renderer-next/src/main.tsx` without rebasing them to the harness location.
- **Root Cause:** `../../renderer/styles.css` and `./shell.css` are correct only from `renderer-next/src`; a harness in `renderer-next/` needs `../renderer/styles.css` and `./src/shell.css`.
- **Rule:** When adding a temporary renderer proof entry, rebase every relative import from the new file location and run one import-only check before taking screenshots; stop after two failed screenshot attempts and report the missing proof rather than looping.
