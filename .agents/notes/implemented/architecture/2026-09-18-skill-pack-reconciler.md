# Agent Note: Skill packs are withheld until their component parts are registered

Status: implemented

English | [中文](2026-09-18-skill-pack-reconciler.zh.md)

## Problem

A deployment wants to ship a skill and the interface that skill talks about as one installable thing: instructions, plus the views that place a component plugin's parts. Skills already install as directories, and the filesystem skill provider passes a skill's frontmatter `metadata` through untouched, so a directory can carry both. What was missing is the judgement. A skill whose views place `toy.data-page` is useless — worse than absent — in a composition that has no component plugin registering `toy.data-page`: the model is told the skill exists, follows it, and the user gets a page with a hole in it or nothing at all.

The delivery side also needs a way to replace what a deployment holds. Packs are retired upstream, packs are edited by hand on the box, and a merge-shaped install leaves a root nobody can reason about.

## Decision

**A skill pack is an ordinary skill directory whose frontmatter `metadata` carries a manifest.** `pack.version` and the optional `pack.platform` range describe the pack; `requires.components` maps a component plugin's package name to a semantic-version range and `requires.parts` names the part ids that must exist in the component catalog; `views` lists the pack's own view files. The object is read strictly — an unknown key refuses the pack — because a misspelled `requires` is a requirement nobody stated and the pack would then be offered without the parts it was written against. `@deepseek-ai/dsh-experimental-skill-pack` owns the manifest schema, the reconciler, the provider, the status route and the pack-root installer.

**Activation is whole-pack.** A pack whose every requirement is met is offered in full; a pack with one unmet requirement is offered to nobody — not to the model, not to user-facing commands, and none of its views. Reconciliation is a pure function of the parsed manifests, the registered parts and the platform version, and it answers a closed `PackMissing` union that names the refused value.

**This package is the skill provider for the pack root.** `ctx.skills` merges what its providers report and exposes no filter, veto or waterfall over another provider's catalog, so the only place a pack can be withheld is the provider that would otherwise have reported it. Listing a withheld pack with both invocation flags false would hide it from every surface but would still win its name in the merged catalog and shadow a same-named skill from another provider, so a withheld pack is not listed at all. A deployment points the generic filesystem provider at its other skill roots. Withholding is enforced at the load as well: a load re-reads the root and answers `undefined` unless the pack is still active, because the registry caches a completed catalog and a selection can outlive the state it was made in.

**The parts come from one optional service this package declares, `ctx.skillPackParts`.** Its `PartsSource` interface is `list(): readonly ProvidedPart[]` plus `onChange(listener): () => void`, where a `ProvidedPart` is `{ id, plugin, version }`. Until a provider of that key is mounted the part list is empty, so every pack naming a part is inactive — the correct fail-closed answer. The adapter over the component catalog's own registry is a row of its own; nothing here reaches into that package.

**State flips without a restart.** `onChange` and a watched pack root both invalidate the skill catalog through the provider's registration-scoped `invalidate()`, and the next read recomputes. Every read — `statuses()`, `activeViews()`, and each provider call — is computed from the pack root, the organization set the intake holds, and the parts source at the moment of the call, so there is no cache of our own to go stale.

**`GET /skill-pack/status` is the only place a withheld pack is visible.** It answers `{ packs: PackStatus[] }` with names, versions, where each pack is installed, an organization entry's channel and refusal reasons, uncached. Where [a delivery directory](2026-09-19-skill-pack-archive-install.md) is configured it adds `lastDelivery`, what the last read of that directory that found an archive did: the archive names, the set the archive's manifest states, `installed`, `unchanged` or `refused`, the refusal's process-log line, and the time. It carries no file contents, no paths inside a pack and no configuration, except that a delivery refusal's line quotes a file-system error, which can name the pack root or the delivery directory. With `perMember` it answers only a request the member directory places with a member. Without it a deployment that installed a pack and cannot find it would have nothing to read.

