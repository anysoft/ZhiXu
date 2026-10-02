# ZhiXu I18N Audit

Date: 2026-10-02 (Asia/Singapore)
Stage: **AUDIT ONLY — PARTIAL I18N, convergence not achieved**
Source commit: `12569b4941174362bd05794e340bd891d2731153`

## Scope and evidence

This is the requested pre-migration audit. No application code, API contract, enum, database, package identity or container configuration was changed. No tag, push or publication is part of this work.

- `i18n-inventory.json`: TypeScript AST inventory of all non-generated `src/` TS/JS files, literal call sites, resource parity, formatting calls, branding references, backend enum declarations, state assignments and error-code candidates. Each entry includes source file and line.
- `inventory.cjs`: reproducible diagnostic scanner; run `node diagnostics/i18n/inventory.cjs` from repository root. It is **not** a CI hard gate and does not silently allowlist all findings.
- `language-probes.json`: isolated, unauthenticated browser contexts against the existing local RC.5 container. These are language-resolution observations, **not** full business acceptance. No admin credentials or user data were read or changed.
- GitNexus query ran; its index is 20 commits behind HEAD and did not resolve the language architecture well. Findings below are confirmed by source/installed dependency inspection. No existing function was edited, so no symbol impact edit was required.
- Inventory includes unreferenced/bridge/proto source, which must not be equated with live UI. Dynamic data, conditional expressions and backend reachability require semantic review; counts below are not a completeness certificate.

## 1. Framework and resource organization

Existing frontend application messages use `react-intl-universal` (^2.12.0), initialized in `src/app.ts:rootContainer`. Two flat JSON dictionaries: `src/locales/zh-CN.json`, `src/locales/en-US.json`.

Umi locale is **already also present** in `.umirc.ts` (`antd`, `title`, `baseNavigator` enabled), using `setLocale` from `@umijs/max`. It supplies Ant Design/framework localization. Do not introduce a third mechanism or replace the established message system. Convergence should coordinate the existing two consumers under one preference/resolver.

Messages currently mostly use Chinese sentence keys through `intl.get`/`intl.getHTML`, not semantic namespaces. Existing keys must remain usable during migration; new/migrated messages should adopt stable semantic keys. No need to split resource files or install another library at this stage.

## 2. Language preference and resolver

| Layer | Current implementation | Consequence |
|---|---|---|
| Settings selector | `src/pages/setting/other.tsx`: empty string / `zh` / `en` | Existing stable values, not literal `system` / canonical locale values |
| App resolver | `intl.determineLocale`: URL `lang` → cookie `lang` → localStorage `lang` → navigator.language | URL/cookie can override the selected persisted preference |
| Normalization | `.slice(0, 2)`; only `zh` and `en` accepted | Chinese prefixes resolve Chinese; English prefixes English; everything else falls back Chinese |
| SYSTEM | Stored empty string; resolver proceeds to browser only if no URL/cookie override | Not a server language mode; no dedicated resolver tests |
| Umi | Separate `localStorage.umi_locale`, browser locale fallback | Derived framework state is independently persisted |
| Backend | Selector PUTs `/system/config/lang`; layout also initializes it | Browser preference currently mutates a shared server preference |
| Fallback | App `zh`; backend `systemLang` treats only English as English | French browser yields Chinese; differs from proposed non-Chinese → English rule |

`react-intl-universal/lib/index.js` confirms URL/cookie/storage/browser precedence. `src/.umi/plugin-locale/localeExports.ts` is generated evidence only: its `setLocale(lang, realReload = true)` reloads by default, and supports `false` for events. Do not edit generated files.

The language selection is persisted locally across reloads by design. Login/logout clears auth state, not `lang`. Full persistence across browser reopen/login and preference interaction with URL/cookie has **not** been accepted by a dedicated test suite.

### Backend coupling (important existing exception)

`src/pages/setting/other.tsx:handleLangChange` stores `lang`, sends browser-resolved language to `/system/config/lang`, then reloads after 500 ms. `src/layouts/index.tsx:reloadSystemConfig` independently reads navigator/localStorage and may initialize backend language.

`back/services/system.ts:updateLanguage` persists the existing `SystemConfig.info.lang` and calls `setLang`; `back/loaders/initData.ts` loads it; `back/shared/i18n.ts` is a pre-existing global translation mechanism consumed by auth/notification/subscription/Express code. Therefore the baseline is **not exclusively machine-coded backend errors**. Do not extend this mechanism or translate new backend contracts. In migration, separate browser-only preference from server notification-language responsibility, preserve existing APIs, and avoid a schema change. Review consumers before removing the frontend side effect.

