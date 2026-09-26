# Agent Note: Desktop shell diagnostics: crash records, server logger records, and update leftovers

Status: implemented

English | [中文](2026-09-27-desktop-shell-diagnostics.zh.md)

## Problem

Field reports from 0.1.0-rc.32 and rc.33 arrived with a `dsh-server.log` that could not say what happened. A server that died on Windows with exit `3221226505` left the `server exited unexpectedly` line and a tail that ended before the lines explaining the death: the shell took that tail on the child's `exit` event, which can arrive while the child's last output is still in the pipes. A V8 fatal error, out of memory above all, left no report anywhere, because nothing asked Node to write one. Every record a plugin wrote through `ctx.logger` — the webserver's failed listen, `@haoran/dsh-auto-compact`'s named `ctx.logger('auto-compact')`, the settings import's per-section failures — reached only the logger's in-memory buffer: the product composition mounts no exporter, so those records were gone with the process.

Two update-channel gaps were left from rc.32. 帮助 → 检查更新 answered a failure with 「无法检查更新」 and the error's raw message, so a screenshot from a user carried no code to match against the log. And electron-updater's `pending` directory kept the installed artifact — the whole zip on macOS, the whole NSIS installer on Windows — after the install had landed, because the library empties it only on a failed download or a cache record that stops matching the feed.

## Decision

### Crash records for the server process

`startServer` puts `--report-on-fatalerror --report-uncaught-exception --report-directory=<log directory> --report-exclude-env --report-exclude-network` before the entry script on the server's own command line (`diagnosticReportFlags`, with the directory carried by `ServerSpec.reportDirectory`). A report leaves out the environment, where the provider key lives, and the network interfaces. An exception produces a report only until the CLI's `installFailLoud` handler is installed, after which that handler's stderr line is the record; a native crash that bypasses V8, such as Windows `0xC0000409`, writes no report.

The exit autopsy and the exit-before-URL rejection wait for the child's `close`, which comes once both pipes are drained, bounded at `CLOSE_WAIT_MS` (2 s) after `exit` for a pipe a process the server started still holds open. The quarantine scan reads the pre-URL rejection's `output`, so it now sees the whole output too.

### Server logger records in `dsh-server.log`

`@deepseek-ai/dsh-desktop-app` gains one plugin module, `./server-log`, and its patch layer inserts the `desktop-server-log` row that mounts it. The plugin registers one exporter on the root logger service, which every context shares, isolated preset realms included, and appends each record at or below `level: 2` to the file named in `DSH_DESKTOP_SERVER_LOG` — the shell sets that variable to `dsh-server.log` for the server child alone, and the row is disabled without it. cordis orders ERROR 0 < INFO 1 < WARN 2 < DEBUG 3, so the threshold keeps warnings and drops debug. Each record is one `appendFileSync` call of lines starting `[server-log]`. On mount the plugin first appends the records the service's buffer already holds within the threshold. The package builds with its own `tsc -b`, like the shell, because the repository's tsdown pass covers `vendor`, `packages`, and `apps/cli` only; the packaging run builds it before the deploy, and the staged boot names a log file so the row mounts there and its module has to resolve from the payload.

### The 「无法检查更新」 detail

Both sites that answer a manual check with 「无法检查更新」 build the detail with `checkFailureDetail`: the failure's first message line, then `错误码:` with every code down the `cause` chain, or the `TimeoutError`/`AbortError` name of a request given up on; a failure carrying neither gets no code line.

### Emptying `pending` after an install

The install click records the staged artifact's `fileName` and `sha512` from `pending/update-info.json`, with the running version, in `desktop-state.json`. Before its first check, a later launch calls `sweepInstalledPending`: nothing happens unless the running version is newer than the recorded one, and `pending` is emptied — the record last — only while its record still names that artifact. A same-version launch means the install did not land and the artifact is still the update to install; a record naming another artifact is a later download. An entry the relaunching Windows installer still holds is reported and the remembered install kept, so the next launch tries again. The differential baselines in the cache root are never touched.

## Alternatives considered

**`NODE_OPTIONS` for the report flags.** An environment variable reaches every process the server starts, so every Node program the agent runs for the user would write its reports into the desktop log directory, and a report without `--report-exclude-env` would carry that program's environment. The flags belong to the one server process.

**Mounting `@deepseek-ai/cordis-plugin-logger-console`.** It prints through `console.log`, and the shell scans the server's stdout and stderr for the readiness line and copies both streams into `dsh-server.log`: a record printed there would be matched against the URL pattern. Writing the file from the exporter keeps the streams as they were and writes each record once.

**A logger preload or a core patch to capture boot-time warnings.** The row is appended after every other entry and the Loader imports entries concurrently, so a warning logged during boot before the row mounts is not in the replayed buffer, which keeps records at INFO. A `--import` preload patching `LoggerService` depends on the preload and the CLI resolving one cordis module; a buffer-threshold or boot-hook change is a core change. Both were left out of this shell-only change.

**Inferring the installed version from the artifact name in `pending`.** The name mixes the product name, `Setup`, the arch, and the platform around the version, and a release version followed by `-arm64` parses as a prerelease below it. The record the install click writes names the artifact by the library's own fields, and the running version decides whether the install landed.

## Consequences

A crash now leaves the lines the server wrote last, and a V8 fatal error leaves a report next to the log. Reports and `dsh-server.log` are never rotated, and the log now also receives every plugin's logger records at INFO and above. A warning logged during boot before `desktop-server-log` mounts — the settings import's section failures on the first boot after an upgrade from rc.33 among them — is still lost. A development launch needs `pnpm --filter @deepseek-ai/dsh-desktop-app run build:ts` before it, because the row imports that package's `lib/`. An install started by a build older than this change recorded nothing, so its artifact stays in `pending` until the next update's download clears it.
