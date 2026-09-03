# Agent Note: A sign-in the user completes, and the one store it leaves behind

Status: implemented

English | [中文](2026-08-25-desktop-sign-in-window-and-login-partitions.zh.md)

## Problem

A page behind a sign-in wall cannot be captured from a session that starts empty. [The render service](2026-08-22-desktop-render-service.md) gives every render a fresh non-`persist:` partition created with its window and destroyed with it, so pointing a capture at an application's own page returns that application's sign-in redirect.

The answer already shipped for that is a session the caller supplies: the `cookies` field of `POST /render`, which [the screenshot tool sends](2026-08-22-screenshot-session-and-output.md) and which `@haoran/dsh-screenshot` 0.3.0 keeps out of the model's arguments by naming a jar configured under `cookieJars`. It works only when someone has exported a browser session by hand into that config file, where the credential then sits for as long as the site honours it. The desktop client is the install where that step is least available: its premise is that a person runs the agent without a terminal, a package manager, or a registry, and a jar cannot be filled at all for a site whose session this machine has never held.

What is missing is not a credential a caller could pass. It is the sign-in itself: the user is in front of a Chromium the shell already runs, and no route lets them use it.

## Decision

The render service answers three more routes and one more field of `POST /render`, and the shell opens exactly one kind of window whose session survives it.

**The routes.** `POST /login-grant` takes `{ url, partition }` and answers `{ nonce, expiresInMs }`; it opens nothing. `POST /login` takes `{ nonce }`, opens a visible window at the page that nonce was minted for, and answers `{ landedUrl, sameSite }` when the user closes it. `DELETE /login-sessions` takes `{ partition }`, calls `clearStorageData()` on it, and answers `{ partition, cleared: true }`. `POST /render` may then name that same `partition`, which is the render that comes back signed in. `routeOf` reads method and path together and everything outside those four is the same 404 that refuses the preflight a page in the user's own browser would have to send.

**The partition space is fixed at `persist:dsh-render-login-<registrable-domain>`.** `loginPartitionOf` checks every partition name every route accepts, the render field included: the `LOGIN_PARTITION_PREFIX` prefix, then `LOGIN_PARTITION_DOMAIN` — a lowercase domain of at most 253 characters. It is a constant rather than a `Config` field because it is what keeps a caller off the partition the user's own window runs in and off every other store this shell may come to hold; inside that space a caller names what it likes, outside it nothing. The domain is the caller's own computation: this service has no public-suffix list and enforces membership of the space rather than the correctness of the label. `POST /login-grant` additionally requires the page's hostname to be that domain or a subdomain of it, because a pair that disagreed would file one site's cookies under another site's name and let the caller then render that other site signed in.

**The nonce fixes what a window may be opened for.** `POST /login` carries no URL and no partition — `LoginGrant` holds the pair the nonce was minted for. `spendNonce` deletes the entry before it checks expiry, `LOGIN_NONCE_TTL_MS` is 30 seconds, and `MAX_LOGIN_NONCES` is 8, with expired grants dropped on the two calls that read the table rather than by a timer that would keep the process awake. A nonce therefore cannot be replayed, cannot be aimed at a page or a partition other than the one it was minted for, and cannot be spent a turn later: the window a user is shown is the one the consent they just gave was about.

**The nonce is not a second authentication factor, and nothing here treats it as one.** A holder of the bearer token calls `POST /login-grant` and `POST /login` in sequence and gets a window; the token remains the only thing that decides who reaches this service at all. What the split buys is that opening is a separate act from asking, bound to an exact pair and to 30 seconds, so a grant obtained for one page opens no other.

**One window at a time, on a person's deadline.** `signingIn` is checked before the nonce is spent, so the 503 a second call gets leaves that caller's grant spendable. An unknown, spent, or expired nonce is a 403 naming `/login-grant` as where to ask again. `RenderLimits.loginTimeoutMs` is ten minutes — someone reads a form, finds a password, and clears a second factor, where every other bound in `RenderLimits` is a page's and is measured in seconds — and a window still open then is closed and answered 504, as is one open when the shell quits. `close()` aborts `closing` before it drops the sockets, because a sign-in window stays on screen until something takes it down and the request holding it is one of those sockets.

**The window says which origin is asking.** `lockTitleToOrigin` sets the title to the current origin on `did-navigate`, `did-redirect-navigation`, and `did-navigate-in-page`, and on `page-title-updated` with the page's own title cancelled: someone typing a password has to be able to see which site is asking, and a page that can name the window can claim to be a different one. `LOGIN_WINDOW` states the rest of the shape — hidden until the first load returns, 520 by 680 content pixels, an empty title, and `resizable: false`, which is also the flag `mainWindow()` in `apps/desktop/src/main-window.ts` uses to tell the app's own window from every other. That shape lives in `render-service.ts` beside the protocol, so the suite checks it without a display.

