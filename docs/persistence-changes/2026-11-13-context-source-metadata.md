---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-13-context-source-metadata

English | [中文](2026-11-13-context-source-metadata.zh.md)

## Summary

Retain Session format V4 while adding optional user-source references and the compaction-rehydration and memory-recall source alternatives. These additions affect user messages, developer messages, inbox insertions, and the transitive Message[] declaration of title requests.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-13-context-source-metadata
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "45208004157e7eb092cf2cd1db29732a1165ad0ac22a78e89ce84c4bdced4651"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "37f582f240a1c71ec6610d172676798eb3152028cae7fca9b504aaec3d052c99"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "807451bab51cb00fb2a583a3c65c8efc1a811dfe72c50bfd28ea7e206f4ba79f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "0d6956551d91064b61b658d877e0366f37183562fa5f80fb27157b3aaa30c8f8"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Historical user sources without references remain readable without synthesized metadata. The optional references field contains display and owner JSON, independently of message content; its absence preserves ordinary prompt behavior. Older V4 readers preserve additional source fields verbatim. The two new producer kinds carry context already recorded in message content: compaction-rehydration records checkpoint identity, section digests and optional ContextFormed metadata; memory-recall records its query digest and selected event identities. Native V4 admission accepts nonempty producer kinds without installing those producers. User and developer surface messages retain their content and source metadata when deriving history; inbox insertions remain pending. Producer-specific duplicate suppression consumes the recorded metadata only when that producer is installed. Existing kinds, roles, header version and envelope rules are unchanged.

The title-request union changes transitively through user and developer source alternatives; it does not authorize additional runtime title representations. The title writer still records one user message with source.kind dsh-session-title-llm and one text block. Both older and current readers require that discriminator and earlier human messageSeqs. They reject title requests carrying the new source alternatives before returning a handle, without changing or truncating the file. Ordinary historical title requests remain readable and remain outside conversation history.

The compatibility regression exercised current readers, the pre-integration master reader sources, and the published dsh-v0.2.0-rc.2 reader sources. Each preserved accepted records and refused invalid title sources for read and write opens in both plain JSONL and Zstandard encoding. Historical runs used the checkout's installed dependencies; the published plugin's default export received a test-only mounting adapter. No historical reader implementation or accepted persistence record was changed.

<a id="verification"></a>
## Verification

Ran node node_modules/vitest/vitest.mjs run with [merged-source-compatibility.spec.ts](../../packages/session/session-persistence-jsonl/tests/merged-source-compatibility.spec.ts), [native-source-admission.spec.ts](../../packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts), [message-sources.spec.ts](../../packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts), [title llm.spec.ts](../../packages/session/session-title-llm/tests/llm.spec.ts), and [DeepSeek serialize.spec.ts](../../packages/llm/llm-deepseek/tests/serialize.spec.ts): 5 files and 323 tests passed. The new 160-case regression checks exact events, derived content, historical references absence, all seven rehydration form alternatives, memory recall, canonical titles, invalid-title refusal, unchanged bytes, and unchanged generation count without producer plugins.

Ran the same new regression with Vitest aliases selecting the historical Session, format catalog, four versioned format packages, format service, persistence service and JSONL provider sources: 160 tests passed for the integration base and 160 passed for dsh-v0.2.0-rc.2.

Ran node node_modules/vitest/vitest.mjs run with [rehydration.spec.ts](../../packages/context/compaction-rehydration/tests/rehydration.spec.ts), [memory-recall.spec.ts](../../packages/test-support/session-snapshot/tests/memory-recall/memory-recall.spec.ts), [prompt-references.spec.ts](../../packages/attachment/attachment/tests/prompt-references.spec.ts), and [pi-ai convert.spec.ts](../../packages/llm/llm-pi-ai/tests/convert.spec.ts): 4 files and 155 tests passed, including restart/fork duplicate suppression and reference validation.

<a id="dev-note"></a>
## Dev Note

None.
