# Agent Note: The desktop shell renders pages for its own server, and ships the screenshot plugin that asks it to

Status: implemented

English | [中文](2026-08-22-desktop-render-service.zh.md)

## Problem

An agent writing HTML, CSS, or a component is working blind: it can read back every byte it wrote and still not know that two elements overlap or that the layout collapses at the width it was asked for. `@haoran/dsh-screenshot` closes that loop by rendering the page and returning the pixels, and its only renderer is a headless Chrome, Edge, Chromium, or Brave that it probes for on the machine. Nothing is downloaded, ever, which is the right call for a plugin — and it means the tool answers `no headless-capable browser found` on a machine with none.

The desktop client is the install where that is hardest to defend. It exists so that someone can run the agent without a terminal, a package manager, or a registry round trip; telling that person to go install Chrome for a screenshot is the same class of requirement the installer was built to remove. And the shell already is a Chromium: it is running, it is the window the user is looking at, and it can render a page and hand back the bytes without anything else being installed.

The plugin had the second half of the same problem the two existing built-ins had. It is unpublished — it exists as a tarball produced by a local workspace — so getting it required a terminal, a working pnpm, and `dsh plugin --profile web add <path>`.

## Decision

The shell runs a loopback render service for the server it spawns, and the installer carries the plugin that uses it.

**The service.** `apps/desktop/src/render-service.ts` opens an `http.createServer` on `127.0.0.1` and an ephemeral port in `app.whenReady()`, before `startServer`, and mints a 32-byte token. Both reach the server process as `DSH_DESKTOP_RENDER_ENDPOINT` and `DSH_DESKTOP_RENDER_TOKEN` through a new `ServerSpec.env`, spread over the inherited environment at the spawn — not through the shell's own `process.env`, which every other process the user starts from the app would inherit from. `POST /render` takes `{ url, width, height, fullPage?, delayMs? }` and answers `200 image/png`, or one line of `text/plain` under 400 (malformed request), 401 (missing or wrong token), 404 (any other path or method), 422 (a well-formed URL whose scheme is not `http`, `https`, or `file`), 500 (the page did not load, carrying the Chromium error code), 503 (the queue is full), or 504 (the deadline passed). That is the protocol the plugin's README specifies; the shell implements it rather than defining one.

**HTTP rather than a channel the two processes already share.** The plugin runs inside the server, which is a spawned Node process, so anything it says to the shell has to cross a process boundary. The shell's existing stream to that child carries the server's log output and its readiness line, and multiplexing a request/response protocol with binary payloads onto it would make the shell own a second framing on a pipe whose contract is "everything here goes to `dsh-server.log`". A loopback port with a bearer token is what the plugin already speaks, and it is what a shell on another platform can implement without inheriting this one's process layout.

**Its security position is the reason the protocol is this narrow.** The listener binds loopback, so nothing off the machine reaches it. The token is compared with `timingSafeEqual` after a length check, so another local process cannot use the service by finding the port. No CORS header is ever sent and every method other than `POST /render` answers 404, so the preflight that an `authorization` header and a JSON content type force a browser to send is refused — which is what keeps a page in the user's own browser from using the service through the user. Each render gets a hidden window on a fresh non-`persist:` partition, so its session lives in memory and dies with the window: a rendered page cannot read or write the cookies, storage, or caches of the window the user works in. That window has no Node integration, no `webview`, and no devtools; its session denies every permission request and check, `will-download` is prevented, and `setWindowOpenHandler` denies every popup.

**What bounds it**: one render at a time, at most four accepted requests (one rendering and three waiting) with the next answered 503, and a 30-second deadline. The deadline runs from acceptance rather than from the start of the render, because a request that spent that window queued has taken that long from its caller's side too — and a request whose deadline passed while queued is answered without ever opening a window. A `fullPage` capture measures `document.documentElement.scrollHeight` and resizes to it, clamped at 8192 px, because a document with an infinite scroller reports a height that grows while it is measured.

**The window half is injected, which is what makes the protocol testable.** `startRenderService` takes a `Renderer` — `(request, signal) => Promise<Buffer>` — and the bounds it enforces as an explicit `RenderLimits`, with the shell's own numbers in `RENDER_LIMITS` at the top of the same file and passed at the one call site that composes the service. `apps/desktop/src/render-window.ts` is the Electron implementation and holds nothing but the window. So 21 unit cases drive authentication, validation, admission, serialization, the deadline, and the abort that reaches the renderer, with no display anywhere; and `scripts/render-smoke.mjs`, run under a real Electron, covers the one thing they cannot — that a window nobody ever showed paints at all, that `capturePage` returns the requested viewport, and that a full-page capture grows past it.

**Failing to open the listener is not a reason to refuse the launch.** The shell logs one line and starts the server with no render variables, and the plugin then does what it does on every non-desktop install: probe for a system browser.

