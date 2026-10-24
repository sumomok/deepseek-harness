---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-24-context-lifecycle-message-sources

English | [中文](2026-10-24-context-lifecycle-message-sources.zh.md)

## Summary

Adds two opt-in user-message source kinds for post-compaction task-state rebuilding and same-workspace historical recall.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-context-lifecycle-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-25-prompt-references"
    after: "3f7749df86031cd9c7abefb7749ade632fc0815479f63d7eede11c8a10ccea5a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-25-prompt-references"
    after: "6b9b40bfacfc3c7715056d8d55eef09a32c3d20d3d553cdf1ba344f1218c21b9"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-25-prompt-references"
    after: "0d525666da54173551164fccd5e08a499ab3efd72f8c48688a9d041e33999ed8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-25-prompt-references"
    after: "69b30975b92408916dc479081a42d718eb87a2881269c49f617cf513fad911aa"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. Both source kinds attach only to already-persisted user-message content written by opt-in plugins: they add no Session event, do not change any existing field's meaning, and change nothing when absent. A reader that does not know a source kind preserves or ignores the source metadata and still projects the original user-message content, so the Session writer stays at V4.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/context/compaction-rehydration packages/test-support/session-snapshot/tests/memory-recall: 5 files, 78 tests passed. pnpm exec vitest run packages/test-support/session-snapshot/tests/context-lifecycle: 7 files, 59 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
