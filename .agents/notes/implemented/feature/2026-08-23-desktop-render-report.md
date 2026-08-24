# Agent Note: Every render answers with a report, and a deadline can answer with pixels

Status: implemented

English | [中文](2026-08-23-desktop-render-report.zh.md)

## Problem

[The timeout line](2026-08-22-render-timeout-diagnostics.md) told the model *what* the render was waiting for and stopped there. Two more sessions on the same Redmine showed what that leaves out. A page whose gravatar.com avatars sit in TCP connect takes 21–22 seconds per round, so the 25-second deadline passes; the model gets one 504 line, no pixels at all for a page that had laid out everything but its avatars, and no knob it can turn. Nothing in the protocol let it ask for longer, and nothing let it say "render this without that host". It wrote its own proxies for 36 minutes instead.

Three separate gaps, all of them in the request: the answer is unstructured, so anything past the first sentence has to be parsed out of English; the failure throws away pixels the compositor already had; and every bound belongs to the shell or to the plugin's deployment config, where a model reasoning about one call cannot reach it.

## Decision

The service answers every render with a structured report, a request owns its deadline and says what a passed one produces, and a request can name hosts it does not want reached.

**The report is the trace, taken as a snapshot.** `RenderTrace.report(outcome, deadlineMs)` returns a `RenderReport` — outcome, phase, elapsed against the deadline, the main document (URL, status, redirect, title), whether the load event fired and whether anything painted, request counts, the oldest pending requests, the first failures, the worst hosts, console errors with samples, the main-frame load failure, what became of the render process, and the size of the pixels the answer carries. The window half feeds all of it from main-process events — `did-navigate`, `did-redirect-navigation`, `page-title-updated`, `ready-to-show`, `did-fail-load`, `console-message`, `render-process-gone`, `unresponsive` — and the session's non-blocking `webRequest` hooks. `ready-to-show` is Electron's only first-paint signal for a window that is never shown, and it fires at all only because `paintWhenInitiallyHidden` is set. `onCompleted` and `onErrorOccurred` now carry their status and error into the record instead of only closing the request; settling an id that never started stays a no-op, so `completed` can never exceed `total`.

**It travels on a header, not in a body.** `x-dsh-render-report` carries the JSON percent-encoded, on the 200, on the 500 a failed render is refused with, and on the 504 — the same encoding as `x-dsh-render-landed-url`, which stays. The two answers that need the report most already own their body: a 200 is PNG bytes and a 504 is the one line humans, logs, and the smoke read. A body would mean a second success format the caller has to branch on; a header means one reader for every outcome, and the existing bodies stay byte-for-byte what they were. A refusal no render was started for — a validation 400 or 422, the 401, the 404, the 503 — carries no report, because there is nothing to report.

**The budget travels with the request; the shell keeps only a ceiling.** `timeoutMs` is validated against `[1000, RENDER_LIMITS.maxTimeoutMs]` (120 s) and refused outside it rather than clamped into it: a caller that asked for three minutes and silently got two arms its own abort on the number it sent and gives up before the answer arrives. A request that names none gets `RENDER_LIMITS.timeoutMs`, still 25 s, so every caller written before the field exists is unchanged. This ends the coupling [the render-service note](2026-08-22-desktop-render-service.md) had to state as a rule — that the shell's deadline must stay under the plugin's 30-second fetch budget or none of the shell's answers reach the model. The plugin now sends the budget and arms its abort at `timeoutMs + 5000`, so the ordering holds by construction instead of by two constants agreeing in two repositories. The floor and the ceiling are resource invariants and stay constants; the number that varies by deployment is the one the caller sends.

**A passed deadline can answer with pixels, and only when the request asked.** `onTimeout: 'capture'` makes the deadline take `capturePage()` of what had painted and answer 200 with `outcome: 'timeout'` and `capture.partial: true`. [The timeout-diagnostics note](2026-08-22-render-timeout-diagnostics.md) deferred exactly this because it changes what 200 means; making it opt-in per request is what settles that. A caller that did not ask can still read 200 as "this is the page", and one that did asked for the other meaning in the same call it reads the answer from — no shell configuration, no version negotiation. The renderer lends the service the capture through `offerCapture`, because it owns the window; the service takes it at the deadline, capped at `captureOnTimeoutMs` (3 s), swallowing every failure into the ordinary 504.

**The order at the deadline is report, release, capture, abort.** The report is taken before anything else, for the reason the 504 line already had: the abort destroys the window and the session then reports every in-flight request as failed, emptying the list the report exists to name. The queue is released next — before the capture rather than after it — so a `capturePage` that never settles holds nothing but its own window, exactly as an unsettling renderer already does. The abort comes last, because it takes the window the capture reads from. The cost is one window alive beside the next render for at most three seconds, which is bounded and which the abandon race already allowed.

