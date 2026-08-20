# Agent Note: Private apps are not release members

Status: implemented

English | [中文](2026-08-20-private-apps-are-not-release-members.zh.md)

## Problem

`scripts/check-workspace-constraints.ts` decides who publishes from the directory alone. `releaseMemberDirectory` matches every `apps/*` package, so each one must be non-private, set `publishConfig.access` to `public`, point `repository` at the published source with its own directory, and hold an entry in the `appPackageFiles` publication policy.

`apps/` also holds product assemblies that never reach npm: an Electron shell, the dependency-only deploy root whose closure that shell embeds, and a composition-layer bundle patched into a running `dsh web`. Each ships inside a client build, each declares `"private": true`, and each therefore failed all four release-member constraints at once.

Nothing outside the script could say otherwise. The gate reads manifests directly and encodes the release-member decision as a hardcoded regular expression, with no plugin seam, configuration file, or allowlist in front of it, so the category had to be taught to the gate itself.

## Decision

`apps/*` carries two kinds of package and `private` separates them. `isPrivateApp` classifies an `apps/*` manifest that declares `"private": true` as an in-tree app, and `checkWorkspace` then skips both the release-member metadata block and the published-app files policy for it. This follows the shape `packages/experimental/*` already has: a category that participates in every shared workspace check while sitting outside `releaseMemberDirectory`.

`private` is the discriminator rather than a nested directory or a name allowlist because it is also what stops `npm publish` from uploading the package. A manifest cannot claim in-tree status here and still reach a registry.

`checkPrivateAppManifest` states what the category owes in place of release metadata. A private app must omit `publishConfig`, mirroring the experimental rule. It must also stay out of `appPackageFiles`, which keeps that table authoritative over which apps publish: without the second rule, adding `"private": true` to `apps/cli` would silently drop the `dsh` CLI out of the release instead of failing the gate.

`checkExperimentalDependencyIsolation` keeps private apps in scope. A desktop build that requires an experimental package breaks a runtime real users install, whether or not npm ever sees the manifest.

## Testing

`scripts/check-workspace-constraints.spec.ts` pins the accepted in-tree manifest, the two rejected publication claims, and the two shapes the predicate must ignore — a published app under `apps/`, and a private package outside it.

## Alternatives considered

**Nest the in-tree apps under a new directory, such as `apps/private/*`.** Rejected because the directory depth is load-bearing in several places at once — `pnpm-workspace.yaml`, this script's own `workspaceGlobs`, and the knip workspace map all assume one level under `apps/` — and because these assemblies are peers of `apps/cli`, not a subordinate tier. A directory move would also rewrite paths that packaging configuration and a deploy root refer to by name.

**List the three package names in an allowlist constant inside the gate.** Rejected because the list would have to grow with every new in-tree app, each growth being another edit to a file this repository already patches against upstream. `private` is a fact the manifest states about itself, so no second registry has to agree with it.

**Skip the three directories in the gate's workspace walk.** Rejected because they would then lose the checks that do apply to them: forbidden publication payloads, the `workspace:` protocol for every workspace reference, and the version and dependency rules the rest of the walk enforces. Exemption from release metadata is not exemption from workspace hygiene.

**Give them release metadata they do not use and rely on `private` to stop the upload.** Rejected because it makes each manifest state two contradictory things, and because `appPackageFiles` would have to name a publication payload for a package that is never packed.

## Consequences

`apps/` now sorts into published members and in-tree apps by a single boolean, and the three fork-owned assemblies pass the gate without weakening what it asks of `apps/cli` and `apps/web`.

The cost is that `"private": true` in an `apps/*` manifest quietly changes which rules apply. The `appPackageFiles` cross-check catches the accident only for an app that already has a files policy; an app born private is indistinguishable from an in-tree one until someone tries to release it. That residue is accepted because a release the gate would have to protect against goes through packing and publishing steps that also read the manifest.

This is one of the few patches this repository carries against an upstream gate. It stays at one predicate, one exported check, and two guarded conditions so that re-applying it across an upstream sync remains a small, reviewable diff.
