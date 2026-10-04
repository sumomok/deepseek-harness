---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-25-prompt-references

English | [中文](2026-09-25-prompt-references.zh.md)

## Summary

Adds optional prompt references to the browser prompt (`user-rpc`) message source.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-25-prompt-references
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "f59eae14fb97cbb776436a520bd7d09c14fd22952689537a62ca3ff27d7c2045"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "339640984b5b1b8274ee21777553560e3961286ad4e70025fe8582cdd3a91ccb"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "85d522c605d528c2fd9e8bff07aae252d4978834347520f79b0b088995dc9ef2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "943dcd53e5cf6a2369f7ce74afc19ad271da8085a5fd62766980f5ca04f1ea81"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: a source without `references` means the prompt carried none, and the Host omits the property instead of writing an empty array. Older format-4 readers already admit a known user source with extra JSON properties and return it verbatim. Replay, projections, titles, session_search, and provider request serialization do not read the property, so older readers ignore it without changing replay; session_event_read of the optional tool-session-query plugin returns the whole stored event, including references, inside a logged tool/result.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/api/session-controller/tests/session-cold.host.spec.ts packages/llm/llm-deepseek/tests/serialize.spec.ts: all tests passed, including verbatim admission of a user source carrying references in user/message and agent/inbox/spliced records and a Messages request body without references.

<a id="dev-note"></a>
## Dev Note

None.
