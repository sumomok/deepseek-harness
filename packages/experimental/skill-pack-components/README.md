---
description: "The adapter a deployment composes between the component catalog and its pack root: it publishes the components this deployment offers as the parts a skill pack requires, so a pack is withheld until the interface it places exists; for deployments shipping packs and the maintainers of that seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-skill-pack-components

English | [中文](README.zh.md)

## Summary

Two packages that must not depend on each other meet here. [`component-surface`](../component-surface/README.md) owns `ctx.componentCatalog` — which components a deployment registered and which of them it offers — and knows nothing about skill packs. [`skill-pack`](../skill-pack/README.md) withholds a pack until the component parts its views place exist, declares the service key that answers what exists, and reaches into no component package to answer it. This row is what a deployment composes to connect the two, and it is the only place the edge runs in both directions.

It publishes the components this deployment **offers** rather than the ones it registered. A component the deployment did not turn on cannot be drawn, so a pack requiring it must stay inactive — the deployment's own data page on a console that left `crud` off is that case, and it is why the catalog answers an offer at all.

## Table of Contents

- [Mount it](#mount-it)
- [What one part carries](#what-one-part-carries)
- [Offered, not registered](#offered-not-registered)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="mount-it"></a>
## Mount it

Anywhere after the component surface and the pack root's provider. The row has no configuration: what it publishes is read off the two services beside it.

```yaml
- name: '@deepseek-ai/dsh-experimental-component-kit'
- name: '@deepseek-ai/dsh-experimental-component-surface'
  config:
    crud: true
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
| `id` | the component's own catalog id, such as `toy.crud` |
| `plugin` | the contributing package's npm name, read at registration off that package's manifest |
| `version` | that same manifest's version |

The identity is the contributing package's rather than anything written here, so a pack and the plugin it was written against agree on the version without either writing it down twice.

The change notification is the catalog's own subscription, disposer included. A component plugin mounted or withdrawn is exactly the event a pack's state turns on, and a second notifier wrapping it would be a way for the two to disagree about when it happened.

<a id="offered-not-registered"></a>
## Offered, not registered

`ctx.componentCatalog.offered` is the registered components minus the ones this deployment will not place. Registering a component is the contributing plugin's act; offering it is the deployment's, and the two differ wherever a component needs something the deployment did not turn on.

Today one component is in that position: `toy.crud`, the deployment's own data page, which every `show_component` composition leaves out of the model's list unless `crud: true`. A console that composed the component plugin and left `crud` off registers the page and cannot draw it, so a pack whose views place it is offered to nobody — the model is never told the skill exists, and `GET /skill-pack/status` says `no component plugin registers the part toy.crud`.

## Model Experience

No prompt, schema, tool or result of its own. What it changes is which skills a model is offered, and that is `skill-pack`'s own [Model Experience](../skill-pack/README.md#model-experience): a pack whose parts this row publishes becomes an ordinary skill in the merged catalog, and a pack whose parts it does not stays absent.

#### KV Cache effect

Through the skill registry's consumer only. A component plugin mounted or withdrawn mid-session flips a pack's state, which invalidates that consumer's durable catalog; the consumer appends a replacement rather than rewriting the prefix.

## Known Limitations and Deferred Work

- **One catalog, one pack root.** The row adapts the single `ctx.componentCatalog` to the single `ctx.skillPackParts` key. A deployment with two pack roots mounts two `skill-pack` rows, and both read the same parts — which is correct today and would stop being correct the moment a pack root is scoped to a user.
- **A part is a component, and nothing smaller.** A pack requires `toy.crud` and is told whether that component exists; it cannot require a property of one, an action of one, or a version of the component itself. The component's version is its package's, so two components shipped by one package can never be required at different versions.
- **The version a range is matched against is the package's, not the component's.** A plugin that renamed or dropped a component in a patch release still satisfies `>=0.4.0`, and the pack activates onto a component that changed under it. What stops that today is `requires.parts`, which names the id and is checked for presence.
- **Not covered by an assembled snapshot** — the row is exercised by its own real-composition spec; the snapshot lanes replay the shipped composition, which composes no experimental row.

**Runtime invariant:** No companion is published because this package holds no state: both reads are computed from `ctx.componentCatalog` at the moment of the call, and there is nothing an independent observation could contradict.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
