# Agent Note: A contribution seat on user messages

Status: implemented

English | [中文](2026-08-24-user-message-action-slot.zh.md)

## Problem

Finalized assistant messages carry a contribution seat: `conversation.chat.assistant-actions`, rendered inside that message's IconActions row, is how the feedback strip reaches the transcript. User messages had no equivalent. Their IconActions row shipped copy and a clock and nothing else, and `UserMessageNodeView` declared no children, so a plugin could not place anything there.

The only ways left were wrong in kind. A plugin could shadow the whole keyed `user` entry, replacing the shipped bubble to add one button, or it could put a message-scoped action somewhere that is not the message — which is what the plugins that wanted this actually did, landing in the composer dock or on the assistant row instead.

## Decision

`conversation.chat.user-actions` is a session-scoped list slot rendered inside the IconActions row of user and admitted-steering messages, beside copy and the clock. Entries render by ascending `order`, as on the assistant side.

The chat view declares the seat, not the message renderers. A child slot key has exactly one declaring entry (`SlotCore.register` rejects a second declaration), while `user` and `steering` are two keyed entries sharing one component — so the declaration sits on the `conversation.view` chat entry, which hands every chat node a `renderUserActions` render share through `ChatNodeOwnerProps`. This is the same mechanism `conversation.message.images` already uses to reach several node kinds through `renderMessageImages`.

`UserActionOwnerProps` is the addressed message's durable log position and its rendered text:

| Field | Why |
|---|---|
| `seq` | The `user/message` event position. A user message carries no message id — `messageId` is the assistant-side identity space — so `seq` is the honest identity. |
| `text` | The joined text the bubble already computed for the copy action, so a contributor addresses the message without re-reading the log. |

The owner decides which bubbles get a strip. Durable `user` and `steering` nodes do; the pending steering bubble does not, because it has no durable position to address until the host admits it.

## Alternatives considered

**Declare the children table on both the `user` and `steering` keyed registrations.** Rejected because the slot core forbids it: the second registration throws `slot "conversation.chat.user-actions" is already declared`. One key, one declaring entry.

**Give each kind its own key (`user-actions` and `steering-actions`).** Rejected: it is one seat with one meaning, and a contributor would have to register twice and keep two entries in step to cover a distinction the reader never sees.

**Declare the seat on `user` alone and leave steering bare.** Rejected: an admitted steering message is a user message in the transcript, and the asymmetry would show as actions that appear on some of the reader's own messages.

**Address the message by `messageId`, mirroring the assistant seat.** Rejected: `UserMessageNode` has no id, and inventing a client-side one would create a second identity space for the same message.

**Let plugins shadow the keyed `user` entry.** Rejected: replacing the shipped bubble to append a button forces every contributor to reimplement bubble chrome and makes two contributors mutually exclusive.

## Consequences

A plugin adds a per-message action on the reader's own messages by registering one entry, with no fork of the conversation package. `ChatNodeOwnerProps` gains a required member, so every construction site of that owner currency supplies it — the seat is part of the standard node currency rather than an optional extra some renderers forget.

**Retirement.** This change is carried as a temporary overlay in the fork. If upstream gains an equivalent per-message contribution seat on user messages — in any form, not only this one — the overlay is retired and the fork's plugins adapt to upstream's form; a forked implementation of the same behavior is never maintained alongside it.

No browser snapshot changes. `apps/web/tests/message-feedback-layout.e2e.ts` measures the assistant row through the feedback plugin's rated control; the shipped Web composition has no contributor to the new seat, so the wrapper renders empty and the scenario has nothing to observe. Adding one would mean shipping a test-only contributor into the composition, which the seat's own component test already covers: it pins the owner props for a user node and a steering node, the absence of a strip on assistant tails, and that removing the render site turns the test red.
