---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-09-content-point-source

English | [中文](2026-10-09-content-point-source.zh.md)

## Summary

Adds the content-point message source: the logged user message the console's 「指一下」 row appends after a user message carrying its points, naming that message and writing each point's key line.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-09-content-point-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-26-console-content-events"
    after: "0390e0dc730dad0ec25fa43e28403fc9ad610d8d23a53601dfd107d36012e046"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-26-console-content-events"
    after: "2669909f0621ab2da9f5d10d8ea3d93f890f867004fa5a368b18eb2e46887a98"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-26-console-content-events"
    after: "626e90e45ae1387304daf001c8008f84666f50229263c4623d42f2987d734a59"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-26-console-content-events"
    after: "61bf312402150b95890adb1f2cd41794732a7e891e48d22a116da790b3531ce4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Additive: an attribution-only source kind. Existing records do not contain it and remain valid. The kind is declared with @persistenceAttribution, so a reader without the content-point package preserves the message content and shows the row by its durable kind; a session written with the row stays readable after the row is removed.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/content-point --maxWorkers=2: 82 tests passed, among them a real Loader composition whose session log holds the content-point message right after the prompt it names; the content-point web scenario records the appended message in the console composition.

<a id="dev-note"></a>
## Dev Note

None.
