# Agent Note: sign-in pages are read, and only a password's value is withheld

Status: implemented

English | [中文](2026-09-04-sign-in-pages-are-read.zh.md)

## Problem

The reader carried a verdict on the page as a whole: a visible password box with a visible box for the account name beside it made the page a sign-in page, and all five content tools refused it. `content_read` answered one sentence in place of the listing, the three markup reads answered the same sentence in place of the page's own spelling, and `content_act` refused before its first step and again on the closing read. [The general-tools note](../simplification/2026-09-03-content-reader-general-tools-only.md) kept that verdict as fail-closed credential protection until the seat could answer to the declarations a page does make — `autocomplete="username"` on the partner box and `current-password` on the password box.

What it refused was the user's own task. Asked to help with a console's sign-in page — one drawing a QR code and a captcha, where what was wanted was the agent's reading of what the page showed rather than any credential — every one of the five tools answered a refusal and nothing else. The page reached the model anyway: the model ran `bash screencapture` over the whole display and read the PNG back through `read_image`, so the credential form arrived as pixels through a tool with no rule about it, along with everything else on the screen at that moment. A gate on one channel moved the same page onto a channel with no gate, and cost the user the read they asked for.

The gate was also a verdict on the wrong thing. What a credential rule has to protect is the value in the box, and the page's shape is a guess about where such a value might be typed later. The reader already withholds the value itself on every path; the page verdict withheld the page around it as well.

## Decision

A page showing a sign-in form is read and acted on like any other page. The page-level verdict is deleted outright, not narrowed.

One credential rule stands, and it is the one that names the credential rather than the page: **a password box's value never reaches the model, on any path.** A control is a password control by its `type` or by a `password` token in its `autocomplete`, on any of the three tags HTML gives an autofill field name to — [`isPassword`](../../../../packages/experimental/content-frame/src/client/access/dom.ts), which every path reads. The box itself is readable: its presence, its ref, its name, its mark and its state all print, so a model can see that a form asks for a password and say so.

| Path | What stands where the value would be |
|---|---|
| `content_read` listing | `= (hidden)`; the value is never collected, in `controlState` |
| `content_read_attrs` | `value=(password withheld)` |
| `content_read_dom` tree line | `(password withheld)` in place of the element's own text |
| `content_read_dom_content` | `(password withheld)` as the whole answer |
| `content_act` step report | `fill "密码" ← (hidden)` |
| `content_act` closing read | the listing's own `= (hidden)` |

### What was deleted

`asksToSignIn` with its `SIGN_IN_PARTNER` and `SIGN_IN_SCOPE` selectors in [`snapshot.ts`](../../../../packages/experimental/content-frame/src/client/access/snapshot.ts); `SnapshotHeader.signIn`; the wire field `ReadSnapshot.signIn`, its parse check, and the `'sign-in'` member of `ReadErrorCode` with its arm of `failureRefusal` and its entry in `ERROR_CODES`; `SIGN_IN_REFUSAL` in `text.ts` and `SIGN_IN_ACT_REFUSAL` in `act-text.ts`; the two host checks in `read-tool.ts` and `markup-tool.ts`; and the three checks in the seat's executor — the header field the read reported, the pre-check before the first step, and the closing read's withholding.

Removing the wire field takes 15 bytes of JSON off every report. `REPORT_SYNTAX_BYTES` stays at 512 — it is a round-up over the measured envelope, and the measurement it is rounded up from moves from 257/301/318 bytes to 242/286/303 — so `REPORT_ENVELOPE_BYTES` and every route bound computed from it are unchanged, and the reports the byte tests are calibrated against are 15 bytes smaller.

### Where the rule does not reach

The approval request `content_act` composes before anything runs writes a `fill` step's text out as the user is asked about it: `填「密码」为「hunter2」`. It is the sentence the user answers, composed from the call's arguments and shown to the person deciding. Whether a password box's value belongs in it is open and is not settled here.

Nothing in this package withholds a credential the user types into the conversation. What is withheld is what a page holds; what a user dictates is a model-visible input and is in the session log by the rule that every model-visible input is.

## Alternatives considered

**Narrow the gate to the declarations a page makes**, which is the retirement condition the general-tools note wrote: answer to `autocomplete="username"` and `current-password` rather than to a password box beside a text box. Rejected by the owner's ruling. It is the same refusal over a smaller set of pages, and the console the user needed read declares neither attribute, so the narrowed gate would have refused that page exactly as the wide one did.

**Keep the gate on `content_act` and drop it from the four reads.** Rejected. The act channel is the one that already asks the user about every step by name before anything runs, which is a stronger check than a rule about the page's shape; and a page the model may read but not act on leaves it describing a form it cannot help with, which is the position the user's task was refused from.

**Withhold the password box itself — its row, its ref and its state — instead of only its value.** Rejected. A form the model cannot see is a form it cannot describe, and the presence of a password box is not the credential. The row is what lets the model say the page is asking for one.

**Leave the gate and answer the screenshot route instead**, by giving the model a way to read the page's drawing without the listing. Rejected: the routing around the gate is a consequence of the refusal, not a missing capability. Two channels reading the same page under different rules is the arrangement that put the whole screen in the transcript.

## Consequences

**The model reads and acts on sign-in forms.** It can list the boxes, print their markup, read a captcha's `alt` text or a QR code's element, and fill and click on the page under the same approval every other `content_act` call takes.

**A refusal fewer to explain.** The read tools' failure set is the four the seat can reach for any read; the act tool's is that set plus the front-changed refusal. `failureRefusal` has one arm fewer and the closed union it switches on ends in the same `assertNever` default.

**The credential rule is one rule with one home.** `isPassword` decides it, every read path asks it, and the README states it once. A page's shape decides nothing.

**A password the user types into the conversation reaches the model and the session log**, by the user's own choice and by the rule that a model-visible input is a logged one. This package's rule covers what a page holds and nothing else.

**The approval window still shows a fill's value on a password box.** Recorded above as open.

## Testing

`pnpm exec vitest run packages/experimental/content-frame` — 696 tests. The gate's own specs are gone; what replaced them pins the reading: `snapshot.client.spec.ts` lists a whole sign-in form with the account box's value printed and the password box's withheld, `content-act-executor.client.spec.tsx` fills both boxes of a sign-in form and reads the report and the closing listing back, and the same suite drives a sign-out that leaves a credential form in front of the user and reads it. The password pins in `markup.client.spec.ts`, `content-act-text.client.spec.ts` and `snapshot.client.spec.ts` are unchanged and are what hold the one remaining rule.

Per-file coverage over this package's `src` stays at 100%:

```sh
pnpm exec vitest run --coverage --coverage.include='packages/experimental/content-frame/src/**/*.{ts,tsx}' \
  packages/experimental/content-frame
```

The four Web fixtures under `snapshots/web/` replay green unchanged — no description, parameter or output schema moved, and none of them drove a sign-in page:

```sh
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read.e2e.ts \
  apps/web/tests/content-act.e2e.ts apps/web/tests/content-read-dom.e2e.ts apps/web/tests/content-read-attrs.e2e.ts
```
