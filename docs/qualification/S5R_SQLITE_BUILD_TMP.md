# SQLite build staging

The reviewed sqlite binding patch compiles its pinned SQLite source in a unique temporary directory. gyp Makefile paths cannot contain `=`, carriage returns, or newlines. pnpm's root lifecycle rewrites `TMPDIR` below its `patch_hash=` package directory, so the Docker dependency stages explicitly create `/build/.sqlite-build-tmp` with mode `0700` and set `ZHIXU_SQLITE_BUILD_TMPDIR`.

This is a build-only path selection. The override must be an existing canonical absolute directory, have no symlink alias, belong to the invoking UID, and have no group or other write permission. Unsafe paths fail closed; there is no permission or verification bypass. The installer retains the `=`, CR/LF rejection, exclusive `mkdtemp` staging, source digest verification, compiler execution, actual SQLite version/source-id probe, and native-byte receipt verification. Without the override it keeps the normal operating-system temporary-directory behavior and rejects unsupported gyp paths.

The variable is set only in Docker dependency/build stages. It does not configure the production application, DataRoot, Runtime, or artifact trust/store domains. Native build controllers may set it to their own protected staging directory; normal non-root pnpm installations do not need it.

The installer publishes addon directories as caller-owned `0755` and its atomic build receipt as `0644`, explicitly after the strict `077` build umask. Lock files remain `0600` and private staging directories remain `0700`. Both Docker runtime stages run the strict SQLite memory-query/source-identity verifier after switching to service UID 10001; v2 does so after removing write permissions from `/app`. These checks must pass in the actual target image.
