# Version identity

package.json version is canonical. The release tag must be exactly v plus this version, validated as strict SemVer. Build metadata carries source SHA, version, build timestamp and lockfile digest; OCI labels must agree. Release manifest identifies the registry multiarch manifest digest and actual supported platforms. An OCI archive transport checksum is not the registry image identity.

Stable 1.0.0 publishes 1.0.0, 1.0, 1, latest and sha-<full SHA>. Prerelease 1.0.0-rc.1 publishes only the exact prerelease and sha-<full SHA>; it never updates stable aliases. Version mismatch, malformed tags or wrong branch ancestry fail closed.

RELEASE_ENGINEERING_IMPLEMENTED describes code completion. LOCAL_CONTAINER_QUALIFICATION_PASS requires actual local acceptance. HOSTED_CONTAINER_QUALIFICATION_PENDING remains until hosted results exist. RELEASE_READY requires hosted qualification and still does not mean RELEASED. Phase16B PASS / PLATFORM_1_0_RELEASED requires actual publication and post-publication verification.

## Prepare a version

From any working directory, run the repository-root `bump-version.sh` with an
exact version (an optional `v` prefix is accepted):

```bash
./bump-version.sh 1.0.0-rc.2 --dry-run
./bump-version.sh 1.0.0-rc.2
./bump-version.sh --check
```

Requires Bash, Git, Node.js and installed project dependencies. Works on macOS
and Linux without GNU sed or a flock executable. The script updates the current
version in package.json, version.yaml, Compose, the deployment environment
example, both Kubernetes image examples and current README/deployment version
references. Dependency versions, historical reports, changelog entries and test
fixture versions are preserved. Build-time timestamps and image labels are
computed by the existing build pipeline.

Writes use same-directory temporary files and atomic renames. An exclusive
`.git/zhixu-version.lock` directory prevents concurrent script invocations;
original bytes and modes are recorded under `.git/zhixu-version-backups/` (the
worktree-specific Git directory is used for linked worktrees). On errors or
handled INT/TERM, changes from that invocation are rolled back. Repeating the
same version is a no-op and creates no extra backup. SIGKILL/power loss cannot
run rollback: inspect the retained backup and transaction.json, restore affected
files if necessary, and remove the stale lock only after confirming no update
process remains. Do not edit version files concurrently with the script.

Review, commit and push the version update to `develop`. Wait for that exact
commit's full Container Qualification to pass; then tag that commit and push the
tag. The script does not commit, push, tag or publish:

```bash
git tag v1.0.0-rc.2 <qualified-commit-sha>
git push origin v1.0.0-rc.2
```

The tag triggers Platform Release, which runs qualification again, publishes the
qualified image bytes to Docker Hub, and creates GitHub Release. Do not manually
create the Release first. Partial reruns select images from the same run/SHA and
the source attempts of their corresponding architecture receipts.
