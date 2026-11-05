---
description: "Post-compaction task-state rebuilding for deployments measuring what a checkpoint drops and for maintainers of the rehydration message."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-rehydration

English | [中文](README.zh.md)

## Summary

`dsh-compaction-rehydration` appends one durable message after a recoverable compaction checkpoint, restating task state the summary may have dropped: the todo list, the latest approved plan, workspace reads, unsettled jobs, and direct subagents. Sections are rebuilt from the Session log and written once per checkpoint, so resumed sessions do not repeat them. It is opt-in, makes no model request, caps the message at 4,000 characters, and omits or references files outside the workspace, known credential paths, and unverifiable reads.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside `dsh-agent`. The todo list, the plan, and unsettled jobs need no other service; the `Files` section uses the optional `ctx.fs` service and is left out when the deployment has none; mount `dsh-session-projection` to include the subagent section.

```yaml
- name: '@deepseek-ai/dsh-compaction-rehydration'
```

<a id="model-experience"></a>
## Model Experience

### The rebuild message

#### What the model sees

After a recoverable checkpoint, the next request carries one additional durable user message: the checkpoint preamble followed by the sections that have state, including the todo list, the latest approved plan, a bounded `Files` block, unsettled jobs, and direct subagents. It appears once per checkpoint and is not repeated on resume.

#### Token effect

The message is capped at 4,000 characters and truncated by section; it adds no model request. It restates state already in the Session log, so it can spend tokens the checkpoint summary mentions too, but it keeps task state that fell outside the retained tail.

#### KV Cache effect

The message appends after the checkpoint replacement. A provider-cached request prefix through that replacement stays reusable, while the rebuild message and the rest of the current turn are new uncached input.

## Known Limitations and Deferred Work

- The subagent section reads the parent-owned `subagentCatalog` projection. Focused tests register a catalog projection stub and cover direct children plus cross-session isolation; the real `dsh-subagent` plugin is not mounted in those tests.
- The jobs section folds `job/registered` and `job/settled` and never reports a job as running: a registration before the latest `session/end-seed` reads "may have stopped", and one after it reads "no settlement logged yet; it may still be running". A killed process that never logged a settlement stays uncertain.
- The message is capped at 4,000 characters and truncates by section; a very long plan loses its tail.
- The `Files` section lists at most five text reads and 2,000 characters. Two rules bound it: only a path inside the Session's working directory may appear, and known credential locations are omitted entirely. A Session without a working directory, a read outside it, or a credential-like path contributes nothing — not even an unchanged path name. Everything else follows freshness: a matching recorded version becomes one `already read` line, a changed whole-file read is restated as current content, and a recorded window, a missing or unreadable file, a file over the inspection ceiling, or a file without a filesystem service becomes a pointer instead.
- Credential matching covers `.npmrc`, `.netrc`, `.git-credentials`, `.htpasswd`, `.pgpass`, `.env*`, `id_rsa*`, key/keystore suffixes, `application_default_credentials.json`, and the `.ssh`/`.aws`/`.gnupg`/`.kube`/`.docker`/`.config/gcloud`/`.config/gh`/`secrets`/`credentials` locations. It is best-effort: an unknown secret with an ordinary name cannot be recognized by filename, so the durable boundary is the workspace plus the deployment's deny rules. When the filesystem backend cannot report containment, a normalized path comparison is used; remote and symlinked backends remain unverified.
- Read facts depend on the `read` tool's persisted `meta`; logs written before `version`/`digest` existed are checked with one bounded re-read. A pruned read result is resolved to its original sequence, and its old content is never treated as the current content.
- A checkpoint is the summary **and** its surface replacement. The closing `compaction/end` may be missing (the process died after the surface replacement committed) or carry an error (closing failed); the replacement is what made the summary model-visible, so the rebuild still runs in both cases. The logged `compactionSeq` is the closing event when one exists and the replacement otherwise. A summary with no replacement never reached the surface and is not a checkpoint, so no rebuild is written for it.
- Approval recognition depends on plan-mode's canonical result sentences; a rewording build degrades to omitting the plan, never to a guessed approval or a reinstated older plan.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Files restoration boundary, deliberate** — only reads inside the Session working directory and outside known credential locations are restated; unknown secrets rely on the workspace plus the deployment's deny rules, not on this package's filename list.
- **Missing-end recovery, accepted** — a summary plus its surface replacement is the checkpoint evidence even when `compaction/end` never committed; the closing event is preferred only as the logged `compactionSeq`.
</details>
