---
description: "Post-compaction task-state rebuilding for deployments measuring what a checkpoint drops and for maintainers of the rehydration message."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-rehydration

English | [中文](README.zh.md)

## Summary

`dsh-compaction-rehydration` appends one durable message after a successful compaction that restates the task state the checkpoint may have dropped: the current todo list, the last approved plan, background jobs the session registered and never settled, and the direct subagents its catalog holds. Every section is rebuilt from the Session's own log (never a fork-inherited prefix) or a projection folded over it, and the message is written once per checkpoint; a resumed Session sees that the rebuild already happened.

The todo list folds the latest whole-list `todo/write` rather than reading the `todos` projection. The two are different semantics: the durable list survives across turns and reopened sessions (as `dsh-tool-todo` states), while that projection is a standing-plan view that clears when the next turn starts. A compaction at a turn boundary must restore the list, so the log is authoritative here.

Only the newest `exit_plan_mode` review decides. An approval carries plan-mode's approved sentence; a dismissal — a non-error result — or an answer this build does not recognise leaves the current plan undecided, so no earlier approval is reinstated and no plan is injected. A review with no result yet is still open, and the plan is left out rather than guessed.

This package is a prototype: it is opt-in, not mounted by any shipped composition, and it treats an absent projection as a missing section rather than a failure. It adds one message source kind and no Session event types.

## Use this package

Mount it beside `dsh-agent`. The todo list, the plan, and unsettled jobs need no other service; mount `dsh-session-projection` to include the subagent section.

```yaml
- name: '@deepseek-ai/dsh-compaction-rehydration'
```

## Known Limitations and Deferred Work

- The subagent section reads the parent-owned `subagentCatalog` projection. Focused tests register a catalog projection stub and cover direct children plus cross-session isolation; the real `dsh-subagent` plugin is not mounted in those tests.
- The jobs section folds `job/registered` and `job/settled` and never reports a job as running: a registration before the latest `session/end-seed` reads "may have stopped", and one after it reads "no settlement logged yet; it may still be running". A killed process that never logged a settlement stays uncertain.
- The message is capped at 4,000 characters and truncates by section; a very long plan loses its tail.
- A checkpoint is the summary **and** its surface replacement. The closing `compaction/end` may be missing (the process died after the surface replacement committed) or carry an error (closing failed); the replacement is what made the summary model-visible, so the rebuild still runs in both cases. The logged `compactionSeq` is the closing event when one exists and the replacement otherwise. A summary with no replacement never reached the surface and is not a checkpoint, so no rebuild is written for it.
- Approval recognition depends on plan-mode's canonical result sentences; a rewording build degrades to omitting the plan, never to a guessed approval or a reinstated older plan.
