# Brand regression checks

The official product display name is exported by `back/shared/brand.ts` and re-exported for the UI by `src/utils/brand.ts`. Surrounding sentences use the existing locale resources. Standalone notification samples retain their self-contained display templates.

Run the source gate from the repository root:

```sh
node scripts/branding/audit.cjs --output diagnostics/branding/brand-audit.json --markdown diagnostics/branding/brand-audit.md
```

The scanner covers tracked text (including historical evidence) and non-ignored new files. Build output, dependency caches and private local configuration are outside that source scope. Binary files are enumerated for visual review. Only the classification JSON and four explicitly named generated audit reports are excluded from recursive scanning; no documentation directory is exempt.

Every exception in `classifications.json` records its category, action and reason. Its key is the SHA-256 of the repository-relative filename, matched value and trimmed source line, separated by NUL bytes. The report records line numbers and columns for each occurrence. A new or changed match fails closed until reviewed. Line shifts alone do not invalidate a review. Removed entries may remain as a record of the initial audit; they do not grant exceptions in another file or for another source line.

Review the context before adding an exception. Current UI/template branding must be fixed in source, never marked as an internal identifier to silence the gate. Attribution, protocol identifiers, environment names, fixture identities and historical evidence remain distinct categories. An unresolved metadata review, missing reason, invalid category or visible old brand fails the gate.

The platform test baseline includes brand/title/metadata and notification regressions. The CI static gate invokes this scanner. The CI browser job also runs `scripts/branding/browser.cjs` for explicit and system language preferences in both supported locales, producing `brand-browser.json` and screenshots in each acceptance directory. It starts an isolated real backend and fresh database, and cleans its owned temporary root.

For a local browser run, set `QL_BROWSER_RUNTIME` to the existing Playwright installation and use the project's supported Node version:

```sh
QL_I18N_LOCALE=en-US BRAND_PREFERENCE=system node scripts/branding/browser.cjs
```

Keep previous qualification evidence intact. A source change requires a new hosted qualification; these local checks do not qualify an older container image for release.
