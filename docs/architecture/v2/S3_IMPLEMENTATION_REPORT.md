# ZhiXu v2.0 — S3 Implementation Report

## Baseline

Branch: `develop`.

Entry HEAD: `0676543fdd6c1a9292d0b759c2d358933426b20a`.

Final HEAD: the local commit containing this report and `s3-validation-results.json`; its exact SHA is verified after commit and returned in the delivery message. A tracked report cannot contain its own commit hash.

User Changes Preserved: `.gitignore` remains uncommitted and byte-identical to entry, SHA-256 `78f778aa7cc3494334676046b883b672c9e98f3fb28adfd3868b9aa99aef4893`.

This is an isolated fresh-v2 candidate implementation. Frozen S0 artifacts and prior S1.A/S2/S1.B evidence remain unchanged. Qualification date: 2026-11-14, Asia/Singapore.

## Git Workspace

Repository Ownership: the explicit candidate Store selects the Workspace's Repository and its credential identity. Default HTTPS/SSH access reuses the existing credential resolver and supervised Git command machinery. Tests receive a separate constructor capability limited to their owned local remote. That capability has no production route or default host fallback.

Private Checkout: S1 root marker, device/inode, linked admin registration, private branch, complete inventory and Git object verification are reused. Repository mutation uses the Repository FD; checkout and discovery additionally use the Workspace FD, always in that order. No SQL write transaction waits for these locks.

Branch / Tag / Commit: branch synchronization resolves its fixed `origin/<branch>` binding. Repository default-branch changes do not retarget it. Tag and commit Workspaces retain the originally resolved SHA, including after a remote tag moves. Same Repository/ref Workspaces retain separate source, Task, SyncRun and Outbox identities.

Sync Policy: `WorkspaceSyncPolicies` persists Manual, Cron/Interval, enable state, independent version, next due and last claimed occurrence. IANA Cron timezones use the existing Cron algorithm; occurrence timestamps persist as UTC. Interval occurrences derive from the anchor, rather than controller restart time. Tag/commit scheduling is rejected.

Manual / Scheduled: one canonical SyncRun admission path checks policy/source expectations, request identity and the frozen active-Workspace uniqueness guard. The durable queue is `WorkspaceSyncRuns`. Controller memory holds local cancellation handles and non-authoritative cursors for bounded claim-attempt rounds. A busy Repository cannot fill every subsequent turn and starve an independent free Repository; new arrivals wait until the finite current attempt round completes. Server bounds cap queue size, concurrently RUNNING claims, deadlines, retries and backoff without adding schema fields.

## Git Update

Fetch: authenticated structured argv, bounded supervised output, atomic shared-ref update and Repository ownership validation. Fetch does not move a Workspace. Unsafe transport configuration is rejected before credential use. Child stdout/stderr and credentials are not stored in SyncRun, Outbox or errors.

FF-only: a verified safe target tree and clean checkout are required before real `git merge --ff-only --no-edit --no-overwrite-ignore <sha>`. There is no reset, clean, stash, rebase, force checkout or auto-merge path. Target links, gitlinks, reserved paths and quota violations are rejected. Normalized casefold aliases are rejected at every target path component, including directory aliases and file/directory ancestors. This deliberately conservative portable-name policy also rejects otherwise legal case-distinct Linux trees.

Dirty Protection: staged, unstaged, unmerged, untracked and ignored collisions block update. `assume-unchanged` and `skip-worktree` are also rejected, since normal Git diff can hide their local bytes. Files and index flags are preserved.

Independent audit reproduced two P1 defects before release: weak Git stat configuration could conceal a same-size/restored-mtime user edit and permit overwrite; a case-insensitive checkout of `Case.sh` plus `case.sh` could leave an incomplete tree with false Sync SUCCESS. The candidate Git supervisor now forces `core.trustctime=true`, `core.checkStat=default` and `core.ignoreStat=false` without rewriting Repository configuration. Target component collision checks reject ambiguous trees before mutation, and post-checkout verification requires a clean exact-target NO_CHANGE plan before reconciliation. Five new real Git preservation regressions pass, and the affected Sync/Outbox/crash paths were requalified after both fixes.

Diverged Protection: actual ancestry distinguishes local-only commits from divergence. Both remain intact. Missing objects, invalid refs and foreign/replaced Git administration fail closed.

