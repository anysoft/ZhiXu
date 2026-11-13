# ZhiXu v2.0 — S2 Implementation Report

## Baseline

Branch: `develop`.
Entry HEAD: `cedfc153c3586be7c4e4f8fa47948debd63ad083`.
S0: `3c96fd3aed1ed8de2b4a58b7e94b2f9bf5709105`.
Final HEAD: the local commit containing this report; its exact SHA is reported in the delivery response and available with `git rev-parse HEAD`. A commit cannot include its own hash.

User Changes Preserved: the pre-existing, unstaged `.gitignore` addition is excluded from this commit and remains byte-identical (SHA256 `78f778aa7cc3494334676046b883b672c9e98f3fb28adfd3868b9aa99aef4893`). The 37 sealed S0 files, frozen DDL/DTO/signature and S1.A historical report/results/status remain unchanged. No existing user data root was used.

## Task Domain

Source: `WORKSPACE_ENTRYPOINT` resolves an owned LOCAL or GIT Workspace. LOCAL requires no Repository, Worktree or Subscription. GIT retains Repository/ref/private checkout identity and verifies actual HEAD. The same candidate TaskService, resolver and runner handle both.

CRUD: create/read/list/update with version CAS, atomic clone, delete, enable/disable, manual submission, references and history. DISCOVERED identity must belong to its GIT Workspace; cloning yields an independent MANUAL Task. No discovery scanner or Subscription emulation was added. Clone failure rolls back the entire definition and all child resources.

Readiness: pure database definition/resource resolution is separate from physical validation under the S1.A Workspace lease. The latter verifies root marker/dev/ino, safe complete inventory, entrypoint, CWD, Git identity, Config revisions and actual managed runtime bytes. It does not spawn task code, inject Config, create user code, sync Git or install dependencies. Missing source, recovery state, missing managed configuration and physically invalid runtimes have distinct errors.

References: TaskSource and custom CWD/ancestor references protect file rename/delete; cross-Workspace Profile and discovered ownership are rejected. Archived resources allow required reference/default detachment while rejecting new configuration. Frozen FK/UNIQUE/CHECK/guards and transaction rollback remain active.

## Execution

Workspace Root: explicit candidate DATA_DIR and S1.A roots/leases; no client host path or legacy Worktree key. Entrypoint and CWD support WORKSPACE_ROOT, ENTRYPOINT_DIR and CUSTOM_RELATIVE. Traversal, symlink, hardlink, special inode and replaced owner/root fail closed.

ExecutionContext: immutable in-memory Task/version, Workspace/type/generation/revision, entry/hash/CWD, GIT commit when applicable, runtime provider/installation/environment/revision/build/toolchain, effective ENV, Config plan, Hooks and settings. Persisted admission/source/metadata contain safe IDs and versions, without child ENV, Config contents, credentials or absolute host roots.

Source Snapshot: admission expectations are immutable; source identity is recorded once only after lease validation and runtime pinning. Source/Task/Workspace/Global ENV/Profile/Runtime/Config changes before execution produce SKIPPED/SOURCE_SUPERSEDED, an explicit SOURCE_CHANGED/TASK_CHANGED/RESOURCE_CHANGED reason, zero Attempts and no injection/child/replacement Run. This uses the active Workspace under a lease, not an immutable source archive. A trusted child that rewrites source before retry fails SOURCE_SUPERSEDED without executing a second Attempt; frozen SQL does not allow RUNNING→SKIPPED. Stable source is published only after child exit, restoration and full verification.

Lease: Platform admission → durable Run claim/real run-owner FD → S1.A Workspace EX → managed runtime pins. Execution never waits for a Repository writer while holding Workspace, and never holds a SQLite write transaction while waiting for OS locks or running children. Runner/Hook supervisors and materialization helpers inherit admission, Workspace, runtime and owner FDs; earlier source/filesystem helpers retain their required admission/Workspace protection.