**`blockHosts` is the remedy the report names.** Up to 32 patterns, each an exact host or `*.suffix` matching that suffix's subdomains and not the suffix itself, cancelled in `onBeforeRequest` and counted in `requests.blocked`. A pattern matching the rendered page's own host is a 400 naming it, since a render that cancels its own document fails with nothing to say. This is the one blocking `webRequest` hook the shell registers, and it is registered only for a request that carries the field — the timing argument that kept the diagnostic hooks non-blocking still holds for every render that names no hosts. `blockedByPattern` is exported from the service so the grammar the validator refuses by and the grammar the window cancels by are one function.

**The encoding escapes `%`, which is what makes it exact.** `headerSafeText` escapes every byte outside printable ASCII and `%` with them, so the wire value is precisely what `decodeURIComponent` inverts. Passing a literal `%` through hands the reader an escape the text never had: a URL carrying `%20` arrives with a space in it, and a bare `%zz` — legal in a URL, common in a badly built one — throws the reader's decode and costs it the whole value rather than one character. This applies to `x-dsh-render-landed-url` too, which shares the function: a reader of either header decodes it, and neither is ever read as a URL directly.

**Bounded by construction, counted in header bytes.** Every list is capped (5 pending, 5 failures, 5 hosts, 3 console samples) and every string cut — 96 bytes for a URL, host, or title, 160 for a message, 64 for a `net::ERR_…` code, 32 for a resource type or a renderer-gone reason. The caps count what the string costs in the encoded header, not characters, because JSON escaping and percent-encoding cost up to six bytes for one source byte, and a `%` costs three; a cap in characters would bound nothing for a page whose URLs are in Chinese or full of escapes. With every list full the header measures 4.2 KB under a 6 KB ceiling — 4254 bytes for ASCII strings, 4223 with every string made of `%`, 4160 in Chinese, since a capped string costs its cap whatever it holds. Nothing ever cuts the finished JSON, which would produce a header no reader can parse.

**Where the bounded clauses sit is the same rule as the line's.** [The session-and-output note](2026-08-22-screenshot-session-and-output.md) put the retry hint ahead of the pending list because everything ahead of it is bounded while the list grows with the page, so a tail cut lands in the list rather than on the advice. The report keeps the ordering discipline in its own shape: the fixed-size fields the caller acts on — outcome, elapsed against deadline, main document, counts — are single values that no page can grow, and the only fields that scale with the page are the four capped lists. The plugin's summary text is built in that order for the same reason.

## Wire contract

| Field | Direction | Meaning |
|---|---|---|
| `timeoutMs` | request | This render's deadline from acceptance, 1000–120000; absent means 25000 |
| `onTimeout` | request | `fail` (504) or `capture` (200 with what had painted) |
| `blockHosts` | request | Up to 32 `host` or `*.suffix` patterns cancelled before they go out |
| `x-dsh-render-report` | response, 200/500/504 | The whole `RenderReport` as JSON, percent-encoded so `decodeURIComponent` returns it exactly, at most 6 KB |

Both failure bodies are unchanged, so a caller that reads only those is unaffected by any of this. `x-dsh-render-landed-url` keeps its name, its condition, and its 96-character cut, and its encoding gains the `%` escape above: a landing carrying `?back_url=%2Fissues` now reaches the wire as `%252Fissues`, and a reader decodes it.

## Alternatives considered

**Answer the report as a JSON body.** The obvious shape for structured data, and it costs the two answers that need it their existing bodies: a 200 would stop being PNG bytes, or would need a multipart format, and a 504 would stop carrying the sentence the smoke and the logs read. Rejected: the header is additive, and every existing reader keeps working.

**Make partial capture the default, or a shell setting.** Both were considered and both break the same thing. As a default it changes what a 200 means for every caller including old ones, which is precisely why [the timeout-diagnostics note](2026-08-22-render-timeout-diagnostics.md) deferred it. As a shell setting it makes the meaning of an answer depend on a deployment the caller cannot see, so a plugin would have to negotiate it. Per request, the caller that reads the answer is the caller that chose the meaning.

**Clamp `timeoutMs` to the ceiling instead of refusing it.** Fewer errors, and a silently shorter deadline is worse than a refusal: the caller arms its own abort on the number it sent, so it gives up before the shell answers, and the diagnosis it needed is the answer it never waited for.