**`syncPackRoot(targetRoot, delivery)` makes the root equal the delivered set.** It stages into a sibling directory, verifies there — for the file rules below and, since [the view-checks note](2026-09-19-skill-pack-view-checks.md), for what each pack's manifest and view files say — and swaps by rename; it compares first and writes nothing when the root already matches. A pack carries `.md`, `.yml`, `.yaml` and raster pictures; every other extension, every symbolic link and every path leaving its pack directory is refused with a typed `PackInstallError`. `.svg` is refused with the rest because an SVG document can carry script. There is no command-line entry point: the repository forbids package bins, and the delivery side calls the library function. A delivery also arrives as one packed file; [the archive-install Agent Note](2026-09-19-skill-pack-archive-install.md) owns that format, its refusals, and the directory a deployment receives one in.

**An organization's packs are installed beside the pack root, not in it.** `ctx.skillPackIntake` installs and judges them in an organization root of their own while the organization plugin reports their skills, and an offered organization pack keeps a view id against the pack root; [the organization-intake Agent Note](2026-10-05-skill-pack-organization-intake.md) owns that intake.

## The decision gate

| Gate | Answer |
|---|---|
| 0. Which standing principle already decides this? | **Plugins, not loop changes** and **a capability seam is complete, never one role** put this behind `ctx.skills.registerProvider` rather than in the registry: the registry is the Service Definition, this is one Provider, and the loop is untouched. **Misconfiguration fails loud** decides that a relative `root` and an unreadable `platformVersion` are refused at load rather than discovered one pack at a time. **Explicit > implicit at package boundaries** decides that the parts source is a declared service key, not a `?? []` hidden inside the reconciler. |
| 1. How many new permanent surfaces? (count, then list) | **7.** One Cordis service (`ctx.skillPacks`); one declared-and-consumed service key (`ctx.skillPackParts`); one skill provider name (`skill-pack`); one HTTP route (`GET /skill-pack/status`); three config fields (`root`, `platformVersion`, `watch`); one on-disk manifest format (frontmatter `metadata.pack` / `requires` / `views`); one exported library function (`syncPackRoot`) with its `PackInstallError`. No new tool, no new session event, no new approval gate, no new dependency direction into `packages/skill`. |
| 2. Smallest version that proves it right | The reconciler alone: a pure `(manifests, providedParts, platformVersion) → PackStatus[]` against a hand-written table, with the provider listing only the active ones. That is what ships. The route, the views and the installer are the smallest additions that make the result observable and installable: without the route a withheld pack is invisible everywhere, and without the installer every deployment invents its own merge semantics. |
| 3. Seam or hardcode? | **One seam, named:** `PartsSource`, because two real providers of it are already in view — the component catalog registry another change is turning `packages/experimental/component-surface`'s static catalog into, and the test-only source this package's own real-composition spec mounts. **Everything else is hardcoded:** the provider name, the rank, the route path and the pack file-extension set are fixed, because no second deployment wants a different one and a configurable extension set is the code-install rule with a switch on it. |
| 4. Boundaries | See below. |

### Boundaries

| Direction | The line | The failure it prevents | Term |
|---|---|---|---|
| Neighbour | This package judges packs; `packages/skill` owns merging and loading, and the component catalog owns what a spec may contain. A pack's `spec` and `params` are carried verbatim and never read here. | A second opinion on a spec that drifts from the one a real `show_component` call is judged by, so a view a deployment configured is accepted here and refused there. | 永久 |
| Contract | A pack is active or it is not. There is no partial activation and no "active except for one view". | A page with a hole in it: a skill the model follows into a view that cannot be drawn. | 永久 |
| Temptation | Asked for the missing plugin, this package reports it and stops. It never fetches, installs or mounts one. | A pack becoming a code-install backdoor: an install path that runs from pack data is the route the no-code rule exists to close. | 暂缓 — trigger: the delivery side can ship plugin and pack as one bundle, at which point the install decision belongs to whatever unpacks that bundle, not here. |
| Red line | Packs never carry code. `.md`, `.yml`, `.yaml` and raster pictures install; `.js`, `.mjs`, `.cjs`, `.ts`, `.vue`, `.node`, `.sh`, `.svg` and everything else are refused by name, as are symbolic links and paths leaving a pack directory. | A pack root — a directory a remote delivery writes into — becoming a way to put an executable file on the box. | 永久 |
| Ceiling | Every read re-scans the root and re-parses every manifest. No cache, no incremental watch diff, no promise about the status route under polling. | A cache that answers with a state the skill catalog has already moved past, which is exactly the bug the whole-pack rule exists to avoid. | 暂缓 — trigger: a pack root large enough that a measured scan shows up in a request, at which point the cache needs an invalidation owner rather than a TTL. |
| Assumption | One pack root per deployment, and one delivered set in it. `root` is a single directory and `syncPackRoot` replaces all of it; an organization's packs live in a separate organization root that no delivery touches. | Inventing a per-user identity this package does not have, and a root whose contents depend on who is asking. | 暂缓 — trigger: the multi-user decision. |

