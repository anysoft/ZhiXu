# Proxy Management targeted checks

The feature uses the existing private SQLite credential boundary and existing backup coverage. Platform defaults to DIRECT; Workspace, Repository, Task and Runtime Operations can inherit, force DIRECT or select a profile. When no proxy management selection exists, explicitly configured task environment variables keep their previous behavior. Explicit DIRECT clears standard proxy variables for that task.

Git HTTPS uses native operation-local Git configuration. SSH proxies are explicitly unsupported. Shared Runtime and environment-build operations inherit the platform default unless overridden per operation. Task proxy values are pinned at startup. pip SOCKS5 requires PySocks in the managed environment; missing support produces an explicit diagnostic and never falls back to direct access.

Run with a supported application Node (22 or 24):

```sh
QL_DIR="$PWD" JWT_SECRET=proxy-test-only TS_NODE_PROJECT=back/tsconfig.json \
  node -r ts-node/register/transpile-only --test \
  tests/workspace-v2/proxy-management.test.cjs \
  tests/workspace-v2/proxy-task-git.test.cjs \
  tests/proxy/runtime-proxy.test.cjs
```

Set `ZHIXU_TEST_PNPM_CLI` to an installed pnpm CLI JavaScript entrypoint to include actual pnpm package installations; those cases explicitly skip when no CLI is supplied. HTTP/HTTPS/SOCKS tests create local proxies and origins, including a fixture-only CA to verify TLS acceptance and rejection. They do not change OS or Docker proxy settings.

After building the v2 frontend, run the controlled-API browser regression:

```sh
ZHIXU_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
ZHIXU_BROWSER_EXECUTABLE=/absolute/path/to/chrome \
  node diagnostics/v2/proxy-browser.cjs
```

Browser fixtures validate UI and submitted payloads; actual proxy traffic is tested separately by the backend tests. No test uses user repositories or credentials.
