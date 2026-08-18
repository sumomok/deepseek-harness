# Agent Note: Desktop update channel over a static feed

Status: implemented

English | [中文](2026-08-18-desktop-update-channel.zh.md)

## Problem

The [installable client packages](2026-08-18-installable-client-packages.md) ship with no update path. A new build reaches people only if someone tells them it exists and they download and reinstall by hand, and an installed copy has no way to learn that it is behind. That non-goal was affordable while the desktop client had no users; it stops being affordable the moment a build is handed to someone who is not the builder, because every later fix is stranded behind a manual step nobody takes.

## Decision

The update channel is a **static directory served over TLS** — electron-builder's `generic` provider — read by two per-platform behaviors that differ only in how far they can take the user, with one mandatory layer above them.

### The feed

`electron-builder.yml` declares one `publish` block per platform, which makes the build emit the manifests the provider reads: `latest.yml` for Windows and `latest-mac.yml` for macOS, each naming the artifacts of that version with their sha512 and size, and each sitting beside those artifacts under `https://lhr.ink/dsh-updates/{win,mac}/`. The Windows block additionally writes `app-update.yml` inside the packaged app.

`channel: latest` is set explicitly on both ends. The default derives the channel name from the running version's prerelease tag, so an `0.1.0-rc.8` build publishes and looks for `rc.yml` — and the channel would rename itself at every stage of the release cycle, stranding clients on a manifest nobody writes any more. This product has one channel.

There is no update service. The manifest *is* the decision procedure: a client fetches it, compares its version, and either acts or does nothing. That is the whole server-side contract, which is why nginx serving a directory is a complete implementation of it.

### Windows: three stages, and installing is never silent

1. **Check** — silent, 15 seconds after launch, every four hours, and on demand from **帮助 → 检查更新**.
2. **Offer the download** — one dialog naming the version, with the release notes as its detail. Nothing has been transferred yet, so declining costs nothing. Accepting downloads in the background behind a small progress window (`src/progress-window.ts`) that reports percentage, size and rate; closing that window does not cancel the download, and the taskbar button keeps the progress either way. A manual check during a download reopens the window instead of stacking a dialog on it.
3. **Offer the install** — one dialog once the bytes are on disk: 「v… 已下载完毕,可以安装。现在重启安装吗?」 with 「暂不」 as the default button, so a reflexive Enter never ends a session.

**No install happens without the user deciding it, on quit or anywhere else.** `autoInstallOnAppQuit` is off and the teardown path is `stopServerBounded()` → `app.exit(0)`; the app replaces itself only in the seconds after someone clicks 「重启安装」, at which point the embedded server's process tree comes down first — the installer replaces the directory that server runs out of. A declined install stays on disk and is offered again exactly twice more: on the next launch, where the cached download re-raises `update-downloaded`, and whenever the user asks from the menu. No badge, no timer, no second reminder.

**What follows that click asks nothing, which is the opposite of installing unasked.** The rule bans installs the user did not decide; the click *is* the decision, and everything after it is that decision being carried out. Three shapes were available for carrying it out, and the choice moved once:

| | What the user sees | Verdict |
|---|---|---|
| Full wizard | Directory page, progress, finish page | Re-asks what the click answered; the first users of this channel reported it as "a reinstall, not an update" |
| Silent (`/S`) | Nothing — until something fails | Shipped first, then withdrawn: see below |
| Progress only | One progress window, no question, app comes back | Current |

`/S` was withdrawn because silence is not actually available. An NSIS silent run still shows any MessageBox that carries no `/SD`, and the uninstall-failure box is exactly one of those (`handleUninstallResult`, `include/installUtil.nsh`) — so the one thing a silent install can put on screen is its own error, arriving out of nowhere with no window that could account for it. That is the worst of both: nothing to watch while it works, and an unexplained error when it does not.

`quitAndInstall(false, true)` therefore installs visibly, and the wizard is removed by other means rather than by silence: the directory page skips itself on an `--updated` run through the template's own `skipPageIfUpdated`, `build/installer.nsh` skips the finish page the same way (`MUI_PAGE_CUSTOMFUNCTION_PRE` + `Abort`, which every MUI page honours), and `SetAutoClose true` — which MUI already sets from `.onGUIInit` for its own finish page — closes the window when the section ends. What is left on screen is one progress bar.

