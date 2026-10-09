# Agent Note: A console point reaches the model as one logged notice per message, under a source kind of its own

Status: implemented

English | [中文](2026-10-09-console-points-become-a-logged-notice.zh.md)

## Problem

The console's user asks about what the content column shows — a column of a data page, a toolbar button, a control on an original-system page, a block of the component view — and the question alone does not say which. The core patch `rail-references` lets an owner plugin file a prompt reference that the browser sends with a message and the host records on the accepted message's source, and the first-party provider serializers never put a source into a request. A reference is therefore display and owner data: the model sees nothing of it unless the owner writes text for the model, and the repository rule that every model input is reconstructable from the session log requires that text to be logged.

`agent/pre-step` runs before every step of a turn, not once per message, so text added there is offered again at each step of the turn and at every later turn that replays the history. A data page's description also carries the row it was taken on, up to twenty columns of a record's values read from the row object itself; on an original-system page, a control inside a table cell is named by its accessible name, which is the cell's text — a project title, a person, a phone number. The session log is kept permanently.

## Decision

**`@deepseek-ai/dsh-experimental-content-point` writes the points of a message as one logged user message right after it.** Its host half is one `agent/pre-step` listener. For each user message entering the step whose `user-rpc` source records references filed under the source `content-point`, it inserts one user message after that message; the text has one paragraph per reference — the chip label, the key line and the display text — for at most `MAX_PROMPT_REFERENCES`, 16, of them.

**The inserted message has a source kind of its own, `content-point`, declared with `@persistenceAttribution`.** The source names the user message it answers (`message`) and carries `form: 'notice'` with a one-line summary, so a reader without this package keeps the content and shows the row by its durable kind. It is not a session event and is not `ignorable`; its declaration went through the persistence-type acknowledgement ([record](../../../../docs/persistence-changes/2026-10-09-content-point-source.md)).

**Each message's points are appended once.** The listener appends nothing for a user message that the step already holds a `content-point` message naming, and a user message enters one step: it is removed from the inbox for that step and recorded, so a later step's `messages` hold only messages that arrived since. The notice is recorded beside it in the same step, and every later request replays both from the history. Two rows of the package in one composition draw two buttons and still append one notice, since the outer listener finds the inner one's.

**No record value reaches the reference or the model.** `src/place.ts` reduces point-anchor's description before `toPromptReference` in the browser, and again in the host whatever a logged payload holds: a DataPage description loses `row` and `rowOmitted`; a control inside an original-system page's table cell keeps `page`, `column`, `role` and `in` and loses its name, mark and position, its column standing as its display target and its label written as 「「名称」列里的按钮」; an original-system place without an anchor keeps no display target. A cell, a row and a row operation are named by column and operation.

**Every block of the content column can be pointed at.** point-anchor describes a data page, an original-system page, a picture and a sidebar entry; a block it refuses as a component it does not describe is filed as a block reference (`v: 1, kind: 'block'`) naming the seat, the `data-component-block` and `data-component-node` values and display text, written as `block seat=… component=… node=…`. A place of an original-system page refused as `nameless`, `no-column` or `unreadable-frame` — a page of another origin included, found under the click's coordinates — is filed as the whole page, `block seat=page page=<content-frame page id>`. The block reference lives in this package rather than point-anchor because only the console's component view writes those attributes and the Beiming shell never picks one.

**The row writes no `content-component/shown`.** Its only durable output is the inserted user message.

## Alternatives considered

**A session event of its own, `ignorable: true`.** A model-visible input has to be a message the request is assembled from; an event would need an extractor to turn it into one, and an ignorable event would leave a reader without the package unable to reconstruct a request that included it.

**Rewriting the user's own message to carry the points.** The browser's message is recorded as the user wrote it, with the references on its source; rewriting its content would show the key lines in the user's bubble and lose the separation between what the user typed and what the console added.

**Appending at `session/prompt` time instead of `agent/pre-step`.** The host records the accepted message before a step admits it; a message queued behind a running turn is admitted later, and appending at prompt time would place the notice before the turn's own messages or require a second ordering rule.

**Putting block references in point-anchor.** point-anchor's key lines are shared with the Beiming pick script and the FDE's export, which never see a component view; a `block` anchor there would be a key line no exported skill can match.

**Keeping the row values with a mask.** Values come from the row object, not from what the page draws, so a column the page hides or masks would still be read; the plan defers values until point-anchor can keep only drawn, unmasked columns.

## Consequences

The model is told what the user pointed at for every point, with the same key line an FDE's pick writes, and the log holds exactly the text it was told. A deployment that removes the row keeps readable sessions: the notices stay as content under their kind.

The notice costs about 40 to 80 tokens per point, only on messages that carry points, and is append-only for the KV cache. The model is not told which record a cell or a row operation belongs to, and two controls of one original-system cell, such as 编辑 and 删除, read alike until point-anchor can keep a name it finds is not the record's own for references too. A form page's or an info card's field is pointed at as its whole block until those components carry a description of their own. The equivalence of point-anchor's `checkDeliverySet` with skill-pack's reader is not yet tested; it arrives with point-anchor 0.2.0.
