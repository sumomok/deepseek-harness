---
description: "A skill that is also a directory of interface: the pack root's skill provider, which offers a pack only once every component plugin part its views place is registered, and publishes every pack's state and reason on one route; for the deployment that ships packs and the maintainers of that seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-skill-pack

English | [中文](README.zh.md)

## Summary

A skill pack is an ordinary skill directory — a `SKILL.md` with YAML frontmatter, and view files beside it — whose frontmatter `metadata` also states which component plugin parts its views place. This package is the skill provider for one directory of them. It reads the root, judges every pack against the parts a component plugin has actually registered, and contributes to `ctx.skills` only the packs whose every requirement is met. A deployment that configures an organization root also provides `ctx.skillPackIntake`, which installs and judges the packs an organization plugin hands over while that plugin reports their skills itself.

## Table of Contents

- [Mount and configure](#mount-and-configure)
- [What a pack says about itself](#what-a-pack-says-about-itself)
- [Why this package is the provider](#why-this-package-is-the-provider)
- [Where the parts come from](#where-the-parts-come-from)
- [Reading what a deployment holds](#reading-what-a-deployment-holds)
- [Replacing a pack root](#replacing-a-pack-root)
  - [What a delivery is checked for](#what-a-delivery-is-checked-for)
- [Installing from a packed file](#installing-from-a-packed-file)
- [Organization packs](#organization-packs)
  - [What the organization plugin hands over](#what-the-organization-plugin-hands-over)
  - [How a set is judged](#how-a-set-is-judged)
  - [How long a set is offered](#how-long-a-set-is-offered)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="mount-and-configure"></a>
## Mount and configure

Activation is whole-pack. A pack with one unmet requirement is offered to nobody: the model is never told the skill exists, no user-facing command lists it, and none of its views is offered. A pack whose page would be half-drawn is worse than a pack that is not there.

The state flips without a restart. The parts source notifies this package when a component plugin is mounted or withdrawn, and a watched pack root notifies it when a pack arrives or leaves; either one invalidates the skill catalog, and the next read sees the new answer.

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
| `deliveries.directory` | absent | Absolute path of the directory a delivery archive is copied into. Leave it out where a deployment installs its packs some other way. |
| `deliveries.maxArchiveBytes` | `33554432` | Largest archive that is read at all. |
| `deliveries.maxFileBytes` | `4194304` | Largest single file an archive may carry. |
| `deliveries.maxFiles` | `512` | Most entries an archive may carry, its manifest among them. |
| `organizationRoot` | absent | Absolute path of the organization root, one `<name>@<version>` directory per [organization entry](#organization-packs). Configured, the row provides `ctx.skillPackIntake`; absent, no organization pack is installed or offered. Give it a parent of its own: a replacement stages and retires sibling directories beside it. |
| `perMember` | `false` | Whether `GET /skill-pack/status` answers only a request `ctx.consoleMembers` places with a member. |

The three `deliveries` defaults are `DEFAULT_PACK_ARCHIVE_LIMITS`, which the package root exports so a delivery side can check a set against the limits a deployment applies when it configures none.

A watched root is re-read when the watch arms and again on every event it delivers. A pack that lands between the watcher's own first listing and its native stream starting is in neither, and without that first reading it would be offered only after the next unrelated change to the root.

A relative `root`, a relative `deliveries.directory`, and a `platformVersion` that is not an exact semantic version are refused when the row loads, because both would otherwise be discovered one pack at a time: a relative root reads whatever directory the process happens to be in, and an unreadable platform version satisfies no range, so every pack stating one would go quietly inactive. A relative `organizationRoot` is refused at load as well, and so are any two of `root`, `deliveries.directory` and `organizationRoot` that are one directory or lie one inside the other: the pack root and the organization root are each replaced whole, so replacing one would write into the other. Each of the three directories is resolved when the row loads — a trailing separator is removed, and `.` and `..` segments are resolved by path rules — and that resolved path is the one every write and every refusal names, so a replacement staged beside a directory never lands inside it. Two directories are compared as the file system reads them: the longest leading part of each path that exists is replaced by its real path, which follows every symbolic link along it, and on macOS and Windows names are also folded the way [two pack names are compared](#replacing-a-pack-root), because APFS and NTFS ignore letter case and APFS also ignores the normalization form. One fold serves both platforms, and it is wider than either file system's: a pair that differs only in normalization is refused on Windows too, where NTFS keeps the two apart, and so is a pair such as `ı` and `I`, which the fold makes one name and APFS keeps apart. A directory whose longest existing leading part is a symbolic link whose target does not exist, a link in a loop among them, is refused at load with an error naming the field, the resolved path and the link: the directory would be created wherever the link points, and comparing the link's own path would miss a target inside another of the three.

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
    viewFormat: 1
  requires:
    components:
      "@deepseek-ai/dsh-experimental-component-kit": ">=0.3.0"
    parts: [toy.data-page]
  views: [views/space-layer.yml]
---
```

`pack.version` is the pack's own exact version and `pack.platform` an optional range over the platform's. `requires.components` maps a component plugin's package name to the range that package must satisfy, and `requires.parts` names the part ids that must exist in the component catalog. `views` lists the pack's own view files, each declaring an `id`, a `title`, a `spec` and a `params` block; a path leaving the pack directory is refused rather than followed. The package root exports both lists: `PACK_MANIFEST_FIELDS` holds every key a manifest may state, read off the schema the manifest is parsed with, and `PACK_VIEW_FIELDS` the four keys a view file is read for. Each entry says whether the key is required and gives a `summary` of what its value must be; a manifest field's summary is the description its schema carries. It also exports `PACK_MANIFEST_KEY`, the frontmatter key `metadata` that the manifest is read under and that every refused manifest field is named from. A manifest key outside its list refuses the manifest; a view-file key outside its list is ignored.

`pack.viewFormat` is the version of the view-file format those files are written in, stated once for the whole pack. A pack that declares views states it, and a pack that declares none has nothing for it to govern and may leave it out. This build reads format `1`; a pack stating anything else, or a pack declaring views and stating nothing, is withheld with `view-format` naming both numbers, and a delivery carrying one is refused. The version is per pack rather than per file because every view file of a pack ships together and a pack is offered whole.

`pack.anchorFormat` is the version of the anchor-file format a pack exported with element anchors is written in. A pack that states none carries no anchors and is read by every build. This build reads format `1`, which is what `PACK_ANCHOR_FORMATS` holds; a pack stating anything else is withheld with `anchor-format` naming both numbers, and a delivery carrying one is refused. Nothing here reads the anchor file — the pack's own instructions tell the model how to read it — so the stated number is the whole check, and no part, plugin or row arriving later changes the answer. The list is a constant rather than a configuration field because it states which anchor lines the point-anchor package built alongside this build writes, not a choice that varies between deployments. A format number is only ever added to it; dropping one is a breaking change for every pack that states it.

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
   *
   * A view id the deployment's own configuration already claims is refused
   * here, because the deployment's views own their ids. Two packs claiming one
   * id is settled by this package instead: two packs of the pack root are both
   * withheld, and an offered organization pack keeps the id against the pack
   * root.
   * @param view - the parsed view file.
   * @returns the refusal, or `undefined` when the view can be drawn here.
   */
  judgeView(view: PackView): PackViewRefusal | undefined
}
```

A composition with no provider of that key sees an empty part list, which is the correct answer rather than a degraded one: a pack that names a part nothing has registered cannot draw its page, so it stays inactive. [`skill-pack-components`](../skill-pack-components/README.md) is the row that implements the interface over the real component catalog; nothing here reaches into that package.

<a id="reading-what-a-deployment-holds"></a>
## Reading what a deployment holds

`ctx.skillPacks` answers two questions, and `GET /skill-pack/status` answers the first over HTTP as `{ "packs": [...] }`, adding [`lastDelivery`](#the-directory-a-delivery-arrives-in) where a delivery directory is configured and a read of it has found an archive since the process started.

| Read | Answers |
|---|---|
| `statuses()` | Every pack in the root in skill-name order, then every entry of the offered organization set in `name@version` order, active and inactive alike, each with its versions and every unmet requirement. |
| `activeViews()` | Each active pack's declared views, the root's and then the organization set's, carrying the pack that declared them. An inactive pack contributes none, including views that read cleanly. |

Each status carries `origin`: `pack-root`, or `organization` for an entry of the offered organization set, which also carries `entryVersion` — its organization manifest entry's version, which keys it together with the skill name — and `channel`, `stable` or `trial`. `version` is always the pack's own `metadata.pack.version`, and nothing compares it with `entryVersion`. No trial identifier is published: which member is in which trial is the organization plugin's to know.

An unmet requirement names the value that was refused: `manifest-invalid` with the field, `platform-version` and `plugin-version` with both versions, `plugin-absent` and `part-absent` with the name, `anchor-format` and `view-format` with the version the pack stated and the versions this build reads, `view-unreadable` with the file, `view-refused` with the file, the value inside it and the component surface's own sentence about that value, and `view-id-conflict` with the id, the other pack claiming it and where that pack is installed. A view whose judgement throws is `view-refused` at `spec`, with the thrown value in the sentence, so one file withholds its own pack and every other view and pack is judged as usual. The union is closed, so a consumer switches on the tag and ends in `assertNever`.

Two packs this root would otherwise offer that declare one view id are **both** withheld, each naming the id and the other pack. One menu row cannot have two owners, and keeping the id for the first of them would make what a deployment offers depend on the order its packs happened to be read in. A pack that is inactive for another reason claims nothing, so a pack nobody is offered cannot withhold one that would be; an id the deployment's own configuration claims is refused earlier, by the component surface, because the deployment's views own their ids.

An active organization entry keeps a view id against the pack root: a pack of the root declaring it is withheld with `view-id-conflict` naming the organization pack, whatever order anything was read in, because the organization set is the source a deployment chooses for a pack delivered both ways. An organization entry that is inactive holds no id.

Order is by code unit, not by `localeCompare`: the skill-name order of `statuses()`, the directory-name order a pack root is scanned in, and the path order an archive is written in are all the same on every host, whatever ICU data and default locale it has.

The route exists because a withheld pack is invisible everywhere else by design, and a deployment that installed a pack and cannot find it would otherwise have nothing to read. It carries names, versions, where each pack is installed, an organization entry's channel, refusal reasons and the last delivery only — no file contents, no paths inside a pack, no configuration — and it answers with no caching, because a pack's state flips with the plugins around it. A delivery refusal's reason names the archive entry it refused, and writes the pack root, the directories above it and the delivery directory by placeholder, as [its `reason` field](#the-directory-a-delivery-arrives-in) states.

With `perMember`, the route answers only a request `ctx.consoleMembers` places with a member: 503 while no such service runs, and 401 when it places the request with nobody. Every placed member reads the same document. Once the composition has loaded, a `perMember` setting that disagrees with whether a member directory runs is logged at error: a per-member row with no directory answers every request 503, and a row without `perMember` beside a running directory answers anyone who reaches the route.

Every withheld pack is also stated once in the process log, and again only when that report changes. Its level says whether anyone has to act: a report naming a refused view is written at **error**, and every other report at **info**. A pack waiting for a plugin, a part or a version activates by itself the moment that row is composed, and a deployment part-way through installing one has nothing to fix; a pack whose view was judged and refused never activates, whatever else arrives, until somebody edits the view file or retires the pack.

<a id="replacing-a-pack-root"></a>
## Replacing a pack root

`syncPackRoot(targetRoot, delivery)` makes a pack root hold exactly the delivered packs. A delivery is a source directory, the packs themselves, or [one archive file](#installing-from-a-packed-file); the three differ only in how the set is read. It is a replacement rather than a merge: a pack retired upstream is gone, and so is one somebody dropped into the root by hand, so the root always says what the delivery says. Running the same delivery twice writes nothing the second time — the call compares the root against the delivered set first and returns unchanged when every pack, path and byte already matches.

Nothing is written into the live root. The delivered set is staged into a sibling directory, verified there, and swapped in by rename, so a failure part-way through leaves the root exactly as it was. A root that does not exist is a first install, and so is a root that is a symbolic link to a path that does not exist; a call that writes replaces that link with a real directory. The row refuses such a link as its configured `root` at load, as [Mount and configure](#mount-and-configure) states, so a root reaches this case when it is handed to `syncPackRoot` directly or when its link target is removed after the row loads. A root that cannot be read for any other reason rejects the call with that error before anything is staged: what it holds is unknown, and replacing it as an empty root would retire every pack in it.

A pack carries `.md`, `.yml`, `.yaml`, and `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` pictures, the list the package root exports as `PACK_FILE_EXTENSIONS`. Every other extension is refused by name with a `PackInstallError`, as are symbolic links and any path leaving its pack directory. A pack root is a directory a delivery writes into; a pack that could carry an executable file would be an install path for one. `.svg` is refused with the rest, because an SVG document can carry script. Two pack names of one delivery, or two paths of one pack, are one name when they are equal after Unicode NFC, lower case, upper case, lower case again and NFC again, and the second of them is refused as `duplicate-entry`. That fold makes one name of every pair APFS reads as one, `ß` and `ss`, `σ` and `ς`, `µ` and `μ` among them, and also of a few pairs that file systems keep apart, such as `ı` and `I`, because refusing such a pair costs less than writing two names into one directory. The later of two paths is refused as `duplicate-entry` too when one pack uses a path both as a file and, under the same fold, as the directory of another path, such as `notes/x.md` beside `notes/X.md/y.md`. A pack name, and each segment of a pack file path, is also refused as `path-escape` in two cases: when it holds a lone UTF-16 surrogate, which Node writes as U+FFFD, so two such names would land in one entry; and when it is over 255 bytes of UTF-8, the most ext4 holds in one name, while APFS and NTFS count a name in UTF-16 code units and hold longer ones. These two are the only checks this package makes on whether a file system can hold a name. A name the file system refuses for another reason, such as one holding a code point to which Unicode assigns no character (APFS refuses it with `EILSEQ` or `ENOENT`), or a path longer than the platform's `PATH_MAX`, fails the write itself: the delivery is rejected with the file system's error rather than a `PackInstallError`, and the root stays as it was.

There is no command-line entry point. This is a library function the delivery side calls, and the delivery directory below is the one place this row calls it by itself.

<a id="what-a-delivery-is-checked-for"></a>
### What a delivery is checked for

The staged tree is read as a pack root before it becomes one, and a delivery failing any of it is refused **whole** — nothing is written, and the old root stays byte-identical. A pack root that installed a broken view would only say so on the status route, long after the operator who copied the file has gone.

| Refusal | What it refused |
|---|---|
| `pack-manifest` | a delivered pack whose `metadata` object is not a manifest |
| `pack-anchor-format` | a delivered pack stating an anchor format this build does not read |
| `pack-view-format` | a delivered pack declaring views in a view format this build does not read, or stating none |
| `pack-view` | a view file a delivered pack declares and does not carry, or carries and is not a view |
| `pack-view-refused` | a view the component surface this deployment composes will not draw |

**A requirement this deployment does not meet yet is not a refusal.** A pack naming a plugin, a part or a platform version that is not here installs, reconciles inactive, says on the status route what it is waiting for, and activates by itself the moment that row is composed — which is the whole point of a delivery that arrives before its plugin. Only a view that is malformed, or one the composed surface refuses for a pack whose other requirements are **already met**, refuses the install.

The component-catalog judgement is a parameter rather than an import. `syncPackRoot(root, delivery, verify)` takes the caller's own surface; [`SkillPackRegistry`](#the-directory-a-delivery-arrives-in) passes the one it reads through `ctx.skillPackParts`, and a delivery-side caller that composes no surface passes nothing. Without one, the checks above still run and the catalog's judgement is deferred to reconciliation, exactly as it is for a pack somebody wrote into the root by hand.

`buildPackArchive` holds a set to the rules about a pack's *files* — its name, its paths, its extensions. It does not read what those files say: a manifest, a view format and a view file are judged by the deployment that installs them, which is the side that has the surface those views are drawn on.

<a id="installing-from-a-packed-file"></a>
## Installing from a packed file

A delivery console hands a deployment one file, and the deployment installs it with one action. `buildPackArchive(source, set)` writes that file from a source directory or from the packs themselves, and `syncPackRoot(root, { kind: 'archive', name, bytes, limits })` installs it.

An archive is a ZIP named `*.dshpack`. It carries `pack-delivery.json` at its root and every pack file under `packs/<pack>/`, and the manifest is what it is read by.

```json
{
  "format": 1,
  "set": { "id": "space-console", "version": "2026.9.19" },
  "files": [
    { "path": "space-data-page/SKILL.md", "sha256": "e3b0c442…" },
    { "path": "space-data-page/views/space-layer.yml", "sha256": "9f86d081…" }
  ]
}
```

All of it is verified before a single byte is staged, and an archive that fails any part of it installs nothing. Every refusal is a `PackInstallError` naming the entry it is about.

| Refusal | What it refused |
|---|---|
| `archive-unreadable` | the bytes are not an archive this deployment can read |
| `archive-format` | the manifest states a format version this build does not know |
| `archive-manifest` | the archive carries no manifest, or the manifest field that is not one |
| `archive-entry` | an entry the manifest does not declare, or a file the manifest declares and the archive does not carry |
| `archive-digest` | a file whose bytes are not the ones the manifest states |
| `archive-oversize` | the archive, one file, or the entry count, over the limit it is read under |
| `duplicate-entry` | a pack, a path inside a pack, or an entry name, delivered twice; two pack names, or two paths of one pack, that [fold to one name](#replacing-a-pack-root) count as one, and a path one pack uses both as a file and as the directory of another counts as delivered twice |

The pack rules apply to an archive exactly as they do to a directory: `code-file`, `path-escape`, `symlink` and `not-a-pack` refuse the same things by the same names, and so do the five [checks a delivery's own packs pass](#what-a-delivery-is-checked-for).

The manifest decides what is installed, and an entry's own container metadata decides nothing. Every declared file is written as an ordinary file, so an entry another tool marked as a symbolic link, a hard link or a device either is not declared, and is refused as an entry the manifest does not declare, or is written as a file holding those bytes.

Writing is deterministic: entries in path order, one fixed modification time and one fixed compression level, so the same packs under the same identity produce the same bytes. What identifies a set across a change of compressor is the digests in its manifest, not the archive's own bytes.

`set.id` and `set.version` are carried and logged, and nothing here compares two of them: a downgrade is an ordinary delivery, and what a deployment holds afterwards is what the archive carries.

<a id="the-directory-a-delivery-arrives-in"></a>
### The directory a delivery arrives in

A deployment that configures `deliveries` installs a delivery by having one copied in.

```yaml
- name: '@deepseek-ai/dsh-experimental-skill-pack'
  config:
    root: /var/lib/dsh/packs
    platformVersion: 0.5.2
    deliveries:
      directory: /var/lib/dsh/pack-deliveries
```

The directory names the delivery. Exactly one `.dshpack` file is the set this deployment holds; none is a deployment nobody has delivered to, and the pack root is left alone; more than one is refused rather than resolved, because which archive a deployment held would otherwise depend on the order a directory happens to list. A name that does not end in `.dshpack`, a name starting with `.`, and a directory are not deliveries, so a copy tool's temporary file and an operator's note can sit beside one.

Nothing here writes into that directory. It belongs to whoever copies into it, so a deployment never consumes, renames or deletes the file it was handed, and it needs no write permission on that volume. Replacing a delivery is removing the old file and copying the new one; installing is idempotent, so the reads either order produces settle on the same root.

The directory is read when the watch is armed and again on every event, and a file is read once it has stopped growing. An archive read half-copied anyway is refused for the digest it was always going to fail, and installed when the copy finishes.

`GET /skill-pack/status` carries `lastDelivery`, what the last read that found an archive did with it:

| Field | Value |
|---|---|
| `result` | `installed` when the pack root now holds the set and did not before this read; `unchanged` when the root already held every pack, path and byte of it and nothing was written; `refused` when nothing was written for any other reason. |
| `archives` | Every archive the directory held at that read, in name order: one, except on a read refused for holding more than one. |
| `set` | The `id` and `version` the archive's manifest states, present once the archive verified against that manifest. A refusal before that point — for the archive's size, for a manifest the archive does not match, or for more than one archive — carries none. |
| `reason` | On `refused` only: the line the process log carries for the refusal, naming the archive and what refused it. Where a path in it begins with the pack root, a directory above the pack root other than the file-system root, or the delivery directory, each as configured or as its real path, that much of the path is written `<pack root>`, `<pack root>/..`, `<pack root>/../..` and so on, or `<delivery directory>`, with the host's path separator. The process log keeps the paths in full. |
| `at` | When the read finished, as an ISO 8601 timestamp in UTC. |

A read that finds no archive keeps the record, and so does an `unchanged` read of the archive the record installed or found unchanged, under the same name and set: every event in the directory reads it again, a note written beside the archive among them, and that read would otherwise report the install as unchanged. Every other read replaces the record. It is held in memory, so it is absent after a start until a read finds an archive, and absent where no delivery directory is configured.

There is no upload route, and this is not an oversight. `dsh` has no authentication of its own and sits behind a reverse proxy that answers its privileged methods with 403; a route that accepted an archive would be an unauthenticated write into the directory this deployment installs its packs from. The delivery directory adds no authority of its own: whoever the host already lets write that directory is who decides what this deployment offers.

Installing or retiring a pack changes what a deployment **offers**, never what a user is **allowed**. This package offers the pack root and the organization set to the whole process; which member is offered which organization version is the organization plugin's decision, made before it hands the set over. Whether a user may act through a pack's page is the customer's own backend and the approval card in front of it.

<a id="organization-packs"></a>
## Organization packs

A row configuring `organizationRoot` provides `ctx.skillPackIntake`. The organization plugin, which verifies an organization's signed skills, hands the packs among them over; this row installs them, judges each one by the rules a pack of the root is held to, and hands the active ones' views to the component surface. The organization plugin stays their only skill provider: nothing here reports them to `ctx.skills`, and the plugin asks `isActive` which versions it may report.

| Method | Answers |
|---|---|
| `replace(packs, { signal })` | Replaces the organization root with the entries that pass, and answers which were refused. |
| `isActive(name, version)` | Synchronously, whether the offered set holds that entry and its parts, plugins, platform range, anchor format and views are all met now. |
| `onChange(listener)` | Calls the listener after a set is offered or withdrawn, or the registered parts change, for as long as the calling fiber lives. |

A deployment writes both rows, with the two fields, in its own overlay. An overlay that writes a row's `config` replaces the whole block, so `organizationRoot` and `perMember` are written in the same entry as `root` rather than in a layer of their own.

```yaml
- name: '@deepseek-ai/dsh-experimental-skill-pack'
  config:
    root: /var/lib/dsh/packs
    platformVersion: 0.5.2
    organizationRoot: /var/lib/dsh/skill-pack-org/packs
    perMember: true
- name: '@deepseek-ai/dsh-experimental-skill-pack-components'
```

Nothing but `replace` writes the organization root, so it is not watched.

<a id="what-the-organization-plugin-hands-over"></a>
### What the organization plugin hands over

The organization plugin hands an entry over when its verified `SKILL.md` frontmatter `metadata` carries `pack`, `requires` or `views`, or when its organization manifest entry carries `requires` or `anchorFormat`. Every entry handed over states `metadata.pack.version`, or it is refused as `pack-invalid`.

| `OrgPackInput` field | Meaning |
|---|---|
| `name` | The skill name; the entry's `SKILL.md` frontmatter `name` must be the same. |
| `version` | The organization manifest entry's `version`, which keys the entry and names its directory `<name>@<version>`, so a stable and a trial version of one skill sit side by side. It must be one directory name on Linux, macOS and Windows: no `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `\|` or control character U+0000 to U+001F, no `.` or space at its end, and not a Windows device name — `CON`, `PRN`, `AUX`, `NUL`, `COM0` to `COM9`, `LPT0` to `LPT9`, and `COM` or `LPT` followed by a superscript `¹`, `²` or `³` — in any letter case, with or without an extension. It holds no lone UTF-16 surrogate, and `<name>@<version>` is held to the [pack-name rules](#replacing-a-pack-root), which limit it to 255 bytes of UTF-8. A version breaking this is refused as `pack-invalid`, and the rest of the set is written. It need not equal `metadata.pack.version`, which is shown and traced only, and nothing here compares the two. The organization contract states no version format up to 0.4.0; the planned 0.5.0 limits a version to ASCII in the format `^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?$`, unique under one skill name ignoring letter case, and the organization refuses any other version when it is published. That format admits Windows device names such as `CON`, which this rule still refuses. It covers the version only: a path inside an entry is not bound by that format, may hold Chinese, and the pack rules judge it. |
| `channel` | `stable` or `trial`, shown on the status route; nothing here chooses a version by it. |
| `files` | Every file of the skill directory, its path relative to that directory with `/` separators. Content is bytes, or a string written as UTF-8; the organization plugin hands the raw bytes it verified against the organization's digests. The bytes judged are the bytes written, a byte-order mark included, so an entry is judged in memory exactly as the same file reads from disk. |

The organization root is this package's own layout and enters no model-visible path. The organization plugin points each of these skills' `resourceBase` at its own skill cache, `orgSkillsCacheRoot`, rather than at the organization root, so the version in a directory name never reaches `<skill_resources>`.

The organization plugin compiles in another repository and reads the intake as a structural type of its own, through `ctx.get('skillPackIntake')` or an `inject` of it. It does not declare `Context.skillPackIntake` again: two declarations of one property with different types fail any program that holds both.

<a id="how-a-set-is-judged"></a>
### How a set is judged

Each entry is judged on its own. An entry breaking a rule is refused and not written; the accepted entries are staged and swapped in together, so the root holds all of them or is left as it was. An entry waiting for a plugin, a part or a platform version installs and stays inactive until that arrives, without a restart.

| `IntakeRefusalCode` | What it refused |
|---|---|
| `pack-invalid` | a file, path, extension, frontmatter, manifest or view file breaking the pack rules, two paths that [fold to one name](#replacing-a-pack-root), or a path used both as a file and as the directory of another, among them, and a path segment or `<name>@<version>` that holds a lone UTF-16 surrogate or is over 255 bytes of UTF-8; a frontmatter `name` other than the entry's; a version that is not one directory name. A name the file system refuses for another reason, such as one holding a code point APFS refuses, or a path longer than `PATH_MAX`, is not refused here: writing it fails, so the whole `replace` answers `failed`, and the organization root and the offered set stay as they were |
| `anchor-format` | an entry stating an anchor format this build does not read |
| `view-format` | an entry declaring views in a view format this build does not read, or stating none |
| `view-refused` | an entry whose other requirements are met and whose view the composed surface will not draw |
| `view-id-conflict` | an entry declaring a view id another entry of the set declares with a file of different bytes |
| `duplicate` | every occurrence of a `name@version` the set names more than once, two that [fold to one name](#replacing-a-pack-root) counting as one: two that differ only in letter case name one directory on macOS and Windows, and two that differ only in Unicode normalization name one on macOS, and both are refused on every platform, so that one rule holds wherever the set is written; the fold is wider than any one file system's, so it also refuses a few pairs a file system keeps apart, such as `ı` and `I`; nothing says which of them is meant |

Codes are added as the pack rules grow, so a consumer shows one general sentence for a code it does not know. Each refusal also carries `detail`, one English sentence for an operator naming the refused value; it belongs in a diagnostic log, not in an interface or a model request.

A view id the set declares with files of identical bytes is one view, listed once under the first entry in `name@version` order. With different bytes the answer does not depend on the order the entries come in: an id already held keeps the bytes it holds, and every entry declaring it with other bytes is refused; an id nothing holds is refused to every entry declaring it. While a set is offered, that set is what holds an id. While none is — after a start, or once the fiber that handed the last set over stopped — the entries the last write left in the organization root are, read the way the pack root is read. Only a `replace` whose entries passed these rules writes that root. A call whose caller or row stops while its set is written leaves there a set that was never offered, and while no set is offered, that set is the one later calls are judged against. An id the new set declares with one content takes over whatever was held, so a new stable version replaces an old one the set no longer names. An id the deployment's own configuration claims is refused as `view-refused`, as it is for a pack of the root.

<a id="how-long-a-set-is-offered"></a>
### How long a set is offered

`replace` answers `{ kind: 'ok', refused }` or `{ kind: 'failed', detail }`, and no other kind. When it answers `ok`, `isActive` already answers from the new set, and every `onChange` listener has been called after the set was offered. Calls run one at a time in the order they arrive, and the last one offered is the set offered.

The set is held by the calling fiber — the fiber of the context the caller read `skillPackIntake` from, an `inject` callback's own fiber included — while that fiber is loading or loaded. When it stops, because the organization plugin was disabled, reloaded or failed, or this row went away, the set is withdrawn: its views leave the sidebar and its entries leave the status route, and its files stay on disk. A withdrawal the organization plugin decides on, such as an expired manifest or a member signing out, is `replace([])`, which withdraws the set and empties the organization root. After a process starts nothing is offered until the first `replace`, and a set the root already holds byte for byte is offered without being written again.

A call answers `failed` and offers nothing new when reading the organization root for the view ids it holds fails, when the write fails, when this row has stopped before the call's turn or stops while its set is written, or when the calling fiber is no longer active at its turn, once its entries are judged, or when its write finishes. Where the row or the calling fiber stopped while the set was written, the root already holds the new set, and the next call handing over the same files writes nothing. A `signal` aborted before the call or while the call waits rejects it with the signal's `reason`, changing nothing; once the write starts the call no longer reads it.

## Model Experience

Indirectly, through `dsh-tool-skill`: an active pack appears in the merged skill catalog as an ordinary skill, and loading it returns its `SKILL.md` body. An inactive pack contributes nothing to any catalog or result, so the model is never told a skill exists that it could not use. The organization intake adds no model-visible input. An organization entry reaches the model only through the catalog entry the organization plugin reports for it, and its views reach the sidebar through `activeViews()`, as a pack of the root's do. `metadata.pack.anchorFormat` is carried in a candidate's `metadata`, which `dsh-tool-skill` does not render.

#### KV Cache effect

The skill registry's consumer owns the durable catalog message and its append-only replacements. A pack changing state invalidates that catalog, so the consumer appends a replacement rather than rewriting the prefix.

## Known Limitations and Deferred Work

- **A missing plugin is reported, never installed.** A pack that needs a component plugin the deployment does not have stays inactive until somebody installs it. Nothing here fetches or mounts a plugin: an install path that runs from pack data would be the code-install route the pack rules exist to close. The trigger for revisiting is a delivery side that ships plugin and pack together as one bundle.
- **One pack root and one organization set per deployment.** `root` is a single directory and `syncPackRoot` replaces all of it, and the organization set is offered to the whole process, so every member sees the same packs of the root and the same organization views. Which member is offered which organization skill is the organization plugin's decision; this package has no member list and filters nothing per member.
- **A trial version's views are offered to the whole process, and its files are readable by every member's agent.** The views of a trial entry join the view index every member's sidebar is built from, and the organization plugin's skill cache that members' agents read resources from holds trial versions too. This is accepted: a trial manages how far a version is rolled out, not who may read it, and every member belongs to the same customer organization. The trigger for revisiting is `ctx.componentViews` offering views per member.
- **Nothing is offered between a start and the first `replace`.** The organization set is held in memory by the fiber that handed it over, so after a restart the organization plugin calls `replace` with its cached set once the intake arrives; a conversation started in that window sees none of the organization's views.
- **The organization root is not watched.** What is offered is the set `replace` judged in memory; a hand edit in the organization root changes nothing offered, and the next `replace` that writes puts the root back. While no set is offered, the entries the root holds on disk are what the next `replace` judges view ids against, so a hand edit there changes that judgement.
- **A delivery directory or a pack root that cannot be read is read as empty.** Reading the delivery directory for its archives and reading the pack root for its packs treat every failure, not only a missing directory, as an empty directory, and report nothing. An archive copied into a delivery directory this deployment cannot read is therefore not installed, and no line names it; a pack root it cannot read offers no pack, and `statuses()` lists none of its packs. A watcher that cannot watch that directory either logs `delivery watch failed` or `pack root watch failed`, naming the directory rather than an archive. Installing reads the pack root differently, as [Replacing a pack root](#replacing-a-pack-root) states.
- **A delivery arrives by being copied in, and by nothing else.** There is no route, no command and no pull: something outside this deployment puts the archive in the directory. The trigger for revisiting is an authenticated identity for the delivery console, at which point a route is authenticated where every other privileged method already is.
- **One archive is read whole, in memory.** `maxArchiveBytes` is what keeps that bounded, and a set larger than it is a loud refusal rather than a slow one. There is no streaming install and no resume.
- **An archive's entry metadata is never read.** A link, hard-link or device entry cannot install as one — every declared file is written as an ordinary file — but the refusal that names it is `archive-entry`, for an entry the manifest does not declare, rather than one naming what the entry claimed to be.
- **The same packs produce the same bytes for one build of this package.** The entry order, modification time and compression level are fixed here; the compressor is `fflate` at the version the lockfile pins. A set's identity across versions is the digests in its manifest.
- **Two packs of the root may claim one skill name.** Both are reported by `statuses()`, and the skill registry resolves the duplicate by its own rank and order rules, silently. There is no refusal and no report naming the shadowed pack. Organization entries are reported to the registry by the organization plugin, which reports one version per skill name; an organization skill sharing a name with a pack of the root is resolved by the registry's rules the same way.
- **A pack's views are judged by whoever provides the parts, and unjudged where nobody does.** Without a provider of `ctx.skillPackParts` a view that parsed is carried through, because nothing could draw it either way; the pack is then offered with views no surface has seen, and a delivery is installed on the structural checks alone. It is the same fail-closed position the part list is in, one step further along.
- **One pack declaring one view id twice keeps the first of them.** The whole-root rule is about two packs. Inside one pack the order is the `views` list the pack's own author wrote, so the second is dropped where any second claim on an id is — by `ctx.componentViews`, with one error line naming the source twice.
- **A delivery the root already holds is installed by doing nothing, and checked by nothing.** `syncPackRoot` compares first, so a set that matches the root byte for byte returns unchanged without reading a manifest or a view. A root that holds a pack this build would refuse therefore keeps it until a different set arrives. The status route shows such a read as `unchanged`, and the process log has no line for it.
- **Only the last delivery is reported, and only since the process started.** `lastDelivery` is held in memory and keeps one read. A restart empties it, and the read made when the watch arms records the archive the directory still holds, as `unchanged` when the root already holds its set. Earlier deliveries are in the process log only.
- **A delivery console cannot pre-check what a deployment will make of its views.** `buildPackArchive` holds a set to the rules about its files and reads none of them; the manifest, the view format and each view file are judged where the surface that draws them is. The trigger for revisiting is a delivery console that composes a catalog of its own.
- **The anchor formats this build reads are tied to the point-anchor package by a comment.** `PACK_ANCHOR_FORMATS` follows the `ANCHOR_FORMATS_READ` list of the point-anchor package, and no test holds the two together until that package is vendored into the console composition. The trigger is that vendoring, which brings the equivalence test with it.
- **No test installs an archive the point-anchor package wrote.** The archive cases here build their archives with `buildPackArchive`; an archive exported by point-anchor's own writer becomes a fixture once that package's anchor work is merged and pushed, generated from the pushed commit.
- **Every read re-reads the root.** `statuses()`, `activeViews()` and each provider call scan the pack root and re-parse every manifest. That keeps the answer current with no cache to go stale, and it is why the status route is not for polling at interactive rates.
- **A pack root with no parts provider offers nothing with a view.** Until a provider of `ctx.skillPackParts` is mounted, every pack naming a part is inactive. That is the correct fail-closed state and an easy one to mistake for a bug, which is what the status route is for. [`skill-pack-components`](../skill-pack-components/README.md) is the provider a deployment composes.
- **Not covered by an assembled snapshot** — the package is exercised by its own specs, including a real Loader composition over a real pack root; the snapshot lanes replay the shipped composition, which composes no experimental row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `examples/space-data-page` directory is a pack shaped the way a delivery would ship one. Its `SKILL.md` body is a placeholder: pack instructions are written by whoever owns the pack, not by this package.

</details>