Restarting the app then has to be done by hand, because the template's relaunch is `${if} ${isForceRun} ${andIf} ${Silent}` (`installSection.nsh`) and a visible run never satisfies it however the flag is passed — `quitAndInstall` does not even forward `isForceRunAfter` unless `isSilent` is set, substituting `autoRunAppAfterInstall` (`BaseUpdater.js`). `customFinishPage` starts the app itself through `${StdUtils.ExecShellAsUser}`, which hands the launch to the shell so the app runs with the user's token instead of inheriting the installer's elevated one. `$INSTDIR` is unaffected by any of this: it comes from the registry's `InstallLocation`, read in `.onInit` before any page exists.

**The dialogs are attached to the window they belong to.** `dialog.showMessageBox` without a parent opens an independent top-level window, which Windows is free to place behind whatever is in front — a real user reported 「发现新版本」 arriving underneath their editor. Every dialog now passes the app's window, and an app that is not focused asks for attention first: `flashFrame` on Windows, cleared on the next focus, and one `dock.bounce('informational')` on macOS.

### Staying installable: process lifecycle and elevation

Real Windows updates found four ways to fail, and they are worth writing down because none of them is visible from the update code alone.

**The install failed because the installer was never elevated, on a machine that never says so.** With a per-machine install, replacing the old version means running the old uninstaller against `HKLM` and Program Files, which needs administrator rights. electron-updater spawns the installer from the running app, which is not elevated, so the silent uninstall aborted and returned exit code 2 — surfaced as 「Failed to uninstall old application files: 2」, where the number is the old uninstaller's own exit code (`handleUninstallResult` prints `$(uninstallFailed): $R0`, and the separate "could not launch" path prints only to the details log). The user saw no UAC prompt at any point, because their UAC slider is at **Never notify**: on that setting a process that *asks* for elevation is granted it silently, while a process that does not ask keeps its filtered token. The updater's installer never asked. Running the same installer through "Run as administrator" — which grants the full token explicitly — installed it in one pass.

The fix is to let the updater ask. `perMachine: true` gives the product one install location and removes the mode page; `packElevateHelper: true` is what actually puts `isAdminRightsRequired: true` in the manifest, because the emit condition is `updateInfo != null && isPerMachine && (oneClick || options.packElevateHelper)` (`NsisTarget.js`) and an unset option is falsy there — the helper binary is copied regardless, so leaving this out ships a build that *could* elevate and never tells anyone. The updater then reads the flag off the downloaded file's manifest entry (`DownloadedUpdateHelper.js`, `fileInfo.info.isAdminRightsRequired === true`), passes it to `doInstall`, and launches `elevate.exe` instead of the installer directly (`NsisUpdater.js`). On an ordinary machine that is one UAC confirmation per install; on a Never-notify machine it is silent.

**A dying app looks the same as a stuck one.** The teardown held the quit, stopped the server, then exited — with nothing bounding the stop, so a stop that never settled left a windowless process alive forever. The installer allows the old app about 7.6 s to disappear (300 ms + 1 s, then two rounds of 1 s + 2 s, per `_CHECK_APP_RUNNING`) before it gives up and asks the user to close it by hand. `stopServerBounded` now bounds the wait: 4 s on Windows, comfortably inside that budget, and 10 s on POSIX, which must instead outlast the server's own 8 s SIGTERM-to-SIGKILL escalation so the deadline cannot preempt it.

**Killing the app does not kill its server.** The server is a separate `node.exe` under the install directory, and the installer's own cleanup does not reach it: its PowerShell branch stops matched processes by pid without their children, and its fallback branch matches the app's image name only. An orphaned server keeps the files the uninstaller is about to delete. Two defenses cover it. On startup, before a new server starts, `sweepOrphanedServers` kills processes whose executable is *exactly* this install's bundled Node binary — full path, not image name, because every other `node` on the machine belongs to someone else. In the installer, `build/installer.nsh` defines `customInit`, which app-builder-lib picks up by name from the buildResources directory; it gives the app and its server 10 s to leave on their own and then tree-kills what remains, because the server's own children — shells, language servers — hold the same files it does.

**And the update's own launcher holds a file inside the directory being replaced.** This is the failure that survived all of the above, reported as 「Failed to uninstall old application files…: 2」 after an install that showed nothing at all. The chain is entirely in the templates:

