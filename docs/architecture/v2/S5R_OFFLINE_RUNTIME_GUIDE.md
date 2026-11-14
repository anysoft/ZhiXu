# Verified offline Runtime provisioning

Artifact acquisition and Managed Runtime installation are separate operations. An artifact package contains exact-byte manifests and source objects, not an installed Runtime, Environment Build or host npm cache. Existing Provider operations, leases, staging, verification and READY transitions still perform installation.

## Independent trust

The administrator configures a protected SHA256 allowlist outside the package, artifact store and DataRoot. Import authenticates the manifest against that allowlist; it cannot create or extend the allowlist. A package's own manifest and checksums establish consistency, not independent provenance.

| Input | Publisher and source verification |
|---|---|
| Node 24.22.3 | Node.js project / OpenJS Foundation; exact official HTTPS SHASUMS256 entry |
| npm 11.21.2, pnpm 10.34.9 and package dependencies | Their npm package publishers; official registry HTTPS metadata and each tarball's SHA512 SRI |
| pyenv provider | pyenv community project; fixed upstream commit, clean checkout and controlled source snapshot |
| Python 3.13.15 | Python Software Foundation / CPython source, checked against the independently reviewed project definition's SHA256 |
| Python cryptography and compression | OpenSSL Project 3.5.9 LTS and zlib project 1.4, fixed publisher source digests; private PIC static libraries |
| Python SQLite | SQLite project / Hwaci 3.54.1, independently pinned publisher archive and source ID; private PIC static library |
| Conditional Python build sources | GNU Readline / Free Software Foundation, using the reviewed definition's digest |
| Python CA bundle | Dated curl conversion of Mozilla CA store, publisher SHA256; MPL-2.0, with browser-specific name-constraint limitations recorded |
| Python pip 26.3 | Python Packaging Authority / pip project, official PyPI release metadata and independently pinned wheel SHA256; bundled vendor components are inventoried separately |
| esbuild 0.28.2 | ZhiXu controlled rebuild from pinned upstream source with Go 1.26.11; not upstream prebuilt bytes |

Python is compiled by the existing python-build Provider. No third-party standalone binary is described as an official Python binary. Rebuilt esbuild digests and build inputs are independently reviewed in [curated-esbuild.json](../../../scripts/runtime-artifacts/curated-esbuild.json), outside the imported package.

Signature status is recorded truthfully. SIGNATURE_NOT_VERIFIED does not mean SIGNATURE_NOT_AVAILABLE. The acquisition administrator must review source and rebuild evidence before approving the external allowlist; creating a manifest alone supplies no source authentication.

## Trusted acquisition and transfer

Use a reviewed checkout and the independently verified target esbuild executable:

    node scripts/runtime-artifacts/acquire.cjs \
      --output-root /opt/zhixu-acquisition/release-inputs \
      --os linux --arch x64 \
      --esbuild-binary /opt/zhixu-reviewed-binaries/esbuild-linux-x64 \
      --application-root /opt/zhixu-reviewed-application \
      --git-tools /opt/zhixu-reviewed-application/bin/git-tools

The output root must be new. The tool uses private HOME, npm cache and Git configuration; verifies curated publisher checksums, registry SRI and reviewed rebuild pins; and writes a complete package plus a separately located allowlist. It does not read an imported manifest and has no “trust this package” command.

Full Python acquisition requires a reviewed compiled application and its controlled Git tools. The acquirer reuses that application's strict verifiedGitSshTools gate, forces the verified absolute Git executable, GIT_EXEC_PATH and PATH, and records actual Git version, executable digest, tool-manifest digest and compiled-verifier digest with the source snapshot. It never falls back to host Git. --application-root defaults to the reviewed checkout and --git-tools to its bin/git-tools, so a source checkout must first be built or explicitly select a reviewed compiled root. Node-only acquisition does not invoke Git.

Default npm and online pnpm profiles are an empty Environment and is-number 7.0.0 plus tsx 4.23.15, using esbuild 0.28.2. An administrator-selected --profiles JSON array can provide additional dependency definitions. Each result has a fixed manager-specific lock and an exact package.json digest. Target optional dependencies are included; another OS/architecture is rejected. A Node-only acquisition can explicitly use --components node. --source-cache may name an administrator-selected directory of source archives; each reused file is still checked against the independent curated publisher digest, and installed Runtime trees are never accepted as inputs.

Review the acquisition receipt and source verification before independent transfer. Protect the allowlist as administrative configuration, preferably root-owned, read-only to the application, with protected parent directories. Transfer the package and trusted allowlist through independently controlled channels. Preserve manifest bytes exactly; JSON reformatting changes its digest.

## Destination import and application configuration

The package has only manifest.json and objects/<sha256>. Keep it separate from the writable private artifact store. Neither belongs in a Workspace, installed Runtime, Build or DataRoot. The application UID needs read access to protected inputs and ownership of its artifact store.

Use the supported release Node and compiled administrative importer:

    node scripts/release-v2/runtime-artifacts.cjs import \
      --data-root /var/lib/zhixu/data \
      --package /opt/zhixu-runtime-input/package \
      --runtime-artifact-mode OFFLINE_VERIFIED \
      --runtime-artifact-store /var/lib/zhixu-artifacts \
      --runtime-artifact-trust-anchor /etc/zhixu-runtime-trust/approved-manifests.json \
      --runtime-artifact-manifest /opt/zhixu-runtime-input/package/manifest.json

Import does not initialize or migrate a database. It requires independently approved manifest bytes, all declared objects, no unlisted objects, matching digests and safe archive structure. A complete receipt is published only after verification.