### Proposed convergence decision (not implemented)

Retain backward reading of `''`, `zh`, `en`; accept canonical aliases if needed. One frontend resolver returns both preference mode and effective `zh-CN`/`en-US`. Choose deliberately whether unsupported system languages retain current Chinese fallback (allowed by the specification's existing-rule exception) or change to English; this report recommends the requested non-Chinese → English product behavior, documenting it as an intentional change. Do not leave Umi, date formatting and backend notification language to resolve independently.

## 3. Switching, mounted components, HTML lang, title

Immediate switching currently **FAIL**: settings explicitly reloads after 500 ms. `rootContainer` calls Umi `setLocale` without disabling its default reload. Neither framework limitation requires retaining this: existing mechanisms support updating locale, but React subscribers/state must be coordinated.

`src/layouts/defaultProps.tsx` and `src/utils/config.ts` evaluate many translations at module load. A rerender alone would not recompute these values. Layout `siteTitle` is initialized in state; menus, config-driven forms, active modal/toast content and mounted subscriptions must be audited for stale strings. Preserve in-progress form/user state during switching, rather than remounting the entire app.

No application-owned `document.documentElement.lang` update was found. All five isolated browser probes observed an empty HTML lang. Route titles are assigned in `src/layouts/index.tsx` as `${title} - ${siteTitle}`; some route names remain English literals.

| Preference | Browser | Observed login title | HTML lang |
|---|---|---|---|
| zh | en-US | 登录 - 枝序 | empty |
| en | zh-CN | Login - ZhiXu | empty |
| SYSTEM (empty) | zh-SG | 登录 - 枝序 | empty |
| SYSTEM (empty) | en-US | Login - ZhiXu | empty |
| SYSTEM (empty) | fr-FR | 登录 - 枝序 | empty |

No app-level `languagechange` subscription was found. Umi itself emits that event on non-reloading switches, so a future listener must avoid resolver/update event loops.

## 4. Product branding

Frontend TS/JS literal scan found no `青龙`, `QingLong` or `qinglong` brand text. **This is not branding PASS**: 11 source references contain `枝序`; Chinese resources and the live login still show 枝序 while the requested invariant product name is ZhiXu. The scan counts source references, not independently visible screens.

Targets: default header/sidebar, login title, initialization welcome, about, default site title/tooltips, client-IP helper copy, and the developer-console environment banner. Existing customized `zhixu_panel_title` is user content and must not be translated/replaced. Internal `QlBaseUrl`, repository/package paths and storage keys are out of scope.

`back/shared/i18n.ts` still contains historical QingLong translation entries; dictionary presence is not proof of current user-visible reachability. Trace consumers before classifying or editing those references. No blanket backend/repository rename.

## 5. Resource parity and missing keys

Each dictionary has 665 keys. Duplicate keys: zh=0, en=0.

- Missing in zh-CN: `Minimum is 4`.
- Missing in en-US: `最小是 4`.
- Static translation call sites missing in **both** resources:
  - `src/utils/config.ts:381` — `OpeniLink的app_token，在OpeniLink Hub后台安装App后获取，参考 https://openilink.com/docs/hub/apps`
  - `src/utils/config.ts:388` — `OpeniLink Hub地址，默认为 https://hub.openilink.com，自建Hub时填写自己的地址`
  - `src/utils/config.ts:394` — `OpeniLink的context_token，用于标识消息会话上下文，可从消息事件中获取`
  - `src/utils/config.ts:422` — `邮箱认证地址`


No semantic status/error namespace is currently registered. Equal dictionary counts do **not** imply parity or complete UI coverage. No identical zh/en values or empty values were found in the current dictionaries; translation quality still needs semantic review (e.g. `Welcome to use ZhiXu` is unnatural English).

## 6. UI inventory and migration domains

The AST scan identifies **66 source files and 1,054 UI-literal candidates**. Categories: JSX text, literal visible attributes, object properties such as title/label, JSX expression literals, toast arguments. Some are technical terms, user-data templates, or non-UI properties. It deliberately does not scan all English strings as errors and does not claim 1,054 confirmed violations. Dynamic statuses, arrays of option labels, validators and imported constants are separate review obligations.

Concrete confirmed examples:

- Dashboard: Observability, Refresh, All runs, Success rate, Recent failures, literal data status values.
- Navigation: Runs, Tasks, Notifications, Code Workspace, Runtime; hardcoded 仓库管理 and 配置资产.
- Tasks: Configured Resources, General/Source/Runtime tabs, form helpers, trigger policies, JSON validators and resource readiness labels.
- Repository/Worktree: mixed Chinese form labels and Branch / Ref, Dirty, Busy, raw lifecycle/dirty enums.
- Runtime and environments: Python/Node operations, Versions/Environments, install/build/verify/delete dialogs, NPM/PNPM policies and error codes.
- Shared components: Config Binding, hooks, scoped ENV, resource references, observability run details, notification deliveries and policy controls.
- Workspace: file/Git/search/save dialogs and tooltips; file contents, paths, commit messages and terminal output must remain original.
- Backup/restore: Chinese labels and confirmations, raw operation phases/errors. Confirmation tokens such as RESTORE remain machine values; surrounding prompts are localized.
- Legacy translated screens: login, initialization, logs, security/settings have i18n calls but require branding, formatting, missing-key and validator review.

### Complete source-file ledger

`Intl calls` counts static get/getHTML call sites, not translation completeness. `Candidates` is heuristic; zero is not automatic PASS. Includes page imports/shared helpers beyond routed screens.

| Source file | Intl calls | UI literal candidates |
|---|---:|---:|
| `src/app.ts` | 0 | 0 |
| `src/components/NodeRuntime/index.tsx` | 0 | 140 |
| `src/components/PythonEnvironments/index.tsx` | 0 | 74 |
| `src/components/config-bindings.tsx` | 0 | 35 |
| `src/components/copy.tsx` | 3 | 0 |
| `src/components/iconfont.tsx` | 0 | 0 |
| `src/components/name.tsx` | 0 | 0 |
| `src/components/observability/index.tsx` | 0 | 37 |
| `src/components/observability/taskPolicy.tsx` | 0 | 9 |
| `src/components/repository-environment.tsx` | 0 | 7 |
| `src/components/scoped-environment.tsx` | 0 | 34 |
| `src/components/tag.tsx` | 1 | 0 |
| `src/components/task-bridge/logModal.tsx` | 3 | 0 |
| `src/components/task-bridge/type.ts` | 0 | 0 |
| `src/components/task-hooks.tsx` | 0 | 22 |
| `src/components/task-resource-references.tsx` | 0 | 5 |
| `src/components/terminal.tsx` | 0 | 0 |
| `src/hooks/useFilterTreeData.ts` | 0 | 0 |
| `src/hooks/useScrollHeight.ts` | 0 | 0 |
| `src/hooks/useTableScrollHeight.ts` | 0 | 0 |
| `src/layouts/defaultProps.tsx` | 8 | 0 |
| `src/layouts/index.tsx` | 8 | 1 |
| `src/loading.tsx` | 0 | 0 |
| `src/pages/404.tsx` | 1 | 0 |
| `src/pages/config/index.tsx` | 0 | 34 |
| `src/pages/dashboard/index.tsx` | 0 | 14 |
| `src/pages/env/index.tsx` | 0 | 0 |
| `src/pages/error/index.tsx` | 7 | 1 |
| `src/pages/initialization/index.tsx` | 19 | 2 |
| `src/pages/log/index.tsx` | 16 | 0 |
| `src/pages/login/index.tsx` | 20 | 3 |
| `src/pages/notifications/index.tsx` | 0 | 24 |
| `src/pages/repository/index.tsx` | 0 | 60 |
| `src/pages/repository-workspace.tsx` | 0 | 85 |
| `src/pages/runs/index.tsx` | 0 | 1 |
| `src/pages/runtime-python.tsx` | 0 | 65 |
| `src/pages/scoped-env.tsx` | 0 | 33 |
| `src/pages/setting/about.tsx` | 10 | 3 |
| `src/pages/setting/appModal.tsx` | 9 | 0 |
| `src/pages/setting/backup.tsx` | 0 | 35 |
| `src/pages/setting/clientIp.tsx` | 28 | 3 |
| `src/pages/setting/index.tsx` | 25 | 3 |
| `src/pages/setting/loginLog.tsx` | 7 | 0 |
| `src/pages/setting/other.tsx` | 23 | 9 |
| `src/pages/setting/progress.tsx` | 4 | 2 |
| `src/pages/setting/security.tsx` | 21 | 4 |
| `src/pages/setting/systemLog.tsx` | 2 | 0 |
| `src/pages/subscription/discovery.tsx` | 0 | 14 |
| `src/pages/subscription/index.tsx` | 38 | 5 |
| `src/pages/subscription/logModal.tsx` | 3 | 0 |
| `src/pages/subscription/modal.tsx` | 2 | 14 |
| `src/pages/tasks/index.tsx` | 0 | 78 |
| `src/pages/tasks/triggers.tsx` | 0 | 35 |
| `src/pages/workspace.tsx` | 0 | 71 |
| `src/utils/codemirror/systemLog.ts` | 0 | 0 |
| `src/utils/config.ts` | 109 | 92 |
| `src/utils/const.ts` | 0 | 0 |
| `src/utils/date.ts` | 4 | 0 |
| `src/utils/hooks.ts` | 0 | 0 |
| `src/utils/http.tsx` | 1 | 0 |
| `src/utils/httpError.ts` | 0 | 0 |
| `src/utils/index.ts` | 1 | 0 |
| `src/utils/init.ts` | 0 | 0 |
| `src/utils/monaco/index.ts` | 0 | 0 |
| `src/utils/type.ts` | 0 | 0 |
| `src/utils/websocket.ts` | 0 | 0 |


## 7. Enum/status display

97 backend declaration groups (including internal/historical types) plus literal state assignments are inventoried in JSON. Do not translate API values. Central presentation keys should be domain-specific to avoid collisions (e.g. READY runtime vs readiness; state ERROR vs request errors), with raw-value fallback and development/test missing-key diagnostics.

Required active domains and evidence:

| Domain | Authoritative source / observation |
|---|---|
| Task origin, readiness, execution policies | `back/data/task.ts`; MANUAL/DISCOVERED, READY/CONFIGURATION_REQUIRED/INVALID/SOURCE_MISSING/RESOURCE_UNAVAILABLE |
| Run and attempt | `back/data/taskRun.ts:taskRunStatuses`; attempts reuse TaskRunStatus; includes RECOVERY_REQUIRED, INTERRUPTED, SKIPPED, TIMEOUT |
| Trigger/event | `back/data/taskTrigger.ts`; CRON/WEBHOOK/GIT_UPDATE; RECEIVED/PROCESSING/SUBMITTED/SKIPPED/FAILED, misfire and update policies |
| Runtime provider/install/operation | `back/data/runtime.ts`; provider/runtime state, operation types and QUEUED/RUNNING/SUCCESS/FAILED/CANCELLED/INTERRUPTED |
| Python/Node environments/builds/toolchains | `back/data/pythonEnvironment.ts`, `back/data/nodeEnvironment.ts`, shared/services modules; many fields typed `string`, so declaration-only scanning is insufficient; assignment inventory includes EMPTY/BUILDING/HEALTHY/UNVERIFIED/PARTIAL/ORPHAN etc. |
| Repository / Worktree | `back/data/repository.ts`, `back/data/worktree.ts`; storage state, availability, lifecycle, dirty state and purpose |
| Delivery / notification | `src/components/observability/index.tsx`, `taskPolicy.tsx`, backend notification dispatcher modules; status/event/error fields currently rendered directly, with DEAD/RETRY action conditions |
| Backup / restore | `back/services/backup/operations.ts`, `restore.ts`, `barrier.ts`; phases and restore stages distinct from operation status |
| Subscription / login / ENV | Existing lower-case/numeric domain values also need localized presentation; do not assume all statuses are uppercase |

Static translations of ordinary words elsewhere do not constitute a centralized enum mapping. Current complete enum coverage: **NOT ACHIEVED**. Free-form string states, generated events and runtime diagnostic stages require data-flow review during migration; no false zero-missing claim.

## 8. Frontend error and validation presentation

`src/utils/http.tsx` displays backend `message`, response data and validation `item.message` directly; only selected messages such as session-expired are localized. `src/utils/httpError.ts` assembles raw field/message/value details. `obsGet` throws raw `error_code` or English `Request failed`. Runtime/backup/notification/workspace views also render raw codes independently.

AST backend scan found **422 distinct error-code candidates** near Error constructors, assertions, failure calls and error_code fields. The attached file/line inventory is intentionally a superset: it includes internal diagnostics and some enum-like values. It is not 422 proven UI errors, and does not cover every computed code. Map actual UI-reachable API codes first, retaining fallback for internal/unknown codes. Known errors have no centralized `error.<CODE>` translation inventory today.

Planned frontend-only boundary: translate known codes; unknown code → localized generic error + code; diagnostic messages are details, never implicit translation keys. Do not translate task names, field values, secrets, paths, stdout/stderr, config contents or user descriptions. Review the existing value-appending validation behavior for sensitive content while preserving security boundaries.

Form validation requires both Ant Design locale/validateMessages coordination and translation of custom validators (JSON arrays, path/range/required validators). Error text from JSON parsers and backend validation cannot automatically become a semantic resource key.

## 9. Formatting

- `src/utils/date.ts:diffTime` exists and localizes time-unit suffixes with legacy message keys. Reuse/converge it; currently arithmetic/string concatenation does not format numbers by effective locale.
- Login/login log/about use fixed `dayjs(...).format('YYYY-MM-DD HH:mm...')`.
- Repository and Worktree use `new Date(...).toLocaleString()` without explicit app locale.
- Observability/runtime/backup tables frequently expose raw timestamp/size/state fields.
- Log page uses `pretty-bytes` without explicit application locale.
- Dashboard formats percentage with `.toFixed(1) + '%'`; no single date/number/percent presentation helper found.
- Preserve timezone responsibility separately from language. IDs, ports, versions, hashes, API numbers and log bytes must not be reformatted as localized input values.

All concrete formatting call sites are in JSON. Future helpers need invalid/missing-date, zero, fraction, duration-boundary and locale-switch tests; no such focused i18n suite found.

## 10. Accessibility and browser test contracts

Do not remove accessible labels or translate user data to make locators pass. Ant Design required markers, `aria-label` propagation to wrapper+input, and nested modal focus are already known regressions.

- Phase12 `browser-e2e.cjs` explicitly uses browser locale zh-CN.
- Phase14 `platform-e2e.cjs` explicitly uses browser locale zh-CN, but selectors mix Chinese controls with English Runtime/Source/Config etc. A browser locale alone does not make those mixed-language contracts safe after translation.
- `tests/ci/browser-tab.test.cjs` has four browser tests but no explicit context locale. It checks tab layout shifts plus real Ant Design Select variants, not bilingual acceptance.
- Phase14 `browser-observability.cjs` and `browser-backup.cjs` inherit the page and contain additional locale-sensitive selectors.
- No dedicated ZH/EN full business-flow acceptance, SYSTEM-specific acceptance, mixed-language chrome assertions or preference persistence suite found.

Plan: explicitly set the app preference and browser locale for non-i18n tests, preferably en-US; update all labels in Phase12/14 and companion modules consistently. Add separate real ZH/EN flows covering account/login, repository/Worktree, runtime environment binding, task execution/result and notifications/settings. Assert UI chrome only. Keep user content/logs out of language scans. No arbitrary sleeps, forced clicks or weakened assertions.

## 11. Migration order and decisions

1. One preference resolver/storage adapter over existing lang preference; compatibility with existing values; decide/document URL/cookie precedence and unsupported-locale fallback. Coordinate react-intl-universal with Umi/Ant Design; set actual document lang. Implement switching without dropping mounted form state.
2. Add semantic common/navigation/brand/status/error keys and shared date/number/duration formatting. Convert module-level translated objects to reactive factories/hooks as appropriate.
3. Migrate shared components first, then all pages in the ledger; categorize technical tokens explicitly. Preserve machine enums/API values/backend behavior.
4. Inventory UI-reachable errors and remaining dynamic enum displays, translate known cases, retain safe unknown fallback.
5. Update all browser tests and CI registration; add paired ZH/EN acceptance and SYSTEM probes. Add conservative AST lint plus parity/duplicate-key tests. Inventory candidates must be reviewed rather than blanket-whitelisted.
6. Run typecheck, frontend build, relevant frontend/platform tests and complete Phase12/14 browser regression. Requalify the final container commit before any release claim.

No product decision requires a new DB field, schema migration, repo/package/image rename, new i18n framework or backend Accept-Language contract.

## 12. Gate status and next phase

| Gate | Audit result |
|---|---|
| Locale key parity | FAIL (equal counts, different key sets) |
| Duplicate keys | 0 in current flat resources |
| Hardcoded UI zero | NOT ACHIEVED; candidate ledger provided |
| Known statuses/errors fully localized | NOT ACHIEVED |
| SYSTEM behavior | Observed and documented; non-Chinese defaults Chinese |
| Persistence full acceptance | NOT RUN; static mechanism exists |
| Immediate switch | FAIL; explicit reload |
| HTML lang | FAIL in all 5 live probes |
| Branding invariant ZhiXu | FAIL in Chinese default UI |
| ZH/EN full flow | NOT RUN |
| Mixed-language acceptance | NOT RUN; mixed literals confirmed statically |
| TypeScript/build/platform/Phase12/Phase14 regression | NOT RUN in audit-only phase; no app code changed |
| Backend localized contract introduced | NO |
| Tag/push/publish | NOT PERFORMED |

**ZHI_XU_I18N_CONVERGENCE_PASS: NO.** Audit artifacts are ready for migration; no resource parity, browser or release-ready status is fabricated. This phase intentionally stops before implementation, following the request to complete the audit first.
