# Agent Note: content_act — the agent's hands on the page in the column

Status: implemented

English | [中文](2026-09-02-content-act-page-steps.zh.md)

## Problem

`content_read` gave the agent eyes on the page the user is looking at and left it with nothing to do about what it saw. A console user asking for a point to be renamed, a filter applied, a form filled and saved is asking for something the agent can now describe in full and cannot touch. The workaround is the agent reading the page back to the user and the user doing the clicking, which is the arrangement the column exists to end.

Acting is not a host capability either, and for the same reason reading was not: the document lives in an iframe in somebody's browser, under an application's own event handlers, and the host has neither the DOM nor a way to address the browser holding it. It is also the first thing this package does that the user cannot undo by looking away — a click on 删除 is a click on 删除 — so where a read needed a channel, a step needs a channel and a decision.

## Decision

`content_act({ steps, dialogs? })` runs up to `maxSteps` steps of five actions — `click`, `fill`, `select`, `press`, `wait` — in order, against the page the column has in front, stopping at the first failure. It rides the read's channel: the same pending table, the same claim, the same report route, the same four endings when there is no page to act on. What differs is the document posted back and the approval in front of it.

### One call is one approval request, composed from the arguments alone

A `tools/pre-execute` listener escalates every call of this tool to `{ kind: 'ask' }`. The listener delegates first, so a policy, hook or guard that would deny the call still denies it and the user is not asked about something already refused; an allowance is escalated rather than taken. A deployment composing no approval service runs no steps at all — the kernel's own degrade for an ask with nothing behind it.

The request is written before anything has reached a browser. No seat has claimed the call, no page has been read, and the host's own knowledge of the column is a projection of ids and titles it did not draw. So the request names the column's front entry the way the user sees it — 在「当前展示的这一项」上：填「名称」为「东风」；点「查询」 — rather than a page title the host would be guessing at. That is the second reason `label` is required on every step: the user is told what will be clicked and filled, and the only place those names can come from is the call itself.

### The page's own confirmation is a separate agreement

`dialogs: 'accept'` lets the seat answer a `confirm()` the page opens with OK. An approval covering "click 删除" does not cover the confirmation that follows it, so the listener records the call id it asked with whenever the request carried that clause, and the body spends that record before it will answer a dialog with anything but cancel. Every path that reaches the body without the request the user read — a standing allowance, a policy that never asks, a replay, a retry of the same call — therefore cancels the page's dialog. The record is spent on use and the table is bounded at 64 ids; past the bound the oldest is dropped, which is the safe answer in this direction.

### The label is checked against the page before anything is dispatched

Every step but `wait` names its element twice: by the ref a read returned, and by the accessible name that read printed. The seat resolves the ref, computes the name again, and refuses the step when they differ. This is the failure the whole design is arranged around: a page that re-rendered its table between the read and the call has the same refs pointing at different rows, and a step that trusted the ref alone would press whatever now sits there — the one mistake a later read cannot undo. Four more endings stop a step: an element the page no longer has, one it no longer shows, one behind a dialog the page has put in front of the user, and one the page has switched off. The visibility check is the reader's own, walked over the ancestors, and it runs before the name: a hidden element still answers to its name, still takes an event and still runs the handler behind it, so nothing else on the way to a step would stop one — and what the model would be doing is pressing a control the user cannot see.

The check is not an identity. Two rows whose buttons are both called 编辑 pass it, and a page that renumbers and renames together is a page a read has to be taken of again. It is what catches the common case — the page moved — at the cost of one accessible-name computation per step.

### The scope is the reader's, not the frame's

The reader walks into same-origin frames the page itself holds — the product's own topology is a shell page with an application in a frame of it — so a ref the model holds can name an element in any of them. Everything a step does therefore follows the element rather than the frame: the events and the value setter are taken from the element's own window, the settle wait watches the document it acted in, and the dialog check asks each document the element sits inside, from its own out to the frame's, so a dialog holding the frame does not hide what is in it while one drawn over the frame does.

