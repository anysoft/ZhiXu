#!/usr/bin/env bash
set -Eeuo pipefail
# macOS/Linux; requires Node.js and the project's installed js-yaml dependency.
readonly VERSION_SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
command -v node >/dev/null 2>&1 || { printf 'Error: Node.js is required.\n' >&2; exit 1; }
exec node "$VERSION_SCRIPT_ROOT/scripts/release/bump-version.cjs" "$@"