1. `uninstallOldVersion` (`include/installUtil.nsh`) runs the **old** uninstaller as `/S /KEEP_APP_DATA /allusers --updated _?=$INSTDIR`, and retries it five times.
2. `--updated` puts that uninstaller's section on the `${if} ${isUpdated}` branch (`uninstaller.nsh`), which calls `un.atomicRMDir` — renaming every file in `$INSTDIR` into `$PLUGINSDIR\old-install` before deleting anything, so a failure can be rolled back.
3. `$PLUGINSDIR` is under `%TEMP%`. When the install directory is on another volume than the user profile — `D:\soft\DSH Desktop` against a profile on `C:` — every one of those renames is a cross-volume `MoveFile`, which Windows performs as a copy followed by a **delete**. A running executable can be renamed; it cannot be deleted.
4. `elevate.exe` is a running executable inside that directory for the whole install: electron-updater launches it from `process.resourcesPath` (`NsisUpdater.js`), and it waits on the installer rather than exiting (`ShellExecuteExW` + `WaitForSingleObject`). So the move fails, `un.atomicRMDir` aborts, and `Abort` in a section is NSIS error level **2** — the number in the message is the old uninstaller's exit code, not a code of ours.
5. Every retry fails identically, because nothing about elevate.exe changes while the installer it is waiting for is still running.

This is why the same installer succeeded every time it was started by hand with "Run as administrator": a hand-started install has no `elevate.exe`. It is also why it only appeared on one machine — an install under `C:\Program Files` renames within one volume, which needs no delete and does not care what is running.

`customInit` therefore kills `elevate.exe` **first and unconditionally**, and pointedly *without* `/T`: the installer is its child, so a tree kill would end the install it is trying to repair. Waiting for it instead would deadlock, since it is waiting for us. Only then does the wait-and-tree-kill loop for the app and the server run. All of it matches on executable path under `$INSTDIR`, which is what makes killing a `node.exe` safe to do at all.

The whole macro runs in one PowerShell process rather than one per poll: the query costs more than the 500 ms between polls, so a poll count is not a time budget. The no-PowerShell fallback can only tree-kill the app by image name — `node.exe` is far too common a name to kill by name — which is a degradation, not a plan.

**`build/installer.nsh` is source, and `build/` was ignored.** The macro that repairs the install lived only in one working tree, which is the same as not existing. `.gitignore` now lists the generated icons individually instead of the directory, so anything hand-written in `buildResources` is tracked. The alternative — moving the file elsewhere and pointing `nsis.include` at it — was rejected because the by-name lookup in `buildResources` is the documented convention, and a second convention is worth less than a correct ignore rule.

### The new build confirms itself

An update that restarts the app by itself ends with a window that looks exactly like the one that closed, so the last thing the user is told about the operation is that it started. Each launch writes its version to `desktop-state.json` in the user data directory — the only directory an update is required to preserve, since the uninstaller is invoked with `--updated` — and a launch that finds an older version there puts one line on the boot page: 「已更新到 vX.Y.Z」. A missing or unreadable file means no receipt rather than a wrong one, and a downgrade says nothing at all.

The line is baked into the boot page's document rather than pushed into it with `executeJavaScript`. The push path deliberately drops what it carries when the page is not ready, which is right for a phase that will be re-pushed a second later and wrong for a message that is shown once.

### macOS: detect and hand off

macOS deliberately does **not** use electron-updater. Squirrel.Mac stages an update only when the running app is signed and the replacement satisfies the same signing requirement; these builds carry no certificate, so an in-place install is not available at any amount of effort. Rather than ship a path that always fails, the macOS check reads `latest-mac.yml` directly, compares versions, and — when the feed is ahead — opens the artifact URL in the system browser and states what to do with it, including the right-click-open that Gatekeeper demands of an unsigned app on its first run.

That dialog is confined to launch and manual checks. A scheduled check that finds a new version mid-session only writes a log line, because the session in progress did not ask.

### The mandatory layer

The manifests carry one field of this product's own, `minimumVersion`: a client older than that version must update before it can be used. electron-updater parses the manifest with js-yaml and preserves unknown fields on `updateInfo`, so Windows reads it there and macOS — which parses the file itself — reads it directly. The verdict is computed in exactly one function, `isMandatory`, from exactly one input, and an absent field means no red line, so a feed that never sets one behaves precisely as it did before the field existed.

| | Windows | macOS |
|---|---|---|
| **At launch** | The UI is not shown and the embedded server is torn down. The download starts without being asked, behind the progress window, and the finished dialog offers only 「重启安装」. A failed download offers 「重试」 beside 「退出应用」. | A blocking dialog offers 「去下载」 or 「退出应用」; either way the app quits rather than opening. |
| **Mid-session** | The download starts immediately without being asked, with one dialog saying so. When it finishes, 「立即重启安装」 sits beside 「稍后」 — the work in progress is respected, and the next launch is where the gate stops being negotiable. | One prompt offering the download; the next launch blocks. |

