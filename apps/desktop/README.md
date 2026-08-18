# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

Desktop client: an Electron shell whose main process starts the embedded `dsh web` server — the pnpm-deployed closure of [apps/desktop-server](../desktop-server/README.md) running on a bundled real Node runtime (never Electron's own Node, so the server keeps the tested engines line, `node:sqlite`, and the stock N-API prebuilds) — waits for the `dsh web:` URL line, and opens the served UI in a native window. The window is a plain browser surface: no preload, no Node integration; external links open in the system browser. Quitting tears the server process tree down (SIGTERM with a kill escalation; `taskkill /T` on Windows).

## Building installable packages

```sh
pnpm exec tsx apps/desktop/scripts/package.ts --mac        # zip + dmg (arm64), runnable on this machine
pnpm exec tsx apps/desktop/scripts/package.ts --win        # NSIS installer (x64), cross-packaged from macOS
```

Products land in `apps/desktop/dist-app/`. The pipeline stages the server by the python/sdk-runtime recipe (legacy hoisted `pnpm deploy`, restore hoists, materialize symlinks), prunes host-compiled native `build/` trees so loads go through the multi-platform prebuilds, fetches the win32-x64 members of platform-split optional dependencies the macOS install skipped, and stages the Node runtime per platform (`--skip-repo-build` / `--skip-deploy` reuse existing artifacts).

## Trust and signing

Builds are unsigned development artifacts: macOS Gatekeeper needs right-click-open (or `xattr -dr com.apple.quarantine`) on machines other than the builder's, and Windows SmartScreen shows its unknown-publisher prompt. The Windows package is cross-built and structurally verified only — smoke-test it on a real Windows machine before handing it to anyone.

## Server environment

The server starts in the user's home directory with the GUI-inherited environment plus the standard shell PATH entries (macOS GUI apps launch with launchd's minimal PATH). `DEEPSEEK_API_KEY` resolves through the normal credential chain (environment → managed store → `.env`), so a first run without a key still boots into the UI, where the models settings page can store one. Server output is appended to the app's log directory (`dsh-server.log`).

## Known Limitations and Deferred Work

- No auto-update: replacing the app is the update path (the same npm-release cadence as the CLI).
- Windows arm64 and Linux desktop targets are unbuilt; node-pty prebuilds cover win32-arm64, so the arm64 gap is packaging work only.
- A dev launch (`pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`) uses the checkout's built CLI and the PATH Node, not the staged resources.
