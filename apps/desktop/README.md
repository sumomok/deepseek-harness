# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

Desktop client: an Electron shell whose main process starts the embedded `dsh web` server — the pnpm-deployed closure of [apps/desktop-server](../desktop-server/README.md) running on a bundled real Node runtime (never Electron's own Node, so the server keeps the tested engines line, `node:sqlite`, and the stock N-API prebuilds) — waits for the `dsh web:` URL line, and opens the served UI in a native window. The window is a plain browser surface: no preload, no Node integration; external links open in the system browser. Quitting tears the server process tree down (SIGTERM with a kill escalation; `taskkill /T` on Windows).

## Building installable packages

```sh
pnpm exec tsx apps/desktop/scripts/package.ts --mac        # zip + dmg (arm64), runnable on this machine
pnpm exec tsx apps/desktop/scripts/package.ts --win        # NSIS installer (x64), cross-packaged from macOS
```

Products land in `apps/desktop/dist-app/`. The pipeline stages the server by the python/sdk-runtime recipe (legacy hoisted `pnpm deploy`, restore hoists, materialize symlinks), prunes host-compiled native `build/` trees so loads go through the multi-platform prebuilds, fetches the win32-x64 members of platform-split optional dependencies the macOS install skipped, and stages the Node runtime per platform (`--skip-repo-build` / `--skip-deploy` reuse existing artifacts).

## Closing the window, and being called back

**On Windows the close button asks what it should mean**, once: 「最小化到托盘」 or 「退出应用」, with 「记住我的选择」. Unchecked, the answer covers that one close; checked, it goes into `desktop-state.json` as `closeAction` and every later close follows it without asking, until the tray menu's 「关闭时询问」 clears it. The minimize button is untouched — it stays the ordinary taskbar minimize. The tray icon exists from launch, so 「最小化到托盘」 names something already on screen and **检查更新** / **退出** stay reachable while the window is hidden; the menu is 打开 / 检查更新 / 关闭时询问 / 退出, localized like the menu bar. Every quit — from the tray, from a remembered answer, from an update — runs the same `before-quit` teardown that stops the server, and an update dialog shows the window before attaching to it, because a window-modal dialog owned by a hidden window can be neither seen nor found. macOS keeps its own idiom: closing leaves the app in the Dock and `activate` reopens the window, so there is no menu-bar icon.

**The client says when a session wants you back.** Two moments qualify — a session finished running, and a session is waiting for an approval or an answer — and neither interrupts while the window is focused. Both are read from the server the shell already started, over `/api/events.host` and `/api/events.mux`, the same downlink WebSockets the browser UI consumes; nothing was added upstream for this, and the streams replay what is still pending when reopened, so each request announces itself once. Windows shows a system toast that raises the window when clicked. macOS shows a Dock badge and bounces once, and posts nothing to notification centre — a dozen finished turns would be a dozen banners to dismiss, while the badge says how many and clears when the window is focused.

**A notification opens the app, not the session.** The web UI has no URL routing, so the shell has nowhere to navigate; the sidebar's own pending and completed markers identify the session that asked.

## Updates

Installed clients read a static feed — an electron-builder `generic` provider directory holding the manifests and the artifacts they name:

```
https://lhr.ink/dsh-updates/win/     latest.yml  + the NSIS installer + its blockmap
https://lhr.ink/dsh-updates/mac/     latest-mac.yml + the zipped app
```

There is no update service: the manifest *is* the decision procedure, so nginx serving a directory implements all of it. The feed URL lives in two places — `electron-builder.yml`, which generates the manifests and the packaged `app-update.yml`, and `src/updater.ts`, which reads them at runtime — so moving the feed means changing both. `channel: latest` is explicit on both ends; the default names the channel after the running version's prerelease tag, which would rename the channel at every stage of the release cycle.

**Windows installs in place, in three steps.** A silent check (15 s after launch, every four hours, and from **帮助 → 检查更新**) offers the download. Accepting downloads in the background behind a small progress window that can be closed without cancelling. The finished download offers the restart. **No install happens without the user deciding it**, on quit or anywhere else: `autoInstallOnAppQuit` is off, and the app replaces itself only in the seconds after someone clicks 「重启安装」. A declined install stays on disk and is offered again on the next launch and from the menu — nowhere else. Every one of these dialogs is attached to the app's own window, and an app that is not in front asks for attention first (a flashing taskbar button on Windows, one Dock bounce on macOS) — an unparented dialog is free to open behind whatever the user is working in, which is how an update offer can exist without being seen.

**The install is neither silent nor a wizard.** There are three things it could be, and the middle one is the only one that is both honest and click-free:

| | What the user sees | Why not |
|---|---|---|
| Full wizard | Directory page, progress, finish page | Re-asks what the click already answered; reads as a reinstall |
| Silent (`/S`) | Nothing — until something fails | An install with no surface cannot report itself, and NSIS shows its uninstall-failure box anyway (`handleUninstallResult`'s MessageBox carries no `/SD`), so the one thing that reaches the user is an error from nowhere |
| **Progress only** | One progress window, no question, app comes back | — |

`quitAndInstall(false, true)` picks the third. What removes the wizard around it is not silence: the directory page skips itself on an `--updated` run through the template's own `skipPageIfUpdated`, `build/installer.nsh` skips the finish page the same way, and MUI's `SetAutoClose true` closes the window when the section ends. Restarting the app is then ours to do — the template's relaunch is `${if} ${isForceRun} ${andIf} ${Silent}`, which a visible install never satisfies — so `customFinishPage` starts it through `ExecShellAsUser`, which drops the installer's elevated token. `$INSTDIR` comes from the registry's `InstallLocation` in `.onInit` either way, so nothing can land anywhere but the directory the app already occupies.

**Windows installs for all users, so the update elevates.** `perMachine: true` plus `packElevateHelper: true` puts `isAdminRightsRequired` in the manifest, and the updater then launches the installer through `elevate.exe`. On a machine with ordinary UAC settings that is **one confirmation dialog per install**; on a machine whose UAC is set to "Never notify" it is granted silently and nothing appears. Without the elevation the per-machine uninstall of the old version aborts — one of the two ways to reach `Failed to uninstall old application files: 2`.

**The other way is a file the old uninstaller cannot move, and it is the installer's job to clear it.** Updating runs the *old* uninstaller with `--updated`, whose uninstall section renames every file in the install directory into `$PLUGINSDIR\old-install` before deleting anything. `$PLUGINSDIR` lives under `%TEMP%`, so for an install directory on a different volume than the user profile every one of those renames is a cross-volume `MoveFile` — a copy followed by a delete — and Windows will not delete a file whose image is mapped by a running process. Three processes can be that file's owner: the app, its `node.exe` server, and `elevate.exe`, which the updater starts from the app's own `resources` directory and which waits there for the whole install. `customInit` (in `build/installer.nsh`, picked up from `buildResources` by name) kills `elevate.exe` at once — without `/T`, since the installer is its child — then gives the app and its server 10 s to leave on their own and tree-kills what is left. Around it, a quit bounds its server stop (4 s on Windows, inside the installer's own patience; 10 s elsewhere) and exits regardless, and each launch kills any server a previous run left behind, matched on the full path of this install's bundled Node binary rather than the `node` image name.

**The new build says so.** Each launch records its version in `desktop-state.json` under the user data directory, and a launch that finds an older version there — which is what an update that restarted the app by itself looks like — puts one line on the boot page: 「已更新到 vX.Y.Z」. Nothing else changes; there is no dialog to dismiss.

**When an install fails**, the downloaded installer is still on disk under `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\pending\`. Running it by hand — right-click, **Run as administrator** — installs the same build the update was carrying, and the app keeps every session either way. The reason to run it elevated is that a hand-started installer has no `elevate.exe` to ask for the rights the per-machine uninstall needs.

**macOS detects and hands off.** Squirrel.Mac stages an update only for a signed app, and these builds carry no certificate, so macOS compares versions itself and opens the download in the system browser instead. That prompt appears at launch or on a manual check, never mid-session.

### Mandatory updates

The manifests carry one field of this product's own, `minimumVersion`: a client older than it must update before it can be used.

| | Windows | macOS |
|---|---|---|
| **At launch** | The UI is not shown, the server is torn down, and the download starts without being asked. A failed download offers a retry beside quitting. | A blocking dialog offers the download or quitting; the app does not open either way. |
| **Mid-session** | Downloads immediately, with one dialog saying so; the finished download can still be deferred. | One prompt; the next launch blocks. |

An unreachable feed **opens** the gate rather than closing it — a network fault must never lock someone out of their own machine. The line is set explicitly at publish time and then carries forward on its own, so forgetting the flag cannot silently drop it.

### Publishing

```sh
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt             # ship the built version
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt --dry-run   # verify without uploading
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt --minimum-version 0.1.0-rc.8
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt --republish  # repair a cut-off upload
```

The script refuses a `dist-app` that disagrees with `package.json`, re-verifies the installer's NSIS integrity CRC, and asserts the build supersedes what the feed serves. Uploads go **artifacts first, checksummed on both ends, manifests last**, so a client polling mid-publish reads the previous manifest naming the previous artifacts — never a manifest pointing at a file still uploading. It also drops manifest entries for artifacts it does not upload: the macOS build lists a dmg beside the zip and only the zip is published, so leaving that entry in would put a 404 in the feed.

On the update host the feed is `/var/www/dsh-updates/{win,mac}`, served by a single appended `location /dsh-updates/` with an `alias`. That nginx has a custom prefix (`/data/third_party/nginx`), is built without the rewrite module, and its master is not under systemd — reload it with `nginx -s reload`, never `systemctl`. The directory carries no BasicAuth because electron-updater sends no credentials.

## Trust and signing

Builds are unsigned development artifacts: macOS Gatekeeper needs right-click-open (or `xattr -dr com.apple.quarantine`) on machines other than the builder's, and Windows SmartScreen shows its unknown-publisher prompt. The Windows package is cross-built and structurally verified only — smoke-test it on a real Windows machine before handing it to anyone.

This bounds what the update feed can promise. TLS authenticates the server and each manifest's sha512 binds artifact to manifest, so nothing can be tampered with in transit. The artifacts themselves are unsigned, so write access to `/var/www/dsh-updates` is write access to every client's next installer, and neither operating system will vouch for what arrives. Closing that gap means code signing — Authenticode on Windows, Developer ID plus notarization on macOS — which is also what would let macOS install in place instead of handing off.

## Server environment

The server starts in the user's home directory with the GUI-inherited environment plus the standard shell PATH entries (macOS GUI apps launch with launchd's minimal PATH). `DEEPSEEK_API_KEY` resolves through the normal credential chain (environment → managed store → `.env`), so a first run without a key still boots into the UI, where the models settings page can store one. Server output is appended to the app's log directory (`dsh-server.log`), which **帮助 → 查看日志** opens; the boot page reports startup phases only and prints no path.

**The boot page and the download window follow the app's theme.** Both palettes are the web UI's own tokens, so the splash and the app it hands over to are the same two colors in either mode. The appearance is resolved before the window exists — `backgroundColor` is what paints while the page loads — in this order: the durable `ui-theme.preference` from `~/.dsh/settings.yaml` when it is an explicit `light` or `dark`, otherwise the system (`nativeTheme.shouldUseDarkColors`), which is also what its default `system` means. **An explicit setting wins over the system.** **帮助 → 关于** names the build and its update feed. Menu-bar labels follow `app.getLocale()` (Chinese or English); dialogs stay Chinese.

## Known Limitations and Deferred Work

- A notification cannot open the session it is about: the web UI keeps the selected session in memory and puts nothing in the URL, so there is no address for the shell to load. Closing this needs the web client to accept a session in its URL; the shell side is then one `loadURL` argument.
- macOS cannot install an update in place: unsigned builds are outside what Squirrel.Mac will stage, so the client detects the new version and opens the download. Code signing is the prerequisite, not packaging work.
- Windows arm64 and Linux desktop targets are unbuilt; node-pty prebuilds cover win32-arm64, so the arm64 gap is packaging work only.
- A dev launch (`pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`) uses the checkout's built CLI and the PATH Node, not the staged resources.
