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
    after: "ce884812a97f5cee5460fa893035876a8a1ae9e5b8861f2711eef61982364b42"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-26-console-content-events"
    after: "0d71b7d96a005f4af80899b5b6a3554415dcd974a55b1fccd2a9bd30eae57efe"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-26-console-content-events"
    after: "1fe8c85ceb6c97f7d5f26862d1e3d119986c697b5bf96d9e677c408cb40230e9"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-26-console-content-events"
    after: "018fae974b7119038daddbf1cbd530a804cb67453e673d74baa4b9885edc960f"
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
