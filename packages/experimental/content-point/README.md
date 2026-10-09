---
description: "「指一下」 for the customer console: a composer button beside 「+」 that points at a place in the content column or the sidebar — a data page's column, toolbar button or row operation, an original-system page's control, a picture, a sidebar entry, or any block of the component view or original-system page as a whole — files it as a prompt reference chip, and before the step the message enters appends one logged message writing each point's key line and display text, never a record's values."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-content-point

English | [中文](README.zh.md)

## Summary

「指一下」 lets the console's user point at what they ask about. A button beside the composer's 「+」 starts a pick; the place clicked becomes a reference chip above the composer, and the sent message tells the model each point's key line and display text. Data pages are pointed at by column, toolbar button and row operation, original-system pages by control, sidebar entries by entry; any other block, and an original-system page where nothing finer is named, as a whole. No record value reaches the reference or the model.

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

The customer console composes it through [`dsh-experimental-console-profile`](../console-profile/README.md), whose own layer inserts the row; a deployment layer does not insert it again, since a second row would draw a second button. The notice is still appended once: the outer row's listener finds the inner row's notice in the step and skips the message.

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

A click on the button starts a pick over the whole console document; Escape, or a second click on the button, cancels it. While it runs, presses, clicks and activation keys on the page reach nothing, and hovering draws the place a click would take with its words, in the console's locale. The place clicked becomes one chip in the attachment row; the user can remove it before sending, and a message holding only chips cannot be sent. Pressing the button leaves the focus in the composer, so Enter sends after a point. The button is disabled while the composer submits; with 16 of its chips in the row a click reports that, since the host refuses a prompt carrying more references, and a chip the composer refuses after all is released and reported.

| Place | What the reference records | Key line, for example |
| --- | --- | --- |
| A data page's column header, cell, toolbar button, row operation | point-anchor's description, without the row | `data-page model=SpaceLayer region=table part=header column=zh_label` |
| A control, a cell or a region of an original-system page | point-anchor's description | `frame page=orders role=button name="查询" in=main` |
| A control inside a table cell of such a page | point-anchor's description by column and role, without the control's name | `frame page=orders column="名称" role=button in=main` |
| A drawing on such a page | point-anchor's description | `picture page=orders tag=canvas nth=1` |
| A sidebar entry | point-anchor's description | `nav nav=view id=space-layer-crud` |
| Any other block of the component view | a block reference | `block seat=component component=toy.info-card node=card` |
| An original-system page where nothing is named, a cell no column can be told for, or a page of another origin | a block reference | `block seat=page page=orders` |
| A seat holding no block | a block reference | `block seat=office` |

A place point-anchor refuses for any other reason — a popup, a point outside the content column — is reported in a toast over the composer, and nothing is filed. Every refusal that becomes a block reference is stated as 「指这一整块」 while hovering.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The package has two halves and no session event of its own.

The browser half registers the button in ui-conversation's `conversation.input.left` seat and writes point-anchor's page marker on the console document. A point runs point-anchor's picker for a reference (`createPicker(document, { purpose: 'reference' })`) with every word — the place labels, the refusal reasons — from this package's dictionary. For a place it describes, `src/place.ts` takes off what a reference may not carry before `toPromptReference` holds it to 8192 bytes: a DataPage row, and on an original-system page a control's name, mark and position when the control sits in a table cell, whose text is the record's own, so the control is named by its column and role. For a place it refuses inside a seat as `unsupported-component`, `kit-too-old`, `not-ready`, `unknown-point`, `unknown-model`, `nameless`, `no-column` or `unreadable-frame`, the block around the click is filed instead (`src/block.ts`): the nearest element carrying `data-component-node` inside the seat, with its `data-component-block`; the content-frame page id of an original-system page; else the seat itself; the selected switcher entry's title and a display name from the dictionary are the display text. The picker reports no element for a refusal, so capture listeners added before the picker's own, on the console window and on every frame window within reach, read the click it takes; a click on the shield the picker draws over a page of another origin is placed by its coordinates. A trusted click on the button itself cancels the point there, before the picker would refuse it. The reference is filed with `createReferenceDraft` under the source `content-point`; its payload is resolved unchanged when the message is sent, and the host records it on the accepted message's source.

The host half is one `agent/pre-step` listener. For each user message entering the step whose source records references of the `content-point` source, it inserts right after that message one user message whose source is the `content-point` kind (`{ kind: 'content-point', message: <the user message's id>, form: 'notice', summary }`). Its text has one paragraph per reference, for the first 16 of them — the protocol's bound per prompt. A point-anchor description is read with `parsePointData`, reduced by `src/place.ts` as the browser reduced it, whatever the logged payload holds, and written with `renderPointText`, or in the same three lines with this package's label for a control in a table cell; a block reference is read strictly (`parseBlockData`) and written in the same three lines. A reference whose format this build does not read is written as one sentence naming the stated format and the formats read, labelled with its recorded label, rather than dropped. A step that already holds a `content-point` message naming a user message appends nothing more for it, and each user message enters exactly one step, so each message's points are written once. The row writes no `content-component/shown` and appends no session event.

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

