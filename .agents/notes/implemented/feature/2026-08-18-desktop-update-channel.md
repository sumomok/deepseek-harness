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

**Installing is never silent, including on quit.** `autoInstallOnAppQuit` is off and the teardown path is plain `server.stop()` → `app.exit(0)`; the app replaces itself only in the seconds after someone clicks 「重启安装」, at which point the embedded server's process tree comes down first — the installer replaces the directory that server runs out of. A declined install stays on disk and is offered again exactly twice more: on the next launch, where the cached download re-raises `update-downloaded`, and whenever the user asks from the menu. No badge, no timer, no second reminder.

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

### Where the feed lives

The server is the project's existing always-on host. Its nginx (custom prefix `/data/third_party/nginx`, built `--without-http_rewrite_module`, master not under systemd) gains exactly one `location /dsh-updates/` with an `alias`, appended to the TLS server block that already existed, and reloads with `nginx -s reload`. The feed carries no BasicAuth because electron-updater sends no credentials, and the directory holds nothing but this product's installers.

### The boot page shows phases, not output

The same change replaces the boot console. It used to live-tail every main-process preflight line and every byte the server printed, which is the correct diagnostic surface for the developer and the wrong one for the person waiting: it presents a wall of text as though it required reading, and its most common content — an ordinary slow first launch under antivirus scanning — looks like a fault in progress.

The page now shows three named phases (`校验运行环境`, `启动 dsh 服务`, `连接界面`) with the active one's elapsed seconds, and a slow-start line after eight seconds saying a first launch is scanned. On failure the active phase turns red, one summary line appears, and the log path is rendered as selectable text with the instruction to send that file. A blocked launch reuses the same hint line to say why it is holding. **The file sink is unchanged** — every byte still lands in `dsh-server.log`; it simply no longer reaches the screen. That is what keeps the diagnosis material intact while removing it from the waiting experience.

## Verification

The macOS build launches from the packaged `.app`, reaches its `dsh web:` line, and serves 200 at that URL, with no process left behind after quit. The Windows installer passes the NSIS CRC gate, `app-update.yml` is present in the packaged resources, and `app.asar` carries `node_modules/electron-updater`. The feed route was verified from the public internet against the real certificate chain before anything was published, and the pre-existing `/flood/` route was confirmed still answering `401` after the nginx reload.

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
