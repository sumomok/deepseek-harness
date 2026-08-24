# Agent Note: A timed-out render says what the page was waiting for

Status: implemented

English | [中文](2026-08-22-render-timeout-diagnostics.zh.md)

## Problem

On Windows, DSH Desktop 0.1.0-rc.17, an agent was asked to screenshot a Redmine instance behind a login. Every logged-in Redmine page carries a gravatar.com avatar, and gravatar.com was blackholed on that network, so every image request sat in TCP connect until Windows gave up on it about 21 seconds later. The [render service](2026-08-22-desktop-render-service.md) waits for the full `load` event — `await window.loadURL()` resolves on did-finish-load — under a 25-second deadline, so a page carrying one avatar took about 22 seconds and an issue list carrying several went past the deadline.

What the tool then handed the model was `504 render timed out after 25000ms`, one sentence and nothing else. That line is true and useless: it cannot distinguish a hung subresource from a dead proxy, a wrong port, a redirect to a login page, or a renderer that stopped painting, and every one of those is a different next step. The model picked one of the wrong ones and spent 36 minutes and roughly 200 tool calls rewriting a cookie proxy that was not what was failing. A line reading `main document 200, load event not fired, 7 requests pending: [image] https://www.gravatar.com/avatar/…` would have ended it at the first call.

## Decision

The service owns a `RenderTrace` per accepted request, the window half fills it in, and the 504 body is one line built from it.

**The trace is the service's, and the renderer only writes to it.** `startRenderService` creates one `RenderTrace` in `runQueued` for each admitted request and passes it as the renderer's third argument, so `Renderer` is now `(request, signal, trace) => Promise<Buffer>`. It records three things: the phase the render is in — `queued` at creation, then `navigating`, `loaded`, and whichever of `delaying`, `measuring`, `resizing`, and `capturing` the request actually reaches; the main frame's final URL and HTTP status, from `did-navigate`; and the requests the page has started and not finished, keyed by Chromium's request id and held in insertion order so the oldest are the ones printed. Settling an id that was never started is a no-op rather than an error, because a response served from the cache completes without ever having sent headers — the started set and the settled set are not the same set. `RenderTrace` and its phase union are exported, which is what lets the unit suite drive the real thing rather than a stand-in.

**The window half feeds it from non-blocking observers only.** `render-window.ts` registers `did-navigate` on the `webContents` and `onSendHeaders`, `onCompleted`, and `onErrorOccurred` on the render's own session, before the load. `onSendHeaders` fires before the connection is made, which is exactly why a request stuck in TCP connect — the incident's case — counts as pending. Nothing here changes the render: these three observe, where the blocking hooks hold each request until their callback runs and would alter the timing they exist to report.

**The line is built once, before the abort.** The deadline timer reads `trace.describeTimeout(timeoutMs)` first and aborts second, because the abort destroys the window and the session then reports every in-flight request as failed, emptying the list the line is there to name. `RenderTimeout` now carries that whole line as its message, so it reaches the caller through the existing `fail(response, 504, error.message)` path with no other change.

**What the line says**, keeping the leading `render timed out after <ms>ms` that callers and the README grep for:

| Phase | The line after the deadline |
|---|---|
| `queued` | `the render had not started (queued behind earlier renders)` |
| `navigating`, nothing from the main document | `no response from the main document yet, 2 requests pending: [mainFrame] …, [other] …` |
| `navigating`, main document answered | `main document 200, load event not fired, 7 requests pending: [image] …, [image] …, [script] … (+4 more)` |
| `loaded` and later | `page loaded, timed out while waiting delayMs` / `while measuring the document` / `while resizing the window` / `while capturing` |

Where the main frame landed is appended to the status when it is not where the request pointed — `main document 200 at http://127.0.0.1:18099/login?back_url=…` — which is how a redirect to a login page becomes visible. A navigation Electron reports no HTTP status for reads `main document with no HTTP status`. Zero requests in flight while still navigating is printed as `no requests pending`, because that is itself the signal: the page is not waiting on the network.

