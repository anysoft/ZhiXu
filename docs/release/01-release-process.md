# ZhiXu v2 release workflow

The `release.yml` tag workflow publishes fresh-install v2 images. It explicitly builds `Dockerfile.v2`; the default `Dockerfile` and the Phase15/16B v9 qualification scripts remain historical workflows and are not prerequisites for v2 publication. Existing v9 volumes cannot be upgraded in place.

## Repository settings

| Setting | Use |
|---|---|
| `vars.RELEASE_BRANCH` | Approved branch containing the tagged commit, for example `develop` |
| `vars.DOCKERHUB_USERNAME` | Docker Hub service account/user |
| `vars.DOCKERHUB_IMAGE` | Docker Hub `namespace/repository` |
| `secrets.DOCKERHUB_TOKEN` | Scoped Docker Hub token |
| `GITHUB_TOKEN` | Built-in token for GitHub Release creation |

Missing configuration blocks publication. No PAT or production-host access is needed. The tag must be strict SemVer, match `package.json`, and identify a commit on the approved branch. Only the publish job receives `contents: write`.

## Qualification and publication

`container-qualification.yml` runs on develop pushes/PRs, manual dispatch, and calls from the tag workflow. Native Ubuntu AMD64 and ARM64 runners use Node 22.23.5, validate the release helpers, then build a clean checkout with SBOM and provenance. The OCI audit checks v2 entrypoint/healthcheck, service UID, architecture, source/version labels and blob digests.

Each architecture must pass a fresh-v2 container smoke: explicit initialization, health and frontend, owner authentication, LOCAL workspace, real Shell Task/Run/Attempt/log, graceful shutdown, independent restart and persistence, and retired subscription API. Every test uses dedicated random-labelled volumes and containers; cleanup failure blocks the gate. This is a focused release smoke, not a repeat of S5 qualification. Full CVE clearance and supply-chain review are **DEFERRED**, not PASS, under the accepted release scope.

The publish job downloads both receipts and OCI archives from the same run and SHA. Existing receipt selection protects retries against expired or ambiguous artifacts. `skopeo --all --preserve-digests` promotes the qualified archives without rebuilding; registry verification checks platform/attestation digests and tag aliases. A final AMD64 smoke pulls the verified immutable multiarchitecture digest.

GitHub Release assets contain fresh-v2 Compose/environment examples, source/image identity, per-architecture SBOM/provenance and gate receipts, the published-image smoke receipt, release notes and SHA256SUMS. The workflow downloads the published assets and verifies checksums after creation. New builds carry the new tagged SHA; historical RC15 evidence is not their artifact identity.

## Triggering a release

Push the code and a matching version tag after configuring the settings above. A branch push alone does not create a GitHub Release; pushing `v2.0.0` triggers the release workflow. Local workflow edits and helper tests do not prove hosted image builds or registry publication succeeded.

A partially failed publication is not PASS. Inspect tags, assets and receipts before retrying; qualification reruns never authorize replacing an existing release with different bytes. No local push, tag, deployment or publication is performed by the preparation task.