A kernel FD lock rejects concurrent imports and is released on process death. Interrupted staging cannot supply an offline install. Unknown store roots, ownership mismatches, symlink paths, traversing archives, changed objects and incomplete closures fail closed without cleaning unrelated data.

Pass the same four --runtime-artifact-* options to the ordinary compiled appV2 entry, along with its normal explicit data, backup, origin and initialization options. All four are required together. Configuration belongs to one asynchronous application domain, not global mutable environment state. Without independent trust configuration, new official Managed Runtime installations and provider installation fail closed. Reading catalogs or old state does not qualify an unsafe existing Runtime. Online installation remains available through explicit ONLINE_VERIFIED configuration.

## Shared installation and Build path

ONLINE_VERIFIED and OFFLINE_VERIFIED use the same approved identities and install/build verification. Configured online mode may acquire eligible missing upstream objects and check their approved digests. Controlled source snapshots and ZhiXu rebuilds require import. Offline mode requires a complete verified import; missing inputs never trigger an online fallback.

The Node Provider extracts the official archive into its normal staging root, replaces bundled npm with separately authenticated npm before running its CLI, and performs normal Runtime verification and publication.

An approved npm Build:

1. Matches the exact Environment manifest, Runtime/npm versions and target closure.
2. Seeds a fresh operation-owned cache from authenticated tarballs with npm --offline.
3. Runs npm ci --offline --ignore-scripts for initial extraction.
4. Replaces the platform and CLI esbuild binaries with the reviewed rebuild.
5. For policy ALLOW, executes npm rebuild --offline --foreground-scripts. IGNORE continues to run no lifecycle scripts.
6. Rechecks the overlay and runs the existing dependency snapshot and Build verification.

Deferring initial scripts does not waive required lifecycle scripts. ESBUILD_BINARY_PATH is not used to embed a temporary absolute path. Old upstream Go binary bytes are replaced in the installed Build; archived upstream inputs retain their truthful provenance.

Python continues using pinned pyenv/python-build and a verified operation-local source cache. A separately approved ZhiXu definition composes the upstream build DSL with fixed CPython, OpenSSL 3.5.9 LTS, zlib 1.4, SQLite 3.54.1 and a dated CA bundle. This is a project definition, not an unchanged upstream definition or a claim that pyenv supplied a vendor flag. Installation checks actual ssl/zlib/SQLite versions, SQLite source ID, physical extension-module digests, default CA location and linked libraries; dynamic host libssl/libcrypto/libz/libsqlite3 dependencies are refused. Compilers, other platform libraries and headers remain build prerequisites and retain their separate inventory scope. Unexpected downloads fail closed.

The same definition uses CPython's native --with-wheel-pkg-dir setting for an independently approved pip 26.3 wheel in the private Runtime. Both base installation and subsequent venv creation use that wheel. The known old wheel is physically removed from the installed ensurepip/_bundled directory; the authenticated CPython source archive remains unchanged and its old input wheel has a separate source-input inventory disposition. Verification checks actual base/venv pip and ensurepip versions, approved pip/__init__.py and vendor.txt member digests, the complete approved wheel digest, and the absence of installed bundled wheels. These witnesses and the actual vendor inventory do not imply a sandbox against a trusted owner who can rewrite the DataRoot.

Online pnpm uses an authenticated pnpm tool archive and a separately approved integrity-locked dependency closure. The ordinary owned pnpm store is populated through fixed-lock fetch, then installation runs offline with initial scripts deferred, the same reviewed esbuild overlay and the original ALLOW/IGNORE lifecycle policy. Its Toolchain and Build have physical-file and independent-policy witnesses. OFFLINE_VERIFIED pnpm remains unsupported and is refused explicitly; the online qualification cannot be counted as an offline success.

The current offline Python profile has no external pip requirements. In OFFLINE_VERIFIED, nonempty pip requirements need authenticated closure support and are refused. ONLINE_VERIFIED retains the existing server-owned pip index and ordinary installation, snapshot and verification path; it does not set PIP_NO_INDEX. This online capability is qualified separately from the offline closure. Unsupported offline closures must not be reported as qualified.

The missing-trust refusal applies inside the explicit v2 Runtime domain. Retained services outside that domain keep their existing Provider source-pin and download paths; their security assessment remains separate and cannot be counted as verified v2 provisioning.

Input trust configuration is an independent administrative asset, not a shadow Runtime database or a replacement for backups. Runtime removal, repair, recovery, version pinning and readiness remain under the existing services. Incomplete staging is never installed state; maintenance must respect the original Store owner marker and active import lock.

## Independent B recovery

1. Create separate A data, Runtime and control roots; install through formal Provider operations and execute the eight LOCAL/GIT language Tasks.
2. Export the authenticated encrypted backup, stop and physically destroy A.
3. Start a new B process with empty installed Runtime/Build roots and independent control state.
4. Restore; first verify historical identities and Runtime NOT_READY.
5. Authenticate/import independent inputs, reinstall Managed Python/Node and create new Environment Builds.
6. Execute the original eight Task IDs with new Run IDs; preserve prior Runs, Attempts, logs and Git state.

Reusing trusted source inputs is permitted; copying A's installed Runtime or Build cache is not. Enforce and record real outbound network denial during offline install/build. npm offline settings and the fail-closed Python downloader do not replace OS network isolation for allowed package scripts.

Record online and offline DR separately. Offline success cannot rewrite an online TLS/RPC failure as an online PASS. Do not change Frozen S0 contracts or old S5 evidence to erase this distinction; the final S5.R report must state the qualification policy and remaining gaps.
