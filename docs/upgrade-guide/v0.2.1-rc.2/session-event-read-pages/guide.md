---
kind: upgrade-guide
description: "session_event_read now returns bounded pages by default and requires full: true for an unabridged event."
---

# `session_event_read` is bounded by default

English | [中文](guide.zh.md)

## Change

`session_event_read` previously returned the complete target event JSON. It now returns at most 16,000 target-JSON characters with the character range and `nextOffset`. Callers that need the old unabridged result must pass `full: true`. This affects model-facing session-history reads and any caller that assumed one call always returned the complete event.

## Migration

1. For ordinary exact reads, keep the default and follow `nextOffset` for later pages. `maxChars` accepts 2–100000, and `before`/`after` neighbor summaries appear only on the first page.
2. For complete recovery of a pruned tool result or another use that requires the entire event, add `full: true`. Do not combine it with `offset` or `maxChars`; that combination is rejected.
3. Verify behavior with `pnpm exec vitest run packages/experimental/tool-session-query`. A long event shows `characters … nextOffset …`, while `full: true` returns the complete event as before.
