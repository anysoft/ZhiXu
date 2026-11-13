# S2 internal Task/Execution qualification

Run the complete S2 candidate qualification from the repository root:

```sh
node tests/workspace-v2/s2-run.cjs
```

The orchestrator provisions one fresh, isolated managed runtime domain through the
existing providers and environment builders. It compiles managed CPython, creates
an actual Python environment, installs the checksum-verified official Node
distribution and controlled npm/tsx build, then runs S2 test files sequentially.
Network access and the providers' build prerequisites are required. It does not
substitute a host Python, Node or TypeScript runner.

For repeated qualification, explicitly supply the private receipt printed by the
provisioner:

```sh
ZHIXU_S2_MANAGED_RECEIPT=/absolute/path/to/receipt.json node tests/workspace-v2/s2-run.cjs
```

The receipt is not a success stub. The fixture checks its private ownership,
directory identity and frozen candidate schema, and reads current environment
revisions/builds from the real database. Managed files, owner markers, executable
hashes and build pins are verified again by the execution resolver. Receipt
provenance describes the initial installation; promotion tests intentionally
advance current build IDs. Do not run files concurrently against the same prepared
domain: Global ENV and managed promotion tests deliberately change resource
versions. The private temporary runtime domain is retained locally for inspection
and repeat runs, and is excluded from Git.

Individual S2 files can be passed to either the orchestrator or the original
isolated runner. `node tests/workspace-v2/run.cjs` continues to run the original
S1.A tests by default. Neither harness reads the developer's `.env` or data root.

The candidate services live in `back/services/taskExecutionV2`. They require an
explicit `WorkspaceStore`, roots and S1.A lease service. TaskRuns is the only
durable queue. In-memory maps only retain active cancellation/lifetime handles;
they cannot authorize execution. No candidate service is registered in the v9
startup, routes or scheduler.

TaskRun admission/source snapshots contain safe identities and versions, not
secret ENV/config values or host roots. The actual context is frozen in memory;
execution uses the live Workspace under its exclusive lease. This is not a full
immutable source archive. A changed queued expectation is skipped with zero
attempts. A child that changes source before retry cannot execute replacement
bytes under the previous snapshot; its Run fails with `SOURCE_SUPERSEDED`.

Config and Node binding reuse the existing algorithms through explicit Workspace
resource adapters. The additional owner proof binds journals to the Workspace
inode/owner/generation and original Run identity. Recovery takes actual run-owner
and Workspace FDs before restoring originals. Unknown artifacts remain protected
in `RECOVERY_REQUIRED`. Proven journals of another Workspace do not block
independent execution, and disappearing journal entries are safely rechecked.

Tests include actual managed LOCAL/GIT executions, private Config/ENV, all hook
phases, cancellation/timeout/retry, queue limits/fairness/idempotency, Cron misfire,
two controller processes, and real SIGKILL followed by a fresh recovery process.
The backup test restores history/resources without executing again in B. The
separately authorized S1.B disaster-recovery gate remains **NOT_RUN**.

See `s2-validation-results.json` and
`docs/architecture/v2/S2_IMPLEMENTATION_REPORT.md` for the final executed evidence.
Formal Linux, browser, container and dual-architecture qualification are separate
gates and must not be inferred from this local component run.
