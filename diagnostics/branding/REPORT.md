# ZhiXu Brand Convergence Report

## Resume

Entry HEAD: `fd38b7d685d6ac18fdcd90f8d92ecc5299df691f` (`develop`, clean at entry).

Previous brand work: `0331f3b68a30f745ea4a706f982bb6b2b62c68d0` established the existing repository/package/image display identity and new logo. This task supplements it rather than reverting that migration. The preceding bilingual implementation is preserved, including its historical audit evidence.

## Product Identity

Official product name: **ZhiXu**. Chinese alias: **NONE**. English name: **ZhiXu**.

`back/shared/brand.ts` is the one display-name source; the UI re-exports it through `src/utils/brand.ts`. Surrounding copy uses the existing internationalization controller and dictionaries. No additional provider/service/framework was introduced. Standalone notification samples remain self-contained.

## Audit

Before edits: **8,213 matched locations / 8,660 occurrences**. A location groups one matched value on one source line, with every column recorded. Repeated identical source lines share a classification fingerprint but remain separate reported locations.

| Classification | Before | After |
|---|---:|---:|
| USER_VISIBLE_REPLACE | 39 | 0 |
| PRODUCT_METADATA_REVIEW | 2 | 0 |
| INTERNAL_IDENTITY_KEEP | 170 | 174 |
| HISTORICAL_EVIDENCE_KEEP | 7,648 | 7662 |
| UPSTREAM_ATTRIBUTION_KEEP | 1 | 2 |
| TEST_FIXTURE_REVIEW | 353 | 377 |
| UNKNOWN_MANUAL_REVIEW | 0 | 0 |

Final inventory: 8215 locations / 8657 occurrences. New audit assertions and this report introduce legitimate evidence references; totals are not expected to reach zero.

See [before inventory](brand-audit-before.json), [final inventory](brand-audit.json), and [per-occurrence review](brand-audit.md). Exact exceptions live in `scripts/branding/classifications.json`. In addition to textual matches, manual source/visual review found and removed the console ASCII wordmark. Its old letter-art did not contain a searchable contiguous brand name; a regression assertion now covers it.

## Changes

- UI: remove the Chinese alias from initialization, login/config, main layout, About, custom-title help and client-IP help. Console product banner uses the constant and localized environment labels. No script stdout/stderr rewriting.
- Titles: reuse the current route/title mechanism; include the formal name and localized page label, retain custom user titles as an additional suffix. Missing Tasks/Runs/Notifications/Repository title entries are localized. Stored custom titles are not migrated or overwritten by this task.
- Metadata: HTML title, application-name, Apple app-title and OpenGraph site name use the same constant. OCI title already matches; retained unchanged. No PWA manifest or Twitter product metadata exists in the tracked active source, so those are N/A.
- Docs: README title/alt text/name explanation now use only the official name and accurate upstream attribution. The obsolete unversioned architecture guide is explicitly historical and links to current architecture; its original content remains intact.
- Notifications: channel-test titles, bot message prefix and email sender display use the formal name. Backend English test notification copy is now translated. Two standalone sample templates are updated. Provider IDs, API fields, recipients and user-authored title/body remain unchanged.
- Startup diagnostics: correct the suggested PM2 process name to the already-existing `zhixu` identity; no health decision or process identity is changed.
- Assets: existing blue/green branch SVG logo and favicon are retained. Login, initialization, main layout and README imports already point to the new icon. Font assets are generic. Historical screenshots remain untouched.

## User-visible Verification

Real compiled frontend/backend, fresh databases and owned temporary roots, local macOS ARM64 with Chrome. Four separate sessions cover explicit zh-CN, explicit en-US, SYSTEM + zh-CN and SYSTEM + en-US.

| Surface | Result |
|---|---|
| Login / Initialization | PASS |
| Dashboard / Repository | PASS |
| Tasks / Runs | PASS |
| Runtime / Notifications | PASS |
| Settings / About | PASS |
| 404 / Browser title | PASS |
| application-name / Apple app-title | PASS |

Each page asserts a visible formal brand, the document title and absence of retired product spellings/aliases in the fresh fixture UI. The title animation is awaited using Playwright visibility, without force clicks or weakened assertions. Existing user data is not scanned and rewritten as brand text.

Six required screenshots were visually inspected in the English session, with Chinese and SYSTEM sessions also captured and automatically checked. No old wordmark or logo was found. Pink rectangles are the existing acceptance harness's form-value privacy masks; they do not hide product branding.

Evidence: `browser-explicit-en-US/`, `browser-explicit-zh-CN/`, `browser-system-en-US/`, `browser-system-zh-CN/` (`brand-browser.json` and screenshots).

## I18N

zh-CN brand: ZhiXu. en-US brand: ZhiXu. SYSTEM zh: PASS. SYSTEM en: PASS.

Resource parity and semantic/ICU checks: PASS, 1,827 keys in each locale. Branding sentences interpolate the official name; no translated competing app-name key remains. Locale switching architecture is unchanged.

## Remaining QingLong References