Physical HEAD: physical Git success is separate from SQL success. Before mutation, a durable Workspace recovery fence closes ordinary execution, editing, lifecycle and backup admission. A fsynced journal pins the SyncRun/source hash, before/target SHA, root identity, admin identity/configuration hash and pre-apply index/inventory proof.

Source Generation: in-place FF retains `source_generation`. Complete inventory publication increments `content_revision` only when the inventory hash changes. A Git commit move with identical content remains a real update fact without an invented content revision.

## SyncRun

State Machine: all transitions obey frozen SQL. Pre-claim timeout is BLOCKED, not the forbidden QUEUED→FAILED transition. Unapplied failures/cancellation have no Outbox. Terminal Runs are never revived for retry; a retry receives a new deterministic request key and Run with the original occurrence/source expectation.

Journal: `tmp/workspace-v2/sync/sync-<id>.json` contains bounded safe identities, not credentials or private ENV/Config. The existing backup admission recursively rejects residual journal files. Unknown, corrupt or replaced evidence is retained.

Crash Recovery: a new controller must first acquire the real per-Run owner FD, then Repository→Workspace FDs. PID and claim expiry do not prove a dead owner. Proven unapplied work becomes INTERRUPTED. A clean checkout at the durable target is reconciled against that target even if another Workspace has since fetched a newer branch. Partial/foreign/unproven state remains RECOVERY_REQUIRED without resetting files. A cancelled checkout that already physically completed must still reconcile its actual applied fact; it does not become a false CANCELLED/unapplied fact.

Multi-controller: active Workspace uniqueness, owner-FD admission, short SQL owner CAS, stable occurrence keys and transactional policy cursors protect independent processes. A controller cannot steal a live owner merely by moving its clock past expiry. Missing/failed ownership is conservative.

## Discovery

Preview: readonly safe inventory and bounded metadata parsing, with a signed bounded preview token. It does not create Tasks, Cron, TaskRuns, Outbox or Sync success.

Apply: versioned Workspace/source/inventory/Git, policy, Task, Trigger and suppression captures are rechecked in one SQL transaction. Filesystem scanning and metadata reads occur before this transaction under the actual Workspace lease. The Sync-only preparation path requires its matching durable Sync owner and does not bypass ordinary readers' recovery fence.

Reconciliation: stable `sha256(relative_entrypoint)` identity within each Workspace; canonical S2 Tasks and settings, rather than a second task domain. New discovered Tasks are disabled. Missing runtime/readiness remains explicit. Invalid metadata, Cron, runtime kind or duplicate identity blocks complete reconciliation and prevents Sync SUCCESS/Outbox publication. Removed scripts retire their owned Tasks with source proof; reappearance requires explicit restore.

Suppression: the frozen Workspace suppression table persists ignore decisions across scans, Store restart and full-root restore. Suppressed entries are not silently recreated.

Manual Task Protection: MANUAL Tasks are never adopted or overwritten. Discovered Task user overrides, Runtime, ENV/profile, Config bindings, arguments, Hooks, execution policy and enable state are retained.

Cron Ownership: Discovery updates only its owned baseline. USER Cron and the user's deletion/override tombstone survive source metadata changes.

Stale diagnostics: actual source generation/revision/inventory/HEAD changes return `SOURCE_SUPERSEDED`, as requested for S3; policy/Task/Trigger/preview capture mismatch returns `DISCOVERY_PREVIEW_STALE`. Frozen S0 artifact bytes are unchanged.

## GitUpdate

Success Transaction: Workspace inventory/revision, Git applied/verified SHA, complete Discovery reconciliation, SyncRun SUCCESS, immutable trigger plan, Outbox and initial baseline marker commit atomically. READY is only visible outside that SQL transaction after all writes succeed. The transaction performs no Git operation, scan or OS-lock acquisition.

Outbox: at-least-once dispatch with a real per-Outbox owner FD, SQL owner claim/CAS, bounded timeout, retry/backoff and durable per-target outcome. Event identity is `sha256(gitupdate:v2:<origin-trigger>:<workspace>:<generation>:<after-sha>)`; S2 submission uses `event:<TriggerEvent.id>`.

Initial Event: the first logical baseline has one Outbox even when HEAD did not move. Only `fire_on_initial=true` targets are eligible. Initial path filters evaluate the complete initial source inventory. Baseline establishment and deferred FK constraints commit together.

