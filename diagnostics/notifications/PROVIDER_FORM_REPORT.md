# ZhiXu Notification Provider Form Report

## Source

Entry HEAD: `9bf9419973e1f041df405dd5dfdb7c95dc09768b` (`develop`).

The pre-existing login-error fix in `back/services/user.ts`, `scripts/i18n/errors.json`, `tests/i18n/login-error.test.cjs`, and its locale/baseline additions was retained and excluded from this feature commit. Acceptance ran against the preserved working tree. No user database or existing container volume was used for acceptance.

## Architecture

- Schema Registry: `src/features/notifications/providerSchemas.ts`.
- Dynamic Form: `src/features/notifications/ProviderConfigForm.tsx`.
- Serializer / validator: `serializeProviderConfig` / `validateProviderConfig` in the registry.
- Channel payload boundary: `src/features/notifications/channelForm.ts`.
- Channel editor: `src/pages/notifications/index.tsx`.

The single editor renders provider fields, conditional controls and collapsible optional settings. It uses the existing channel endpoints and version checks. API provider IDs, notification senders, transport, dispatcher, policies, outbox and database schema are unchanged.

## Coverage

Backend Providers: **25**
Frontend Schemas: **25**
UI Fields: **88**
Wire-field occurrences: **81**
Missing Providers: **0**
Missing Fields: **0**

The final staged GitNexus check has no partial or truncated results. Its HIGH scope rating reflects the new schema/form symbols across nine expected frontend configuration/i18n flows plus an additional generic `labelKey` property match to `TaskTriggerRoutes`. The staged feature contains no backend source changes; real trigger scenarios passed in the existing regression.

Contract tests parse the backend provider registry, required-field map and sender parameter destructuring. Every provider's minimal and full serialized configurations pass the existing backend validator. See `provider-schema-coverage.json` for the complete field inventory.

## Special Providers

- **Lark:** required Webhook URL/key and optional signing secret. An empty signing secret is omitted. Existing signing algorithm is unchanged.
- **Email:** preset service or custom SMTP; conditional host/service fields; numeric port, boolean TLS, semicolon-separated recipients and password input. Switching modes removes inactive drafts.
- **WEBHOOK:** URL and the complete Authorization header value; no automatic Bearer prefix. Existing HTTP/HTTPS transport rules are retained.
- **webhook:** separate HTTP method / content type / URL / key-value headers / body template. Existing `$title` and `$content` and newline key-value parser semantics are preserved.
- **WeWorkApp:** five logical controls serialize to the existing comma-separated field. The actual fifth wire item is `thumb_media_id`: `1` = text, `0` = textcard, other media ID = mpnews. Commas/newlines that shift fields are rejected.
- **ntfy:** none / access token / username-password modes; inactive credentials are cleared and excluded from serialization.
- **wxPusher:** nonblank topic IDs or UIDs required (separator-only lists are rejected); existing semicolon-separated formats retained.

## Configuration Security

Secret readback: **NONE**. No secret-reading endpoint was added. URLs and all connection values remain in the existing protected `secret` object; field sensitivity controls input masking, not API exposure.

- New: REPLACE with validated complete configuration.
- KEEP: metadata only; no `secret` property.
- REPLACE: re-enter the full configuration; no merging with stored credentials.
- DELETE: explicit checkbox confirmation; no `secret` property.
- Provider switch: clears drafts, forces REPLACE, forbids KEEP/DELETE for a different type.
- Close/reopen: clears configuration drafts.
- Serialization: only current-provider wire keys; no dangerous object keys; correct primitive types and preserved special characters.
- Storage/logs: no provider configuration in localStorage, sessionStorage, URLs or logs.

## Internationalization

zh-CN: **PASS**
en-US: **PASS**
Locale Parity: **PASS**

Names, help text, options, validation and confirmations use the existing i18n system. Live language changes update an open editor and existing validation errors without clearing entered values.

## Tests

| Check | Result |
|---|---|
| Frontend TypeScript | PASS, Node 22.23.2 |
| Backend / frontend build | PASS, Node 22.23.2 |
| Schema contract tests | PASS, 9 tests |
| Channel payload tests | PASS, 4 tests |
| Internationalization and existing UI unit tests | PASS |
| Phase13 provider / domain / security regression | PASS, 11 tests, Node 22.23.2 |
| Related Phase12 workspace/API and Phase14 production/operation tests | PASS, 50 tests, Node 24.22.1 |
| Notification Browser E2E | PASS, 25 providers / 13 scenario groups / automatic cleanup PASS |
| Existing Phase12 Browser E2E | PASS, 16 stages |
| Existing Phase14 Browser E2E | PASS, 54 stages |

Browser acceptance uses real Chrome on macOS ARM64, a real isolated backend/database, synthetic credentials and an owned local receiver. All provider-coverage channels are disabled and not default; the only real test delivery goes to the local receiver. No external Lark, Telegram or SMTP service was contacted. GET/list/details are checked for no readback. Desktop Chinese and mobile English empty-form captures were visually inspected.

Existing browser harnesses now select the setup confirmation controls and structured WEBHOOK fields. Teardown stops each owned backend before closing its browser to release application WebSockets; original regression scenarios remain intact.

### Reproduce

Use the project's pinned Node 22.23.2 and installed dependencies:

```sh
node node_modules/typescript/bin/tsc --noEmit --skipLibCheck
node scripts/build-back.cjs
node node_modules/@umijs/max/bin/max.js build
node --test tests/notifications/*.test.cjs tests/i18n/*.test.cjs tests/phase13/providers.test.cjs tests/phase13/domain.test.cjs tests/phase13/security.test.cjs
QL_BROWSER_RUNTIME=/path/to/pinned-browser-tools/node_modules node tests/notifications/provider-form.browser.cjs
```

The browser tool versions are pinned in `scripts/ci/tools/package.json`. Existing full browser regressions also require the existing isolated managed Python/Node fixtures. Evidence: `browser/provider-form-browser.json`, `provider-schema-coverage.json` and `regression-results.json`.

## Git

Commit: this report is included in the local feature commit; its exact hash is provided in the final response. Prior login fixes are excluded.
Push: **NOT PERFORMED**
Tag: **NOT PERFORMED**
Publish: **NOT PERFORMED**

## Final

NOTIFICATION_PROVIDER_FORM_PASS: **YES**

Remaining blockers: **NONE**. The final wxPusher-only refinement was followed by a fresh 25-provider browser run and all related unit/contract/security checks.
