---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-26-console-content-events

English | [中文](2026-09-26-console-content-events.zh.md)

## Summary

Adds the product console's six content events and its two attribution-only message source kinds that the Host aggregate declares (content-surface, content-component); content-frame's source kind is declared in a Client package outside the Host aggregate and is not part of this record.

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
    previous: "2026-09-25-prompt-references"
    after: "13990d298055a3296bf03f5945a5bc67147f28e3c81986be8a9e2d9e44620b68"
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
    previous: "2026-09-25-prompt-references"
    after: "53dcbe174677fb3aa04c4a56ee5ed9fd392e3954d1c0618d53444ceb3b1a0495"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-25-prompt-references"
    after: "e4bbc373dca50ec970c7112801cb77e3233687c135e700dfe51ebea1e3e8b187"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-25-prompt-references"
    after: "d6c181927f267021214d1c415aa28abbddd3e344b1a33d810798868cfa25580d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The six events are new ordinary event types and the two source kinds are qualified with @persistenceAttribution, so every existing record keeps its schema and replay, including the user-question reply source and the prompt references that precede this record. An older reader that does not know the six events refuses a log that carries them, because they are not marked ignorable; a reader without the producers preserves the two source kinds and their metadata without validating or replaying them. component-surface's action notices write the content-component kind. Logs written before the rc.2 base recorded these sources as kind plugin, which the V3 to V4 migration rewrites to plugin:content-surface and the like, and the console does not map those back.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/content-surface packages/experimental/content-frame packages/experimental/component-surface: 72 files, 1714 tests passed. pnpm run verify-persistence-changes passed.

<a id="dev-note"></a>
## Dev Note

None.
