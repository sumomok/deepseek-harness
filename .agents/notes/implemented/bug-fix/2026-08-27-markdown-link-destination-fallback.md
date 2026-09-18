# Agent Note: Stop silently discarding a disallowed link destination

Status: implemented

English | [中文](2026-08-27-markdown-link-destination-fallback.zh.md)

## Problem

`renderSafeLink` in `dsh-client-ui-primitives`'s direct markdown renderer (`src/markdown/render.tsx`) checks a link destination against a protocol allowlist (`http:`, `https:`, `mailto:`). A destination that fails the allowlist — a relative path (`[text](relative/path.ts)`), an absolute local path, a `file:` URL, or another unsupported scheme — rendered as a bare `Fragment` around the link's children: the link text survived, but the destination itself was silently discarded. A reader had no way to tell that a link had been authored at all, let alone where it pointed.

## Decision

A disallowed destination now renders as the link's children followed by the destination in visible, inert text: `text (destination)`. The text shown is the same string already computed as the candidate `href` (the normalized `mdast` destination for a `link` or reference node), never re-derived. No element wraps the fallback — it is plain text, carrying no `href`, no click target, and no styling that could read as a live link. A `title` attribute was rejected for the reason the original Fragment was a problem in the first place: neither is visible without a pointer hovering the text. The protocol allowlist itself (`sanitizeUrl`) is unchanged; only the disallowed branch's rendering changed.

The rendered markdown DOM is pinned byte-for-byte by `tests/fixtures/markdown-dom`. `links-and-autolinks.settled.txt` and `links-and-autolinks.streaming.txt` are updated to the new rendering — the paragraph's text run changes from `relative dropped and js dropped and ` to `relative dropped (/settings) and js dropped (javascript:alert(1)) and ` — a deliberate, reviewed behavior change, not a refactor re-recording. `markdown.client.spec.tsx`'s neutralization test is updated the same way.

## Alternatives considered

**Keep the Fragment and add a `title` attribute naming the destination.** Rejected: a `title` is invisible until a pointer hovers the text, so a reader scanning rendered prose — or reading through assistive technology without hover — still cannot see that a link existed.

**Style the destination as inline code (`<code>`).** Rejected: the existing inline-code path is reserved for actual Markdown code spans and for the one case where inline code IS a live link (a complete HTTP(S) URL); reusing that presentation for an unrelated fallback would blur the two.

**Drop the destination and only flag that a link failed (e.g. a warning icon).** Rejected: the point is for the reader to see where the link pointed, not just that something was elided; an icon with no destination text repeats the original problem in a different shape.

## Consequences

A reader can always tell a link was authored and see its destination, even when the destination cannot become a live link — closing a silent-data-loss gap in untrusted markdown rendering. The rendered text for a disallowed link destination is now longer (link text plus the destination in parentheses); the two updated DOM-parity fixtures and the `markdown.client.spec.tsx` assertion pin the new text.

**What upstream now owns.** Upstream's `renderAnchor` sends a destination its `parseFileLink` accepts — a local path, with or without an `#L24` fragment — to `MarkdownFileLink` before `renderSafeLink` is reached. With an `openFile` delegate, which the chat view always supplies, that destination becomes a clickable button; with no delegate, the component renders the link text alone and the destination is dropped again. The fork does not follow into upstream's component: no product surface renders markdown without the delegate. This patch's reach is therefore every destination the file-link parser rejects — unsupported schemes, fragment-only links, malformed percent escapes, `//host/path`, and paths carrying a query string.

**Retirement.** This patch is a temporary overlay: if upstream stops silently discarding a disallowed link destination in its own markdown renderer, this patch is retired and the fork adapts to upstream's rendering.