Queue: TaskRuns is the sole durable queue. FORBID/QUEUE/ALLOW Task policy is evaluated before WAIT/SKIP/FAIL_FAST Workspace policy, including when a FAIL_FAST probe is busy. Duplicate submission/event identity returns the original Run before policy/quota checks. A probe grants no lease; an accepted probe race skips that same Run on the first real busy acquire. Automatic triggers use WAIT. QUEUED caps are 32 per Task / 128 per Workspace / 1024 global; active claim cap is 8. Limits can only be lowered by the internal harness. Absolute waiting deadline is 900000 ms, with durable 250 ms initial backoff, a 4000 ms maximum base (within the S0 5000 ms bound), and at most 10% jitter. Waiting releases owner and resource FDs. Cron SKIP/FIRE_ONCE and durable occurrence replay use this same queue; no S3 GitUpdate producer/dispatcher is registered.

Concurrency: same Workspace is exclusive even for ALLOW; different Workspaces run concurrently. Actual two-controller processes create exactly one child/Attempt for one ticket. Queue tests cover explicit QUEUE FIFO under SKIP/FAIL_FAST, FORBID precedence, quotas, deadline/restart, queued and active cancellation, cancel-vs-claim, file editing, backup and archive competition. Global cap qualification uses ten Workspaces and two controllers with real gated children.

Recovery: a fresh process takes actual owner and Workspace FDs, rechecks current durable state and CAS owner epoch, then reconciles journals and source. Unknown ownership remains RECOVERY_REQUIRED; no unknown user directory is removed. Owner proofs bind Run, Workspace dev/ino/token/generation and resource key. Successful recovery ends the same Run INTERRUPTED without replay. A completed Attempt may truthfully remain SUCCESS when a crash occurred before Run terminal commit; the Run is still INTERRUPTED. Log bytes are redacted, bounded and fsynced before terminal persistence.

## Runtime

Python: actual managed CPython 3.13.15 compiled through the pinned pyenv provider (`c293de3650a2d08ea36c5f6f0d55c5a3841b0c72`), with a real managed virtual environment.

Node: actual Node 24.21.0, controlled npm 11.19.0 and environment build containing `is-number@7.0.0`.

TypeScript: managed Node plus `tsx@4.20.6` from the immutable managed build; no host TS runner.

Shell: existing fixed `/bin/sh` contract. Host Python used by established FD/supervisor filesystem helpers is control infrastructure, not a task interpreter fallback.

Revision Pin: adapter physically verifies owner markers, executable hashes, runtime installation and environment revision/build. Real Python and Node rebuild/promotion retain the old shared Build FD and reject acquisition of the exclusive deletion lock; the pin test does not invoke a provider delete API. A queued Run does not absorb a newly promoted revision/build. Task override wins over Workspace default; missing binding is CONFIGURATION_REQUIRED, and forged READY metadata without bytes is RUNTIME_NOT_READY.

Host Fallback: NONE for Python/Node/TypeScript tasks. The fresh qualification provisioned seven successful provider/runtime/environment operations. Official Node HTTPS and SHA256 were verified; detached-signature verification is explicitly false. Per-executable hashes, operation identities, matrix results and log hashes are in the machine evidence. Build IDs in the receipt describe initial provisioning; later pin/supersession tests intentionally promote builds and query current IDs.

## ENV

Workspace Profile: one enabled same-Workspace Profile, Task selection over Workspace default; tested on LOCAL and GIT. System allowlist → Global → selected Profile → Task SET/UNSET, enabled/disabled and protected runtime variables are applied. No unexpected backend process.env or credential inheritance.

Task Override: runtime/profile/environment overrides are versioned atomically with the definition. Global changes have a monotonic SQL revision. A queued definition/resource change skips rather than silently incorporating new secret values.

SET/UNSET: clone, validation, default selection and explicit detachment preserve ownership and CAS. Secret update/keep semantics are supported.

Secret Redaction: previews are masked; actual ENV and Config secret bytes are redacted from streamed logs, Hooks and retry output. Snapshot metadata and events retain only safe IDs/versions/reasons. Hook output cannot override protected PLATFORM_* or reintroduce untrusted PATH/loader variables.

