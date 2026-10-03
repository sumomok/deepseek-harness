# Agent Note: The desktop downloads the LibreOffice engine on request

Status: implemented

English | [中文](2026-09-27-desktop-office-engine-on-request.zh.md)

## Problem

rc.34 dropped every `@deepseek-ai/libreoffice-kit-*` engine from both desktop payloads and disabled the `office-to-pdf` row, so the desktop previews no Word or PowerPoint file. The product decision for rc.35 is that the desktop still ships no engine, the person may download it, and a `dsh web` deployment keeps shipping it. Each engine is a whole LibreOffice build: `darwin-arm64` is a 66,711,287-byte tarball and 145 MB unpacked, `win32-x64` 71,367,891 bytes and 182 MB.

`@deepseek-ai/libreoffice-kit` 0.1.1 fixes where the engine can come from. `lib/index.js` resolves `@deepseek-ai/libreoffice-kit-<platform>-<arch>/package.json` with `createRequire(import.meta.url)` from its own directory (lines 1211–1295), takes no path from configuration or environment, requires the engine's `package.json` version and `prebuilds.json` to match its own `0.1.1` (1295), checks the executable bit (1287), and on macOS and Windows throws `Required LibreOfficeKit native package is missing` instead of falling back to WASM. `@deepseek-ai/dsh-office-to-pdf` deletes a converter slot whose creation failed (`src/index.ts:241-244`), so the next conversion creates it again.

## Decision

- **Version from the kit.** `readEngineRequirement` resolves the kit through `@deepseek-ai/dsh` → `dsh-web-app` → `dsh-office-to-pdf` → `libreoffice-kit` from the server closure (the chain holds in the hoisted payload and in a workspace checkout) and reads `optionalDependencies["@deepseek-ai/libreoffice-kit-<target>"]`, refusing anything but one exact version. A kit upgrade therefore moves the download once `ENGINE_DOWNLOADS` registers the engine version it declares, and a package run whose staged kit declares an unregistered version for `darwin-arm64` or `win32-x64` stops.
- **Location is a function of the data directory.** `officeEngineRoot(dataDir)` is `<dataDir>/engines/office`, one directory per version. `main.ts` passes `resolveHarnessHome()`; the rc.35 data-directory move passes its own directory there.
- **`NODE_PATH`, set from launch.** `engineServerEnv` puts `<root>/<version>/node_modules` first in the server child's `NODE_PATH`, ahead of any inherited value, whether or not it exists yet. Node reads `NODE_PATH` once into its global paths and caches only resolutions that succeed; `rc34-work/office-scope/probe/t.mjs` showed a package directory created after startup resolving in the same process, and `t2.mjs` showed deleting `process.env.NODE_PATH` after startup keeps this process resolving while a child no longer sees it. The desktop layer drops its `office-to-pdf` row, so the shipped row is on from launch and the first conversion after a download succeeds without a restart.
- **The entry is named separately.** `DSH_DESKTOP_OFFICE_ENGINE_MODULES` carries the same path; the notice plugin's host half removes exactly that entry from `process.env.NODE_PATH` at apply. `scrubbedParentEnv` in `@deepseek-ai/dsh-subprocess` copies `process.env` at spawn time and already drops every `DSH_*` name, so the endpoint, token, and modules variables never reach a tool's child; `NODE_PATH` is the one name that needs removing.
- **Install through the shipped pnpm, staged and renamed.** `installEngine` creates `<root>/.staging-*`, runs `pnpm.mjs` under the bundled Node with `add <engine>@<version> --ignore-workspace --ignore-scripts --reporter=ndjson --config.node-linker=hoisted --config.lockfile=true --store-dir=<staging>/.pnpm-store`, compares the integrity the run's `pnpm-lock.yaml` records for the engine with the sha512 `ENGINE_DOWNLOADS` pins (the registry's `dist.integrity`), checks the engine's version, `prebuilds.json`, and executable, removes the per-run store, and renames the staging directory to `<root>/<version>`, retrying `EPERM`/`EBUSY`/`EACCES` nine times at 500 ms, about 4.5 seconds. pnpm checks the tarball against the registry metadata and owns `os`/`cpu` filtering, executable bits, and the user's `.npmrc`; the pinned value catches metadata that names another tarball. A kit version the table lacks is not offered. `pnpm:fetching-progress` records (`size` on `started`, `downloaded` on `in_progress`) drive the progress bar; the field names come from a captured pnpm 11.7.0 run.
- **A loopback service with a native confirmation.** `office-engine-service.ts` serves `GET /state`, `POST /install`, `POST /cancel` behind its own token. `/install` answers `202 confirming` at once and puts up a native dialog parented to the main window; the download starts only on its confirming button, and the default button is the cancelling one. For 30 seconds after the person declines, `/install` answers `409 declined-recently` without asking again. Every `409` body is `{ code, message }`, so the plugin tells the person which refusal it was. A caller names nothing. `close()` aborts a running download and does not wait on an open dialog, and an answer arriving after it starts nothing.
- **Prune by name shape only.** Before the server starts, and after an install, every entry under the root that is an exact version other than the current one or starts with `.staging-` is removed; any other name stays.
- **The payload is unchanged.** `platformDirRules`, the gate's `platform-variant` exemptions, and the packaging step's absence check still keep every engine out; their stated reason now names the download.

