# Agent Note: Builtin undici inventory — npm overrides do not patch Node or Electron runtimes

Status: implemented

English | [中文](2026-10-30-builtin-undici-inventory.zh.md)

## Problem

A pnpm override replaces the `undici` npm dependency, but Node.js and Electron embed their own copy of undici. A CVE fixed in the npm package can therefore stay reachable through the runtime's bundled copy even when every workspace manifest resolves a fixed version.

## Decision

Production runtimes must bundle a fixed undici copy: require Node.js `>=24.9.0` for the repository, use Node 24.15.0 or later for the bundled fixes, and require Electron `^44.9.1` in the Desktop app. The npm override keeps the package copy at `undici >=8.12.2` for each supported major.

## Verification

Check the override ranges in `pnpm-workspace.yaml` and the Electron requirement in `apps/desktop/package.json`. Bundled-runtime versions are environment facts, not lockfile facts: read `process.versions` and the runtime release notes instead of assuming the embedded copy matches the npm resolution. The advisories are [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) and [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm).

## Consequences

The npm override and the runtime requirements must move together: the override fixes the package copy, and the Node/Electron requirements decide the embedded copy. The exact embedded version stays a property of each runtime build, so verification reads it from the runtime instead of inferring it from the lockfile. A runtime older than the stated minimum reopens the advisory regardless of the npm resolution.

## Alternatives considered

Pinning only the npm `undici` dependency leaves the Node and Electron copies untouched, so it does not close the runtime path. Replacing the runtime's embedded copy or patching the runtime binary is not a supported deployment path for either runtime.
