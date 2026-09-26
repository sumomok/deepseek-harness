---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-17-command-run-engages

English | [中文](2026-09-17-command-run-engages.zh.md)

## Summary

Adds the optional `engages` member to the persisted `command/run` payload, which records whether that run makes its Session leave the blank state.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-17-command-run-engages
baseline: false
changes:
  - root: "event:command/run"
    previous: "2026-09-11-initial"
    after: "9a944f8067e257ede51d92c059c34043c4dbcd59fa5b70a7215580875cd4ef08"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Older records omit the member, and the fold reads an absent value as an engaging run, which is the behavior every build before this patch had. Older readers ignore the member without changing replay: the value only selects whether the list-metadata fold clears `blank`, and a build that does not know it clears `blank` on every `command/run` exactly as it did before. Only a command that declares `engages: false` writes the member, so the corpus keeps at most one extra boolean per configuration-only command run.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/interaction/commands packages/api/session-controller packages/session/session-format-v0-to-v1 packages/session/session-format-v1-to-v2: 2 tests failed on an unrelated concurrent timeout and passed on rerun; all command-engagement, payload-validation and v0/v1/v2 migration cases passed.

<a id="dev-note"></a>
## Dev Note

None.
