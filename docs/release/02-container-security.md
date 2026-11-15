# Fresh-v2 container boundaries

The default `Dockerfile` builds the fresh-v2 application. Its context is allowlisted and excludes local `.git`, `.env`, diagnostics and user state. Build inputs include required source, frozen contracts and test inputs; the runtime stage copies selected application artifacts. Native addons are built for the target architecture.

The default `compose.yaml` runs as UID/GID 10001 with a read-only application filesystem, dropped capabilities and `no-new-privileges`. Writable mounts are the dedicated `v2-data`, `v2-backup`, `v2-scratch` volumes and private tmpfs. `/data/state` and `/backup/state` are the v2 data and backup roots. No Docker socket or host namespace access is granted. Keep one active service per data volume and use a fresh project instead of adopting v9 volumes.

Task code executes with the platform identity. Restrict script administration to trusted users; this is not isolation against hostile task authors. Keep credentials, task logs, runtime trust material, encrypted exports and backup passphrases outside public release assets. Public origin must match the browser URL; remote access needs an authenticated TLS entry.

The current release OCI audit verifies architecture, source/version and v2 entrypoint identity, service UID, blob digests, SBOM and provenance. Runtime smoke checks authentication, real Shell execution, persistence, shutdown and cleanup. Compose configuration is validated for both repository defaults and generated release assets. These checks are not a full secret, dependency or operating-system vulnerability audit.

Full CVE clearance and supply-chain review remain **DEFERRED** under the [accepted release scope](../architecture/v2/V2_RELEASE_SCOPE_DECISION.md). Historical Phase16B scanner gates, private-key pattern scans and public upstream self-test vector exceptions describe earlier qualification tooling; they are not claims that the fresh-v2 release passed those gates. Preserve the historical reports and resolve any confirmed direct severe defect before releasing the affected scope.