## Alternatives considered

- **`module.registerHooks` to redirect resolution** — `require.resolve`, which the kit uses, bypasses resolve hooks, so the kit would still miss the engine.
- **A symlink or copy into the payload's `node_modules`** — writes into the signed application bundle on macOS and into `Program Files` on Windows, both of which an update replaces.
- **Electron `session.downloadURL`** — marks every extracted file with `com.apple.quarantine` on macOS, and leaves integrity checking, extraction, and executable bits to the shell.
- **The `dsh-pnpm.cmd` launcher** — Node refuses to spawn a `.cmd` without `shell: true` on Windows, and a kill would stop `cmd.exe` rather than pnpm.
- **The user's global pnpm store** — puts a second 145 MB copy under the user's home, outside the data directory the move feature relocates.
- **Hard-coding the engine version** — silently mismatches the kit's own check after a kit upgrade.

## Consequences

- The end-to-end run on macOS arm64 (`rc34-work/rc35-office/e2e/run.mts`) installed the real `darwin-arm64@0.1.1` engine through `installEngine` into a `mkdtemp` data directory in 7 s: 13 progress reports up to 66,711,287 bytes, 147 MB on disk, executable mode 755, no `com.apple.quarantine`, no store left behind. A kit installed with its engine sibling removed refused to convert without `NODE_PATH` and converted a generated Chinese `.docx` to a PDF whose text `pdftotext` read back unchanged with it.
- While the notice plugin is not loaded, the server's children inherit the engine's `NODE_PATH` entry.
- Checked out alone, the three commits from "lend the server a loopback service that downloads the Office engine" through "document the on-request Office engine, with an Agent Note" do not pass every test and hygiene check; "read the engine service's JSON answer without an unknown assertion" fixes that. History is only appended, so `git bisect skip` those three.
- Windows is unverified on hardware: Defender scanning the unpacked engine during the rename, the `win32-x64@0.1.1` engine converting, and path length under the hoisted layout.

## Related

- `apps/desktop-shell/src/office-engine.ts`, `office-engine-service.ts`, `pnpm-launcher.ts` (`pnpmInvocation`), `main.ts` (`startOfficeEngineForServer`)
- `apps/desktop-app/cordis.patch.yml`; `apps/desktop-shell/README.md` "Office engine service"
- `@haoran/dsh-office-preview-notice` 0.2.2, vendored as `apps/desktop-server/vendor/haoran-dsh-office-preview-notice-0.2.2.tgz`, which offers the download beside opening the file in the default application, and strips the `NODE_PATH` entry
