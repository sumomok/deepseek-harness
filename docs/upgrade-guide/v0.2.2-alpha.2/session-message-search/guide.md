---
kind: upgrade-guide
description: "SessionQueryEngine gains an abstract searchMessages method, so every provider implements it."
---

# SessionQueryEngine providers must implement searchMessages

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-session-query` adds an abstract `searchMessages(request, exec)` to `SessionQueryEngine`. It returns a page of matching events rather than one ranked hit per Session, so a caller can address the message a snippet came from. Session pages keep their existing behavior: `searchSessions` still groups events and keeps the strongest hit per Session.

Because the method is abstract, a provider compiled against an older release no longer satisfies the base class. The change is confined to implementers of `SessionQueryEngine`; consumers that only call the service see an added method.

## Migration

1. Implement `searchMessages` in every `SessionQueryEngine` subclass. A provider that cannot answer at message granularity should raise rather than return an empty page, so the gap stays visible instead of reading as "no matches".
2. Return the provider's own `SessionSearchPage<SessionEventSearchHit>`, ordered by relevance and paged by the same cursor contract as `searchSessions`. Each hit carries the `sessionId` and `seq` it belongs to.
3. Run the provider's search tests against both entry points. The visibility, surface, and message-type rules a caller applies are the same for each, so a fixture that exercises one should exercise the other.
