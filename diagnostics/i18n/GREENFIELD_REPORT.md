# ZhiXu I18N Final Report

Date: 2026-10-02. Stage: IMPLEMENTED.

This report supersedes the language model in the earlier [implementation report](../../I18N_REPORT.md). The original audit, audit inventory JSON, language probes and earlier browser evidence remain historical records. New results are in [greenfield-evidence](greenfield-evidence/), with a machine-readable [validation receipt](greenfield-evidence/validation.json) and [coverage](i18n-coverage.json).

## Product Model

Deployment: **FRESH INSTALL ONLY**.

Legacy QingLong compatibility: **NONE**.

Legacy language migration: **NONE**.

No old preference lookup, alias conversion, cookie migration, cleanup job or data migration was added. Existing user data and the local RC.5 deployment were not used as test fixtures.

## Language Architecture

Preference: `system | zh-CN | en-US`.

Storage key: **`zhixu.language`**. Only these three values can be written. A fresh installation defaults to `system`; blocked storage still permits switching in memory.

Effective locale: `zh-CN | en-US`.

Resolver: [src/utils/language.ts](../../src/utils/language.ts). Explicit preference wins; Chinese browser language variants resolve to `zh-CN`, other browser languages resolve to `en-US` in system mode.

Controller: [src/utils/i18n.ts](../../src/utils/i18n.ts) exports preference getters/setter, effective locale, resolver, apply and subscription. React subscriptions, presentation and formatters share that controller.

Umi: the controller calls `setLocale(effectiveLocale, false)`. `umi_locale` is derived framework state, never read by the product resolver. Umi's independent navigator detection is disabled. The existing framework locale container updates Ant Design without replacing the application tree.

react-intl: the existing `react-intl-universal` instance now uses canonical `zh-CN` / `en-US` resources directly. No third framework or duplicate resolver.

Backend: unchanged. Browser preferences are per browser; they do not overwrite shared backend notification language. No new language synchronization, Accept-Language architecture, API enum mutation, schema or timestamp change.

## Removed Legacy Language Logic

Old `''`, `zh`, `en` preference compatibility: **REMOVED**. Explicit alias branches and their compatibility test cases were removed. Short Chinese browser language tags remain valid navigator inputs, not stored preference values.

Old `lang` storage authority: **REMOVED**. Production and browser fixtures use the new namespace exclusively.

Cookie precedence: **ABSENT**.

URL production precedence: **ABSENT**.

Tests no longer seed old cookies, old preference aliases or an old framework language as migration cases. No migration reads or writes occur.

## Switching

Immediate: **PASS**. Reload: **NO**. Mounted state: **PASS**. `document.lang`: **PASS**. SYSTEM `languagechange`: **PASS**.

Real browser checks switch both directions using Settings while a Task definition modal remains open in another tab. The Task name and unsaved Settings title retain their exact mixed-language user content. Both pages keep the same `performance.timeOrigin`; modal labels, log placeholder and Ant Design required validation change to the selected language.

The test waits for initial Settings configuration to be rendered before entering its draft, so the check measures language switching rather than racing initialization. Chinese two-character buttons use the existing whitespace-aware button helper. Active-tab scoping and ordinary actionable clicks remain intact; no forced click, retry loop or arbitrary sleep was added.

Explicit preferences survive refresh and logout/login. `system` remains the stored preference while the effective locale responds to browser language changes. Explicit modes ignore those changes.

## Resources

| Check | Result |
| --- | --- |
| zh-CN keys | 1,827 |
| en-US keys | 1,827 |
| Parity | PASS |
| Duplicate keys | 0 |
| Missing static translation keys | 0 |
| Missing declared enum/error presentation keys | 0 |

Existing resources and translations were preserved. The repeatable [inventory entry point](inventory.cjs) now calls the same current-source [static gate](../../scripts/i18n/check.cjs) used by resource tests. It fails on parity, duplicate keys, missing static keys, unclassified UI literals or missing declared enum/error messages, and no longer overwrites the completed audit JSON.

Run `node diagnostics/i18n/inventory.cjs` or `node scripts/i18n/check.cjs` from the repository root.

## UI

Shared components: **PASS**. Pages: **PASS** within the established current-frontend inventory and browser-flow coverage.

Unclassified current user-visible literals: **0**.

The original 1,054 audit candidates remain classified as 902 localized, 142 technical tokens and 10 user-content templates. They are not 1,054 errors. Current-source scanning finds 172 retained literals: 144 technical tokens and 28 user-content templates. These counts describe different stages and are not interchangeable.

Existing render-time layout/config translation factories remain in place. Task names, descriptions, paths, package names, versions, raw logs and other user content are not translated.

The existing [framework exception](framework-exceptions.json) remains: the pinned third-party dialog close-icon ARIA label is English `Close`. Application-visible close buttons are localized. This is not a new compatibility path or a resource parity exception.

## Enum / Status

