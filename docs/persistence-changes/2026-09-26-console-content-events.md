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
    previous: "2026-09-21-user-question-reply"
    after: "94843f9d9fa8e11376be659407d5cf543a2dd707aaf4f15699e408ee6fc3fa4b"
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
    previous: "2026-09-21-user-question-reply"
    after: "6bd2e61a23f063b07cf0559b77267357890438a905e420620b198689ee7e8e4c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "fa70c64552504733734b7d05d6708074cfaee19fce00bfc7bb6c50555a20680c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "703fa13cdf1e1acf2cd64be1aee29a2eb062367d41125e3f1d8182047e3ffc14"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The six events are new ordinary event types and the three source kinds are qualified with @persistenceAttribution, so every existing record keeps its schema and replay, including the user-question reply source that precedes this record. An older reader that does not know the six events refuses a log that carries them, because they are not marked ignorable; a reader without the producers preserves the three source kinds and their metadata without validating or replaying them. component-surface's action notices write the content-component kind. Logs written before the rc.2 base recorded these sources as kind plugin, which the V3 to V4 migration rewrites to plugin:content-surface and the like, and the console does not map those back.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/content-surface packages/experimental/content-frame packages/experimental/component-surface: 75 files, 1738 tests passed. pnpm run verify-persistence-changes passed.

<a id="dev-note"></a>
## Dev Note

None.
