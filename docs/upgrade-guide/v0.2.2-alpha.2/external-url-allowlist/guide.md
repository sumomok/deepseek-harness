---
kind: upgrade-guide
description: "Desktop and Desktop Shell refuse non-allowlisted or credential-bearing external URLs, cancel main-frame redirects leaving the served origin, and use HTTPS-only download destinations."
---

# External URL hand-offs tighten

English | [中文](guide.zh.md)

## Change

Desktop and Desktop Shell now resolve every external hand-off through an explicit protocol allowlist before calling the operating system. The main window accepts `http:` and `https:` web links; Desktop Shell also accepts `mailto:` for popups and top-level navigations. Platform popups and update or release-download destinations accept `https:` only. Every accepted scheme requires a target without URL credentials, so `https://user:pass@example.com/`, `https://user@example.com/`, and `mailto://user:pass@example.com/` no longer reach the OS.

A top-level navigation away from the served application origin is still cancelled and, when the allowlist accepts it, handed to the OS after resolution. In Desktop Shell, a top-level redirect that leaves the served origin is now cancelled without opening a browser, while a subframe redirect stays with Chromium, including a cross-site HTTP(S) redirect. A blocked target and an operating-system refusal each write one log line naming only the stable reason or protocol.

These checks cover links a page opens in a new window, main-frame navigations, Platform payment and documentation links, and update or release-download pages. No setting disables them.

## Migration

1. Replace a custom-scheme link (`ftp:`, `file:`, `tel:`, `ms-settings:`, or an application deep link) that relied on the OS handler with an `https:` page, or open that target outside the application.
2. Remove URL credentials from links and configured destinations. Sign in through the destination's own page instead of embedding `user:password@` or a bare `user@` in the URL.
3. If an embedded page relied on a top-level cross-origin redirect opening the system browser, link to the external HTTP(S) destination from that page instead; the redirect is cancelled and opens nothing.
4. Serve update and release-download destinations over `https:`. An `http:` destination is refused before the OS is called.
5. Confirm the migration by opening one affected link. No OS handler opens for a refused target, and the desktop log holds one `[external] blocked target: protocol-not-allowed` (or `credentials`) line instead.