Two things are asked of the page as a whole instead: a `wait` step looks for its text in every one of those documents, and the stand-ins and the message watch are installed in all of them. A `confirm()` an application opens from inside a nested frame blocks the whole tab exactly as one opened by the shell does, which is the only reason the stand-ins exist. The set is fixed when the call starts; a frame the page adds while the steps run is in none of it.

### Not on a page asking the user to sign in

`content_read` refuses to hand over the listing of a page showing a sign-in form. A channel that types into one would be the way around that rule, so the same verdict — the reader's own, taken from the page's header — gates the steps: a call against such a page fails before its first step and says so. The closing read is checked again, because the steps themselves can produce one (a sign-out, a session that expired mid-call), and its structure is withheld from the report the way the read withholds it. The refusal is a wire code of its own, worded by the seat, because the model reaching for `content_act` is the one being told.

### The events are the ones a user produces

A click is `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`, because a framework listening for `mousedown` alone never sees a bare `click`. A fill goes through the prototype's own value setter and then fires `input` and `change`, because React and Vue both track the value they last wrote on the element and an assigned `el.value` is a change they undo on the next render. A key is `keydown`, `keypress`, `keyup` with no form submitted behind it, because what Enter means is the page's decision. A `select` is either the platform's own `<select>` or the two clicks a drawn picker takes: open it, wait for the options, click the one whose text matches.

Between steps the page is given `settleQuietMs` to go quiet, bounded per step by `settleMaxMs`, so a click that opens a dialog has opened it before the step that fills a box inside it resolves its ref. Per step rather than for the run: a page that never stops moving costs one ceiling per step and the steps still run.

### The deadline bounds the run, and the run is checked against it

`actTimeoutMs` is the host's deadline, and it starts when the claim is granted. The steps get three quarters of it and the closing read and the trip back get the rest, so the seat's own clock is the same one the host is watching: a step that would start past the steps' share fails with that said in its own message, the rest are reported as never run, and the report still arrives. Both waits are capped by the same moment — the wait for stillness after a step, and a `wait` step's own budget.

That leaves one arithmetic a deployment can get wrong, so it is refused at load: `maxSteps × settleMaxMs` must come to less than the steps' share of `actTimeoutMs`. Above it, a page that never settles spends the whole deadline before the last step runs, and the model is told the console went quiet with the steps half done — the one ending nothing on either side can describe. The shipped defaults satisfy it with room: 20 steps of a 2000ms ceiling against 45,000ms.

### What the page did on its own comes back with the answer

A step is one event dispatched at one element; everything the application does in answer to it happens afterwards. A toast that came and went leaves nothing for the closing snapshot to read, a `confirm()` nobody answered would block the frame's event loop until the deadline, and a window opened behind the console is one nobody will look at. For the length of the call — and no longer — the seat watches the document for text that appeared and went away, listens for route changes and compares the address, and stands in for `confirm`, `alert`, `prompt` and `window.open`. A link that would open a new window is stopped and reported the same way.

Those two stand-ins are the only thing this package injects into the documents it shares an origin with, and they are put back in a `finally`: a frame left holding this package's `confirm` is a frame whose own dialogs never open again, and nothing in the product would report that. The suite pins the restoration as hard as the interception.

### Three sections, every time, in the same order

What ran or which step stopped the call; what the page did on its own, or one line saying it did nothing; and a whole fresh reading of the page at the deployment's own budget. The third section is what makes the next call possible without reading again, since the refs it names are current — a call that changed the page costs about what reading it costs, and the model does not pay twice. A section that appeared only sometimes would be a section the model stops looking for, so the "none" line is written rather than omitted.

A step failure is a value, not a rejection. The model needs the page's new state in the same answer that says which step stopped it, which is exactly what a rejection cannot carry. Only the endings where nothing ran reject: refused arguments, no owning session, no console. The one ending that is neither is a console that claimed the call and went quiet: the steps may have run in full, in part, or not at all, so it answers `status: 'unverified'` with the sentence telling the model to read the page before deciding to retry.