| Identity/evidence | Decision |
|---|---|
| Current repository `anysoft/ZhiXu`, package `@anysoft/zhixu`, configured Docker image | KEEP current state; no migration or remote change |
| Historical `anysoft/qinglong`, upstream package/repository references | KEEP exact historical or upstream meaning |
| GitNexus index name `qinglong` | KEEP tool identity |
| `QL_*`, `QlBaseUrl`, CSS/icon IDs, fixture packages and temporary paths | KEEP internal contracts |
| `com.ql.api`, `com.ql.health`, `X-QL-Log-Total`, `X-QL-Log-Truncated` | KEEP RPC and log-response contracts |
| `qinglong.repositoryId`, certificate subject `qinglong-ca` | KEEP persistent repository/certificate identities |
| `PLATARC1`, `PLATBKP1`, UUID `.platform-backup` filenames | KEEP backup format and restore identity |
| Phase reports, archived workflows, previous diagnostic artifacts | KEEP historical evidence byte-for-byte |
| README upstream acknowledgement, security attribution and LICENSE | KEEP attribution; LICENSE unchanged |

Each remaining occurrence justified: **YES** in the final classified inventory.

### Separately recorded technical residue

`/ql/data` appears in historical records and retained, unreferenced `shell/lang/en.sh` / `shell/lang/zh.sh` dictionaries. No active shell consumer was found; this is **LEGACY_TECHNICAL_IDENTITY**, not authorization to restore the old layout. Active container layout remains `/data`, `/data/state`, `/data/home`, `/backup`, with no path/schema change. No new **LEGACY_ARCHITECTURE_VIOLATION** was introduced.

The existing error page still suggests the retired `ql check`, `ql update`, and `ql log` commands, and an unused locale entry describes command import. These are technical/help-text residue rather than product-brand labels; they were retained and explicitly classified, not silently declared supported or migrated under this task. They merit a separate current-operations help correction.

## Automated Brand Audit

USER_VISIBLE_QINGLONG_REMAINING: **0**. USER_VISIBLE_青龙_REMAINING: **0**. Other retired product aliases in current brand source: **0**. Unclassified legacy brand: **0**.

The scanner examines tracked text and non-ignored new source, including documentation/history. Generated audit outputs are excluded only by five exact filenames (the classification file and four report files), to prevent recursive self-reporting. Generated build/dependency/private local files are outside source scope. Binary assets are explicitly listed for visual review. No entire docs/source directory is ignored.

Negative tests cover all requested spellings, aliases, QL tokens, added occurrences in an already reviewed file, missing reasons, invalid categories and unresolved metadata. CI static qualification invokes the source gate. The platform baseline includes brand and notification tests. The browser CI job now includes all four focused brand sessions and records their stage results.

## Regression

| Check | Result |
|---|---|
| Frontend TypeScript | PASS |
| Backend TypeScript/build | PASS |
| Frontend production build, Node 22.23.3 | PASS |
| Platform suite, including health, provider protocols and new brand tests | PASS — 411 tests |
| Focused frontend/i18n/brand and CI foundation tests | PASS — 23 tests |
| Browser tab interaction tests | PASS — 4 tests |
| Brand audit / i18n parity | PASS |
| Four focused brand browser sessions | PASS |
| Browser Phase12 | PASS — 16 scenarios |
| Browser Phase14 | PASS — 54 scenarios |

First test iterations exposed a fixture-loading issue in the new notification test and an early read during the logo's entry animation; both were corrected before the passing runs. A standalone tab-test invocation initially lacked its browser dependency environment; rerunning with the configured runtime passed. Product assertions were not removed.

The official Python source was hash-verified against the managed provider's expected SHA-256, then compiled as CPython 3.13.15. Node 24.21.0 is the real managed Node fixture. No fake runtime was substituted. Local test roots are isolated from the user's existing deployment.

GitNexus: upstream checks were run before production symbol edits. The health helper reported HIGH (3 direct references, 7 impacted symbols); aggregate `detect_changes` reported CRITICAL and a broad 318-flow graph through shared services. This was communicated, reviewed against the narrow diff, and backed by the full platform and browser tests. Dynamic frontend dispatch has incomplete graph coverage; browser verification supplements it. The full report is retained with the final scope check. This is not a claim that every graph path was separately exercised.

Build notes: the frontend toolchain reports its existing Browserslist-age and bundle-size warnings. Local shellcheck is unavailable; CI retains its required Linux shellcheck. No shell script was changed.

## Git

Commit: the local commit containing this report (see `git log -1`; a commit cannot contain its own hash).

Push: **NOT PERFORMED**. Tag: **NOT PERFORMED**. Publish: **NOT PERFORMED**.

No changes to git remote, package/registry identity, schemas, API/RPC paths, backup magic, LICENSE or historical qualification reports. [Identity preservation hashes](identity-preservation.json) record key unchanged files.

## Final

ZHI_XU_BRAND_CONVERGENCE_PASS: **YES**.

Blockers: **None for this local brand convergence**.

Release boundary: this is local source verification, not new hosted Linux/container qualification. Previous image digests, SBOMs, provenance and acceptance artifacts refer to their old source commits. A future release must rebuild and qualify the final brand commit. No tag or publish was performed.
