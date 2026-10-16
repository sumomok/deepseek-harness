# Agent Note: Private apps are not release members

Status: implemented

English | [中文](2026-08-20-private-apps-are-not-release-members.zh.md)

## Problem

`scripts/check-workspace-constraints.ts` treats every `apps/*` directory that its release-member expression does not exclude as a package this repository publishes. Such a package must not be private, must set `publishConfig.access` to `public`, must point `repository` at its own directory, needs an entry in the app publication files policy, must carry the workspace version, and must not depend on an experimental package.

This line's `apps/` also holds four product applications that never reach npm: the Electron shell `apps/desktop-shell`, the dependency-only deploy root `apps/desktop-server` whose closure the shell embeds, the composition-layer bundle `apps/desktop-app`, and the installable phone client `apps/pwa`. Each declares `"private": true` and carries its own product version, so each failed every one of those rules.

## Decision

The gate names the four directories in `privateProductAppDirectories` and excludes them in the three places where it excludes upstream's own private repository tool, `apps/plugin-market-generator` (upstream Merge pull request #5633): the negative lookahead of `standardReleaseMemberDirectory`, the app publication files policy condition, and the shared-version check in `checkWorkspaceManifest`. Every other workspace check still applies to them.

The exclusion lives on `develop` only. The patch line and `product/server-console` hold no private app, and `.claude/core-patches.md` lists this change under the core-path changes that live only on `develop`. A new private app on this line needs its directory added to `privateProductAppDirectories`.

## Testing

`scripts/check-workspace-constraints.spec.ts` reads each of the four manifests, accepts it in its own directory, and expects the same manifest under another `apps/*` directory to fail the release-member, publication files policy, and root-version rules.

## Alternatives considered

**Classify an `apps/*` package by `"private": true`.** This was the earlier form of the decision, carried as the patch-line family `workspace-gate-private-apps`. Upstream's own case asserts that an unknown `apps/*` package stays a release member even when it is private, so the predicate contradicted upstream's rule and had to be reapplied against every sync of the gate; the family retired at `dsh-v0.2.1-alpha.4`.

**Exclude the four apps from the release-member rules but keep them in the experimental dependency isolation.** `checkExperimentalDependencyIsolation` reads release members only, so keeping them in scope would need a fourth edit to the gate. `apps/desktop-app` depends on `@deepseek-ai/dsh-tool-session-query` and `apps/desktop-server` on `@deepseek-ai/dsh-hook-protocol`, both under `packages/experimental/` since `dsh-v0.2.1-alpha.4`.

## Consequences

The four apps pass the gate in the same form upstream uses for its own private tool, and the gate's diff against upstream on this line is one named set and three conditions.

The experimental dependency isolation does not cover the four apps. A desktop payload that loses an experimental package it needs surfaces in the desktop packaging run, whose staged boot composes the shipped profile from the staged server closure.
