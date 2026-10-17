---
kind: upgrade-guide
description: "An act_component step carrying a field its action does not take, or a click whose key names several drawn controls, now fails instead of running with the field dropped or pressing the first match, and a report the agent's own step caused reaches the agent as that step's."
---

# act_component: extra step fields and shared keys are refused

English | [中文](guide.zh.md)

## Change

This concerns the `act_component` tool of `@deepseek-ai/dsh-experimental-component-surface` and every component plugin whose blocks mark controls with `data-component-action` and `data-component-key`.

In v0.2.1-alpha.4 a step's extra fields were dropped: a `click` carrying `name` or `value`, a `set` carrying `key`, and a `wait` carrying `name` or `value` ran as if the field were absent. A `click` whose key named several drawn controls pressed the first one in document order. A report a block sent while the agent's own `click` or `set` step ran reached the agent worded as the user's and could wake it.

In the next release such a step refuses the whole call before any step runs:

```
step 1: a click presses one control named by its key, so it takes no "name".
```

`timeoutMs` on a `click` or a `set` is still dropped. A `click` whose key names several drawn controls presses none, and the step fails naming what tells them apart:

```
- click on "press": action "press" names 3 drawn controls in the entry; name the one to press by its own key: approve, later, reject.
```

A report a block sends while a `click` or `set` step is held carries `step` in its `/component-action` document, opens with `This report comes from step N of your own call acting on this entry, not from the user: `, and never opens a turn. A component's `describe` receives `actor`, `user` or `agent`.

Affected are skill packs and prompts that pass those fields, component plugins that draw several controls with one action key and no distinct own key, and `describe` functions that always word the account as the user's.

## Migration

1. In skill packs and prompts, remove `name` and `value` from `click` and `wait` steps and `key` from `set` steps.
2. In a component plugin, give every control that shares an action key with another control drawn in the same entry its own `data-component-key`: 1 to 64 characters of letters, digits, `_` or `-`, different for each control.
3. In a component plugin's `describe(context)`, read `context.actor` and word the `agent` case as the agent's own (`You picked …`); the opening sentence is added either way.
4. Confirm: `read_component` lists each control's own key, an `act_component` `click` naming one returns `done`, and the notice it causes opens with the sentence above.
