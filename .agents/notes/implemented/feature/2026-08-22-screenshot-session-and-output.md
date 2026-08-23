# Agent Note: The screenshot tool renders the page it was pointed at

Status: implemented

English | [中文](2026-08-22-screenshot-session-and-output.zh.md)

## Problem

Two sessions, on two platforms, were asked to write an illustrated operations manual for a login-protected Redmine at `http://117.73.8.33:30010/`. Both called `screenshot` once, got the sign-in page, and abandoned the tool.

The Windows session, on rc.17, wrote `proxy.mjs` — a cookie-injecting reverse proxy in front of the Redmine — and edited it 28 times across 14 restarts. When that produced images it still could not find them as files, so it wrote `grabshot.ps1` to scavenge PNGs out of `~/.dsh/attachments/v1/objects/` by modification time and size. That broke too: the attachment store is content-addressed, so re-capturing an identical page writes no new object and the newest-file heuristic returns the previous capture.

The macOS session wrote `/tmp/redmine_proxy.py` for the same reason, gave up on the tool entirely, and wrote `/tmp/batch_shots.sh` to drive its own headless Chrome into an `images/` directory. It also searched the installed application for a bundled playwright or puppeteer.

Neither session ever reconsidered the built-in tool, and the reason is in the session logs rather than in the models. The assembled system prompt carries eleven `Use the X tool` directive lines — read, write, edit, glob, grep, web_search, goal, workflow, ralph, subagent, subagent_fork — and none for `screenshot`. Its only appearance there is the negative one in the code-mode section: *the browser provides no implicit DOM, route, or screenshot context*. The tool's own description said `Use it to verify visual work (layout, colors, spacing) against a reference before calling it done`, which frames a capture instrument as a CSS self-check for pages the agent wrote itself. A parameter added to a schema nobody re-reads is not a capability, and neither is a tool the prompt never names.

The same tool also returned an image whose size depended on the machine. `capturePage` returns a bitmap at the display's scale factor, so `screenshot({ width: 900, height: 700 })` stored 1800x1400 on a Retina Mac and 900x700 on Windows. Under rc.17's admission limit of 2000 px that made the tool's own default viewport — 1024x768, captured as 2048x1536 — fail outright with `IMAGE_DIMENSION_TOO_LARGE`. [rc.18 raised admission to 8192 and normalizes anything larger down to 2048](2026-08-20-unified-image-request-pipeline.md), which ends the failure and leaves the size wrong: 1440x900 comes back 2048x1280, neither the requested viewport nor a clean multiple of it, while `width` and `height` are documented to the model as viewport pixels.

## Decision

`@haoran/dsh-screenshot` 0.1.4 and the shell's render service carry a session, name where the render landed, write a file, and return the size that was asked for.

**A request may carry `headers` and `cookies`.** Both are name→value maps of strings. The plugin checks that the model wrote strings and non-empty names and sends them on; the render service owns the bounds, because it is the side that performs the request. `render-service.ts` validates them in `resolveRequest`: 24 entries and 8 KB across both maps together, names against the RFC 9110 token grammar, header values against visible ASCII plus space and tab, cookie values against RFC 6265 cookie-octet. A `cookie` header is refused by name and pointed at the `cookies` field. Headers or cookies on a `file:` URL are a 422.

The two fields do different things and the difference is the reason both exist. `render-window.ts` sets cookies through `session.cookies.set` on the render's own in-memory session before the load, so they cover every request the page makes — a signed-in page whose images all 401 is not the page anyone asked to see. Headers go on `loadURL(url, { extraHeaders })`, which is the main-frame navigation only, which is what a bearer token or a host override wants. Every isolation property is unchanged: the per-render `partition:` session, denied permissions, no downloads, no dialogs, muted, destroyed on every exit. The caller supplies the credential and the shell keeps none of it.

**The cookie is set at path `/`, and the path is explicit because the default is a directory.** `session.cookies.set` called without `path` leaves Chromium applying RFC 6265's default-path, which is the directory of the URL the cookie is set from — not the site. Rendering `/deep/page.html` with `cookies: { probe: 'yes' }` and `headers: { 'x-note': 'hello' }` against a real Electron, the server saw:

```
/deep/page.html   cookie=probe=yes    x-note=hello
/api/pixel.png    cookie=(none)
/deep/sib.png     cookie=probe=yes
```

A cookie scoped to `/deep/` covers the document and its neighbours and reaches nothing under another top-level path, while the render still succeeds and still returns a plausible-looking image. That is the primary use case: an application serves its pages from `/app/…` and its data from `/api/…`, so a directory-scoped cookie arrives at the API signed out and the capture is the empty or signed-out page this field exists to stop returning.

