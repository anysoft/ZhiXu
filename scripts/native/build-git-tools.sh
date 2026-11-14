#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077
script_directory="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "${script_directory}/build-git-tools.py" "$@"
