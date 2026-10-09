---
kind: upgrade-guide
description: "A view that writes a key named `__proto__` in any mapping of its `spec` is refused at that key before anything else in it is judged."
---

# A view cannot write a key named `__proto__`

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.1, a key named `__proto__` in the `spec` of a view — a `views` entry of `@deepseek-ai/dsh-experimental-component-surface` in `cordis.yml` or a `--patch` overlay, or a skill pack view file — is read as the prototype of the mapping it is written in. The view loads, and what sits under the key is drawn without being judged by name: `__proto__: { readOnly: false }` among a `toy.data-page` block's `props` opens the page for writing, a key no component declares is dropped instead of refused, a text cell under the key in a table row is dropped, and nothing under the key counts against the 65536-byte ceiling on a spec.

The next release refuses such a view at the key, in any mapping of its `spec` — a table row included — before anything else in the view is read or measured. A property under the key is refused for the key whether or not a component declares it, and rows under the key are refused for the key rather than for the size of the spec. A view in the `views` config fails that row at error level, and the deployment comes up with no components, no views and no `show_component` tool:

```
component-surface: views[0] "site-overview" — spec.nodes[0].props.__proto__ — is a key named __proto__, which no mapping of a view may carry: copied by assignment, the value under it becomes the mapping's prototype instead of a key, so two readers of one file would disagree on what it holds; this deployment comes up with no components, no views and no show_component tool until that view is corrected or removed
```

A skill pack carrying such a view becomes inactive, and `GET /skill-pack/status` names the file, the path and the same sentence. A `show_component` call is not affected by this change.

## Migration

1. Find every key named `__proto__` in the view specs of `cordis.yml`, `--patch` overlays and skill pack view files.
2. Move each property written under the key into the mapping the key sits in, then delete the key:

   ```yaml
   # before
   props:
     relatedMeta: SpaceLayer
     __proto__: { readOnly: false }
   # after
   props:
     relatedMeta: SpaceLayer
     readOnly: false
   ```

   A property the component does not declare is then refused by name; delete it. A spec that now measures more than 65536 bytes of JSON is refused for its size; shorten it. A table row cannot carry a cell keyed `__proto__` in a view; delete the cell and the column reading it.
3. Confirm: the deployment starts without a `component-surface: views[…]` error line, `GET /component-surface/views` lists the view, and `GET /skill-pack/status` reports the pack carrying it as active.
