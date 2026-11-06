# Agent Note: Private apps are not release members

Status: implemented

English | [中文](2026-08-20-private-apps-are-not-release-members.zh.md)

## Problem

`scripts/check-workspace-constraints.ts` treats every `apps/*` directory that its release-member expression does not exclude as a package this repository publishes. Such a package must not be private, must set `publishConfig.access` to `public`, must point `repository` at its own directory, needs an entry in the app publication files policy, must carry the workspace version, and must not depend on an experimental package.

This line's `apps/` also holds four product applications that never reach npm: the Electron shell `apps/desktop-shell`, the dependency-only deploy root `apps/desktop-server` whose closure the shell embeds, the composition-layer bundle `apps/desktop-app`, and the installable phone client `apps/pwa`. Each declares `"private": true` and carries its own product version, so each failed every one of those rules. `scripts/verify-default-product-isolation.ts` also roots the default `dsh` product at every `apps/*` package, and from `dsh-v0.2.1-alpha.4`, when `@deepseek-ai/dsh-tool-session-query` and `@deepseek-ai/dsh-hook-protocol` moved under `packages/experimental/`, it refused `apps/desktop-app` and `apps/desktop-server` for depending on them.

## Decision

`scripts/private-product-apps.ts` names the four directories in `PRIVATE_PRODUCT_APP_DIRECTORIES`. The workspace gate excludes them in the three places where it excludes upstream's own private repository tool, `apps/plugin-market-generator` (upstream Merge pull request #5633): the negative lookahead of `standardReleaseMemberDirectory`, the app publication files policy condition, and the shared-version check in `checkWorkspaceManifest`. Every other workspace check still applies to them. The default-product gate does not root the `dsh` product at them: the desktop ships `@deepseek-ai/dsh-tool-session-query` switched on as its own product choice.

The exclusion lives on `develop` only. The patch line and `product/server-console` hold no private app, and `.claude/core-patches.md` lists this change under the core-path changes that live only on `develop`. A new private app on this line needs its directory added to `PRIVATE_PRODUCT_APP_DIRECTORIES`.

## Testing

`scripts/check-workspace-constraints.spec.ts` reads each of the four manifests, accepts it in its own directory, and expects the same manifest under another `apps/*` directory to fail the release-member, publication files policy, and root-version rules. `scripts/verify-default-product-isolation.spec.ts` gives each of the four directories a manifest that depends on an experimental package, expects no failure, and expects the same manifest under another `apps/*` directory to fail.

## Alternatives considered

**Classify an `apps/*` package by `"private": true`.** This was the earlier form of the decision, carried as the patch-line family `workspace-gate-private-apps`. Upstream's own case asserts that an unknown `apps/*` package stays a release member even when it is private, so the predicate contradicted upstream's rule and had to be reapplied against every sync of the gate; the family retired at `dsh-v0.2.1-alpha.4`.

**Keep the desktop inside the experimental isolation by moving its session tools to the optional session-search bundle.** That bundle indexes into an in-memory database rebuilt at every launch, selecting it for existing profiles needs a migration, and the desktop snapshot lane would be rewritten; `apps/desktop-server`'s `@deepseek-ai/dsh-hook-protocol` dependency would still need the same exclusion or its own removal.

## Consequences

The four apps pass the workspace gate in the same form upstream uses for its own private tool and pass the default-product gate, and the diff against upstream on this line is one shared set, three conditions in the workspace gate, and one in the default-product gate.

Neither experimental isolation check covers the four apps. A desktop payload that loses an experimental package it needs surfaces in the desktop packaging run, whose staged boot composes the shipped profile from the staged server closure.
