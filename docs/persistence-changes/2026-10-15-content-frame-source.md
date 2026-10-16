---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-15-content-frame-source

English | [中文](2026-10-15-content-frame-source.zh.md)

## Summary

Adds the content-frame message source: the notice the content column's row injects when the user opens a page there, naming the page that is now in front.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-15-content-frame-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-09-content-point-source"
    after: "da202589e73f3737cbc43bcca5ffae28378e33ae0c937a0b04035f6f9f4fda15"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-09-content-point-source"
    after: "7011ee848ccb76d19a197b95ed03d7644d0af8e60347e32b17591a1311570ab2"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-09-content-point-source"
    after: "bfe43be97603c26d8f4ac4c8d3d7119b4724f1fd4b9e1b930814f69477e76fb2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-09-content-point-source"
    after: "e198badbd6923ea75cc046361878f7f14cb412dc7d94377b844d7ef1caeced1b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Additive: an attribution-only source kind. Existing records do not contain it and remain valid. The kind is declared with @persistenceAttribution, so a reader without the content-frame package preserves the message content and shows the notice by its durable kind; a session written with the row stays readable after the row is removed.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/content-frame/tests/command.client.spec.ts --maxWorkers=2: 22 tests passed, among them the case that opens a page and finds the injected notice on the log with source { kind: 'content-frame', form: 'notice' } and the page's summary.

<a id="dev-note"></a>
## Dev Note

None.
