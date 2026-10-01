# Agent Note: The desktop ships upstream's voice input switched off

Status: implemented

English | [中文](2026-09-26-desktop-voice-input.zh.md)

## Problem

On dsh 0.1.7-rc.2 `@deepseek-ai/dsh` depends on `@deepseek-ai/dsh-experimental-voice-input-bundle`, one of upstream's `OPTIONAL_BUNDLES`, so the desktop server closure carries it. Its recognizer, `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice`, loads `sherpa-onnx-node`, which requires `../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node` by a relative path built from `os.platform()` and `os.arch()`, with `win` in place of `win32`.

The payload pipeline lost that member in three places. `bundle-closure.ts` deleted `sherpa-onnx-darwin-arm64` as unreferenced, because a relative path names no package, and the payload gate failed the macOS package. `stageWindowsVariants` fetched only optional dependencies whose names contain `win32-x64`, so it never fetched `sherpa-onnx-win-x64`, and it would have fetched `^1.13.8` by that literal string. The gate's `variantOf` did not read `win` as a platform, so it could not see the Windows member missing from the Windows payload or riding into the macOS one.

The page records with `getUserMedia` in the app window. The app window runs on Electron's default session, which had no permission handler, and Electron without one grants every permission to every frame. The macOS bundle declared no `NSMicrophoneUsageDescription`, and the hardened runtime had no `com.apple.security.device.audio-input` entitlement.

## Decision

**Voice input ships as upstream ships it: in the payload, switched off.** The desktop composition layer adds no row for it. A person switches it on in upstream's Plugins page. The first model download happens only when that person presses **Download and prepare** on the plugin details: about 239 MB of INT8 SenseVoice model, 0.3 MB of tokens, and 1.8 MB of Silero VAD, from `huggingface.co` or `hf-mirror.com`, into `$DSH_HOME/speech-to-text/sensevoice/models/`.

**Both platforms' members are named, and each payload keeps its own.** `NATIVE` in `apps/desktop-shell/scripts/bundle-closure.ts` names `sherpa-onnx-node`, `sherpa-onnx-win-x64`, and `sherpa-onnx-darwin-<arch>`. The top-level rule in `platform-dir-rules.ts` treats `sherpa-onnx-` as a platform-split family like `node-addon-require-builtin-`, keeps `sherpa-onnx-node` by name on both targets, and keeps only the target's own member. `namesWindowsX64` recognizes `win32-x64` and `win-x64`. `pinnedVariantVersion` pins a range to the single version of the sibling members the host installed, because the members are published together and a newer Windows member could pair with an older JavaScript entry; a range without one agreed sibling version fails the build. `payload-gate.ts` reads the segment `win` as the platform `win32`.

**Only the served UI in the app window may open the microphone.** `apps/desktop-shell/src/microphone-permissions.ts` ports upstream's `apps/desktop/src/microphone-permissions.ts`, comparing the requesting URL with the running server's origin where upstream checks its `dsh-app:` scheme. `media` is granted to the app window's main frame on that origin, for audio alone, and on macOS only after `systemPreferences.askForMediaAccess('microphone')` answers yes. Every other permission keeps Electron's default answer. The render and login windows run on partitions of their own that refuse everything. `electron-builder.yml` adds `NSMicrophoneUsageDescription`, and `build/entitlements.mac.plist` adds `com.apple.security.device.audio-input`.

## Alternatives considered

**Withhold the voice input bundle, as the payload withholds auto-review.** Rejected: the release owner chose to ship it in 0.1.0-rc.34, and the bundle, unlike auto-review, does not duplicate a desktop feature.

**Keep Electron's default permission answer and rely on the system prompt.** Rejected: that grants the microphone to any frame the conversation or content column embeds, from any origin, and leaves the macOS prompt to Chromium rather than asking before the page records.

**Fetch the newest version a range allows.** Rejected: it can pair a Windows binary with an older `sherpa-onnx-node`, and the macOS member would then be from a different release than the Windows one.

## Consequences

The macOS payload grows by about 34 MB and the Windows payload by about 23 MB, whether or not a person switches voice input on. A machine that reaches neither model source cannot use voice input.

The Windows payload is cross-built on macOS and checked for presence only. Whether `sherpa-onnx.node` loads its DLLs from `sherpa-onnx-win-x64` under the bundled Node runtime, and whether the Windows privacy setting for desktop-app microphone access is on, are known only after a recording on a real Windows machine. On macOS the packaging run also checks the member for presence only; loading it and the microphone prompt are checked on a real machine.

A later upstream package whose platform members use another spelling, or a relative require, needs the same three changes: `NATIVE`, the platform rule, and the gate's reading of its platform segment.

## Related

[Desktop payload and boot gate on the 0.1.7-rc.2 base](../process/2026-09-26-desktop-payload-on-the-rc2-base.md) owns the other closure decisions on the same base; [the desktop payload prune gate](../process/2026-08-20-desktop-payload-prune-gate.md) owns the gate checks; [plugin management on upstream](2026-09-26-desktop-plugin-management-on-upstream.md) owns the Plugins page the bundle is switched on from.
