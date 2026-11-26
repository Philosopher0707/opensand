# Use the repository's current lessons-index interface

- **Trap:** A handoff may prescribe `bash scripts/lessons-index.sh --write`, but the current script rejects that option.
- **Root Cause:** The generator defaults to write mode; its supported interfaces are no argument, `--check`, `--stdout`, and `--merge`.
- **Rule:** Read the checked-out script's usage and run `bash scripts/lessons-index.sh` to regenerate the index.
