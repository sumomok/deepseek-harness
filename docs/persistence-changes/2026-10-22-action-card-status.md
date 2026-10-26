---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-action-card-status

English | [中文](2026-10-22-action-card-status.zh.md)

## Summary

Adds action-card status attribution to logged model context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-action-card-status
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-25-prompt-references"
    after: "a1e70b4f7de5457c5034fc8b5b09d86dc7597f30cecb4a38bce1dfebb0e68ce7"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-25-prompt-references"
    after: "5112a5c22d4df5b9d378a9329d69097de3f2fadaf93e10158924364e14726246"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-25-prompt-references"
    after: "077dda2f8133f4c22085ffcbcc968cd80ec172825e5e7dead7d8784aa024df8c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-25-prompt-references"
    after: "9a9aee7a1fe9f796c25993e3c19fa496a3fd84c7ba7b8e472bf594064d3e6939"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing messages and records are unchanged. Readers without the action-card plugin preserve the new action-cards source kind and its JSON metadata and derive the recorded text as ordinary context. Only the producer uses the through sequence, to acknowledge delivered decisions; it grants no authority and does not change replay interpretation.

<a id="verification"></a>
## Verification

pnpm exec vitest run on the action-cards, creation-recommendations, client-ui-action-cards and client-ui-creation-recommendations tests: 120 tests passed with 100% coverage of their sources. The Web creation-recommendations replay logs the status notice of a dismissed card before the next answer.

<a id="dev-note"></a>
## Dev Note

None.
