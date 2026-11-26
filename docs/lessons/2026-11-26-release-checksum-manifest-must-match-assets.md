# Release checksum manifests must match the published asset set exactly

**Trap:** `shasum -c SHA256SUMS.txt` verified listed files but accepted a manifest that omitted one of the binaries the release job would publish.

**Root Cause:** The gate treated the checksum list as authoritative without comparing it to the platform's actual release-file set.

**Rule:** Derive the expected macOS or Linux assets from the release directory, require every platform asset type, and require the checksum manifest to equal the sorted hashes and names of exactly those files before checking their hashes.
