# Agent Note: Installable client packages

Status: implemented

English | [中文](2026-08-18-installable-client-packages.zh.md)

## Problem

dsh ships two application forms — the CLI and the `dsh web` browser UI served from it — and two distribution channels, npm and PyPI. There is no installable client for the three everyday surfaces people expect of a GUI product: a Windows desktop app, a macOS desktop app, and a phone. All three must come from the composition layer alone: upstream packages, `apps/web`, and the frontend build stay untouched so the checkout keeps fast-forwarding.

## Decision

Three additive leaves cover the three surfaces, each riding an extension point the platform already had.

**Phone — `apps/pwa`.** A host-plane function plugin registers `/manifest.webmanifest`, `/sw.js`, and `/pwa/*` PNG icons as named webserver routes and injects missing head references through `webServer.tapIndex`. The manifest route shadows the frontend's minimal static manifest at the same URL, so the dist's existing `<link rel="manifest">` resolves to the full standalone manifest and the tap adds no duplicate link. The package declares `dsh.bundle`, so `dsh plugin --profile web add` activates it as a profile layer with no flags. LAN exposure stays opt-in: upstream's `--host 0.0.0.0` refusal is honored, and `overlay/lan.patch.yml` is the explicit patch that binds all interfaces, leaning on the web-app trust fence's LAN sampling.

**Desktop — `apps/desktop` + `apps/desktop-server`.** `apps/desktop-server` is a dependency-only deploy root (the python/sdk-runtime pattern) whose single dependency `@deepseek-ai/dsh` closes over the whole `dsh web` runtime including the frontend dist. `apps/desktop/scripts/package.ts` stages it with the build-exe recipe — legacy hoisted `pnpm deploy`, restore hoists, materialize symlinks — prunes host-compiled native `build/` trees so loads use the multi-platform N-API prebuilds (node-pty ships darwin/win32, koffi ships all), fetches win32-x64 members of platform-split optional dependencies the macOS install skipped, and bundles a real Node v24 runtime per platform. The Electron main process spawns that Node on the deployed `bin.js web --port 0`, treats the `dsh web:` line as readiness, opens the URL in a sandboxed no-preload window, and tears the process tree down on quit. electron-builder emits macOS zip+dmg (arm64) and a cross-packaged Windows NSIS x64 installer; `pnpm-workspace.yaml` gains `allowBuilds: electron` (and denies `electron-winstaller`).

## Verification

The PWA layer is verified against a live boot: routes serve the expected bodies, the injected head carries exactly one manifest link, and a real Chrome on `127.0.0.1` reports the service worker activated at scope `/` with the standalone manifest parsed. The macOS package is launched and exercised on the build machine. The Windows installer is cross-built and structurally verified only (win32-x64 prebuilds, injected optional variants, bundled node.exe) and needs a smoke test on real Windows before distribution.

## Alternatives considered

- **Tauri instead of Electron.** Smaller artifacts, but cross-building a Windows installer from macOS is not supported without a Windows machine, and the server must ship a Node runtime anyway — the shell's weight is not the payload's weight.
- **Electron-as-Node (`ELECTRON_RUN_AS_NODE`) instead of a bundled real Node.** Kills the second runtime download, but moves the server onto Electron's Node ABI and feature set: `node:sqlite` availability and every N-API prebuild assumption would need revalidation per Electron upgrade. The bundled v24 runtime keeps the server on the tested engines line.
- **A "connect to a server" shell with no embedded server.** Trivially cross-platform, but the product then requires a separately installed dsh to be useful, which is not an installable client.
- **Forking `apps/web` to add PWA files to the dist.** Rejected by the zero-upstream-change constraint; the webserver's index tap and named routes exist precisely so a composition layer can do this.
- **Capacitor/React Native phone apps.** The backend cannot run on the phone, so a native wrapper is still a remote client; it adds signing chains and mobile toolchains (absent on the build machine) for no capability the PWA lacks.

## Consequences

Three surfaces ship from composition alone, and the additions double as a live proof of the extension points: `dsh.bundle` auto-activation, profile plugin installs via `link:`, index taps, named routes, and the deploy-root staging recipe. The cost is carrying an Electron dependency (~110 MB dev download, unsigned ~200 MB artifacts), a pinned Node runtime version to bump alongside engines, and a Windows artifact that cannot be smoke-tested from this repo's macOS-only development loop. No session event, model-visible surface, or SDK projection changed, so snapshot surfaces are untouched. Signing, notarization, auto-update, store distribution, Windows arm64, and Linux desktop targets are deliberate non-goals recorded in the package READMEs.
