---
description: "「指一下」 for the customer console: a composer button beside 「+」 that points at a place in the content column or the sidebar — a data page's column, toolbar button or row operation, an original-system page's control, a picture, a sidebar entry, or any block of the component view as a whole — files it as a prompt reference chip, and before the step the message enters appends one logged message writing each point's key line and display text, never a row's values."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-content-point

English | [中文](README.zh.md)

## Summary

「指一下」 lets the console's user point at what they are asking about. A button beside the composer's 「+」 starts a pick over the console; the place clicked becomes a reference chip above the composer, and the model, when the message is sent, is told where each point is: its key line and its display text. Data pages are pointed at by column, toolbar button and row operation, original-system pages by control, and sidebar entries by entry; every other block of the component view is pointed at as a whole. No value of any row reaches the reference or the model.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The customer console composes it through [`dsh-experimental-console-profile`](../console-profile/README.md), whose own layer inserts the row; a deployment layer does not insert it again, since a second row would draw a second button and append each point's message twice.

### When to choose it

Choose it for a console whose user asks about what the content column shows. It reads the console's DOM — the content surface's seats and switcher, the component view's blocks, the content-frame iframes, the sidebar's entries — so it is of no use in a composition without them.

### Minimal configuration

```yaml
- insert:
    - id: content-point
      name: '@deepseek-ai/dsh-experimental-content-point'
```

The row has no config.

### What a point records

A click on the button starts a pick over the whole console document; Escape, or a second click on the button, cancels it. While it runs, presses, clicks and activation keys on the page reach nothing, and hovering draws the place a click would take with its words. The place clicked becomes one chip in the attachment row; the user can remove it before sending, and a message holding only chips cannot be sent.

| Place | What the reference records | Key line, for example |
| --- | --- | --- |
| A data page's column header, cell, toolbar button, row operation | point-anchor's description, without the row | `data-page model=SpaceLayer region=table part=header column=zh_label` |
| A control, a cell or a region of an original-system page | point-anchor's description | `frame page=orders role=button name="查询" in=main` |
| A drawing on such a page | point-anchor's description | `picture page=orders tag=canvas nth=1` |
| A sidebar entry | point-anchor's description | `nav nav=view id=space-layer-crud` |
| Any other block of the component view | a block reference | `block seat=component component=toy.info-card node=card` |
| A seat holding no block | a block reference | `block seat=office` |

A place point-anchor refuses for any other reason — a popup, a frame the console may not read, a point outside the content column — is reported in a toast over the composer, and nothing is filed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The package has two halves and no session event of its own.

The browser half registers the button in ui-conversation's `conversation.input.left` seat and writes point-anchor's page marker on the console document. A point runs point-anchor's picker for a reference (`createPicker(document, { purpose: 'reference' })`). For a place it describes, the description loses its `row` and `rowOmitted` before `toPromptReference` holds it to 8192 bytes; for a place it refuses as `unsupported-component`, `kit-too-old`, `not-ready`, `unknown-point` or `unknown-model` inside a seat, the block around the click is filed instead (`src/block.ts`): the nearest element carrying `data-component-node` inside the seat, with its `data-component-block`, else the seat itself, and the selected switcher entry's title and a display name from this package's dictionary as the display text. The picker reports no element for a refusal, so a capture listener added on the console window before the picker's own reads the click it takes. The reference is filed with `createReferenceDraft` under the source `content-point`; its payload is resolved unchanged when the message is sent, and the host records it on the accepted message's source.

The host half is one `agent/pre-step` listener. For each user message entering the step whose source records references of the `content-point` source, it inserts right after that message one user message whose source is the `content-point` kind (`{ kind: 'content-point', message: <the user message's id>, form: 'notice', summary }`). Its text has one paragraph per reference, for the first 16 of them — the protocol's bound per prompt. A point-anchor description is read with `parsePointData` and written with `renderPointText` after its row is taken off; a block reference is read strictly (`parseBlockData`) and written in the same three lines. A reference whose format this build does not read is written as one sentence naming the stated format and the formats read, labelled with its recorded label, rather than dropped. A step that already holds a `content-point` message naming a user message appends nothing more for it, and each user message enters exactly one step, so each message's points are written once. The row writes no `content-component/shown` and appends no session event.

