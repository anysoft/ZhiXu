# S1.A internal component qualification

Run from the repository root:

```sh
node tests/workspace-v2/run.cjs
```

The runner allocates its own private temporary configuration, data and control
directories. Fixtures create the complete frozen fresh-v2 SQL schema in an
exclusive new database. They never initialize the application's v9 connection or
read the developer's default data directory. Fixture cleanup removes only its
allocated temporary parent.

Tests use real SQLite, Git, POSIX leases, backup inventory, encrypted archives,
candidate-root publication and rollback. Crash workers terminate with SIGKILL;
the parent reopens the actual database and invokes recovery. One save test kills
the process after observing the existing atomic writer's temporary file, and the
lease test leaves an inherited child running after its controller dies.

Task/TaskSource and terminal TaskRun rows are candidate-schema reference fixtures.
They test foreign keys, protected entrypoints and retained historical identity.
They do not execute tasks or qualify S1.B.

Production services do not import `back/services/workspaceV2`. Candidate components
require explicit existing fresh-v2 `database.sqlite`, DATA_DIR, BACKUP_DIR and
private external control directory. `WorkspaceStore.open` only validates and
opens; fresh schema creation exists exclusively in this fixture. There is no
public LOCAL endpoint, schema migration or startup switch.

Limits in `workspaceV2/limits.ts` are bounded S1.A defaults. Internal test options
may lower them. Overrides cannot raise a reviewed default. A complete source scan
is conservative: unsafe files, unstable inventory, unknown owner or unresolved
journal stop operations. Recovery preserves unknown temporary artifacts for
manual investigation rather than deleting them to manufacture readiness.

Restore replaces the explicit candidate root under the backend lifetime lease,
retains the previous root in an owned rollback directory and returns a newly
opened Store. Callers must rebuild services with that returned Store; the original
Store is closed. Rollback/candidate retention and preservation holds are not
automatically purged. No final metadata purge or hold-release API is exposed.

See the committed `validation-results.json` and
`docs/architecture/v2/S1A_IMPLEMENTATION_REPORT.md` for executed checks and stage
boundaries. Browser, managed runtime, Linux and container qualifications are
separate gates.