**Keep the shell's deadline authoritative and let the plugin configure its own.** What shipped before, and the coupling it produced is the reason for this change: two constants in two repositories had to keep an inequality, and when they did not the plugin's abort fired first and every answer the shell wrote for the model was discarded.

**Block hosts by URL pattern or by regular expression.** More expressive, and it makes the refusal of the main document's own host undecidable in the general case; it also invites a caller to block a path and be surprised that the page still fetches it from another. A host is the unit the field exists for — the report names hosts, and the caller pastes one back.

**Count dialogs, and offer `waitUntil` modes.** Both were in scope and both are out. Electron gives the main process no signal for a dialog that `disableDialogs` already suppressed, so counting them means page-world code — and page-world `executeJavaScript` on a wedged renderer is the known hang this service works around, not a place to add a second call. `waitUntil: 'domcontentloaded'` would help the same pages `onTimeout: 'capture'` helps, with a second meaning for success and no report of what was still missing; the partial capture answers the same need and says what it left out.

**Take the partial capture after the abort.** Simpler ordering, and impossible: the abort destroys the window, so there is nothing left to capture. Releasing the queue before the capture is what keeps that ordering from costing the queue anything.

## Consequences

A caller can now act on a failure instead of only reporting it: the report names the host, and `blockHosts` is what to do about it. A page that hangs on a third-party host answers with pixels and a diagnosis in one call, where it used to answer with one sentence and an hour of proxy-writing.

The `Renderer` type changed twice over: it returns a `Capture` (`{ png, width, height }`) rather than a `Buffer`, so a complete render and a partial one report their size the same way, and it takes an `offerCapture` argument. Anything implementing that seam updates with it — inside this repository that is `renderInHiddenWindow` and the unit suite's injected renderers.

`RenderTrace.requestSettled` is now `requestCompleted(id, statusCode)` and `requestFailed(id, error)`, because the report distinguishes a request that answered 503 from one that never answered at all.

`x-dsh-render-landed-url` is percent-exact where it was not. A reader that printed the header verbatim showed the right URL for a landing with no `%` in it and a wrong one for a landing with an escape; it now decodes, and gets the URL Chromium reported in both cases.

A render can now hold its window for up to three seconds past its deadline while a capture is taken. The queue does not wait for it, and the window is destroyed either way, so what this costs is at most two live windows for that interval.

The report reaches the model, and it names third-party hosts the page itself requested, the page's title, and its console errors. That is the point — it is the difference between "the page is slow" and "gravatar.com does not answer on this network" — and it is worth stating plainly that a tool result now carries that much of what a rendered page said.

## Testing

`apps/desktop/tests/render-service.spec.ts` drives the real `RenderTrace` and the real protocol against injected renderers: the report on a 200, a 500, and a 504; the counts, the capped lists, the worst-host ordering and the failure list; console counting and sampling; the redirect, title, paint and renderer fields; that a refusal no render reached carries no report; that a request's own `timeoutMs` replaces the deployment default and that an out-of-range one is refused with the message naming both bounds; `blockedByPattern`'s grammar directly; every `blockHosts` refusal including the two forms that match the rendered page's host; `onTimeout: 'capture'` answering 200 with `outcome: 'timeout'` and `capture.partial`; a capture that throws, one that was never offered, and one that never settles — the last asserting the order two concurrent requests are answered in, which is what proves the queue advanced while the capture ran.

Two cases pin the header's bound rather than its content: 100 pending requests with 2000-character URLs, 60 failures, and 50 console errors, and the same shape written in Chinese and again in `%` signs. All assert the encoded header is at most `REPORT_HEADER_BYTES` and still parses, which is what a bound expressed in characters would fail. Two more pin the encoding itself: a report whose requested URL, landing, title, and console sample carry `%20`, a bare `%`, a malformed `%zz`, and Chinese, asserting that `JSON.parse(decodeURIComponent(header))` returns those strings unchanged and that no `%` on the wire opens anything but a real escape — and the same round trip for `x-dsh-render-landed-url`.

`apps/desktop/scripts/render-smoke.mjs` covers what no injected renderer can. A page whose only image points at a listener that accepts and never answers is rendered three ways against a real Chromium: with `onTimeout: 'capture'` under a 2-second budget it answers 200 whose PNG decodes at the requested viewport with the hanging host named in the report; with `blockHosts: ['127.0.0.1']` it completes in about 85 ms with `requests.blocked` at 1 and the load event fired; left alone it is the 504, whose report names the same image its line does. A page that calls `console.error` proves `console-message` and the title reach the report, and the viewport case now asserts the report's `capture` size and `firstPaint`.
