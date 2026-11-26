# Code signing policy

This document describes how official Arbiter desktop releases are built, verified, and signed.

## Privacy policy

Arbiter will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. Stable desktop builds run locally on the user's machine and send zero telemetry. See [`SECURITY.md`](SECURITY.md) for the complete list of external game/economy APIs and GitHub update hosts contacted during normal operation.

## Signing status and provider

- **Windows (x64):** Official Windows installers (`Arbiter-Setup-<version>.exe` and `Arbiter-<version>-win.zip`) are built from public tagged commits in GitHub Actions ([`.github/workflows/release-desktop-win.yml`](.github/workflows/release-desktop-win.yml)). We are applying for free open-source code signing through **SignPath.io** with a certificate issued by the **SignPath Foundation**. Until SignPath signing is active, Windows builds are unsigned and attested with GitHub Artifact Attestations (`actions/attest-build-provenance`) plus published SHA-256 checksums and VirusTotal scan links on every release.
- **macOS (Apple Silicon `arm64`):** Builds are packaged locally from the same tagged commit and are currently ad-hoc signed (not Apple-notarized).

## Roles and access control

- **Maintainer, author, and approver:** `Shazambom` (repository owner).
- Multi-factor authentication (MFA) is required on GitHub and SignPath accounts with release or signing access.
- Every GitHub Actions workflow pins third-party actions to full commit SHAs and runs with least-privilege permissions.

## Build and release process

1. All releases are built from public commits in `https://github.com/Shazambom/shazam-poe2-dashboard` after passing the automated test, lint, and market regression gates (`ops/run-tests.sh`).
2. Windows binaries are compiled and packaged exclusively inside GitHub Actions from the exact commit SHA targeted by the release.
3. Once SignPath Foundation signing is active, CI submits release artifacts to SignPath and requires explicit manual approval from the maintainer before signed binaries are published to GitHub Releases.
4. Release assets are verified for integrity (`desktop/scripts/release-assets.mjs`) before the draft GitHub Release is published as Latest.

## Third-party code

Arbiter is licensed under the MIT License ([`LICENSE`](LICENSE)). Third-party dependencies are open source; vendored query-building code from Exiled Exchange 2 carries its original MIT license and attribution in [`desktop/src/vendor/ee2-query/`](desktop/src/vendor/ee2-query/).
