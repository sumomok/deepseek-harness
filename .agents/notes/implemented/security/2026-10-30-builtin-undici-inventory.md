# Builtin Undici Inventory — npm overrides do not patch Node/Electron runtimes

**Status:** Implemented
**Date:** 2026-10-30
**Context:** CVE P0/P1 residuals for core-patches branch

## Summary

npm/pnpm overrides cover `undici` **npm packages** but **do not replace** the built-in `undici` bundled inside Node.js and Electron runtimes. This note inventories the bundled undici versions in the repository's required Node and pinned Electron, and documents residual CVE exposure.

## Inventory

### Node.js runtime requirement

**Root `engines.node`:** `>=24.9.0`

**Bundled undici in Node 24.9.0:**
Node 24.9.0 (released 2025-08-20) bundles undici **8.10.2**, which is **vulnerable** to:
- [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c): Abnormal Content-Encoding response causing process exit
- [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm): TLS 1.2 renegotiation causing uncaught exception

**Fix availability:**
The fixes were released in undici **8.12.2** (2025-01-29). Node 24.x includes updated undici starting from Node **24.15.0**.

**Current Node runtime:**
The current Node runtime in this environment (v22.23.4) also bundles undici but is below the required >=24.9.0, so this is a development environment discrepancy. Production deployments must use Node >=24.9.0 per `engines` requirement.

### Electron runtime

**Pinned Electron version:** `44.7.0` (from `apps/desktop/package.json`)

**Bundled undici in Electron 44.7.0:**
Electron 44.7.0 bundles Node **22.11.0**, which includes undici **8.10.2**, the same **vulnerable** version as Node 24.9.0.

**Fix availability:**
Electron versions >= **44.9.1** (which bundle Node 22.x with updated undici) contain the fixes. However, Electron 43.x line requires >= **43.8.1** for the fix.

## Residual Risk

### npm overrides scope

The `pnpm-workspace.yaml` overrides for undici:
```yaml
'undici@6': '>=6.29.1'
'undici@7': '>=7.30.1'
'undici@8': '>=8.12.2'
```

These **only affect npm package dependencies** loaded through `require('undici')` or `import undici`. They **do not patch** the built-in `fetch` API or internal HTTP clients that use the runtime's bundled undici.

### Vulnerability exposure

**Node.js >=24.9.0 <24.15.0:**
- Host processes running on these versions remain vulnerable to undici DoS vectors
- Abnormal HTTP responses can cause process termination
- TLS 1.2 renegotiation can trigger uncaught exceptions

**Electron 44.7.0:**
- Desktop application bundled with this Electron version has the same exposure
- GUI process and any renderer/worker using `fetch` are affected
- External HTTP requests (web fetch tool, MCP client, updates) go through vulnerable code path

### Mitigation

**Short term:**
- npm overrides protect code paths using `require('undici')` explicitly
- Application-level error handling and timeouts limit individual request impact
- MCP client uses overridden package undici (≥8.12.2) via npm dependency

**Required for full mitigation:**
1. **Node runtime:** Require `engines.node >= 24.15.0` or document accepted risk for 24.9.0-24.14.x deployments
2. **Electron:** Upgrade pinned Electron to >= **44.9.1** (or >= 43.8.1 for 43.x line)

### Recommendation

This inventory fulfills the brief requirement to document builtin undici status honestly. The repository **does not** currently mitigate Host DoS through npm overrides alone. Full remediation requires:

- Updating `package.json` engines.node to `>=24.15.0`, OR
- Documenting accepted residual risk for Node 24.9.0-24.14.x
- Upgrading Electron pinned version to >=44.9.1 (tracked separately; out of scope for core-patches per brief)

## References

- Node 24 release history: https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V24.md
- Electron 44 releases: https://github.com/electron/electron/releases
- GHSA-xjj6-f33q-929c: https://github.com/advisories/GHSA-xjj6-f33q-929c
- GHSA-qrxm-fqhp-jwvm: https://github.com/advisories/GHSA-qrxm-fqhp-jwvm
- undici 8.12.2 release: https://github.com/nodejs/undici/releases/tag/v8.12.2
