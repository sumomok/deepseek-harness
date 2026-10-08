---
kind: upgrade-guide
description: "A data page view that switches off the page's add or modify form while keeping the button that opens it is refused at load."
---

# A data page view cannot keep a button whose form it switches off

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.1, on a deployment with `dataPage: true`, a view that places a `toy.data-page` with `readOnly: false` and switches off one of the page's own forms with `regions.addForm: false` or `regions.modifyForm: false` loads, and the page keeps the button that opens that form. The next release refuses such a view when it is judged, unless the view also places a `toy.form-page` reading the page's `editing` output. The add button is kept where `regions.toolbar` is not `false` and `toolbarButtons` lists `add` or is left out; the modify button is kept where `rowOperations` lists `modify` or is left out ([view rules](../../../../packages/experimental/component-surface/README.md#view-placed-components)).

A view written in the `views` config of `@deepseek-ai/dsh-experimental-component-surface` fails that row at error level, and the deployment comes up with no components, no views and no `show_component` tool:

```
component-surface: views[0] "layers" — spec.nodes[0].props.regions.addForm — is false while the page keeps its add button, and no toy.form-page in this view reads editing of "page": the button would open nothing.
```

A skill pack carrying such a view becomes inactive, and `GET /skill-pack/status` names the file, the value and the same sentence.

The release adds other view rules, and each of them judges only a view that places `toy.form-page` or `toy.info-card`. No component plugin registers either block, so such a view is refused as naming no component of the deployment, as it was in v0.2.1-alpha.1, and no view that loaded before meets those rules.

## Migration

1. Find every view placing `toy.data-page` whose `regions` sets `addForm: false` or `modifyForm: false`, in `cordis.yml`, `--patch` overlays and skill pack view files.
2. For each form switched off while its button is kept, do one of these:
   - delete the `addForm: false` or `modifyForm: false` entry, so the page draws its own form;
   - remove the button: for the add form, drop `add` from `toolbarButtons` or set `regions.toolbar: false`; for the modify form, drop `modify` from `rowOperations`;
   - leave `readOnly` out, which makes the page read-only and draws neither button.

   Placing a `toy.form-page` block instead is refused as naming no component of the deployment.
3. Confirm: the deployment starts without a `component-surface: views[…]` error line, `GET /component-surface/views` lists the view, and `GET /skill-pack/status` reports every pack carrying a data page view as active.