The launch gate runs concurrently with the server boot, so on the ordinary path it costs no wall-clock time, and it is bounded by a timeout that **opens** the gate. An unreachable feed must never lock someone out of their own machine; the red line is enforced on a later launch that can read it.

Operationally the line is set by the publisher and then persists: `--minimum-version` writes it, and every later publish that omits the flag copies the value the feed already serves. Forgetting the flag cannot silently drop a red line.

### Publishing is an ordered upload

`scripts/publish-update.ts` takes `--notes <file>`, an optional `--minimum-version`, and `--dry-run`. It refuses a `dist-app` whose manifests disagree with `package.json`, recomputes the NSIS startup CRC on the installer it is about to upload, refuses a red line above the version being published (which would strand every client), and asserts the local version supersedes what the feed serves.

The upload order is the atomicity mechanism: **every artifact first, checksummed on both ends, and the manifests last.** A client polling mid-publish therefore reads the previous manifest naming the previous artifacts — never a manifest pointing at a file that is still uploading. The NSIS CRC check moved to `scripts/nsis-integrity.ts` so the build gate and the upload gate are the same code.

The manifest is also pruned to what actually ships. electron-builder lists every artifact it produced, so `latest-mac.yml` names the dmg beside the zip while only the zip is uploaded; the script drops entries outside the upload set rather than widening the upload set, because the dmg is a hand-install convenience and nothing in the update path wants it.

Moving the bytes turned out to be the hard part. The link to this host drops often enough that `scp` — which restarts a cut transfer from zero — could not finish the 145 MB installer across three attempts, and the server has no rsync and is not this project's to install packages on. The uploader therefore streams only the part the server lacks into a remote `cat >>`, sizing it with `stat` and confirming it with `md5sum` on every pass: each attempt keeps the ground it took, so a bounded retry converges on a link that keeps failing. Ordering also only keeps each channel self-consistent — one death between the two manifests left Windows on a newer version than macOS — so the publish reads both manifests back at the end and fails when they disagree.

Re-publishing a version is the repair path for an upload cut short, and it is the only operation that overwrites artifacts a live manifest already vouches for: while the bytes are being replaced they do not match the published sha512, and a client downloading in that window fails its checksum and retries later. That is recoverable and short, but not something to reach by accident, so it takes an explicit `--republish`.

### Where the feed lives

The server is the project's existing always-on host. Its nginx (custom prefix `/data/third_party/nginx`, built `--without-http_rewrite_module`, master not under systemd) gains exactly one `location /dsh-updates/` with an `alias`, appended to the TLS server block that already existed, and reloads with `nginx -s reload`. The feed carries no BasicAuth because electron-updater sends no credentials, and the directory holds nothing but this product's installers.

### The boot page shows phases, not output

The same change replaces the boot console. It used to live-tail every main-process preflight line and every byte the server printed, which is the correct diagnostic surface for the developer and the wrong one for the person waiting: it presents a wall of text as though it required reading, and its most common content — an ordinary slow first launch under antivirus scanning — looks like a fault in progress.

The page now shows **one phase at a time** — whichever is actually running, out of `校验运行环境`, `启动 dsh 服务`, and `连接界面` — with its elapsed seconds once it passes three, and a slow-start line after eight seconds saying a first launch is scanned. Phases that have not started are not drawn at all: a checklist of things that have not happened is a list of ways to wonder what is wrong. The rows are stacked in a fixed-height box and cross-fade, so advancing a phase moves nothing else on the page. A blocked launch reuses the hint line to say why it is holding.

The page carries a wordmark (`从这里开始` with a blinking caret; the Chinese glyphs take a real CJK face and only the caret stays monospace) and, at the bottom, the bare version. It does **not** carry the log path any more — a path on a splash screen is only useful to someone who already knows to want it. Reaching the log is a menu item instead, **帮助 → 查看日志**, which opens the file and falls back to revealing it in the file manager; it is built before the packaged-only branch, so a development launch has it too. On failure the running phase turns red, one summary line appears, and the guidance under it names that menu path.

**The file sink is unchanged** — every byte still lands in `dsh-server.log`; it simply no longer reaches the screen. That is what keeps the diagnosis material intact while removing it from the waiting experience.

