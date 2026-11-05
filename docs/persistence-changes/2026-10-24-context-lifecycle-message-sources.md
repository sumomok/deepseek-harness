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
    previous: "2026-10-22-action-card-status"
    after: "ab745034ce2567062bc2d77c666c56b2cede10d1d16e7463e634b8ab1d533da4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "2b4f4e709e7f4e0a80b00616c6c6008d613c3d958b6fc3e425d0d2d0f91646da"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "dfcb7471099e73fdf3db00c8e29ff16831fa4baa654bc83285bbb4ab2dbf920e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "42bbeec482ca3556312bf7dbb91ea68c01c5893a9a9b1ae2c63377585a26fd5f"
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
