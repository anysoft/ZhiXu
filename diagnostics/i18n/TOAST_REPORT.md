# Toast localization follow-up

Date: 2026-10-02. Base commit: b5965eb150a3ed977c00237e7a24af86744388c1.

The repository and credential access tests shared one frontend callback that displayed the backend's English message directly. It now selects `ui.repositoryAccessSucceeded` or `ui.repositoryAccessFailed` from the returned availability status. No backend API or status value changed.

All 45 current Ant Design message/notification primary toast call sites were inspected. No other primary toast localization gaps were found. Login notification descriptions use translated labels and locale-aware timestamps; address, IP and device values are user metadata. HTTP notification details already accept typed safe error codes and translate them, excluding arbitrary backend messages and validation values.

The repeatable i18n gate now inspects imported message/notification calls, import aliases, computed method names, conditional severity calls, translated local variables and message/content options. Unlocalized primary text fails the gate, including direct backend message use or using a backend message as a translation key. New APIs such as hook-created message instances would require extending the checker; none exist in the current source.

Validation:

- Frontend TypeScript: PASS.
- Frontend production build: PASS (existing bundle-size advisory remains).
- I18N unit/regression tests: 12 PASS.
- Resource parity: 1,829 keys per locale; no duplicate or missing static keys.
- Brand static gate: PASS.
- Real Chrome browser: 8 PASS (repository/credential, available/unreachable, Chinese/English). Responses deliberately contain an untranslated backend canary, which never appears in the toast.

[Audited calls](toast-evidence/toast-audit.json) and [browser receipt](toast-evidence/toast-browser.json) are new follow-up evidence, not replacements for the earlier full-flow qualification.

The [browser probe](toast-browser-probe.cjs) runs with the existing isolated focused-browser harness using Node's `-r` preload. It creates its own test repository/credential in that temporary backend and intercepts only their access-test results. It does not operate on the user's preview container or real repository.

No hosted CI, full platform/browser flow rerun, image rebuild, deployment, push, tag or publication was performed for this follow-up.
