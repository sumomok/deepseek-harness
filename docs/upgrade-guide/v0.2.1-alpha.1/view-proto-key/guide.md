---
kind: upgrade-guide
description: "A view that writes a key named `__proto__` anywhere in its `spec` is refused at that key when it is judged."
---

# A view cannot write a key named `__proto__`

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.1, a key named `__proto__` in the `spec` of a view — a `views` entry of `@deepseek-ai/dsh-experimental-component-surface` in `cordis.yml` or a `--patch` overlay, or a skill pack view file — is read as the prototype of the object it is written in. The view loads, and the properties under the key are drawn without being judged by name: `__proto__: { readOnly: false }` among a `toy.data-page` block's `props` opens the page for writing, a key no component declares is dropped instead of refused, and what sits under the key is not counted against the 65536-byte ceiling on a spec.

The next release keeps the key as an ordinary key and refuses the view at it, in the sentence a `show_component` call carrying the same key gets: `is not accepted here. Accepted properties: …` among a block's properties or inside an object-valued property, `is not part of a node. …` beside a node's `id`, `component` and `props`, and `is not part of a spec. …` beside `nodes`. A view in the `views` config fails that row at error level, and the deployment comes up with no components, no views and no `show_component` tool:

```
component-surface: views[0] "site-overview" — spec.nodes[0].props.__proto__ — is not accepted here. Accepted properties: dataList, labelWidth, columnNum.; this deployment comes up with no components, no views and no show_component tool until that view is corrected or removed
```

A skill pack carrying such a view becomes inactive, and `GET /skill-pack/status` names the file, the path and the same sentence.

## Migration

1. Find every key named `__proto__` in the view specs of `cordis.yml`, `--patch` overlays and skill pack view files.
2. Move each property written under the key into the object the key sits in, then delete the key:

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

   A property the component does not declare is then refused by name; delete it. A spec that now measures more than 65536 bytes of JSON is refused for its size; shorten it.
3. Confirm: the deployment starts without a `component-surface: views[…]` error line, `GET /component-surface/views` lists the view, and `GET /skill-pack/status` reports the pack carrying it as active.
