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
| Docker image (Wolfi) | Optional `Dockerfile.wolfi` variant on a digest-pinned Wolfi base (weekly Renovate bump) with the same user, entrypoint and pins; CI builds, smoke-tests and Trivy-scans it next to the Debian image |
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

## Accepted findings

Listed in `.trivyignore` (keep both in sync):

| ID | Package | Reason |
| --- | --- | --- |
| CVE-2025-47273, CVE-2026-59890, GHSA-xmj3-9gf7-h52w | setuptools 70.3.0 | Only listed in pip's `vendor.txt`; pip vendors `pkg_resources`, not the affected `PackageIndex`, sdist or legacy-wheel code. |

## Upstream sync

Upstream regenerates `servers.json` and edits `pnpm.overrides`. Merging upstream can bring back
example tokens or vulnerable pins; the security workflow catches both.