`path: '/'` rather than a prefix computed from the URL, because the caller named a cookie for the site and not for a directory, and a real session cookie is issued with `Path=/`. Nothing is widened by it: the session is the render's own in-memory one loading a single page, so a site-wide cookie has no other page to reach, and it dies with the window. `domain` stays unset, which keeps the cookie host-only — the caller supplied a credential for the host it named. The caller cannot change either, because the cookie-octet grammar refuses the `;` that would begin an attribute.

**A successful render says when it is not the page that was asked for.** The service already knew: `RenderTrace` records the main frame's landing from `did-navigate`, and [the timeout line](2026-08-22-render-timeout-diagnostics.md) names it. `RenderTrace.landedElsewhere()` now exposes it, `runQueued` reads it after the render, and a 200 carries `x-dsh-render-landed-url` when the frame ended somewhere other than the requested URL — percent-encoded outside printable ASCII, cut at 96 characters, and compared after URL normalization so the trailing slash Chromium adds to an origin is not a redirect. The plugin turns the header into one sentence in the tool result:

```
The main frame ended at http://10.0.0.4:30010/login?back_url=/issues, not the requested URL: the site redirected the render, so pass cookies or headers to capture it with a session.
```

It is in the result text rather than an error because the render succeeded; the 500-character discipline the plugin imposes on quoted error bodies does not apply, and the landing is bounded at the shell instead. A screenshot of a sign-in page returned without comment is what sent both sessions down the proxy path.

**A timed-out render says the same thing, in the same words.** [The timeout line](2026-08-22-render-timeout-diagnostics.md) names where the main frame ended — `main document 200 at http://10.0.0.4:30010/login?back_url=/issues` — and carries the retry beside it: `pass cookies or headers to capture it with a session`, the clause the success sentence ends with, so a caller reads one instruction whichever way the render ends. The condition is what the service actually knows, `RenderTrace.landedElsewhere()`, not a sign-in page. A `file:` render that navigated away names its landing and stops there, because `resolveRequest` answers 422 to headers or cookies on that scheme and advice the service refuses is worse than none. A phase after the load names the landing too — `page loaded at http://127.0.0.1:18099/login, timed out while capturing` — so the retry never appears without the fact it follows from.

**Where that clause sits in the line is the decision.** It is printed before the pending list, not at the end. Everything ahead of it is bounded — the deadline, a status, a landing URL cut at 96 characters, and fixed wording, under 250 characters together — while the pending list grows with the page, and `TIMEOUT_LINE_CHARS` cuts the line's tail at 500 because that is all of an error body the plugin quotes. A retry appended after the list is therefore dropped on exactly the pages where a stuck render is hardest to explain: the ones with the most requests in flight. Putting it first costs the tail of the third pending URL in the worst case, which is the cheapest thing in the line to lose, because a URL is cut from its end and the host that says which request is stuck is at its front. Measured on the incident's own shape, the line runs 353 characters with the retry in it; the worst case the unit suite drives — a cut landing URL and twelve long pending URLs — reaches the 500-character cut with the whole retry clause and the start of the pending list still ahead of it.

**The system-browser backend refuses rather than pretends.** `renderScreenshot` chooses the backend, and a call carrying headers or cookies on the `--headless=new --screenshot` command line fails there with one sentence naming the limitation. Dropping them silently would return exactly the artefact this whole change exists to eliminate.

**`outputPath` writes the PNG to a file.** The image block is unchanged and still the thing the model looks at; the file is what the rest of the work can use. A relative path resolves against the calling session's workspace (`exec.agent.session.header.cwd`), matching every other file-writing tool in the harness, and the resolved path must stay inside it. Missing parent directories inside the workspace are created, an existing file is replaced, and the result says which path it wrote and whether it replaced anything. A call with no session cannot ask for a file at all, because there is no workspace to place it in.

The write is a plain `node:fs` write. `ctx.fs` has no byte write — `writeText` takes UTF-8 text — so a PNG cannot go through the filesystem seam, and the plugin declares no sandbox dependency it could consult for the caller's real writable roots. The session workspace is the boundary this plugin can enforce honestly, and it is narrower than any deployment policy rather than wider.

**The description says what the tool is for, and one prompt line says it again where the model will read it.** The description now opens `Render any page in a headless browser and return what it looks like as an image` and names `cookies`, `headers`, and `outputPath`; the CSS-self-check framing is gone. `applyScreenshotTool` registers the tool and one section together, in the voice of the harness's own eleven:

```
Use the screenshot tool to look at any page as pixels — your own HTML or CSS work, or a live site you need to see, including one behind a login: pass cookies or headers to render it with a session, and outputPath to save the PNG as a file as well.
```