**It is bounded to fit its reader.** `@haoran/dsh-screenshot` quotes the first 500 characters of an error body into the message the model sees (`MAX_ERROR_DETAIL` in its `lib/types/desktop.js`), so the line lists at most 3 pending URLs, cuts each at 96 characters, counts the rest as `(+N more)`, and cuts the whole line at 500 — each cut ending in an ellipsis, so the model can tell that something was dropped rather than reading a sentence that stops mid-word. The three constants sit at the top of `render-service.ts` with the reason for each.

## Alternatives considered

**Block on `onBeforeRequest` and time each request.** It would give exact per-request durations rather than only "started and not finished". Rejected: the blocking hooks hold every request until their callback runs, so the diagnostic would be inside the timing it reports — a render that timed out could have timed out because it was being measured. A diagnostic that can change the outcome it describes is worse than a coarser one that cannot.

**Attach `webContents.debugger` and read the Network domain.** It carries far more — timings, status per request, response headers — and it is what a devtools panel would show. Rejected on cost and posture: it attaches a debugger to every render rather than to the one that went wrong, it is a second protocol to keep working across Electron upgrades, and none of the extra detail changes the caller's next step, which is the only thing this line is for.

**Capture the partial page on timeout and answer 200 with what had painted.** Often the most useful answer of all — a page whose avatars hang has usually already laid out. Rejected here as a different decision: it changes what the protocol means by success, so a caller can no longer read 200 as "this is the page", and it needs its own answer for how a partial capture is labelled. Deferred, not refused — [the render-report note](2026-08-23-desktop-render-report.md) ships it as the per-request `onTimeout: 'capture'`, where only a caller that asked for it can receive one and `outcome: 'timeout'` labels it.

**Report the diagnostic on a response header for successful renders too**, so a slow-but-successful render also says what it waited for. Rejected for now: the plugin reads the body of a failure and the bytes of a success, so nothing would read the header without a plugin change, and the plugin is a vendored tarball this repository does not own. [The session and output note](2026-08-22-screenshot-session-and-output.md) reverses this for the one fact that matters — where the main frame landed — by shipping both halves together. [The render-report note](2026-08-23-desktop-render-report.md) reverses the rest of it on the same ground, putting the whole record on `x-dsh-render-report` for every answer a render reached.

**Leave the 504 alone and tell the model to retry with a longer deadline.** Rejected: the shell's deadline is pinned below the plugin's own 30-second budget, so there is nothing to lengthen, and a retry against a blackholed host produces the same 504 more slowly.

## Consequences

A 504 now names third-party hosts the rendered page loads. That is what the caller needs — it is the difference between "the page is slow" and "gravatar.com does not answer on this network" — and it is worth stating plainly that the line therefore reports where the page pointed the browser, in a body that reaches the model. Nothing is reported that the page did not itself request.

The line is bounded twice over, by the per-URL cut and by the whole-line cut, so a page with very long URLs cannot push the caller's 500-character quote past the phase and the status. The leading `render timed out after <ms>ms` is unchanged, so anything matching on it still matches.

Nothing about the render itself changed: same window, same isolation, same limits, same queue, same deadline. A render that used to succeed still succeeds, and a render that used to time out still times out — at the same moment, with a longer sentence.

## Testing

`apps/desktop/tests/render-service.spec.ts` drives the real `RenderTrace` from an injected renderer and asserts the exact line for every shape above, plus the `(+N more)` overflow, the 96-character URL cut, the redirect form, a settled request leaving the pending list, a settle for an id that never started, and that the line is one line of at most 500 characters when every URL is long enough to overflow it.

`apps/desktop/scripts/render-smoke.mjs` covers the half no injected renderer can: it starts a `net` listener that accepts connections and never answers, renders a `file:` page whose only image points at it under a 2-second deadline, and asserts the 504 body says `load event not fired` and names that image — which is the assertion that the session's `webRequest` hooks actually reach the trace.