**PASS**: 57 active domains and 328 declared values localized in both languages. Existing machine values are unchanged. Unknown values display their raw value and emit the existing development/test diagnostic.

## Errors

**PASS**: 32 known UI-reachable error codes localized. Unknown codes use localized generic presentation with the safe code. Arbitrary backend messages are not treated as translation keys; raw diagnostic/user content is not translated.

Ant Design required validation follows live language changes in the real Task form. Existing application validation translations and ICU interpolation checks pass.

## Formatting

Date/time: **PASS**. Date: **PASS**. Number: **PASS**. Percent: **PASS**. Duration: **PASS**. Bytes: **PASS**.

The existing centralized formatters use the effective locale. Unit tests exercise both locales, empty/invalid values and numeric boundaries. Stored timestamps and timezone semantics are unchanged.

## Browser

| Gate | Result | Evidence |
| --- | --- | --- |
| Phase12, deterministic en-US | PASS, 16 scenarios | [receipt](greenfield-evidence/phase12/browser-e2e.json) |
| Phase14, deterministic en-US | PASS, 54 scenarios | [receipt](greenfield-evidence/phase14/platform-e2e.json) |
| I18N zh-CN complete flow | PASS, 65 scenarios | [flow](greenfield-evidence/full-zh-CN/platform-e2e.json), [11 language checks](greenfield-evidence/full-zh-CN/i18n-browser.json) |
| I18N en-US complete flow | PASS, 65 scenarios | [flow](greenfield-evidence/full-en-US/platform-e2e.json), [11 language checks](greenfield-evidence/full-en-US/i18n-browser.json) |
| Focused zh-CN / en-US | PASS, 11 checks each | [zh-CN](greenfield-evidence/focused-zh-CN/i18n-browser.json), [en-US](greenfield-evidence/focused-en-US/i18n-browser.json) |
| SYSTEM zh-CN / zh-SG | PASS | Included in both language receipts |
| SYSTEM en-US / fr-FR | PASS | Included in both language receipts |
| Immediate switch preserving Task / Settings form | PASS | Included in both language receipts |
| Existing brand browser tests | PASS, 4 sessions | Explicit and SYSTEM in Chinese and English |

Full flows cover initialization/login, repositories/worktrees, managed Python/Node environments, task configuration/execution, run results, triggers, notification delivery, settings, encrypted backup/restore and post-restore executions. Ordinary browser tests default to an explicit `en-US` preference and browser locale. Dedicated internationalization flows explicitly select their target locale.

The brand implementation and brand assertions are unchanged. Only their browser fixture preference key was updated. Two exact report-only historical-name statements were added to the existing classification data; scanner logic and thresholds were not changed.

## Legacy QL

**OUT OF SCOPE**. Existing technical environment variables, command contracts, paths, attribution and historical records are not internationalization blockers and were not cleaned up.

No migration: **YES**. No compatibility code added: **YES**.

## Regression

| Check | Result |
| --- | --- |
| Frontend TypeScript | PASS |
| Backend TypeScript/build | PASS |
| Frontend production build | PASS |
| I18N unit tests, parity, enum/error/formatting | 9 PASS |
| Platform suite | 412 PASS, 0 failures, 0 skips |
| Focused i18n / CI / brand tests | 29 PASS, 0 failures |
| Standalone browser-tab tests | 4 PASS |
| Brand static gate | PASS |

Counts overlap; they must not be added as a single unique-test total. Production build retains the existing bundle-size advisory.

Validation ran locally on macOS arm64, Node 22.23.3 and real Chrome through Playwright, with freshly provisioned managed Python 3.13.15 and Node 24.21.0. These are **local results, not a new hosted Linux/GitHub CI run**. Test-owned managed runtimes were cleaned after browser validation.

## Impact and Change Review

GitNexus upstream impact was run before symbol edits and its index was refreshed. The runner returned CRITICAL with the same 351 direct / 650 impacted / 95 process counts for unrelated targets, including unrelated backend callers. This anomaly was reported before editing; those counts are not reliable proof of the real blast radius. The diagnostic inventory's local functions were not indexed.

Manual call-site review confines production changes to language resolution/application and Umi navigator configuration. Other edits are browser fixtures, static checking, tests and evidence. Backend services, APIs, schema, locale message resources, brand implementation, dependencies and release workflows have no changes. Required change detection was run for the working changes and against `develop`, and again for the staged commit; the tool's misattributed flows were checked against the actual diff and full regressions.

## Git

Entry HEAD: `99116241390db230e0538a257fa680567f772c62`.

Commit: the local convergence commit containing this report; resolve with `git log -1 --format=%H -- diagnostics/i18n/GREENFIELD_REPORT.md`. Implementation/test hashes are recorded in [source-state.json](greenfield-evidence/source-state.json).

Push: **NOT PERFORMED**. Tag: **NOT PERFORMED**. Publish: **NOT PERFORMED**.

## Final

**ZHI_XU_I18N_CONVERGENCE_PASS: YES**

Blockers: **NONE** within the requested local implementation/qualification scope.