## Testing

Unit suites pin the manifest schema and the fields its refusals name, the reconciler's closed union and its fixed ordering, view-file parsing, the pack-root scan, and the installer's first install, add/replace/retire, idempotence, drift repair, code-file rejection, path-escape rejection, symbolic-link rejection and its failure-leaves-the-root-alone guarantee. A real Loader composition over a real pack root boots the skill registry, the web server and this row, and asserts the merged catalog, the model and user invocation filters, the loaded body, the status document, the 405, the views, the flip in both directions as a parts source arrives, changes and is disposed, a pack arriving in a watched root, the refusal to load a pack the root no longer offers, and provider withdrawal on fiber disposal. Per-file coverage of `src` is 100%.

## The adapter

The provider of `ctx.skillPackParts` is `@deepseek-ai/dsh-experimental-skill-pack-components`, a row of its own that injects the component catalog and publishes each **offered** component as a part — its id, the npm name of the package that registered it, and that package's own version — forwarding the catalog's own subscription and its disposer. Offered rather than registered: a component the deployment did not turn on cannot be drawn, so a pack requiring it stays inactive.

That same row carries the active packs' views the other way, into the index the sidebar is built from, and `PartsSource` grew the second question it asks — whether one view file can be drawn — with the `view-refused` member of `PackMissing` that answers it. [The pack-views Agent Note](2026-09-18-skill-pack-views.md) owns both, and the click that opens a view holding a data page. [The view-checks Agent Note](2026-09-19-skill-pack-view-checks.md) owns when that question is asked — at install as well as at reconciliation — and the view-file format version it is asked under.

## Alternatives considered

**List withheld packs with `modelInvocable: false, userInvocable: false`.** Rejected. It hides the pack from both surfaces, but the candidate still wins its name in the merged catalog and silently shadows a same-named skill from another provider; and it leaves a pack that cannot be used sitting in `ctx.skills.list()` for any future consumer that reads the invocation-neutral catalog.

**Add a filter or veto hook to `packages/skill`.** Rejected. The registry's contribution contract is `registerProvider`, and a filter would let any plugin withhold any other provider's skills — a much wider authority than this package needs, added to a core package for one experimental consumer.

**Mount the generic filesystem provider on the pack root and post-filter its catalog.** Rejected for the same reason: there is nothing to filter through. It would also mean two providers reporting the same directory, with the first one to answer deciding what the model sees.

**Activate a pack partially, offering the skill and only the views that resolve.** Rejected. The instructions describe the whole pack; a model following them into a view that was silently dropped produces exactly the half-drawn page the pack was meant to prevent.

**Validate the component spec here.** Rejected. The component catalog owns what a spec may contain, and a second implementation of that judgement drifts from the first. This package parses the view file and carries the spec through.

**Merge a delivery into the pack root instead of replacing it.** Rejected. A merge leaves retired packs and hand-edited packs behind, so nothing can say what the deployment holds. Replacement makes the root equal the delivery, and the compare-first step keeps a repeated delivery free.

**Ship a CLI for the installer.** Rejected: the repository forbids package bins, and only `dsh` profiles launch supported Node applications. `syncPackRoot` is a library function the delivery side calls.

## Consequences

A deployment can install a pack before the plugin it needs and get a defined state instead of a broken page: the pack sits inactive, the route says which plugin and which part it is waiting on, and it activates the moment that plugin appears. The cost is that a pack root with no parts provider mounted offers nothing with a view at all, which is the correct answer but an easy one to mistake for a bug — the status route exists because of it.

The strict manifest read means a pack with an unknown `metadata` key is refused rather than partly honoured, so a future manifest field is a breaking change for packs that adopt it early. That is deliberate: `SESSION_FORMAT_VERSION`-style silence about unknown keys is what would let a misspelled requirement ship.

Judging on every read keeps the answer current at the cost of a directory scan per call, and the package accepts that until a measurement says otherwise.