**The plugin travels in the payload.** `apps/desktop-server/package.json` declares `@haoran/dsh-screenshot` as `file:./vendor/haoran-dsh-screenshot-0.1.0.tgz`, with that tarball committed beside it, and `BUILTIN_WEB_BUNDLES` names it so the shell seeds it into the web profile like the other two. A `file:` tarball is what makes this work where a GitHub archive URL did not: pnpm records `integrity: sha512-…` for it exactly as it does for a registry version, and `pnpm deploy` refuses a lockfile entry without one. The scoped name needed no new code — every path the seed builds is joined, and `ensureLink` already creates the link's parent, which is the `@haoran` scope directory — but it did need the tests that prove it, since a name with a separator in it is exactly the kind of thing string concatenation gets away with until it does not. `scripts/bundle-closure.ts` keeps the package whole on the existing rule: its manifest declares `dsh.bundle`, and nothing in the payload imports a profile bundle by specifier.

**The packaging gate now asks the question the mechanism answers.** `verifyClientModules` required every built-in to appear among the client modules the served index names, which is false for a plugin that contributes a tool and nothing to the page. It now reads `dsh.client` from each built-in's manifest **in the payload**: a package that declares one must be served, a package that does not is proved by the boot itself — a bundle the profile names and the Loader cannot resolve is a hard boot failure, so a server that printed its URL line resolved all three — and a run where no built-in declares `dsh.client` fails rather than passing vacuously.

## Alternatives considered

**Ship a browser in the payload.** Playwright's Chromium or a bundled Chrome makes the tool work identically everywhere. Rejected on size: the installer exists to be downloaded by people who do not want a toolchain, and this adds a second browser to a package that already contains one.

**Have the plugin drive the shell over the server child's stdio.** No port, no token, no listener. Rejected because that stream is the log: its whole contract is that every byte lands in `dsh-server.log`, and framing a binary request/response protocol into it means the shell owns a second protocol on a pipe whose readiness line is already parsed by a regular expression.

**A Unix domain socket or a named pipe.** Tighter than a TCP port, since filesystem permissions replace the token on POSIX. Rejected because there is no single cross-platform form — a path on POSIX, `\\.\pipe\…` on Windows — and the plugin's protocol is HTTP over an origin, so a shell that offered a socket would be implementing a different one.

**Put the endpoint and token on the shell's own `process.env`.** One line shorter, and the spawn inherits them for free. Rejected: everything else the app ever starts — a terminal, a subagent, whatever the user opens from inside the UI — would inherit a token that renders arbitrary `file:` URLs.

**Render in the app's own session, or in the visible window.** Sharing the session would let a page the model names read the cookies of the UI the user is signed into; rendering in the visible window would put every page the agent looks at on the user's screen.

**Declare the plugin from a GitHub archive URL, as `dsh-at-file` does.** Rejected before it was tried: the archive has no `integrity`, which is exactly the failure (`ERR_PNPM_MISSING_TARBALL_INTEGRITY`) that the commit pin exists to work around, and this plugin has no public repository to pin a commit in.

**Depend on the plugin's workspace with `link:`.** Rejected: that checkout is not part of this repository, so the dependency would resolve only on a machine that has it beside this one, and `pnpm deploy` would need it present at build time.

**Keep the client-module assertion and exempt the new plugin by name.** Rejected as a second declaration to maintain: the payload's own manifests already say which packages have a browser half, and a name list drifts the first time a built-in gains or loses one.

## Consequences

A desktop screenshot no longer depends on what browsers the machine has, and it is the more accurate of the two backends: the shell measures the document, where the command-line backend renders into a fixed-height window and cuts or pads the result. Nothing changes for a CLI or server install, which keeps the browser probe.

The shell now holds an open listener for as long as the app runs. It is loopback-bound, token-guarded, and closed on `before-quit`; the close is unawaited, because a quit must not wait on a render.

Rendering is serial and shallow-queued by design, so a page that takes the full deadline to load holds the slot and the requests behind it can be answered 504 without ever opening a window. The shell's viewport floor is 16 px per edge where the plugin's own minimum is 1, so a `screenshot` call for a smaller viewport is answered 400 on the desktop and rendered by a system browser everywhere else.

The vendored tarball is that plugin's update channel: a new version means committing a new tarball and moving the specifier, and the installer that carried a build owns the version, exactly as it does for the other two built-ins. `THIRD_PARTY_NOTICES.md` names it through a repository-relative link to that tarball, because an unpublished package has no public URL to name — the one entry in the file whose link is not a repository.

The payload carries a third profile bundle, and the build prints it: `package: darwin payload built-in profile bundles: @haoran/dsh-screenshot, dsh-at-file, dsh-better-sidebar`. The deployer copies `apps/desktop-server/vendor/` into the staged tree along with the manifest, so the packaging step removes it beside the README files it already drops: the staged tree holds the installed package, and the archive it came from resolves nothing at run time.