`ctx.systemPrompt.section({ name: 'tool:screenshot', order: 100, … })` is the same public registry `tool:read`, `tool:write`, and `tool:edit` use, at the same order; the plugin adds `systemPrompt` to its `inject` and a peer dependency on `@deepseek-ai/dsh-system-prompt`. Nothing in `packages/` changed. This tool earns the line where other plugin tools do not because the failure is measured rather than assumed: two sessions, two platforms, one wall, and roughly an hour of work each spent rebuilding the missing parameter out of proxies and file scavengers. What this measured generalizes to — a parameter added without changing the description is not added, a failure message is where a missed parameter is cheapest to recover, and a prompt section needs a recorded reason — is in [the tool cookbook](../../../../docs/cookbook/adding-a-tool.md).

**The capture is the requested size.** `render-window.ts` resizes the captured `NativeImage` to the requested CSS pixels before encoding — `image.resize({ width, height, quality: 'best' })`, verified against `electron@43.4.0`'s `electron.d.ts` (`resize(options: ResizeOptions): NativeImage`, with `quality` one of `good | better | best`) — and skips the resize when the capture already is that size. A full-page capture resizes to the requested width and the content height it measured and set the window to. The window keeps the display's own scale factor: `--force-device-scale-factor` is process-wide and would change the user's visible window to fix a screenshot. Downsampling a 2x capture to 1x keeps everything a 1x render would have had.

## Wire contract

| Field | Direction | Meaning |
|---|---|---|
| `headers` | request | Name→value map; applied to the main-frame navigation |
| `cookies` | request | Name→value map; set on the render's session before the load at path `/`, covering every request the page makes |
| `x-dsh-render-landed-url` | response, 200 | Where the main frame ended, when that is not the requested URL |

The plugin sends `headers` and `cookies` only when a call carried them, so a request that names neither is byte-identical to the one rc.18 sent. A shell that cannot honour them must refuse the request; the README states that as the contract a shell implements against.

## Alternatives considered

**A cookie-injecting reverse proxy, and a tool that scavenges the attachment store.** Both sessions built exactly these, and both are the right instinct applied to the wrong layer: a proxy reimplements request headers outside the browser that already sends them, and a scavenger reimplements a file path outside the tool that already has the bytes. The proxy costs a process, a port, and a rewrite per site; the scavenger cannot work at all against a content-addressed store, which is what its `Get-ChildItem | Sort-Object LastWriteTime` discovered the hard way. Rejected as evidence rather than as a design: they are what a caller does when the parameter is missing, and they are the measurement of what it cost.

**Force a process-wide device scale factor.** One switch — `app.commandLine.appendSwitch('force-device-scale-factor', '1')` — and every capture is 1x with no resize. Rejected: it is process-wide. The user's own window is in that process, and making it render at the wrong scale to make a screenshot come out right trades a visible product defect for an invisible one.

**Leave the description alone and let the schema carry the new arguments.** Cheapest possible change, and the one the evidence refutes: the model that abandoned this tool did so with a complete schema in front of it. The description and the prompt line are the change; the parameters are what they point at.

**Report the landing on failure only.** [The timeout-diagnostics note](2026-08-22-render-timeout-diagnostics.md) rejected a success-path header on the ground that nothing would read it — the plugin was a vendored tarball this repository does not own. That reason is gone: this change ships both halves together, and the success path is the one the incident actually took, since a redirect to a sign-in page renders fast and answers 200.

**Append the retry at the end of the timeout line.** The obvious placement, and the one the 500-character cut defeats: a page with a dozen requests in flight overruns the line, and the tail is what goes — so the advice disappears from the renders that need it most. Rejected on that arithmetic.

**Reserve room for the retry and truncate the pending list to fit it.** Guarantees both halves and keeps the diagnostic reading order. Rejected as machinery for something ordering already does: with the retry ahead of the list, the only place the cut can land is inside the list, which is what the reservation would have arranged.

**Detect the sign-in page.** Rejected: the service knows where the main frame ended and nothing about what is on it, so a detector would be a guess printed as a fact — and a consent page, a region gate, and an error page all redirect too. `landedElsewhere()` is what the render measured.

**Refuse a render that landed elsewhere instead of reporting it.** Tempting, and wrong: a sign-in page is sometimes exactly the page a caller wants a picture of, and a redirect to a consent or region page is not always a failure. The caller is told what it got and decides.

**`cookies` as a `Cookie:` header string.** One field instead of two, and closer to what a caller copies out of devtools. Rejected: a cookie header reaches the document and nothing in it, so a signed-in page would come back with every image and stylesheet 401ing — a worse artefact than the sign-in page, because it looks like a rendering bug. A name→value map is also what `session.cookies.set` takes, so nothing has to parse a cookie header.