## Config / Hooks

Bindings: Workspace ATTACH plus Task ATTACH/MASK, exact immutable asset revision, COPY/SYMLINK and conflict restoration. Config targeting an executable entrypoint, including inode aliases, is rejected before Attempt creation. Disk, entry-count and recovery-journal budgets are checked before publication.

Materialization: the mature ConfigMaterializationService is reused through an explicit candidate revision reader and journal root. Original → private durable backup → temporary injection → actual execution → reverse restore. Only a proven owned link/file is removed; unknown/replaced content fails closed. The canonical Workspace key is sha256(workspace:id).

Frozen contract discrepancy: `contracts/api.dto.ts` uses TASK_DIR / REPLACE_RESTORE, while frozen `fresh-v2.sql` accepts TASK_CWD / BACKUP_AND_RESTORE. The internal candidate uses SQL-canonical values and maps them only at the existing materialization algorithm boundary (custom Task CWD is preserved). No frozen enum, DTO, guard or signature was rewritten. Public DTO normalization requires later S4 contract review.

Node Binding: existing algorithm uses candidate Workspace journal/resource identity and the pinned immutable build. No persistent dependency installation into source. Pre-existing user node_modules, unknown staging files and replacement directories are preserved. Config/Node/Workspace owner-proof journals participate in editor, archive and backup gates; proven other-Workspace journals permit independent execution. Journal-disappearance races are revalidated with bounded retries.

Hooks: actual BEFORE, AFTER_SUCCESS, AFTER_FAILURE and FINALLY, main failure, retry ENV reset, active Hook timeout/cancel and live BEFORE/FINALLY SIGKILL. Persistent cancellation may cancel later Hook supervisors before their shell bodies run: phases are still attempted in order, and SIGTERM without a supervisor report can retain the existing EXIT_NONZERO fallback. Tests require the exact signal and cancellation/restoration outcome; successful cleanup-Hook shell bodies are not promised after cancellation.

Crash Recovery: 15 full-engine SIGKILL cases use actual OS SIGKILL and a fresh recovery process. Ten additional direct materialization SIGKILL cases reopen the Store and reacquire the real lease in the surviving test harness. Full-engine cases cover all eleven requested points (Before Lease, After Lease, After Source Snapshot, After Runtime Pin, Before/During/After Config Injection, During Runner, During Cleanup, After Child Exit, Before Terminal Commit), plus Node-installed, GIT Runner and active BEFORE/FINALLY Hook cases. This is not an eleven-points × all-languages matrix.

## Backup

S1.A Compatibility: all 68 original foundation tests were rerun against the changed shared/S1.A implementation, without skips or lowered assertions.

Domain Validation: frozen full-schema database, TaskSource ownership/entrypoint, ENV/Config/runtime references, Run admission/source history and Attempts survive component restore. Existing runtime restore qualification correctly makes absent physical builds unavailable. Restored logical runtime IDs alone do not prove executability.

Execution Admission: real active execution blocks/waits backup through the common admission barrier. Config/Node/owner or unknown materialization artifacts block successful snapshots. Archive waits actual owners and source cleanup; continuous file mutation retains its deadline/owner behavior and SQL guards.

S1.B Status: **NOT_RUN — requires separate authorization**. The candidate history component restore keeps A and does not execute a task in B. No destroy-A → restore-B → execute-again disaster-recovery PASS is claimed.

## Tests

Authoritative local host: Darwin arm64; formal platform qualifications below remain separate. Every final suite has zero failures, cancellations, skips or todos.