### The call card is display, and display may not throw

`presentCall` runs on replay of whatever was logged, which includes the arguments this tool refused. So it reads them with the wire's own parser, which answers `undefined`, rather than with the body's, which throws the sentence naming the step and the field to fix: a call the model got wrong once would otherwise throw every time its row was drawn. A call the parser cannot read prints its raw arguments, cut to 200 characters, and the card's title never changes.

### No new session events, and no new bytes

The call and its result are `tool/call` and `tool/result`; the approval is `approval/asked` and `approval/decided`. What the interceptors answered on the page's behalf is in the result's own second section, so the whole model-visible half is reconstructable from the log with no vocabulary added and no `SESSION_FORMAT_VERSION` question raised. Replay never re-runs a step: the result is in the log.

The report route's envelope is unchanged. Every report spends two of the envelope's four names on the call's id and the tab's; a report of steps spends the other two on the page's id and title, and adds the document's title, its body against the budget, and one step list — spending nothing on the address, two of the header fields, or the cursor, which leaves 9,920 bytes of the allowance unspent. Inside that, the step list costs the failing step's message, which is the same 2000 characters the failure arm is bounded by and which the parser holds to one step, plus about 35 bytes of punctuation per step. `MAX_ACT_STEPS = 100` is what keeps that punctuation inside the rest, and `maxSteps` is refused above it at load.

## Alternatives considered

**A tool per action.** `content_click`, `content_fill`, and so on. Rejected on the approval: five tools is five approval requests for one form, and a user reading five sentences one at a time cannot see what is being agreed to. One call carrying the steps that belong together is also the only shape in which "stop at the first failure" means anything.

**Trusting the ref alone.** Simpler, faster, and wrong on exactly the pages this is for: a console table that re-renders on a filter keeps its refs pointing at rows that moved. The name check costs one accessible-name computation per step and turns a wrong click into a refusal.

**A `postMessage` protocol with the hosted application.** Rejected as the wrong seam for the same reason the read did not take it: it would require every hosted application to implement something, and the whole point is that the agent works against the application the deployment already has.

**Recording every DOM change as a page event.** Rejected as unreadable: an application redrawing a list adds hundreds of nodes, and the model needs to know that a toast appeared, not to read the application's render log. What is reported is text that appeared and then went away, bounded at eight things per call and 200 characters each.

**Letting `dialogs: 'accept'` ride the tool's ordinary approval.** Rejected: a standing allowance for `content_act` would then also confirm every dialog the page opens, which is not what a user agreeing to "click 保存" agreed to. The record spent by the call that was asked about is what keeps the two decisions separate.

## Consequences

A deployment with `pageAccess` now offers two tools rather than one, and the second one changes the user's page. Three new `Config` fields carry what that costs — `actTimeoutMs`, `maxSteps`, `settleMaxMs` — all validated at load with the deadline arithmetic self-contained in that block.

The approval is a hard dependency for a working `content_act`, not a soft one: a composition without an approval service offers the tool and refuses every call of it. That is deliberate and it is the kernel's own behaviour; a deployment that wants the tool composes an approval channel.

`PendingReads` is now `PendingCalls` and its per-call deadline is `answerTimeoutMs`, because both tools wait on one table under different deadlines. The `contentAccess` projection's state is a union of the two requests and its `stateVersion` moves to 2.

Two consoles open on one session run one copy of a set of steps, by the same claim that keeps two consoles from answering alternate reads. 删除 is never clicked twice by this channel.

## Follow-ups

- No gestures: no drag, scroll, hover, file upload or right-click, and no way to act on anything a read did not number.
- A call is scoped to the documents the reader had walked when it started; a frame the page adds while the steps run is neither watched nor waited on, and what it draws is left to the closing snapshot.
- Not covered by an assembled snapshot: the browser evidence is a Playwright scenario against a real composition, and the snapshot lanes replay the shipped composition, which composes no experimental row.
