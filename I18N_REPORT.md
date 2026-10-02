> Historical implementation record. The current fresh-install language model, namespace and final qualification are documented in [the Greenfield final report](diagnostics/i18n/GREENFIELD_REPORT.md). The results below describe the earlier implementation.

# I18N Implementation Report

Date: 2026-10-02. Stage: IMPLEMENTED. Final convergence: ACHIEVED.

## Resume and scope

Entry HEAD: 1c1efb39ba9a669e2261dd63ad12f464b541af16.
Audit baseline: 12569b4941174362bd05794e340bd891d2731153.
Implementation commit: the commit containing this report (see git log).

The original audit, inventory, scanner and language probes are unchanged. The original coverage is preserved in diagnostics/i18n/i18n-audit-coverage.json. This report supersedes the AUDIT_ONLY conclusion for the implemented frontend scope.

No backend API, enum, schema, dependency, release workflow, brand, package identity or Docker image identity changed. No push, tag or publication was performed. Existing user data and the local RC.5 deployment were not used as test fixtures.

## Language architecture

- One browser preference: system, zh-CN or en-US. Reads also accept the existing empty string, zh and en representations; writes use canonical values.
- One resolver: explicit preference wins; system Chinese BCP-47 language variants resolve to zh-CN; every other system language resolves to en-US.
- src/utils/language.ts owns normalization, resolution, subscription and guarded system/storage events. src/utils/i18n.ts drives cached react-intl-universal resources, Umi setLocale(locale, false), document.lang and React subscriptions. No third message framework was added.
- URL lang, old cookies and Umi's persisted locale do not override the browser preference. Umi locale is derived state, not a second source of truth.
- Browser switching no longer writes the shared backend language preference. The existing backend language API, stored language and backend notification/auth/subscription translation behavior remain unchanged. No Accept-Language contract or database field was added.
- Module-time layout/config translations became locale-aware factories. Mounted form state, pagination and editor contents are not reset by language application. Log placeholders are rendered from presentation state separately from raw log buffers.

## Switching and persistence

PASS: both directions of immediate switching without reload, unsaved repository form preserved, refreshed preference retained, logout/login retained, document.lang equal to effective locale, log-page placeholder refreshed.

PASS: system browser languages zh-CN, zh-SG, en-US and fr-FR; runtime languagechange; explicit preferences isolated from system changes; stale cookie, URL and Umi preference ignored. Browser tests compare performance.timeOrigin and actual form values, not just storage.

## Resource and UI coverage

- zh-CN keys: 1827; en-US keys: 1827.
- Key parity PASS; duplicate keys 0; missing static calls 0; empty values 0.
- Original 1054 audit candidates: 902 LOCALIZED, 142 TECHNICAL_TOKEN, 10 USER_CONTENT_TEMPLATE. Original inventory hash retained in implementation-ledger.json.
- Current AST gate: 172 reviewed residual literals; UNCLASSIFIED_UI_LITERAL = 0. File/value exceptions include explicit reasons. These are semantic classifications, not a claim that all English letters are forbidden.
- Shared UI covered: Python/Node runtime and environments, config bindings, observability, task policies/hooks/resource references, repository/scoped environments, terminal and log views.
- Pages covered: dashboard, repository/worktree, tasks/triggers/runs, workspace, config assets, scoped ENV, subscriptions/discovery, runtime, notifications, backup/restore, settings, login, initialization and errors.
- New translations use semantic namespaces; stable legacy keys remain supported. User names, files, paths, code/config contents, versions, URLs, Git output and stdout/stderr remain raw.

## Enums, errors and formatting

Active enum inventory: 57 domains, 328 values; missing known translations 0. Includes runtime states/operations, both environment/build domains, task/run/attempt states, triggers, repository/worktree states, notifications, backups/restore and credential capabilities. API values are unchanged. Unknown future enum values remain raw and produce a development diagnostic.

Known UI error inventory: 32 codes; missing translations 0. Known execution failures (timeout, non-zero exit, cancellation and interruption) have localized descriptions. Unknown safe codes use localized generic text plus the code. Arbitrary backend validation values/messages are not copied into notifications, protecting secrets and user values.

Date/time, date, number, percent, duration and bytes use the effective locale. Zero, missing/invalid values, fractions and duration carry boundaries are tested. Date instants and timezone semantics are unchanged.

## Browser qualification

All browser flows used disposable roots and real Chrome, Git/SSH, managed Python/Node environments, task execution, notifications and backup/restore. Evidence is in diagnostics/i18n/evidence.

| Gate | Result | Evidence |
| --- | --- | --- |
| Phase12, explicit en-US | PASS | phase12/browser-e2e.json |
| Phase14, explicit en-US | PASS | phase14/platform-e2e.json |
| Full zh-CN | PASS | i18n-zh-CN/platform-e2e.json |
| Full en-US | PASS | i18n-en-US/platform-e2e.json |
| Switching, persistence, SYSTEM, document.lang | PASS | both i18n-browser.json receipts |
| Final capability/UNSET/log switching probes | PASS | focused-zh-CN and focused-en-US |
| Browser tab/select synchronization | 4 passed | verification.json |

CI browser orchestration now runs the two dedicated bilingual flows after existing Phase12/14 gates. Non-i18n stages explicitly pin en-US and disable i18n-only extensions. Existing accessible controls, tab focus/selection/panel synchronization and negative assertions are preserved; no forced clicks or arbitrary UI sleeps were added.

The installed rc-dialog close icon has a fixed English ARIA label, Close, independent of Ant Design locale. This third-party accessibility exception is recorded in framework-exceptions.json; visible application close buttons are localized. No vendor patch was introduced. Screenshots intentionally mask forms and secret-bearing surfaces through existing acceptance redaction.

## Regression and limits

- TypeScript: PASS, 0 errors.
- Frontend production build: PASS using Node 22.23.3; existing bundle-size and Browserslist age notices remain.
- Backend build: PASS; no backend production changes.
- Platform: 407 passed, 0 failed, 0 skipped.
- Focused frontend/i18n/CI tests: 22 passed, 0 failed.
- Dedicated i18n tests: 8 passed (included above and in the platform gate).
- Actual environment: macOS + real Chrome, managed Python 3.13.15 and managed Node fixtures. Hosted Linux CI was configured but not triggered in this task. No claim of a new hosted CI run is made.

GitNexus upstream analyses were run before symbol edits. Shared frontend consumers produced HIGH/CRITICAL warnings, reported before edits. Final staged/compare-to-develop detection covers expected frontend, test and CI flows only; the aggregate scope is CRITICAL because this is a cross-cutting presentation change. Reports are stored beside this document's coverage evidence.

## Reproduce

Use the project's supported Node 22 toolchain. Run npm run typecheck, npm run build:front, node scripts/i18n/check.cjs and npm run test:platform. The Linux CI browser entry is scripts/ci/run-job.sh browser; it provisions fixtures, executes ordinary and bilingual browser gates, writes summaries and cleans managed fixtures. For a quick local browser-only language check, use scripts/i18n/focused-browser.cjs with QL_BROWSER_RUNTIME, QL_ACCEPTANCE_DIR and QL_I18N_LOCALE set to the desired locale. Full Phase14 additionally needs managed fixtures through QL_MANAGED_DIR.

## Brand and final result

Brand: OUT OF SCOPE / NOT MODIFIED. Existing ZhiXu and 枝序 values are preserved.

ZHI_XU_I18N_CONVERGENCE_PASS=YES.
Remaining blockers: none within the requested i18n scope and recorded exception boundary.
Push: NOT PERFORMED. Tag: NOT PERFORMED. Publish: NOT PERFORMED.