The splash also stopped being unconditionally dark. It carries two palettes taken from the web UI's own token sheet (`packages/client/ui-theme/src/styles/design-platform.css`) — background, primary label, tertiary label, and the blue accent — so handing over to the app is a continuation rather than a cut. Which one it paints is decided before the window exists, because `backgroundColor` is what shows while the page loads and choosing late is exactly what produces a flash of the wrong theme. The choice reads the same durable preference the web UI stores (`~/.dsh/settings.yaml`, `ui-theme.preference`), falling back to `nativeTheme.shouldUseDarkColors` for its `system` default or for any unreadable file; that is why an explicitly light user does not get a dark splash on a dark-mode machine. The download progress window shares the module. Both modes get the same treatment — every surface and text color is a token the app itself paints — so what stays boot-page-specific is the composition rather than the palette: the wordmark, the caret, the dot grid, the vignette, and the accent glow.

## Verification

The macOS build launches from the packaged `.app`, reaches its `dsh web:` line, and serves 200 at that URL, with no process left behind after quit. The Windows installer passes the NSIS CRC gate, `app-update.yml` is present in the packaged resources, and `app.asar` carries `node_modules/electron-updater`. The feed route was verified from the public internet against the real certificate chain before anything was published, and the pre-existing `/flood/` route was confirmed still answering `401` after the nginx reload.

A hook that is not compiled in fails silently — `!ifmacrodef` simply does not fire — so both are proved by injecting `!error` into the macro body and reading the compiler's own reply: makensis stops with `Error in macro customInit on macroline 1` and, separately, `Error in macro customFinishPage on macroline 1`. That is the check to repeat whenever `build/installer.nsh` is renamed, moved, or newly ignored. The update receipt is proved from the log line the same launch writes (`first run after updating from …`) after seeding the state file with an older version.

## Alternatives considered

**Squirrel.Windows instead of NSIS + electron-updater.** The repository already denies `electron-winstaller` builds in `pnpm-workspace.yaml`, and Squirrel.Windows would replace the NSIS installer whose integrity gate exists because a real Windows machine rejected an earlier build. Keeping NSIS means the update path and the install path are the same artifact, verified by the same CRC check.

**A self-hosted update backend.** An update API could serve staged rollouts, per-user channels, and download metrics. None of those are wanted, and the manifest already *is* the decision procedure — a service would add a process to run, monitor, and secure in exchange for nothing the static file does not already do. The mandatory layer is the one piece of policy a backend is usually bought for, and it turned out to be a single field.

**macOS through electron-updater.** Rejected on a hard constraint rather than a preference: Squirrel.Mac refuses to stage an update for an unsigned app, so the code path would exist only to fail. Detecting the version and opening the download is the most an unsigned build can honestly offer.

**Plain HTTP on the server's IP address.** The original plan, abandoned on evidence: inbound TCP/80 is dropped at that host's firewall, so an IP-and-port-80 feed would time out on every check. The host answers on 443 with a certificate valid for the name that resolves to it, so TLS was both the working option and the stronger one — it authenticates the server, which HTTP cannot.

**Installing on quit (`autoInstallOnAppQuit`).** Tempting, because it removes the last click and the update lands while the user is not waiting. Rejected because it makes the app replace itself at a moment nobody chose and nobody is watching: a quit is not consent to an install, and a failure then has no surface to report to. The cost is that a downloaded update can sit uninstalled indefinitely; the two re-offers bound how invisible that can get.

**Keeping the scrolling boot log.** It is genuinely the better surface when a start fails, and losing it was the real cost of the redesign. The failure state buys it back by naming the log file and asking for it, which turns out to be what actually gets the output to a developer — a wall of text on screen gets screenshotted, not sent.

## Consequences

An installed Windows client updates itself in three explicit steps; an installed macOS client tells the user a new version exists and takes them to it. One `publish-update.ts` run serves both, and one `minimumVersion` field escalates either into a requirement without a release of the client.

The feed's security is honest but partial: TLS authenticates the *server* and the manifest's sha512 binds artifact to manifest, so nobody can tamper in transit — but the artifacts remain unsigned, so write access to `/var/www/dsh-updates` is write access to every client's next installer, and neither operating system will vouch for what is downloaded. Code signing (Authenticode, and Developer ID with notarization) is the upgrade that closes it, and is also the thing that would let macOS install in place instead of handing off.

`minimumVersion` is a lock the publisher holds and clients obey. A line set above a version people can actually reach would brick every install, which is why the publish script refuses to write one above the version it is publishing — but nothing stops a wrong line from being published against an artifact that fails to install, so it stays a deliberate, rarely used act.

The channel adds `electron-updater` and `js-yaml` as the desktop app's production dependencies, which must land inside `app.asar` for the Windows path to work at all — hence the asar check in the release routine. Feed URLs now appear in both `electron-builder.yml` (which generates the manifests) and `src/updater.ts` (which reads them at runtime); moving the feed means changing both, and the README records that pairing.
