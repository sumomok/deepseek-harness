# Agent Note: Builtin Undici inventory for desktop runtimes

Status: implemented

English | [中文](2026-10-30-builtin-undici-inventory.zh.md)

## Problem

npm/pnpm overrides cover `undici` **npm packages** but **do not replace** the built-in `undici` bundled inside Node.js and Electron. Earlier inventories named runtime versions that do not match the current lockfiles, and no packaging check executed the shipped binary to read its `process.versions`. The repository needed one current inventory and a packaging gate that rejects runtimes below the patched Undici lines.

## Decision

This repository builds these carriers with these bundled versions:

| Carrier | Locked release | Bundled Node | Bundled Undici | Basis |
|---|---|---|---|---|
| npm `undici` | 8.12.2 in `pnpm-lock.yaml` | — | 8.12.2 | Lockfile and `pnpm-workspace.yaml` overrides; covers npm copies only. |
| Shell Electron | 43.8.6 (`apps/desktop-shell/package.json`) | 24.22.1 | 7.30.1 | Electron `DEPS` source; Linux x64 binary executed. Target-platform binaries were not executed here. |
| Desktop Electron | 44.10.0 (`apps/desktop/package.json`, `^44.10.0`) | 24.22.1 | 7.30.1 | Electron `DEPS` source; Linux x64 binary executed. Target-platform binaries were not executed here. |
| Shell Windows Host | 24.22.1 | 24.22.1 | 7.30.1 | Official `node.exe` SHA-256 and Node source; native Windows probe pending. |
| Shell macOS Host | Build host Node, 24.22.1 recommended | 24.22.1 | 7.30.1 | The copied binary is executed during packaging; any other host must pass the gate. |
| Primary runtime | 24.22.1 (`scripts/primary-runtime/lock.json`) | 24.22.1 | 7.30.1 | Lockfile and official archive hashes; Linux x64 extracted and executed. Other target execution pending. |

The npm copy tracks `undici` 8.12.2; the Node and Electron runtimes bundle the 7.x line. A package override cannot move the second number.

`scripts/runtime-version-gate.mjs` executes the actual binary in Node mode and reads `process.versions`, including `electron`, `node`, and `undici`. The accepted minimums are 6.29.1 for 6.x, 7.30.1 for 7.x, and 8.12.2 for 8.x. A missing `process.versions.undici`, an unparsable version, or an unknown major rejects the runtime, and the rejection stops packaging.

The gate runs from the shell's `stageRuntime` and `after-pack.cjs`, the desktop's `prepare-runtime.ts` and `smoke-packaged-runtime.ts`, and the shared primary-runtime smoke. A Windows package cross-built on macOS cannot execute its `node.exe` or Electron binary on the build host: packaging verifies the official Node SHA-256 and records the native probe as pending. Native Windows and macOS package acceptance therefore remain pending for this change; executing the Linux x64 Electron binaries is evidence for the versions, not for those packages.

The user-facing `engines.node` remains `>=24.9.0`. `docs/development.md` recommends Node 24.22.1 for desktop packaging and states that this recommendation does not raise the engine floor or require application users to install Node.js.

## Alternatives considered

**Raise the user-facing Node engine floor to 24.22.1.** Rejected for this batch because it changes the compatibility promise of the CLI, Python SDK and every launch carrier, while packaged applications ship their own runtime. The packaging gate applies the security requirement to the builds this repository produces without narrowing user installations.

**Replace global `fetch`, `Request` and `Response` at startup.** Rejected because it would change response, redirect, cache, cookie and byte semantics across unrelated call sites and cannot be validated as a general transport migration in this change. The gate proves the runtime instead of rewriting every consumer.

**Force TLS 1.3 globally.** Rejected because it can break servers that only offer TLS 1.2 and does not address the Content-Encoding advisory. The fixed upstream runtime is the supported remedy.

**Build Node or Electron locally, or patch the Electron archive.** Rejected: this repository consumes official release binaries. The shell pins Electron 43.8.6 and the other desktop requires `^44.10.0`; the primary-runtime lock pins Node 24.22.1.

## Consequences

- New packages built after this change execute their bundled Node and Electron binaries and fail packaging when Undici is below the patched line, when `process.versions.undici` is absent, or when its major is unverified.
- Previously installed packages, user-provided Node, and plugins that bring their own runtime remain outside the gate. `engines.node >=24.9.0` still admits runtimes whose bundled Undici predates the fixes.
- Shell `updater.ts`, `resumable-download.ts`, `notifications.ts`, the Host plugin-market, account, LLM and search-provider calls, and `apps/desktop/src/web-document.ts` still use the runtime's global `fetch`. The gate proves the runtime that executes them; it does not migrate those calls.
- The TLS 1.2 renegotiation advisory ([GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm)) and the Content-Encoding advisory ([GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)) are addressed by the upstream fixed release, not by a local dynamic reproduction in this batch.
- Cross-built Windows packages verify the official `node.exe` digest and defer both native probes; a macOS package cross-built elsewhere cannot be accepted without its native build and smoke.

## Testing

- `vitest run scripts/runtime-version-gate.spec.ts scripts/primary-runtime/prepare.spec.ts` covers the patched minimums, missing and unknown versions, actual-binary probing, hash verification, and the packaging rejection path.
- The Linux x64 Electron 43.8.6 and 44.10.0 binaries report Node 24.22.1 and Undici 7.30.1; the extracted Node 24.22.1 primary-runtime binary reports the same Undici version.
- Native Windows and macOS package smokes, and execution of their target binaries, remain pending.

## References

- Runtime gate: [`scripts/runtime-version-gate.mjs`](../../../../scripts/runtime-version-gate.mjs)
- Node 24.22.1 Undici package: https://raw.githubusercontent.com/nodejs/node/v24.22.1/deps/undici/src/package.json
- Electron 43.8.6 DEPS: https://raw.githubusercontent.com/electron/electron/v43.8.6/DEPS
- Electron 44.10.0 DEPS: https://raw.githubusercontent.com/electron/electron/v44.10.0/DEPS
- GHSA-xjj6-f33q-929c: https://github.com/advisories/GHSA-xjj6-f33q-929c
- GHSA-qrxm-fqhp-jwvm: https://github.com/advisories/GHSA-qrxm-fqhp-jwvm
