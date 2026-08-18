# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

Desktop client: an Electron shell whose main process starts the embedded `dsh web` server — the pnpm-deployed closure of [apps/desktop-server](../desktop-server/README.md) running on a bundled real Node runtime (never Electron's own Node, so the server keeps the tested engines line, `node:sqlite`, and the stock N-API prebuilds) — waits for the `dsh web:` URL line, and opens the served UI in a native window. The window is a plain browser surface: no preload, no Node integration; external links open in the system browser. Quitting tears the server process tree down (SIGTERM with a kill escalation; `taskkill /T` on Windows).

## Building installable packages

```sh
pnpm exec tsx apps/desktop/scripts/package.ts --mac        # zip + dmg (arm64), runnable on this machine
pnpm exec tsx apps/desktop/scripts/package.ts --win        # NSIS installer (x64), cross-packaged from macOS
```

Products land in `apps/desktop/dist-app/`. The pipeline stages the server by the python/sdk-runtime recipe (legacy hoisted `pnpm deploy`, restore hoists, materialize symlinks), prunes host-compiled native `build/` trees so loads go through the multi-platform prebuilds, fetches the win32-x64 members of platform-split optional dependencies the macOS install skipped, and stages the Node runtime per platform (`--skip-repo-build` / `--skip-deploy` reuse existing artifacts).

## Updates

Installed clients read a static feed — an electron-builder `generic` provider directory holding the manifests and the artifacts they name:

```
https://lhr.ink/dsh-updates/win/     latest.yml  + the NSIS installer + its blockmap
https://lhr.ink/dsh-updates/mac/     latest-mac.yml + the zipped app
```

There is no update service: the manifest *is* the decision procedure, so nginx serving a directory implements all of it. The feed URL lives in two places — `electron-builder.yml`, which generates the manifests and the packaged `app-update.yml`, and `src/updater.ts`, which reads them at runtime — so moving the feed means changing both. `channel: latest` is explicit on both ends; the default names the channel after the running version's prerelease tag, which would rename the channel at every stage of the release cycle.

**Windows installs in place, in three steps.** A silent check (15 s after launch, every four hours, and from **帮助 → 检查更新**) offers the download. Accepting downloads in the background behind a small progress window that can be closed without cancelling. The finished download offers the restart. **Installing is never silent, including on quit**: `autoInstallOnAppQuit` is off, and the app replaces itself only in the seconds after someone clicks 「重启安装」. A declined install stays on disk and is offered again on the next launch and from the menu — nowhere else.

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
```

The script refuses a `dist-app` that disagrees with `package.json`, re-verifies the installer's NSIS integrity CRC, and asserts the build supersedes what the feed serves. Uploads go **artifacts first, checksummed on both ends, manifests last**, so a client polling mid-publish reads the previous manifest naming the previous artifacts — never a manifest pointing at a file still uploading.

On the update host the feed is `/var/www/dsh-updates/{win,mac}`, served by a single appended `location /dsh-updates/` with an `alias`. That nginx has a custom prefix (`/data/third_party/nginx`), is built without the rewrite module, and its master is not under systemd — reload it with `nginx -s reload`, never `systemctl`. The directory carries no BasicAuth because electron-updater sends no credentials.

## Trust and signing

Builds are unsigned development artifacts: macOS Gatekeeper needs right-click-open (or `xattr -dr com.apple.quarantine`) on machines other than the builder's, and Windows SmartScreen shows its unknown-publisher prompt. The Windows package is cross-built and structurally verified only — smoke-test it on a real Windows machine before handing it to anyone.

This bounds what the update feed can promise. TLS authenticates the server and each manifest's sha512 binds artifact to manifest, so nothing can be tampered with in transit. The artifacts themselves are unsigned, so write access to `/var/www/dsh-updates` is write access to every client's next installer, and neither operating system will vouch for what arrives. Closing that gap means code signing — Authenticode on Windows, Developer ID plus notarization on macOS — which is also what would let macOS install in place instead of handing off.

## Server environment

The server starts in the user's home directory with the GUI-inherited environment plus the standard shell PATH entries (macOS GUI apps launch with launchd's minimal PATH). `DEEPSEEK_API_KEY` resolves through the normal credential chain (environment → managed store → `.env`), so a first run without a key still boots into the UI, where the models settings page can store one. Server output is appended to the app's log directory (`dsh-server.log`).

## Known Limitations and Deferred Work

- macOS cannot install an update in place: unsigned builds are outside what Squirrel.Mac will stage, so the client detects the new version and opens the download. Code signing is the prerequisite, not packaging work.
- Windows arm64 and Linux desktop targets are unbuilt; node-pty prebuilds cover win32-arm64, so the arm64 gap is packaging work only.
- A dev launch (`pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`) uses the checkout's built CLI and the PATH Node, not the staged resources.