No-change: after baseline, unchanged effective commit is NO_CHANGE with no new Outbox or TaskRun. Fetch count, restart and repeated occurrence do not produce another initial event. Tag/commit pinning does not follow changed remote refs.

Dispatch: every admitted target is frozen with its full safe S2 admission metadata, including Workspace, Task, ENV/profile, runtime/build and Config revision identities. If dispatch happens after source or resource change, the same durable submission is SKIPPED with zero Attempts and its old complete expectation. It cannot combine an old commit with current resource expectations. Forged Event metadata must fail exact comparison with the immutable Outbox plan.

TaskRun Idempotency: dispatcher death after TaskRun insertion or before acknowledgment replays the same submission key and Run. This guarantees a single durable TaskRun effect per event, not exactly-once arbitrary external side effects.

Two frozen DDL/prose differences require explicit accounting:

1. There is no `dispatch_summary` column; `trigger_plan` is immutable and new TriggerEvent insertion requires an existing target. The success transaction therefore creates RECEIVED/SKIPPED TriggerEvents with the Outbox while targets exist. Their durable statuses are the per-target summary. Deleting a target later uses existing FK/retention rules, and dispatch settles the retained event without inventing a replacement identity.
2. Frozen SQL does not allow DEAD→RETRY/CANCELLED. Transient retry and dead-owner recovery operate before DEAD. `retryDead`/DEAD cancellation explicitly reject `SYNC_RECOVERY_REQUIRED`; they do not bypass guards or manufacture another event. A product action to revive DEAD requires a later contract decision. No S3 public action exposes unsupported revival.

## Subscription Retirement

Responsibilities Reassigned:

| Previous Subscription responsibility | v2 owner and implementation evidence |
|---|---|
| Repository source | `GitWorkspaces.repository_id`, verified S1 storage and `WorkspaceGitAdapter` |
| Worktree management | S1 private Workspace checkout/root/admin ownership |
| Sync policy | `WorkspaceSyncPolicies` and `WorkspaceSyncPolicies.save` |
| Sync schedule | `WorkspaceSyncScheduler`, durable cursor and occurrence identity |
| Discovery | `WorkspaceDiscoveryPolicies`, `GitWorkspaceDiscovery` |
| Suppression | `WorkspaceDiscoverySuppressions`, Workspace-keyed identity |
| Runtime default | S2 `WorkspaceRuntimeDefaults` and Task override |
| ENV profile / Task ENV | S2 Workspace/Task profile and variable ownership |
| Config binding | S2 Workspace/Task binding and immutable revision pin |
| GitUpdate | successful Workspace fact, `WorkspaceUpdateOutbox`, S2 Event admission |
| Sync history | `WorkspaceSyncRuns` |
| Task execution | S2 canonical `TaskRuns`, Attempts, runner and resource leases |

Residual v2 Dependencies: no Subscription ID, owner, default, discovery, schedule or trigger is required. Real LOCAL and GIT Tasks execute in a frozen database with no Subscriptions/Worktrees tables; Sync, Discovery and GitUpdate use those same candidate services. Reused credential/process algorithms do not consult a Subscription.

v9 Isolation: production Subscription files/tables and their existing execution graph remain in place. Related current v9 tests are rerun. No legacy compatibility adapter, data migration or v2 startup registration is introduced.

## Backup / Restore

Sync Domain: existing full-root S1.B snapshots include policy/history/discovery/suppression/Outbox/Event identities in authenticated SQLite. Active Sync ownership and unresolved journals reject backup. A successful Sync cleanup leaves no transient journal asset to restore.

Outbox Recovery: the S3 integration destroys the whole original A, including its remote, before restoring independent B. Completed GitUpdate history does not replay; a pending restored event produces exactly one real original-GIT Task submission. Suppression, retirement proof, fixed checkout, source/helper bytes, original LOCAL Task and history survive, and B can back up again.

S1.B Compatibility: no backup/restore implementation or frozen schema is changed. The shared Git verification seam adds only an optional missing-object error classification; existing callers retain their default behavior. Full S1.B disaster qualification is rerun on current code.

## Failure Injection