### Formats

A point-anchor description carries `v` (its describe format) and `anchorFormat`; this build reads what the vendored point-anchor reads, `DESCRIBE_FORMATS_READ` and `ANCHOR_FORMATS_READ`. A block reference carries `v: 1` and `kind: 'block'`; this build writes and reads format 1 only. A logged reference in another format is told to the model as unreadable, with both numbers.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@haoran/dsh-point-anchor`](vendor/) — the picker, the descriptions and the key lines, vendored as `vendor/haoran-dsh-point-anchor-0.1.0.tgz`.
- [`dsh-client-ui-conversation`](../../client/ui-conversation/README.md) — reference drafts and the attachment row.
- [`dsh-experimental-component-surface`](../component-surface/README.md) — the component view whose blocks a point names.
- [`dsh-experimental-console-profile`](../console-profile/README.md) — the composition that mounts this row.

-----

<a id="model-experience"></a>
## Model Experience

### The point notice

#### What the model sees

After a user message carrying points, one user message with one paragraph per point, separated by an empty line:

```text
用户在内容栏里指着「列「名称」」。
锚点：`data-page model=SpaceLayer region=table part=header column=zh_label`
显示：数据页「图层配置」 · 列「名称」

用户在内容栏里指着「指标」这一整块。
锚点：`block seat=component component=el.metric node=rate`
显示：图层配置 · 指标
```

A point without an anchor writes `锚点：没有（…）` with the reason; a reference this build cannot read writes one sentence naming the stated format and the formats read. No paragraph writes a row's values. The chips the user saw are not in the message the user wrote; this message is the only model-visible trace of them.

#### Token effect

About 40 to 80 tokens per point, for messages carrying points only; at most 16 points per message.

#### KV Cache effect

Append-only: the message is inserted after the user message it answers, inside the step that message enters, so no earlier request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A form page and an info card are pointed at as a whole.** Outside a data page they carry no `.toy-data-page`, so point-anchor refuses their fields as `unsupported-component` and the point names the block (`block … component=toy.form-page`), not the field. A data page's own form fields are pointed at one by one.
- **A whole block is highlighted as the seat while hovering.** point-anchor draws a refused place over the element its refusal names, the whole component seat, with this package's words 「指这一整块」; the reference filed names the block clicked.
- **A row's values never reach the model.** A cell, a row and a row operation are named by column and operation; the model is not told which record the user pointed at.
- **Keyboard activation in a shielded cross-origin frame.** With focus left on a control inside a frame of another origin, Enter and Space during a pick reach that control; see point-anchor's README. point-anchor 0.2.0 moves the focus out.
- **The delivery-set check is not yet held to skill-pack's reader.** `tests/equivalence.spec.ts` holds the anchor formats, the archive bytes and the name and path refusals to skill-pack; the vendored point-anchor 0.1.0 has no `checkDeliverySet`, so the test that the two judge a delivery set alike waits for point-anchor 0.2.0.
- **Not covered by an assembled snapshot.** The `snapshots/console` lane drives ACP, whose prompt carries no references; the evidence is this package's unit suites, the console-profile composition test, and the `content-point` web scenario.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- The vendored point-anchor is a 0.1.0 build of the plugin repository's `feat/point-anchor` at `0eca54e` (tarball sha256 `ab5ae311d315234eeea1aaf567690d048f09cc848887671ce493aea70d06be42`), until 0.2.0 replaces it.
- The button's glyph is ui-primitives' `IconGoalOutlineMedium`, a target, the closest of the shared icons to pointing at something; no icon of the set draws a pointer or a crosshair.
- `src/client/PointButton.module.css` takes one gap of the tool row back while both chip seats of the row's mode box (`conversation.input.permission`, `conversation.input.plan`) are empty, matching them by their `data-slot` attributes and copying the row's 12px and narrow-card 8px from ui-conversation's `InputBar.module.css`. ui-conversation leaves the empty box in the row, and the row's gap on each side of it would otherwise put the button two gaps from 「+」. The `content-point` web scenario holds the distance to the row's gap; the rule goes once ui-conversation drops the empty box from the row's gaps.

</details>
