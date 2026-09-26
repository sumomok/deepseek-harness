---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-console-content-component-source

English | [中文](2026-09-27-console-content-component-source.zh.md)

## Summary

Records the content-component message source kind, which the persistence extractor now reaches because skill-pack-components, a host-program package, imports component-surface.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-console-content-component-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-26-console-content-events"
    after: "1a3f7c4ecd6422f66c15ce10754966c561bbdfa5d72ab80fc5b118c42769d0ec"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-26-console-content-events"
    after: "1a4549f45b4441bf254f7edd80477e08995fe83e5f07f7b38bcdc4752b180083"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-26-console-content-events"
    after: "4e5f9ffc93dec0e10eed95c231cb39ea230825660eeffc3d215370540ff40167"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-26-console-content-events"
    after: "54dc1185359adf59e8fc9aa2336251e5bce4b79e8550fe320d8f3998969757a9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The kind is qualified with @persistenceAttribution and was already written by component-surface's action notices; only its visibility to the extractor changed. Every existing record keeps its schema and replay, and a reader without the producer preserves the source kind and its metadata without validating or replaying it.

<a id="verification"></a>
## Verification

A temporary spec in packages/session/session-persistence-jsonl wrote a user/message whose source kind is content-component at session format 4 and read the same record back.

<a id="dev-note"></a>
## Dev Note

None.
