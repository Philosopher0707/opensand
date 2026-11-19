# An Electron app extracted with dpkg-deb -x cannot start its setuid sandbox

- **Trap:** The packaged Linux app aborted on launch: as root `Running as root without --no-sandbox is not supported`, and as a non-root user `The SUID sandbox helper binary was found, but is not configured correctly ... owned by root and has mode 4755`.
- **Root Cause:** `dpkg-deb -x` does not install `chrome-sandbox` as root-owned 4755; it preserves the mode but uses the extracting user's ownership, which the kernel rejects for a setuid helper. This is true on a GitHub runner too, not just in Docker.
- **Rule:** `scripts/smoke-linux.sh` launches the packaged executable under `xvfb-run -a` with `--no-sandbox`. The smoke tests version reporting, not the sandbox, so disabling it is safe and makes the check work for root and non-root extraction alike. Never substitute an unpackaged or repo Electron binary.
