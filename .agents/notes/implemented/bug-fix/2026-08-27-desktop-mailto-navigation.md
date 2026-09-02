# Agent Note: Forward mailto: navigation to the OS on desktop

Status: implemented

English | [中文](2026-08-27-desktop-mailto-navigation.zh.md)

## Problem

The desktop boot window's `will-navigate` handler declines every navigation that does not target the running server, then forwards only targets starting with `http` to `shell.openExternal`. `MarkdownText`'s sanitizer allows `mailto:` link destinations (`docs`/README: "the http(s) subset of the allowlist `MarkdownText` applies to untrusted links (it also permits `mailto:`...)"), and a `mailto:` anchor never carries `target="_blank"` (only `http(s)` links get that attribute). Clicking a rendered `mailto:` link in the desktop app therefore reaches `will-navigate`, gets `preventDefault`-ed, and goes nowhere: a dead click with no visible effect and nothing in the log.

## Decision

The forwarding predicate now accepts `http`-prefixed and `mailto:`-prefixed targets. It is extracted into `apps/desktop/src/navigation.ts` as `isExternalNavigationTarget`, a pure function with no Electron import, because the `will-navigate` event wiring itself needs a real `BrowserWindow` and cannot run under a plain-Node test; extracting the predicate is what makes the decision unit-testable at all. `apps/desktop/tests/navigation.spec.ts` pins both branches: `http(s)`/`mailto:` targets forward, `file:`/`javascript:`/`about:`/empty targets do not.

## Alternatives considered

**Add `target="_blank"` to mailto anchors in `MarkdownText` instead.** Rejected: a `target="_blank"` mailto link would open a new browser-context window for a scheme no renderer navigates to, and the desktop app has no second window to receive it; forwarding at the `will-navigate` boundary is the layer that already owns "hand this to the OS."

**Broaden the predicate to forward every declined target.** Rejected: the predicate exists specifically to gate which unhandled navigations reach the user's OS-level default handler; forwarding `file:`/`javascript:`/every other scheme unconditionally would hand the OS handler destinations `MarkdownText`'s own allowlist never intended to reach it.

## Consequences

A `mailto:` link rendered in the desktop app now opens the OS's default mail client, matching how the same link already behaves in the browser client (a plain, non-`target="_blank"` anchor navigates in-place there, which the OS mail-client association intercepts). The forwarding predicate is now covered by a unit test where it previously had none; the `will-navigate` event wiring itself remains untested, as Electron event wiring generally is in this app.