| Check | Result |
| --- | --- |
| Backend TypeScript | PASS, exit 0 |
| Project TypeScript | PASS, exit 0 |
| Backend Build | PASS, exit 0 |
| Frozen fresh-v2 DDL | PASS: 58 tables, 94 FKs, 144 guards, 86 CHECKs; integrity_check=ok; foreign_key_check empty |
| Full S2 final candidate suite | 112 / 112 PASS |
| Fresh managed provisioning before integration | 7 actual successful operations; isolated provider harness 1/1 PASS |
| LOCAL/GIT × Python/JS/TS/Shell | 8/8 real executions, exit 0, one Attempt each, cleanup SUCCESS |
| Failure injection / Config / Hooks / queue / ownership | Included in full S2 suite |
| Full-engine SIGKILL | 15 / 15 PASS |
| Direct materialization SIGKILL | 10/10 PASS |
| Backup integration | Actual executed history/resource component restore; included |
| S1.A regression | 68/68 PASS |
| Relevant v9 regression | 190/190 PASS across 51 active manifest files |
| Linux | NOT_RUN |
| Browser | NOT_RUN |
| Container | NOT_RUN |
| Formal AMD64 / ARM64 dual-architecture qualification | NOT_RUN |

Full S2 entrypoint: `node tests/workspace-v2/s2-run.cjs`. It provisions actual providers when no receipt is supplied and serializes qualification files. The final rerun used the already physically validated receipt from the fresh provisioning above, after the candidate admission-order correction and supplemental tests. Managed roots/receipts/binaries/databases remain private temporary fixtures and are not committed. Reproduction and boundaries: [S2_README](../../../tests/workspace-v2/S2_README.md). All final suite names, selected v9 files, counters, host/runtime metadata, frozen checks and source/test SHA256 are retained in [machine evidence](../../../tests/workspace-v2/s2-validation-results.json).

The v9 selection follows current `tests/platform/test-baseline.json`, excluding only its ARCHIVED_LEGACY entries and selecting relevant Phase2/5/6/7/8/9/10/12/14 plus platform environment/fresh-schema suites. It covers Task/execution, locks/process groups, Hooks/Config, runtime, Workspace/files/Git and backup/restore. Existing regression fixtures are not presented as real managed v2 qualification. Candidate-only admission changes after this regression do not alter the shared code whose hashes were tested.

## Isolation

Production Schema Changed: NO. S0 full frozen candidate schema is used explicitly; no existing database is upgraded, initialized or reset. Signature remains `f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c`.

Production API Changed: NO. No public v2 API/routes, frontend menu or LOCAL UI entry, epoch switch, scheduler registration, S3 Git sync/discovery/outbox dispatcher, Subscription deletion or legacy migration.

Production Task Runner Changed: shared RunnerV2 input typing and Hook plan typing were generalized to the fields they actually consume; runtime process algorithms remain the existing implementation. Config/Node components have optional explicit resource/journal adapters and fault checkpoints; existing default Worktree behavior remains covered by the v9 regressions. The new candidate is used only by the isolated internal harness. No second complete Runner, runtime provider or materialization implementation was copied.

Public LOCAL Entry Added: NO. New source is under `back/services/taskExecutionV2/`; S1.A changes are limited to resource-aware journal gating, custom CWD references, archive drain integration and backup owner-artifact checks. Runtime fixture binds only unchanged runtime models to the explicit candidate database, with no schema sync or v9 Task loading.

GitNexus: upstream impact was run before symbol edits; HIGH/CRITICAL shared paths were reported. Index-only refresh and staged/compare detect_changes precede commit. Detection counts/risk and its missing-edge/flow-truncation limitations are retained in machine evidence. Static import boundary and Git path/hash checks independently verify scope; UNKNOWN graph results never mean unused.

## Git

Commit: local `feat: converge v2 task execution on workspaces`, containing code, tests, fault harness, this report and machine evidence. User `.gitignore` remains unstaged.

Push: NO. Tag: NO. Release: NO. Deploy: NO. No image publication.

## Final

ZHI_XU_V2_S2_EXECUTION_CONVERGENCE_PASS: **YES**

READY_FOR_S1B_REVIEW: **YES**

Remaining Blockers: none for the qualified internal S2 candidate. Formal Linux/browser/container/dual-architecture validation and public DTO normalization remain explicitly deferred gates, not completed qualifications. S1.B disaster recovery requires its independent authorization. S2 stops here for review; S3/S4/S5 are not started.
