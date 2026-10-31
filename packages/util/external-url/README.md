---
description: "Resolves one external URL before an OS hand-off, allowing only the protocols the caller names and refusing dangerous or ambiguous targets with a stable reason."
kind: "package-library"
---

# @deepseek-ai/dsh-external-url

English | [中文](README.zh.md)

## Summary

`dsh-external-url` turns a link, navigation, or configured destination into a canonical `URL.href` or a stable refusal reason before an application hands it to the operating system. Callers pass the protocols they accept; the library compares complete `URL.protocol` values, requires absolute credential-free HTTP(S) targets, and preserves encoded `mailto:` fields without decoding them. It registers nothing and has no runtime dependencies.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use this package at every process boundary that may hand a URL to an operating-system protocol handler. `apps/desktop-shell` and `apps/desktop` wrap their Electron `shell.openExternal` calls with it; each caller states its own protocol subset, so a release download stays HTTPS-only while an ordinary rendered link may also use `http:` and `mailto:`.

### Entry point

```text
import { resolveExternalUrl } from '@deepseek-ai/dsh-external-url'

const result = resolveExternalUrl(target, ['https:'])
if (result.kind === 'allowed') {
  // Hand result.url to the OS.
} else {
  // result.reason is a stable refusal category.
}
```

`allowedProtocols` is required. An allowed result carries `url` and `protocol`; a blocked result carries only a stable `reason`, so a caller can log the decision without repeating the raw target. Callers must not reconstruct a target from a rejection or fall back to `target` when blocked.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Resolution happens in this order: reject surrounding whitespace, ASCII control characters, and backslashes; reject anything without an absolute scheme; parse with `new URL(target)` without a base; require the parsed protocol to be one the caller listed; then require HTTP(S) to have a hostname and no credentials. `mailto:` keeps the parser's encoded path and query instead of being decoded or parsed as a mailbox.

The order is part of the contract. The URL parser strips tabs and newlines, so those characters are checked on the raw target first. Backslashes are refused before parsing because Chromium and WHATWG URL parsing treat them as path separators. A prefix match cannot decide a protocol: `httpsfoo:` and `httpx:` are distinct schemes and are refused when only `https:` or `http:` is allowed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security) — why main-process URL handling must validate before delegating to the OS.
- [Desktop shell navigation](../../../apps/desktop-shell/src/navigation.ts) — the popup, navigation, and redirect policy built on this resolver.
- [Util group map](../README.md) — the zero-dependency utility family this package belongs to.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **An allowlist is not trust.** An allowed HTTPS site can still be malicious; this resolver does not perform reputation, user-gesture, or content checks.
- **No SSRF or destination policy.** It does not resolve hosts or reject private addresses; callers that fetch rather than hand off need their own destination rules.
- **No mailbox validation.** `mailto:` targets are preserved as parsed, not checked for a valid address, and multiple recipients or headers are not interpreted.
- **Callers own the hand-off.** A blocked result prevents an OS call only when the caller checks `kind` before invoking its opener.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
