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
    after: "8cde06df44b5be0083e91613574fe3a8ecd1f2c5aa16d10279ffb666eb13776c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-09-content-point-source"
    after: "2df3c0ef4687316a392cca3ca96731b76b027ad146b40c2da52b3620b7451c6f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-09-content-point-source"
    after: "09a7663822734b792c416edcc4b0e62c192b62f6c22c6a33b6932afa4d432927"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-09-content-point-source"
    after: "1c11506f3fa8c453677331c4676965532de2fba767e7fa2c339bb9bfeb1290b2"
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
