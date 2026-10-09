---
kind: upgrade-guide
description: "A data page view that switches off a form but keeps its button is refused at load, and a writable one leaving out its button lists gains the batch and row delete buttons."
---

# Data page views: a switched-off form needs a form page, and default buttons include batch and delete

English | [中文](guide.zh.md)

## Change

Both changes concern a view that places `toy.data-page` with `readOnly: false` on a deployment with `dataPage: true`.

In v0.2.1-alpha.1 such a view could switch off one of the page's own forms with `regions.addForm: false` or `regions.modifyForm: false` and keep the button that opens it. The next release refuses that view when it is judged, unless it also places a `toy.form-page` reading the page's `editing` output. The add button is kept where `regions.toolbar` is not `false` and `toolbarButtons` lists `add` or is left out; the modify button is kept where `rowOperations` lists `modify` or is left out ([view rules](../../../../packages/experimental/component-surface/README.md#view-placed-components)). A view in the `views` config of `@deepseek-ai/dsh-experimental-component-surface` then fails that row at error level, and the deployment comes up with no components, no views and no `show_component` tool:

```
component-surface: views[0] "layers" — spec.nodes[0].props.regions.addForm — is false while the page keeps its add button, and no toy.form-page in this view reads editing of "page": the button would open nothing.; this deployment comes up with no components, no views and no show_component tool until that view is corrected or removed
```

A skill pack carrying such a view becomes inactive; `GET /skill-pack/status` names the file, the value and that sentence.

A view that leaves out `toolbarButtons` drew `add`, `exp`, `gridexp`, `search` and `clear`; it now also draws `batch`, the menu holding batch modify and batch delete. A view that leaves out `rowOperations` drew `modify` on every row; it now also draws `delete`. A delete keeps a record that still has spatial resources bound to it (`deleteGisResource: 3`) unless the view writes `1` or `2`. The visitor's rights still remove any entrance the deployment's rule table denies.

The release's other view rules judge only views placing `toy.form-page` or `toy.info-card` or writing `infoCardLinks`, which no view could load with before.

## Migration

1. Find every view placing `toy.data-page` with `readOnly: false`, in `cordis.yml`, `--patch` overlays and skill pack view files.
2. Where `regions` switches a form off while its button is kept, do one of these:
   - place a `toy.form-page` with the page's `relatedMeta` and `request: { $from: "node:<page id>.editing" }`, and write both `addForm: false` and `modifyForm: false`;
   - delete the `false` entry, so the page draws its own form;
   - remove the button: drop `add` from `toolbarButtons` or set `regions.toolbar: false`, or drop `modify` from `rowOperations`.
3. Where `toolbarButtons` or `rowOperations` is left out and the old buttons are wanted, write `toolbarButtons: [add, exp, gridexp, search, clear]` and `rowOperations: [modify]`.
4. Confirm: the deployment starts without a `component-surface: views[…]` error line, `GET /component-surface/views` lists the view, and `GET /skill-pack/status` reports every pack carrying a data page view as active.
