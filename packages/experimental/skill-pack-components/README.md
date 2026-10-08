---
description: "The adapter a deployment composes between the component catalog and its pack root: it publishes the components this deployment offers as the parts a skill pack requires, so a pack is withheld until the interface it places exists; for deployments shipping packs and the maintainers of that seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-skill-pack-components

English | [中文](README.zh.md)

## Summary

Two packages that must not depend on each other meet here. [`component-surface`](../component-surface/README.md) owns `ctx.componentCatalog` — which components a deployment registered and which of them it offers — and knows nothing about skill packs. [`skill-pack`](../skill-pack/README.md) withholds a pack until the component parts its views place exist, declares the service key that answers what exists, and reaches into no component package to answer it. This row is what a deployment composes to connect the two, and it is the only place the edge runs in both directions. The package also writes the [component catalog file](#the-component-catalog-file) a pack author composes views from.

## Table of Contents

- [Mount it](#mount-it)
- [What one part carries](#what-one-part-carries)
- [Offered, not registered](#offered-not-registered)
- [Judging a pack's views](#judging-a-packs-views)
- [Placing them](#placing-them)
- [The component catalog file](#the-component-catalog-file)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="mount-it"></a>
## Mount it

It publishes the components this deployment **offers** rather than the ones it registered. A component the deployment did not turn on cannot be drawn, so a pack requiring it must stay inactive — the deployment's own data page on a console that left `dataPage` off is that case, and it is why the catalog answers an offer at all.

Views travel the other way. Every active pack's views are offered to `ctx.componentViews` as one source and re-offered whenever the pack set moves, so a pack activating puts its views in the sidebar and a pack going inactive takes them out, with no restart. The packs of an organization set that `ctx.skillPackIntake` installed arrive the same way, through `ctx.skillPacks.activeViews()`, and leave when that set is withdrawn.

Anywhere after the component surface and the pack root's provider. The row has no configuration: what it publishes is read off the two services beside it.

```yaml
- name: '@deepseek-ai/dsh-experimental-component-kit'
- name: '@deepseek-ai/dsh-experimental-component-surface'
  config:
    dataPage: true
- name: '@deepseek-ai/dsh-experimental-skill-pack'
  config:
    root: /var/lib/dsh/packs
    platformVersion: 0.5.2
- name: '@deepseek-ai/dsh-experimental-skill-pack-components'
```

`ctx.componentCatalog` is required rather than waited for optionally: with no component catalog there is nothing to adapt, and a row publishing an empty part list would answer "no component plugin registers that part" for a deployment that never composed a component surface at all. A deployment composing the pack root alone and not this row gets the same fail-closed answer from `skill-pack` itself, and its status route says which part each pack is waiting on.

<a id="what-one-part-carries"></a>
## What one part carries

One offered component becomes one part: the catalog id a pack names in `requires.parts`, the npm name of the package that registered it, and that package's own version, which is what a pack's `requires.components` range is matched against.

| Part field | Read from |
|---|---|
| `id` | the component's own catalog id, such as `toy.data-page` |
| `plugin` | the contributing package's npm name, read at registration off that package's manifest |
| `version` | that same manifest's version |

The identity is the contributing package's rather than anything written here, so a pack and the plugin it was written against agree on the version without either writing it down twice.

The change notification is the catalog's own subscription, disposer included. A component plugin mounted or withdrawn is exactly the event a pack's state turns on, and a second notifier wrapping it would be a way for the two to disagree about when it happened.

<a id="offered-not-registered"></a>
## Offered, not registered

`ctx.componentCatalog.offered` is the registered components minus the ones this deployment will not place. Registering a component is the contributing plugin's act; offering it is the deployment's, and the two differ wherever a component needs something the deployment did not turn on.

Today one component is in that position: `toy.data-page`, the deployment's own data page, which every `show_component` composition leaves out of the model's list unless `dataPage: true`. A console that composed the component plugin and left `dataPage` off registers the page and cannot draw it, so a pack whose views place it is offered to nobody — the model is never told the skill exists, and `GET /skill-pack/status` says `no component plugin registers the part toy.data-page`.

<a id="judging-a-packs-views"></a>
## Judging a pack's views

A pack root asks before it offers anything: every view file a pack declares is handed to `ctx.componentViews.judge`, which is the pass a real `show_component` call is judged by. A view the catalog will not draw makes its **whole pack** inactive, named on `GET /skill-pack/status` with the file, the value inside it and the sentence the model would have been refused with. A pack with a view nobody can draw is worse than a pack that is not there, which is why the refusal lands on the pack rather than on the view.

An id already offered is refused the same way. The deployment's own configured views own their ids, so a pack claiming one is held back rather than losing that view. Two packs claiming one id is a question this row does not answer: the pack root withholds **both** of them, because one menu row cannot have two owners and keeping the id for whichever pack was read first would make what a deployment offers depend on its filesystem.

The same judgement runs before a delivery replaces the pack root, not only after. `SkillPackRegistry` hands each staged pack to this row's `judgeView`, and a view this deployment will not draw — for a pack whose parts and plugin versions it **already** has — refuses the whole delivery with the pack, the file and this row's own sentence. A pack still waiting for a plugin installs and stays inactive, because the surface its views were judged against is not finished arriving.

<a id="placing-them"></a>
## Placing them

Everything the packs do offer is registered into `ctx.componentViews` as one source under this package's name. The read is asynchronous and the registration is not, so each reading carries the number of the refresh that asked for it: a reading a later refresh has superseded, and one arriving after this row has gone, are both dropped.

From there the path is the one a configured view already takes — the sidebar lists it off `GET /component-surface/views`, a click runs `/show-content-view`, and what lands in the column is the same session event a configured view's click writes.

<a id="the-component-catalog-file"></a>
## The component catalog file

`tests/expected/component-catalog.json` is what someone writing a skill pack away from any deployment composes views from: every component the component kit registers, the rules a view file is judged by, and the rules a pack and its `.dshpack` archive are read under. Regenerate it after any change to a catalog entry, to the component surface's limits or to the pack rules, and after any change to the version of the component kit or of the kit it vendors. `scripts/release/bump.ts` changes the component kit's version with every other private package's, so a version bump needs a regeneration too:

```sh
pnpm --filter @deepseek-ai/dsh-experimental-skill-pack-components run component-catalog
```

A test generates the file again and fails when the checked-in copy differs by one byte, so a change that moves the catalog cannot pass with a stale file.

| Key | What it holds |
|---|---|
| `header.catalogFormat` | `1`, the file format. It changes whenever a key is renamed, removed or given another meaning, and a reader that does not know the number does not read the file. |
| `header.componentKit`, `header.toyCrudKit` | The npm name and installed version of the component kit, which a pack's `requires.components` range is matched against, and of the kit it vendors to draw the data page. |
| `header.bodySha256` | SHA-256, in lowercase hexadecimal, of the UTF-8 bytes of `JSON.stringify(body)`: no whitespace, keys in file order. A reader recomputes it from the parsed file; outside JavaScript, the serializer must write exactly what `JSON.stringify` writes, non-ASCII characters unescaped included, or the digest does not match. |
| `header.exampleViewSha256` | `null`, because the file ships no example view yet. |
| `body.components` | Per component: `id`, `label` (the Chinese name the user reads), `purpose`, `placement`, `deploymentSwitches`, `props`, `outputs` (`id`, `summary`, `shape`), `actions` (`id`, `report`), and `sanitize` where the component reads a string as a path, a color or a renderer name. |
| `body.rules` | `view` (the id, the title, the spec size, the keys a spec and a node may carry, the node count and node id, and the rules a spec, its nodes and its data page are judged by), `layout` (the root kind, directions, gaps, depth, the children of one stack, `flex`, the keys a stack and a placed block may carry, and the rules they and the placement are judged by), `binding` (`$from`), `param` (`$param`), `viewFile` (the keys a view file is read for), `manifest` (the frontmatter key, the fields, and when `pack.viewFormat` and `pack.anchorFormat` must be stated), `packFiles` (the extensions a pack may carry) and `archive` (the `.dshpack` format and the limits it is read under by default). |

Each property states `summary`, the notation the tool description writes for it; `required`; `viewOnly`, true where only a view file may set it; `unbindable`, true where it cannot be written as a `$from` reference, read from the component surface's `unbindableReason`, so a property the component reads as a path, a color or a renderer name is unbindable even where it is not declared so; and `schema`, its kind with every bound, list and alphabet, an alphabet written as a regular-expression literal with its flags. A field inside an object property states `summary`, `required` and `schema` only: a `$from` inside an object property is refused, and `viewOnly` is judged on a component's own properties alone. Each field of `viewFile.fields` and `manifest.fields` states its `path`, `required`, and `summary`, the pack root's own words for what the value must be. `deploymentSwitches` names the `show_component` switches that must be on before a deployment offers the component, read from the component surface's `withheldComponents`; whether a given deployment has turned them on is not in the file. `placement` is `call` for every component: the catalog declares no placement yet, so every component a view places can also be placed by a call. A test checks every component of the file against the catalog entry it comes from: the same `id`, `label` and `purpose`, the same property names, the same output ids, the same actions by `id` and `report`, and the same `sanitize`, or none where the entry has none. It keeps one check per key of the entry in a record typed over the entry, so a key added to the entry, such as a placement, fails the typecheck until a check for that key is written.

The components, every upper limit, list and key are read from the module that enforces them. The generator writes the rest itself, because no module exports them as values: the lower bounds of `view.nodes`, `layout.children` and `layout.flex`, `layout.flex.integer`, `layout.root`, the `otherKeys` words, and the `rules` sentences, which restate how the component surface judges a view and how the pack root reads a manifest. Tests check each of those values against the judgement it restates; they also pin the exact text of every `rules` sentence and check the judgement each one states, so changing either the sentence or the judgement fails a test.

## Model Experience

Indirectly, through [`skill-pack`](../skill-pack/README.md#model-experience): this row registers no prompt, schema, tool or result of its own, and what it changes is which packs answer their requirements — a pack this row can answer for becomes an ordinary skill in the merged catalog, and a pack it cannot stays absent.

#### KV Cache effect

Through the skill registry's consumer only. A component plugin mounted or withdrawn mid-session flips a pack's state, which invalidates that consumer's durable catalog; the consumer appends a replacement rather than rewriting the prefix.

## Known Limitations and Deferred Work

- **One catalog, one pack root.** The row adapts the single `ctx.componentCatalog` to the single `ctx.skillPackParts` key. A deployment with two pack roots mounts two `skill-pack` rows, and both read the same parts — which is correct today and would stop being correct the moment a pack root is scoped to a user.
- **A part is a component, and nothing smaller.** A pack requires `toy.data-page` and is told whether that component exists; it cannot require a property of one, an action of one, or a version of the component itself. The component's version is its package's, so two components shipped by one package can never be required at different versions.
- **The version a range is matched against is the package's, not the component's.** A plugin that renamed or dropped a component in a patch release still satisfies `>=0.4.0`, and the pack activates onto a component that changed under it. What stops that today is `requires.parts`, which names the id and is checked for presence.
- **A pack that loses an id collision to the deployment's own views learns it from the status route and nowhere else.** The refusal names the id and says it is already offered; it does not name which configured view holds it, because the judgement runs before the index is built and only the index knows the holder. What the operator has is the two documents side by side. A collision between two packs is named on both sides, by the pack root, which can see both.
- **No example view.** The catalog file's header carries `exampleViewSha256: null`, and no test judges an example view. The example places a data page and an information card bound to the page's `opened` output, and neither the card nor that output is in the catalog yet. Once both are, the example goes under `tests/expected/examples/`, its digest goes into the header, and a test substitutes its `params` and judges it with the component surface's `judgeView`.
- **Not covered by an assembled snapshot** — the row is exercised by its own real-composition spec; the snapshot lanes replay the shipped composition, which composes no experimental row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
