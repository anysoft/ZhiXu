# S3 candidate qualification

These tests import the isolated fresh-v2 S1/S2/S3 services directly. They do not register a production schema, startup service, route or UI.

Run all S3 cases:

```sh
node tests/workspace-v2/s3/run.cjs
```

Run a focused slice:

```sh
node tests/workspace-v2/s3/run.cjs sync.test.cjs sync-crash.test.cjs sync-failure.test.cjs
node tests/workspace-v2/s3/run.cjs discovery.test.cjs scheduler.test.cjs scheduler-policy.test.cjs
node tests/workspace-v2/s3/run.cjs outbox.test.cjs outbox-crash.test.cjs outbox-backup.test.cjs
```

The common S1.B harness allocates owned private domains, installs the complete frozen schema, isolates bootstrap ENV and retains sanitized reporter output, per-case evidence, sampled process-tree RSS and qualification receipts. Test cleanup never touches an unowned instance. Successful and failed runs are retained for inspection.

Git remotes are actual owned local repositories. The local transport constructor capability verifies the exact remote identity and is absent from the default HTTPS/SSH credential path. Fetch, worktree, FF, object corruption, ancestry, real managed runtime execution, SQLite transactions and full-root backup/restore are real operations.

The managed Python contention test can reuse an existing **owned and reverified** S2 qualification receipt via `ZHIXU_S2_MANAGED_RECEIPT`. Otherwise its managed fixture provisions a private runtime. This is never a host-runtime fallback. The S1.B regression independently downloads/builds its managed assets in A and B.

Required SIGKILL boundaries:

| Test file | Boundaries |
|---|---|
| `sync-crash.test.cjs` | Before Fetch; After Fetch; Before FF Apply; After Physical HEAD Changed; Before/During/After Discovery; Before DB Success Commit; After DB Commit |
| `git-inflight.test.cjs` | During actual Fetch; During actual Checkout |
| `outbox-crash.test.cjs` | Before Outbox Dispatch; After TaskRun Insert; Before Outbox Ack |

Each boundary kills an actual controller process and starts a fresh recovery process. In-flight checks observe actual Git child work; Checkout additionally observes changed bytes, index lock and old HEAD. Partial Checkout may correctly remain fenced as RECOVERY_REQUIRED. It is never reset into a claimed success. Additional tests reject otherwise-valid admin replacement and configuration changes using the journal's original identities.

`sync-failure.test.cjs` adds real malformed discovery and a temporary SQLite abort trigger inside its private database. The latter demonstrates rollback of Discovery, Workspace publication, Sync SUCCESS and Outbox, followed by formal recovery after removal of that test-only abort. Frozen DDL files are untouched.

The committed result is an aggregate of the latest applicable passing focused cases and fresh full regressions. Superseded failed runs remain identified; repeated cases do not increase the unique S3 pass count. No single whole-suite snapshot run is implied by that aggregate.

Contract verification:

```sh
python3 docs/architecture/v2/contracts/validate_ddl.py
python3 tests/workspace-v2/s3/validate-contracts.py
```

The S0 wrapper checks all frozen hashes and runs the original structural assertions read-only. Its five historical entry-audit predicates are marked as historical rather than asserted against a later implementation HEAD. It does not overwrite frozen validation receipts.

`collect-results.py` accepts a private evidence index and writes the sanitized machine result. Private log/root paths are inputs, not published evidence. The output records hashes, commands, identities and outcomes, excludes raw output/secret values, and identifies the containing local commit without an impossible self-referential commit hash.

Darwin arm64 host qualification does not establish S5 Linux, Container, AMD64/ARM64 or Browser qualification. Delivery is at-least-once with one durable TaskRun per event; arbitrary external effects are not promised exactly once.
