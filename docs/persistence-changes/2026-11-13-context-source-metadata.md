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
    previous: "2026-10-27-retry-control-input"
    after: "60131246b57c365269ddf04bbea7767b7a69882016c26186c6d268b5b9aa0647"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "6e0e5bb1b52e3eeade2262503f7ab33319eb095403d09840e34dfd2c073dbb7d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "b7513b6f33332679ef8fb039b0e255b595445a024a8196c209e0807b44f256b1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "d417e49b19afc351e8877aad429bb3c6a325981a5bad9c63279c6b6812f59737"
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