**Four lockdowns hold, one is relaxed.** Permission requests, permission checks, downloads, and audio are refused in this window exactly as in a render window, and `devTools: false`, `sandbox: true`, `contextIsolation: true`, and the absence of Node integration are untouched. `disableDialogs: false` is the relaxation: `alert()` and `confirm()` are how a sign-in page reports a wrong password or a missing second factor, and this window — unlike a hidden render — is one the user asked for and is looking at.

**A popup becomes a navigation of this same window.** `setWindowOpenHandler` denies the child and loads its URL into the window the user already has, which carries an OAuth hand-off out to the identity provider and back with one origin on screen at a time. The landing the route answers with is read from `did-navigate` and `did-navigate-in-page` as they happen, because the web contents are gone by the time `closed` fires.

**Persistence stops at that one space.** A render naming a partition may not also carry `cookies`, and is refused 422 if it does: writing a caller's own jar into a store that outlives the request would persist a credential on that caller's behalf, which is the one thing this service does not do. A partition on a scheme that carries no session is refused the same way. Nothing in the shell reads a value out of a login partition, no route returns one, and `clearLoginSession` is `clearStorageData()` — the cookies, the caches, and every storage backend Chromium keeps for a partition — which is all "sign out" can mean for a store this process never reads.

**Both halves are injected, for the reason `Renderer` already is.** `RenderServiceSpec` requires `openLogin` and `clearLoginSession` beside `renderer`, `apps/desktop/src/login-window.ts` holds the whole Electron implementation, and the nonce table, the partition grammar, the deadlines, and the window's declared shape are then driven with no display anywhere.

## Alternatives considered

**Let a caller name a partition on `POST /render` and add no grant flow.** The smallest possible change: one field, one branch in `render-window.ts`, no routes. Rejected because nothing would tie a stored session to a human decision — the store a render writes into outlives the request, and with no route where a person opened the window that filled it, the shell would be keeping a persistent session created by a call the user never saw.

**Open same-eTLD+1 popups as child windows.** `sameSite` already computes the test, so `setWindowOpenHandler` could open a real second window for a target on the site the partition is keyed by and deny the rest. Rejected in favour of following every popup in the same window: a second window carries no origin title strip, `mainWindow()` finds the app window by `isResizable()` so a second sign-in window would have to declare `resizable: false` too, and the user would be looking at two origins at once. An identity provider is also usually not on the site being signed in to, which is exactly what a same-site test would drop.

**Make `openLogin` and `clearLoginSession` optional on `RenderServiceSpec`.** Rejected: a shell that composed the service without the login half would answer a consent-granted `POST /login` by opening nothing, and the caller would read that as a sign-in the user declined. Required members make a shell that answers these routes a shell that has the window.

**Let one render carry both `cookies` and `partition`.** Tempting as a merge — a caller with a jar and a signed-in partition would get both — and rejected for what it would make the service do: write a caller's credential into a store that outlives the request. The partition is the session for a render that names one, and the refusal says so.

## Consequences

The service's negative guarantee narrows from "nothing persists" to a carve-out with four properties, and those four are what keep it the narrowest one available: one named partition space, checked on every route that accepts a name, never readable by any route, and never mixed with cookies a caller supplied.

A local process holding the bearer token can put a visible window on screen at a page of its choosing and can erase a login partition. It cannot read one, cannot open a window at a page it did not name in a grant, and cannot reach any partition outside the login space — including the one the app's own window runs in.

The shell never expires or garbage-collects a login partition. What a user signed in with stays in Chromium's profile data under the app's userData directory until something calls `DELETE /login-sessions` for that partition, and no route lists what is stored.

One sign-in is open at a time and a second is refused rather than queued, so a caller that needs two does them one after the other.

The payload's own caller does not use any of this: `@haoran/dsh-screenshot` 0.3.0 renders with configured `cookieJars` and names no partition, so `cookieJars` remains the session path on every install and the three routes are reached by whatever holds the token.

## Testing

`apps/desktop/tests/render-service.spec.ts` drives the protocol against an injected opener: every login route refused without the token before a body is read, a nonce nobody minted and a nonce of the wrong shape, a grant that mints without opening, the granted pair reaching the opener, a nonce spent exactly once and one older than its time to live, a grant whose page is not on its partition's site, every partition outside the login space on both routes that name one, the sign-out call, a second window refused without spending its nonce, the window nobody finished, `LOGIN_WINDOW.resizable` against the `isResizable()` discriminator, and the render field — handed to the window half, absent when unnamed, refused outside the space, refused beside cookies, refused on a page that carries no session.

`apps/desktop/scripts/render-smoke.mjs` composes the real Electron halves at each of its three services. It opens no sign-in window: that window is finished by a person closing it, and the smoke runs unattended.
