---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-26-console-content-events

English | [中文](2026-09-26-console-content-events.zh.md)

## Summary

Adds the product console's six content events and its three attribution-only message source kinds (content-surface, content-frame, content-component).

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-console-content-events
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "688bda1d52cd4e79ea57451c511621e4c7ac107615e75cfd76a3a5257c956bef"
    decision: same-version
  - root: "event:content-component/resolved"
    previous: null
    after: "4f32865bccfdf8fe0abac226d4d2f8c1d2b78070174ae3de059b44474db76071"
    decision: same-version
  - root: "event:content-component/shown"
    previous: null
    after: "7f723dc6ec038f47ead783d50012698f414212e6a3cc6f4e9b829b3dbc8f582d"
    decision: same-version
  - root: "event:content-surface/dismissed"
    previous: null
    after: "4ad228bdbed1b7de8d019fe494d963be0650509d3d29769258e9b1e79ab6b456"
    decision: same-version
  - root: "event:content-surface/selected"
    previous: null
    after: "0c8f7c583d9df301011303ed5739d7764664093b4ef3072d9373285cbc937c9b"
    decision: same-version
  - root: "event:content/navigated"
    previous: null
    after: "27c8bdff407955334cfd7e20f5809d438e2c826892f29c31ff5dd88043f967d4"
    decision: same-version
  - root: "event:content/shown"
    previous: null
    after: "a21aefcdb207a9f214b3a5e7ea13a96aa085fcc10b6555b9750679f5be02673c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "bdfe3bfb16b6e037153249a74f7adad41a3708e25cf1183257977ccc8ec79913"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "039a5be0827030b0530e2c3c2f83f85f5c22f94d97a9a440da927f18c6f15d6e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "ebc9df9b986ccc625872fb686fcbd0a4e66909ee0b4e3113d2bbe89e1f0fd48a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The six events are new ordinary event types and the three source kinds are qualified with @persistenceAttribution, so every existing record keeps its schema and replay. An older reader that does not know the six events refuses a log that carries them, because they are not marked ignorable; a reader without the producers preserves the three source kinds and their metadata without validating or replaying them. Logs written before the rc.2 base recorded these sources as kind plugin, which the V3 to V4 migration rewrites to plugin:content-surface and the like, and the console does not map those back.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/content-surface packages/experimental/content-frame packages/experimental/component-surface: 72 files, 1625 tests passed. A temporary spec in packages/session/session-persistence-jsonl wrote each of the six events at session format 4 and read the same record back.

<a id="dev-note"></a>
## Dev Note

None.
