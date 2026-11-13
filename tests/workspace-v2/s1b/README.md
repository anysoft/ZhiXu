# S1.B full asset disaster-recovery qualification

From the repository root:

```sh
node tests/workspace-v2/s1b/run.cjs
```

Individual files can be passed by name. The complete qualification includes a
fresh managed Python compilation and two independent installations of the
managed Python/Node environments. Network access to the pinned provider,
CPython/Node distributions and managed dependency registries is required.

The runner creates one private temporary sandbox, private bootstrap configuration,
logs and a receipt. It never reads the developer's default DATA_DIR. Every case
uses exclusive owned instance roots, the complete frozen schema and the actual
S1.A/S2 services. Failed and successful evidence is retained in the printed
sandbox; no automatic recursive cleanup targets an unverified path.

The full disaster case uses separate A and B controller OS processes. A creates
all eight LOCAL/GIT language Tasks and actual history, encrypts the official
backup, copies it into the independent transfer domain, then destroys its owned
source, runtime, catalog, remote and control roots. A exits before B starts. B
receives only the authenticated archive, ID/version/hash expectations and a
48-byte key through an anonymous private pipe. No key, plaintext source copy,
Config/ENV value or A runtime tree is transferred through JSON. B imports and
restores under a different root, rejects missing managed runtimes without an
Attempt, reinstalls them through the official resource mechanisms and executes
the original Task IDs. Completed history is compared by full row/log hashes.

The same suite verifies reclamation holds and portable preserved assets,
seven real restore SIGKILL checkpoints with independent recovery processes,
active managed Runtime/Workspace/Config/Node ownership versus backup, source
supersession, ownership and archive corruption failures. The current physical
ENOSPC fixture uses a bounded 32 MiB file-backed HFS+ image on Darwin. It first
checks the unmodified free-space policy, then lowers only the internal test
minimum so actual I/O can run out of space. It ejects only its verified private
mount point. An equivalent bounded-volume fixture is required before running
this case on another OS; no skip converts it into a pass.

`reporter.mjs` emits test status, safe failure code, stack locations and counters.
It withholds raw output and assertion actual/expected values, which can contain
Secret Sentinels when a safety assertion fails. A deliberate failing-child test
proves that this protection preserves the nonzero failure status. Detailed safe
facts and evidence hashes remain in per-case private JSON records. The runner
samples descendant-process RSS every 250 ms; per-phase metrics also record
measured disk usage and elapsed time. These are engineering observations, not
production SLO or formal S5 qualification.

The S1.A and S2 original entrypoints remain separate regression suites. Formal
Linux, browser, container and AMD64/ARM64 release qualification are NOT_RUN here.
No public API/UI, startup epoch, Git sync/discovery dispatcher, Subscription
removal, migration, push or deployment is part of this harness.

Final executed evidence is in `../s1b-validation-results.json` and
`docs/architecture/v2/S1B_QUALIFICATION_REPORT.md`.