**Write `outputPath` through `ctx.fs`.** The right seam if it had a byte write. It has `writeText` and nothing else, and adding one to a core package for one plugin's PNG is a change to a shared capability made from the wrong end. Recorded rather than closed: a `writeBytes` on the filesystem seam would move this write behind the sandbox policy, which is where it belongs.

**A bounded `scale` parameter for a caller that wants a 2x image.** Deliberately not shipped. `width` and `height` already say how many pixels the caller wants, and a second multiplier interacts with the attachment store's own normalization at 2048 — a `scale: 2` on a 1440-wide viewport produces exactly the 2048x1280 this change exists to stop returning. A caller who wants more detail asks for a bigger viewport, which is one knob whose meaning matches its name.

## Consequences

A tool result can now name a third-party host and a login redirect, in text that reaches the model. That is the point — it is the difference between "the page did not render" and "the site sent the render to its sign-in page" — and it is worth stating plainly that the landing URL the page itself produced is reported.

A 504 for a redirected render is 53 characters longer, all of them ahead of the pending list, so a line that already reached the 500-character cut now shows that much less of its last pending URL. The trade is deliberate: a URL is cut from its end, where its least identifying characters are, and the retry it makes room for is the only part of the line a caller can act on.

The plugin now carries credentials the caller supplies. They live on a session that dies with the render window, nothing is persisted, and the shell mints none of its own; the README's pairing note with `@haoran/dsh-llm-permission-gateway` is updated to say that `screenshot` calls are worth a review model's attention for this reason too. The permission gate reviews the call like any other.

Images no longer vary by display. A `screenshot` call answers the requested viewport on a Retina Mac and on Windows alike, which also means rc.18's normalization no longer fires for an ordinary capture: nothing reaches the 2048 ceiling that a caller did not explicitly ask for. This is a deliberate change to behavior shipped in rc.18 — a capture that came back at 2x now comes back at 1x, and a caller comparing a stored rc.18 screenshot with a new one will see different pixel dimensions for the same request.

A third-party plugin now contributes to the system prompt. The registry is public and the mechanism is the one the harness's own tools use, but the prompt is a shared budget, and this is a precedent: one line, one tool, and evidence that the tool is unreachable without it.

An install without the shell's render service is now a narrower deployment than one with it. A `screenshot` call carrying a session is refused there rather than answered with a logged-out page, which is the honest outcome and also a visible difference between the desktop client and every other surface.

## Testing

`apps/desktop/tests/render-service.spec.ts` covers the new validation — non-map fields, non-string values, invalid token names, a `cookie` header, CR/LF in a header value and a semicolon or comma in a cookie value, the shared count and byte bounds, the `file:` refusal, and that the renderer receives the maps only when the request carried them — plus the landing header: present with the URL when the trace landed elsewhere, absent when it stayed, percent-encoded for non-ASCII, and cut for a long one.

The same suite asserts the timeout line as whole strings: the landing and the retry while navigating, the landing and the retry after the load (`page loaded at …, timed out while capturing`), a `file:` render that names its landing and no retry, and the truncation case — a cut landing URL with twelve long pending URLs, where `pass cookies or headers to capture it with a session, 12 requests pending: ` must appear intact in a 500-character line ending in an ellipsis. That one assertion fails if the retry is ever moved after the list, which is the regression the placement exists to prevent.

`apps/desktop/scripts/render-smoke.mjs` covers what no injected renderer can. It serves a page that redirects anyone without a session to `/login` and renders it three ways against a real Chromium: without a session (200 plus the landing header), with a cookie, and with a header (200, no header). A second site case serves a page at `/app/issues/page` with one image beside it and one at `/api/pixel.png`, and asserts what that server received rather than what came back as pixels: the cookie is on the document and on both images, and an extra header is on the navigation and on neither image. Asserting on the pixels would pass under a directory-scoped cookie, since a page whose images 401 still encodes to a PNG. Its viewport case asserts the capture is exactly the requested size, which on a Retina Mac is the assertion that the resize runs. A further case is the only place a real redirect and a real pending request meet: the sign-in page it renders loads an image from a listener that never answers, so under a 2-second deadline the 504 line carries both the landing Chromium reported through `did-navigate` and the retry, which is what `render-smoke` prints.

The plugin's own suite covers `outputPath` (written inside the workspace, the overwrite report, refusals for a path outside it and for a call with no session), the system-browser refusal for a call carrying a session, the landing sentence in the rendered result, and that `applyScreenshotTool` registers the prompt section beside the tool.
