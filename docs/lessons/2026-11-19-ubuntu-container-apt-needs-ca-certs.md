# A bare ubuntu:22.04 container cannot apt-get over HTTPS until CA certs are seeded

- **Trap:** `apt-get update` over the image's default HTTP mirrors failed with `Connection failed`, and after switching sources to HTTPS every fetch failed with `No system certificates available / certificate is NOT trusted`. A partially populated apt cache then reported unrelated packages as `not installable`.
- **Root Cause:** The official ubuntu base image has no `ca-certificates`, so apt's HTTPS method cannot verify any mirror; the earlier failed HTTP update left stale lists that looked like held-broken packages.
- **Rule:** For local Ubuntu acceptance containers, copy the host CA bundle (macOS `/etc/ssl/cert.pem`) to `/etc/ssl/certs/ca-certificates.crt`, switch `/etc/apt/sources.list` to `https://`, clear `/var/lib/apt/lists/*`, then `apt-get update` and install. Do not "fix" the held-broken-package symptom by pinning versions.
