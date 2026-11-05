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
    previous: "2026-10-13-user-rpc-principal"
    after: "d8d8e7d8f398f9b6bf76872dbfa550b6627a2371c8c23e81671c30991003a3f5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "58e733b9a5e7a282025d7adf6e754d0f596b90cb4b069b701dcd8f9a365967cb"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "57ffe3611876596e30b389419b2ffe2a36ebb466f0253a348cd16a1e8848ee27"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "afadd5a3d07b87d6d7f071783f697448a10fdb0b2e36c47d0512f50468defa7c"
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