After a user message carrying points, one user message with one paragraph per point, separated by an empty line: the chip's label, the key line, and the display text. A control in an original-system page's table cell is written by its column and role, as 「「名称」列里的按钮」, with no name in its key line. A point without an anchor writes `锚点：没有（…）` with the reason; a reference this build cannot read writes one sentence naming the stated format and the formats read. No paragraph writes a row's values. The chips the user saw are not in the message the user wrote; this message is the only model-visible trace of them.

##### The notice for a column header and a block

```markdown
用户在内容栏里指着「列「名称」」。
锚点：`data-page model=SpaceLayer region=table part=header column=zh_label`
显示：数据页「图层配置」 · 列「名称」

用户在内容栏里指着「指标」这一整块。
锚点：`block seat=component component=el.metric node=rate`
显示：图层配置 · 指标
```

#### Token effect

About 40 to 80 tokens per point, for messages carrying points only; at most 16 points per message.

#### KV Cache effect

Append-only: the message is inserted after the user message it answers, inside the step that message enters, so no earlier request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A form page and an info card are pointed at as a whole.** Outside a data page they carry no `.toy-data-page`, so point-anchor refuses their fields as `unsupported-component` and the point names the block (`block … component=toy.form-page`), not the field. A data page's own form fields are pointed at one by one.
- **A whole block is drawn in point-anchor's refusal style while hovering.** point-anchor draws a refused place as a red dashed box over the element its refusal names, the whole seat, with this package's words 「指这一整块」; the reference filed names the block clicked. A box over the block in an accepting style belongs to point-anchor (T05).
- **No record value reaches the model.** A data page's cell, row and row operation are named by column and operation. A control in an original-system page's table cell is named by its column and role only, so two buttons in one cell, such as 编辑 and 删除 in an 操作 column, read alike; keeping the names point-anchor finds are not the record's own, its name-in-data check, for references too belongs to point-anchor (T05). The model is not told which record the user pointed at.
- **A data page's delete operation is pointed at as the whole page.** kit 0.5.0 describes the row delete icon, which the vendored point-anchor 0.1.0 does not read (`unknown-point`), so the point names the data page block; reading it is planned for point-anchor 0.2.0 (T05).
- **A page of another origin is pointed at as a whole, by the pointer's position.** The picker shields such a frame and refuses it as `unreadable-frame`; the point finds the page seat under the click's coordinates.
- **Keyboard activation in a shielded cross-origin frame.** With focus left on a control inside a frame of another origin, Enter and Space during a pick reach that control; see point-anchor's README. Moving the focus out is planned for point-anchor 0.2.0 (T05).
- **The guard after a pick can last about three seconds.** For `PICK_TAIL_GUARD_MS` (400 ms) after a pick, and again after every swallowed event, up to `PICK_GUARD_LIMIT_MS` (3 s), clicks and activation keys reach nothing, the button and Enter included. This is point-anchor's behavior (T05).
- **The button follows the composer's submission, not its other locks.** It is disabled while the input phase is not `plain`, when the composer refuses attachments; a composer locked for another reason — a removed Session, no workspace, an owner's block, an offline parent — passes its `locked` to the permission and plan seats but not to `conversation.input.left`, so following it is a ui-conversation change.
- **The host does not check a reference again at the JSON boundary.** The references are recorded on the user message's source by the session controller before this row sees them; filtering them there needs a core interface in `session-controller`. The row reads every payload strictly when it writes the notice, so a payload it would not have written is told to the model as unreadable.
- **A fork made at a message carrying points has the message without its notice.** The notice is appended in the step the message enters, after the fork point.
- **The delivery-set check is not yet held to skill-pack's reader.** `tests/equivalence.spec.ts` holds the anchor formats, the archive bytes and the name and path refusals to skill-pack; the vendored point-anchor 0.1.0 has no `checkDeliverySet`, so the test that the two judge a delivery set alike waits for point-anchor 0.2.0 (T05).
- **The vendored tarball's type declarations name source maps it does not carry.** Each `.d.ts` ends in a `sourceMappingURL` comment for a map the package's `files` leaves out; dropping the comments belongs to point-anchor (T05).
- **Not covered by an assembled snapshot.** The `snapshots/console` lane drives ACP, whose prompt carries no references; the evidence is this package's unit suites, the console-profile composition test, and the `content-point` web scenario.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- The vendored point-anchor is a 0.1.0 build of the plugin repository's `feat/point-anchor` at `0eca54e` (tarball sha256 `ab5ae311d315234eeea1aaf567690d048f09cc848887671ce493aea70d06be42`), until 0.2.0 replaces it.
- The button's glyph is ui-primitives' `IconGoalOutlineMedium`, a target, the closest of the shared icons to pointing at something; no icon of the set draws a pointer or a crosshair.
- `src/client/PointButton.module.css` takes one gap of the tool row back while both chip seats of the row's mode box (`conversation.input.permission`, `conversation.input.plan`) are empty, matching them by their `data-slot` attributes and copying the row's 12px and narrow-card 8px from ui-conversation's `InputBar.module.css`. ui-conversation leaves the empty box in the row, and the row's gap on each side of it would otherwise put the button two gaps from 「+」. The `content-point` web scenario holds the distance to the row's gap; the rule goes once ui-conversation drops the empty box from the row's gaps.

</details>
