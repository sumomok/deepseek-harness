---
description: "Safe binary file write with symlink containment and TOCTOU mitigation for screenshot restore and artifact output."
kind: "package-library"
---

# @deepseek-ai/dsh-safe-binary-write

## Summary

Use `dsh-safe-binary-write` when writing binary data (screenshots, images, artifacts) that must stay within a workspace boundary. It rejects dangling symlinks, refuses to follow symlinks that escape the allowed root, and mitigates TOCTOU races by writing to a temporary file in the same directory and renaming atomically. This zero-dependency library is designed for scenarios like screenshot restore where following a symlink could write outside the intended workspace.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Use `writeBinarySafe` when binary content must be written inside a specific directory boundary without following symlinks that could escape it.

### Writing binary data safely

```ts
import { writeBinarySafe } from '@deepseek-ai/dsh-safe-binary-write'

declare const screenshotData: Uint8Array
declare const workspaceRoot: string

await writeBinarySafe(
  '/workspace/screenshots/capture.png',
  screenshotData,
  workspaceRoot,
  { mode: 0o600 }
)
```

The function:
- Verifies the target path is under the allowed root
- Checks no symlinks in the path escape the root
- Creates parent directories as needed (within the root)
- Writes to a temporary file with exclusive create
- Verifies no symlinks were introduced during the write
- Atomically renames the temp file to the target

### Failures to plan for

The function throws `SymlinkContainmentError` when:
- The target path itself is a symlink
- Any parent directory in the path is a symlink
- A symlink points outside the allowed root
- The target is a dangling symlink

Regular filesystem errors (EACCES, ENOSPC) propagate as-is. The temporary file is cleaned up on any failure.

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `writeBinarySafe` function and `SymlinkContainmentError` |

### Write path

1. **Lexical containment check**: Verifies the target path is lexically under the allowed root using normalized absolute paths
2. **Symlink scan**: Walks up from target to root, checking each component with `lstat` to detect symlinks
3. **Directory creation**: Creates parent directories within the allowed root
4. **Temporary write**: Writes complete data to a random-suffix temp file in the same directory using `wx` flag (exclusive create, no symlink following)
5. **Final verification**: Re-checks for symlinks before rename
6. **Atomic rename**: Renames temp over target (replaces symlink itself if target is one)

### Why the write stays safe

- **No symlink following** — `lstat` detects symlinks without following them; `wx` flag refuses to follow symlinks during write; `rename` replaces a symlinked target rather than writing through it
- **Path containment enforced** — every component checked before and during write
- **TOCTOU mitigation** — temp file in same directory ensures atomic rename; final symlink check before rename catches races
- **Fresh inode with caller mode** — temp file carries permission bits through rename
- **Cleanup on failure** — temp file removed if any step fails

</details>

-----

## Model Experience

None, as this is a pure filesystem write primitive that registers nothing model-facing.

### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

These limits define where the package is not the right tool. They are current package constraints, not a task backlog.

- **Binary data only** — accepts `Uint8Array` (including `Buffer`); text content should use `dsh-atomic-write`
- **Single-host operation** — symlink checks run on the current host; network filesystems shared across hosts may see different symlink states
- **No durability guarantee** — no `fsync` of file or directory, so after crash the write may be unwound
- **Residual TOCTOU** — narrow window between final symlink check and system call; accepted for this threat model where untrusted paths, not untrusted code, are the concern
- **Rejects all symlinks in path** — conservative policy; legitimate in-workspace symlinks are blocked