Git Applied / DB Failed: no false SUCCESS, Outbox or Event is visible before the success transaction. Physical HEAD and the recovery fence survive controller death; an independent controller reconciles the same recorded target.

Discovery Failed: blocking metadata diagnostics leave the physical fact fenced and preserve source. No partial Task reconciliation or successful event is committed.

Outbox Recovery: death before dispatch, after TaskRun insertion and before acknowledgment retains stable Event/Run identities. Live owner expiry cannot steal the FD; dead-owner recovery permits replay without a second TaskRun.

SIGKILL: real subprocess kills cover all 14 requested boundaries. DURING_FETCH observes actual Git/upload-pack work; DURING_CHECKOUT observes changed bytes plus index lock and pre-update HEAD. The other nine Sync and three Outbox checkpoints use fresh recovery processes. JavaScript exceptions are additional rollback checks, not substitutes for SIGKILL.

Concurrency: real managed Python vs Sync/editor, independent Workspace publication, concurrent occurrence admission, queue fencing, cancellation after physical apply and backup/lifecycle recovery admission are checked. Leases remain held through child teardown.

## Tests

Final counts, exact commands, exit codes, individual case IDs, evidence/log hashes and bounded resource measurements are recorded in `tests/workspace-v2/s3-validation-results.json`. Earlier failed harness attempts are retained and identified there; they are not counted as passes.

S3: 81/81 unique cases PASS, zero skips. The result deduplicates repeated focused qualifications; it does not imply a single whole-suite invocation. After the final Git fixes, the relevant sets passed 17/17 (safe Git and new preservation), 5/5 (fresh-process recovery and reconciliation), 4/4 (fairness/cap/reconciliation), 16/16 (Sync/atomicity/retirement/cleanup), 14/14 (Outbox/full-root restore) and 8/8 (Scheduler).

S1.A: current-code 68/68 PASS, zero skips.

S2: current-code 112/112 PASS, zero skips; real managed eight-combination execution and source/resource supersession are included.

S1.B: current-code 36/36 PASS, zero skips, including separate-controller A→destroy→B real managed disaster and all seven restore SIGKILL boundaries.

v9: current-code 210/210 PASS, zero skips; the historical related 190 cases plus current Git/Subscription coverage selected from the active manifest.

TypeScript / Backend Build: backend and project TypeScript, plus backend build PASS on final source. The collector's positive/negative privacy, duplicate-case and fresh-process proof self-tests also pass.

DDL: original frozen validator is rerun read-only against in-memory SQLite; 58 tables, 94 FK constraints, 144 guards and 86 dynamic checks retain signature `f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c`.

S0 Contract Validation: all 37 frozen input hashes are verified. The frozen validator's current structural assertions are executed without modifying its source or historical receipt. Its five original S0 entry-HEAD/tree/report audit predicates are explicitly marked historical and replaced by the current frozen-hash and preserved-user-change proof; they are not falsely reported as S3 entry facts.

Linux / Browser / Container: not qualified here. Host verification is Darwin arm64; formal Linux/Container/AMD64/ARM64/Browser qualification remains S5.

## Isolation

Production Schema Changed: NO.

Production API Changed: NO.

Public LOCAL/GIT v2 Entry: NO. Candidate services are imported only by internal qualification code.

Subscription v9 Removed: NO.

## Git

Commit: this local containing commit, `feat: converge v2 git sync and discovery on workspaces`.

GitNexus: the refreshed current Repository index is explicitly bound to `ZhiXu`. Before commit, staged and `develop` comparison change detection are reviewed. Overall graph risk is CRITICAL because the change connects the full new candidate domain and shared Git verification/S2 methods. Method-specific warnings were raised before edits. Generic property nodes such as `version`, `workspace_id` and unchanged `limits` broaden graph flows; direct import/diff review verifies that the concrete edits remain in candidate services/tests, the optional shared verification seam and this report. Current complete S1.A/S2/S1.B/v9 regressions provide the corresponding behavioral check.

Push / Tag / Release / Deploy: NO.

## Final

ZHI_XU_V2_S3_GIT_WORKSPACE_CONVERGENCE_PASS: YES.

READY_FOR_S4_REVIEW: YES.

Remaining Blockers: none for the S3 internal candidate. Frozen SQL/prose limitations and S5 platform qualifications are stated above. S4 implementation is not started; delivery stops here for human review.
