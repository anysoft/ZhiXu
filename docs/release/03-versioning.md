# Version identity

`package.json` is canonical. A release tag must be strict SemVer, exactly `v` plus that version, and on the branch configured by `vars.RELEASE_BRANCH`. Image labels and the release manifest identify the source SHA and version. The manifest records the registry multiarchitecture digest; an OCI archive transport checksum is a different identity.

Stable `2.0.0` publishes `2.0.0`, `2.0`, `2`, `latest` and `sha-<full SHA>`. Prereleases publish only the exact prerelease and SHA tags. A branch push does not publish an image or GitHub Release.

## Prepare a version

Run the repository-root helper with an exact version, optionally prefixed by `v`:

```sh
./bump-version.sh 2.0.1 --dry-run
./bump-version.sh 2.0.1
./bump-version.sh --check
```

The helper manages `package.json`, `version.yaml`, the default `compose.yaml`, root `.env.example`, deployment environment template and current README/Docker deployment version references. Compose takes its complete image reference from `ZHIXU_V2_IMAGE`; the two example templates carry the current source version. Published release environment assets replace that tag with the verified immutable registry digest. Historical Kubernetes/v9 examples are outside this version set and are not qualified v2 deployment configurations.

Dependency locks, historical reports and changelog entries are preserved. The helper requires Bash, Git, Node.js and installed project dependencies. Same-directory atomic writes, an exclusive worktree Git lock and retained transaction backups protect updates. Repeating the same version is a no-op. Errors and handled signals roll back that invocation; after power loss or SIGKILL inspect the retained transaction before any manual recovery or stale-lock removal.

Review and commit the update, then push the commit to the approved release branch. A matching tag triggers **ZhiXu v2 Release**, which qualifies the exact source, promotes the qualified OCI archives and creates the checksummed GitHub Release. The helper does not commit, push, tag or publish. Local checks do not substitute for hosted results; partial publication is not success.

See the [release workflow](01-release-process.md) for repository settings and evidence requirements.
