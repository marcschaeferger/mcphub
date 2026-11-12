# Security

## Reporting a vulnerability

Report vulnerabilities in MCPHub itself upstream at
[samanhappy/mcphub](https://github.com/samanhappy/mcphub/security). Report issues that only
affect this fork through a private GitHub security advisory on this repository.

## Fork-specific hardening

This fork carries security changes that are not yet upstream:

| Area | Change |
| --- | --- |
| Dependencies | MCP SDK 2.4.0 with a rebased client patch; `pnpm.overrides` pin transitive dependencies to fixed versions |
| Docker image | Multi-stage build, digest-pinned bases, app runs as uid 10001, tini, HEALTHCHECK, no compiler toolchain |
| Docker image (Wolfi) | Optional `Dockerfile.wolfi` variant on a digest-pinned Wolfi base (weekly Renovate bump) with the same user, entrypoint and pins, published as `*-wolfi` tags |
| Image release | Every variant is Trivy-gated (debian and wolfi also smoke-tested) before push; images ship with an SBOM and max-mode provenance and every pushed digest is signed keyless with cosign, see [Verifying images](#verifying-images) |
| Source | SSO account linking, OAuth registration limits, XSS in OAuth URLs, OpenAPI DoS limits, admin-only cloud tools, session token kept out of URLs |

## Automation

- **Renovate** (`renovate.json`) replaces Dependabot, because Dependabot cannot update
  `pnpm.overrides`, where the transitive fixes live. Non-major updates are grouped; base-image
  digests and GitHub Action digests are pinned and updated. New releases wait 3 days, security
  updates do not. The Renovate GitHub App must be enabled on the repository.
- **Security workflow** (`.github/workflows/security.yml`) runs on PRs, on `main` and weekly:
  - Trivy repository scan: production dependencies and secrets, fails on MEDIUM+ with a fix.
  - Trivy config scan of the `Dockerfile`, fails on HIGH+.
  - Builds the image and scans it, fails on HIGH+ with a fix.

  Unfixed Debian CVEs are reported but do not fail the build; they clear with base-image
  updates from Renovate.
- **Build workflow** (`.github/workflows/build.yml`) publishes the debian, wolfi and full images
  on `v*.*.*` tags (`edge*` on a manual run) to GHCR and, when `DOCKERHUB_USERNAME` and
  `DOCKERHUB_TOKEN` are set, Docker Hub. Per variant it builds an amd64 image, runs
  `scripts/docker-smoke.sh` (not for full, which runs as root by design) and the Trivy gate
  (HIGH+ with a fix, `.trivyignore`); only then it pushes `linux/amd64` and `linux/arm64` from
  the same build cache, checks that the pushed amd64 layers equal the scanned ones, and signs the
  digest.

## Verifying images

Release images are signed with [cosign](https://docs.sigstore.dev/) keyless signing: the
signature is bound to a short-lived Sigstore certificate issued to this repository's Build
workflow through GitHub's OIDC provider, and recorded in the public Rekor transparency log. No
long-lived signing key exists. The signature covers the image index digest, which also pins the
SBOM and provenance attestations listed in that index.

Verify a release image (replace the tag; for Docker Hub use `docker.io/<image>` instead of the
GHCR name):

```bash
cosign verify ghcr.io/marcschaeferger/mcphub:latest \
  --certificate-identity-regexp '^https://github\.com/marcschaeferger/mcphub/\.github/workflows/build\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

`edge*` images come from manual runs on a branch. Verify them with the identity
`'^https://github\.com/marcschaeferger/mcphub/\.github/workflows/build\.yml@refs/heads/main$'`.
A fork that publishes its own images replaces `marcschaeferger/mcphub` with its repository.

To deploy what you verified, pin the digest (`ghcr.io/marcschaeferger/mcphub@sha256:...`) that
`cosign verify` and `docker buildx imagetools inspect` print, not the tag.

View the SBOM (SPDX) and the build provenance (SLSA v1, `mode=max`) attached by BuildKit:

```bash
# Index, platforms and attestation manifests
docker buildx imagetools inspect ghcr.io/marcschaeferger/mcphub:latest

# SBOM and provenance for one platform
docker buildx imagetools inspect ghcr.io/marcschaeferger/mcphub:latest \
  --format '{{json (index .SBOM "linux/amd64")}}'
docker buildx imagetools inspect ghcr.io/marcschaeferger/mcphub:latest \
  --format '{{json (index .Provenance "linux/amd64")}}'
```

For a single-platform image or a platform digest, `--format '{{json .SBOM}}'` and
`--format '{{json .Provenance}}'` print the attestation directly.

## Accepted findings

Listed in `.trivyignore` (keep both in sync):

| ID | Package | Reason |
| --- | --- | --- |
| CVE-2025-47273, CVE-2026-59890, GHSA-xmj3-9gf7-h52w | setuptools 70.3.0 | Only listed in pip's `vendor.txt`; pip vendors `pkg_resources`, not the affected `PackageIndex`, sdist or legacy-wheel code. |

## Upstream sync

Upstream regenerates `servers.json` and edits `pnpm.overrides`. Merging upstream can bring back
example tokens or vulnerable pins; the security workflow catches both.
