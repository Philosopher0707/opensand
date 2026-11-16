# Release pipeline download race against release build workflow

- **Trap:** Running `scripts/release.sh` straight through from Step 4 (push release tag) to Step 5 (download release assets) fails with `release not found` because GitHub Actions `release.yml` takes ~4.5 minutes to build, package, and publish the release assets.
- **Root Cause:** Pushing the tag triggers an asynchronous remote CI job on `macos-latest`. The release does not exist on GitHub until `softprops/action-gh-release` runs at the end of the workflow.
- **Rule:** Treat Step 4 as an asynchronous boundary. If `release.sh` exits 1 at Step 5 immediately after tag push, wait for the `release.yml` workflow run to complete, then re-run `scripts/release.sh --install <version>`, which is idempotent and resumes cleanly from the downloaded assets. Always export `GH_TOKEN` in the environment so non-interactive subshells never fail on `gh` GraphQL calls.
