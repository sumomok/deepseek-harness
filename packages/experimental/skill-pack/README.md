---
description: "A skill that is also a directory of interface: the pack root's skill provider, which offers a pack only once every component plugin part its views place is registered, and publishes every pack's state and reason on one route; for the deployment that ships packs and the maintainers of that seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-skill-pack

English | [中文](README.zh.md)

## Summary

A skill pack is an ordinary skill directory — a `SKILL.md` with YAML frontmatter, and view files beside it — whose frontmatter `metadata` also states which component plugin parts its views place. This package is the skill provider for one directory of them. It reads the root, judges every pack against the parts a component plugin has actually registered, and contributes to `ctx.skills` only the packs whose every requirement is met.

Activation is whole-pack. A pack with one unmet requirement is offered to nobody: the model is never told the skill exists, no user-facing command lists it, and none of its views is offered. A pack whose page would be half-drawn is worse than a pack that is not there.

The state flips without a restart. The parts source notifies this package when a component plugin is mounted or withdrawn, and a watched pack root notifies it when a pack arrives or leaves; either one invalidates the skill catalog, and the next read sees the new answer.

## Table of Contents

- [Mount and configure](#mount-and-configure)
- [What a pack says about itself](#what-a-pack-says-about-itself)
- [Why this package is the provider](#why-this-package-is-the-provider)
- [Where the parts come from](#where-the-parts-come-from)
- [Reading what a deployment holds](#reading-what-a-deployment-holds)
- [Replacing a pack root](#replacing-a-pack-root)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="mount-and-configure"></a>
## Mount and configure

Mount the row beside `@deepseek-ai/dsh-skill`, and point the generic filesystem provider at the deployment's other skill roots rather than at this one.

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-experimental-skill-pack'
  config:
    root: /var/lib/dsh/packs
    platformVersion: 0.5.2
```

| Field | Default | Meaning |
|---|---|---|
| `root` | required | Absolute path of the pack root: one directory per pack. A root that does not exist holds no packs. |
| `platformVersion` | required | The console platform's own exact version, which a pack's `pack.platform` range is matched against. |
| `watch` | `true` | Whether the root is watched, so a pack arriving or leaving takes effect without a restart. |

A relative `root` and a `platformVersion` that is not an exact semantic version are refused when the row loads, because both would otherwise be discovered one pack at a time: a relative root reads whatever directory the process happens to be in, and an unreadable platform version satisfies no range, so every pack stating one would go quietly inactive.

<a id="what-a-pack-says-about-itself"></a>
## What a pack says about itself

A pack's manifest is the `metadata` object of its own frontmatter, which the skill registry's filesystem provider already passes through untouched, so a pack stays a valid skill wherever it is read.

```yaml
---
name: space-data-page
description: The deployment's layer table, with the questions it answers.
metadata:
  pack:
    version: 1.0.0
    platform: ">=0.5.0"
  requires:
    components:
      "@deepseek-ai/dsh-experimental-component-kit": ">=0.3.0"
    parts: [toy.crud]
  views: [views/space-layer.yml]
---
```

`pack.version` is the pack's own exact version and `pack.platform` an optional range over the platform's. `requires.components` maps a component plugin's package name to the range that package must satisfy, and `requires.parts` names the part ids that must exist in the component catalog. `views` lists the pack's own view files, each declaring an `id`, a `title`, a `spec` and a `params` block; a path leaving the pack directory is refused rather than followed.

The `metadata` object is read strictly: a key this manifest does not know refuses the pack. A misspelled `requires` is a requirement nobody stated, and a pack would then be offered without the parts it was written against.

Prereleases are compared by their release numbers. Every package in this workspace carries one, and a plain semver range excludes a prerelease whose numbers it otherwise covers, so a pack asking for `>=0.3.0` would be refused the `0.4.0-rc.1` plugin it was written against.

A spec and its params are carried through without being read. The component catalog owns what a spec may contain, and a second opinion here would be a second answer that can drift from the one a real call is judged by.

<a id="why-this-package-is-the-provider"></a>
## Why this package is the provider

`ctx.skills` merges what its providers report. [`registerProvider`](../../skill/skill/src/index.ts) is the whole contribution contract, and the registry exposes no filter, veto or waterfall over another provider's catalog, so the only place a pack can be withheld is the provider that would otherwise have reported it. Listing a pack with both invocation flags false would hide it from the model and from commands, but it would still win its name in the merged catalog and shadow a same-named skill from another provider; a withheld pack is therefore not listed at all.

Withholding is enforced at the load as well as at the listing. The registry caches a completed catalog until something invalidates it, so a selection can outlive the state it was made in; a load re-reads the pack root and answers `undefined` unless the pack is still active.

<a id="where-the-parts-come-from"></a>
## Where the parts come from

The component surface is read through one optional service, `ctx.skillPackParts`, whose interface this package declares. It answers two questions — which parts exist, and whether one view file can be drawn — because both come from one catalog and change together: a deployment that could mount the part list without the judgement would have a state where a pack's parts are known and its views are unjudged, and the pack would be offered with a view nobody can draw.

```ts type-equiv
/**
 * The component surface, as a pack's requirements read it: `ctx.skillPackParts`.
 *
 * Both questions come from one catalog and change together, so they are one
 * key: a deployment that could mount the part list without the judgement would
 * have a state where a pack's parts are known and its views are unjudged, and
 * the pack would be offered with a view nobody can draw — which is the state
 * this package exists to prevent.
 *
 * This package declares the key and consumes it; the row that implements it
 * over the real component catalog is separate wiring. Until a provider of the
 * key is mounted every pack sees an empty part list, so a pack that requires
 * any part stays inactive.
 */
interface PartsSource {
  /**
   * The parts registered right now.
   * @returns every registered part, in no guaranteed order.
   */
  list(): readonly ProvidedPart[]
  /**
   * Observe registrations and withdrawals.
   * @param listener - called after the registered set changes; it reads {@link PartsSource.list} for the new set.
   * @returns the disposer that stops the notifications.
   */
  onChange(listener: () => void): () => void
  /**
   * Judge one view file against the surface that would draw it.
   *
   * The judgement is the component surface's own, so a view a pack ships and a
   * block the model places are accepted on identical terms. This package reads
   * neither the spec nor the params it hands over.
   * @param view - the parsed view file.
   * @param claimed - view ids already taken by the deployment's own
   *   configuration or by a pack judged before this one; a view repeating one
   *   is refused, because two views under one id is one menu row whose owner is
   *   decided by load order.
   * @returns the refusal, or `undefined` when the view can be drawn here.
   */
  judgeView(view: PackView, claimed: readonly string[]): PackViewRefusal | undefined
}
```

A composition with no provider of that key sees an empty part list, which is the correct answer rather than a degraded one: a pack that names a part nothing has registered cannot draw its page, so it stays inactive. [`skill-pack-components`](../skill-pack-components/README.md) is the row that implements the interface over the real component catalog; nothing here reaches into that package.

<a id="reading-what-a-deployment-holds"></a>
## Reading what a deployment holds

`ctx.skillPacks` answers two questions, and `GET /skill-pack/status` answers the first over HTTP as `{ "packs": [...] }`.

| Read | Answers |
|---|---|
| `statuses()` | Every pack in the root, active and inactive alike, in skill-name order, each with its version and every unmet requirement. |
| `activeViews()` | Each active pack's declared views, carrying the pack that declared them. An inactive pack contributes none, including views that read cleanly. |

An unmet requirement names the value that was refused: `manifest-invalid` with the field, `platform-version` and `plugin-version` with both versions, `plugin-absent` and `part-absent` with the name, `view-unreadable` with the file, and `view-refused` with the file, the value inside it and the component surface's own sentence about that value. The union is closed, so a consumer switches on the tag and ends in `assertNever`.

Packs are judged in skill-name order, and an active pack claims its view ids for the packs judged after it: two packs offering one view id is one menu row whose owner would otherwise be decided by load order, so the later pack is withheld. A pack that is inactive for another reason claims nothing.

The route exists because a withheld pack is invisible everywhere else by design, and a deployment that installed a pack and cannot find it would otherwise have nothing to read. It carries names, versions and refusal reasons only — no file contents, no paths inside a pack, no configuration — and it answers with no caching, because a pack's state flips with the plugins around it.

Every withheld pack is also stated once in the process log, and again only when that report changes. Its level says whether anyone has to act: a report naming a refused view is written at **error**, and every other report at **info**. A pack waiting for a plugin, a part or a version activates by itself the moment that row is composed, and a deployment part-way through installing one has nothing to fix; a pack whose view was judged and refused never activates, whatever else arrives, until somebody edits the view file or retires the pack.

<a id="replacing-a-pack-root"></a>
## Replacing a pack root

`syncPackRoot(targetRoot, delivery)` makes a pack root hold exactly the delivered packs. It is a replacement rather than a merge: a pack retired upstream is gone, and so is one somebody dropped into the root by hand, so the root always says what the delivery says. Running the same delivery twice writes nothing the second time — the call compares the root against the delivered set first and returns unchanged when every pack, path and byte already matches.

Nothing is written into the live root. The delivered set is staged into a sibling directory, verified there, and swapped in by rename, so a failure part-way through leaves the root exactly as it was.

A pack carries `.md`, `.yml`, `.yaml`, and `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` pictures. Every other extension is refused by name with a `PackInstallError`, as are symbolic links and any path leaving its pack directory. A pack root is a directory a delivery writes into; a pack that could carry an executable file would be an install path for one. `.svg` is refused with the rest, because an SVG document can carry script.

There is no command-line entry point. This is a library function the delivery side calls.

## Model Experience

Indirectly, through `dsh-tool-skill`: an active pack appears in the merged skill catalog as an ordinary skill, and loading it returns its `SKILL.md` body. An inactive pack contributes nothing to any catalog or result, so the model is never told a skill exists that it could not use.

#### KV Cache effect

The skill registry's consumer owns the durable catalog message and its append-only replacements. A pack changing state invalidates that catalog, so the consumer appends a replacement rather than rewriting the prefix.

## Known Limitations and Deferred Work

- **A missing plugin is reported, never installed.** A pack that needs a component plugin the deployment does not have stays inactive until somebody installs it. Nothing here fetches or mounts a plugin: an install path that runs from pack data would be the code-install route the pack rules exist to close. The trigger for revisiting is a delivery side that ships plugin and pack together as one bundle.
- **One delivered set per deployment.** `root` is a single directory and `syncPackRoot` replaces all of it, so every user of a deployment sees the same packs. Per-user sets would need an identity this package does not have; the trigger is the multi-user decision.
- **Two packs may claim one skill name.** Both are reported by `statuses()`, and the skill registry resolves the duplicate by its own rank and order rules, silently. There is no refusal and no report naming the shadowed pack.
- **A pack's views are judged by whoever provides the parts, and unjudged where nobody does.** Without a provider of `ctx.skillPackParts` a view that parsed is carried through, because nothing could draw it either way; the pack is then offered with views no surface has seen. It is the same fail-closed position the part list is in, one step further along.
- **Every read re-reads the root.** `statuses()`, `activeViews()` and each provider call scan the pack root and re-parse every manifest. That keeps the answer current with no cache to go stale, and it is why the status route is not for polling at interactive rates.
- **A pack root with no parts provider offers nothing with a view.** Until a provider of `ctx.skillPackParts` is mounted, every pack naming a part is inactive. That is the correct fail-closed state and an easy one to mistake for a bug, which is what the status route is for. [`skill-pack-components`](../skill-pack-components/README.md) is the provider a deployment composes.
- **Not covered by an assembled snapshot** — the package is exercised by its own specs, including a real Loader composition over a real pack root; the snapshot lanes replay the shipped composition, which composes no experimental row.

**Runtime invariant:** No companion is published. This package keeps no mutable state that an independent observation could contradict: every read is computed from the pack root and the parts source at the moment of the call, and the one retained value is the last withheld-pack report, which exists so an unchanged report is not logged twice.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `examples/space-data-page` directory is a pack shaped the way a delivery would ship one. Its `SKILL.md` body is a placeholder: pack instructions are written by whoever owns the pack, not by this package.

</details>
