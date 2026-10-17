---
kind: upgrade-guide
description: "An act_component step carrying a field its action does not take, or a click whose key names several drawn controls, now fails; a click names a table row by its key; and a report the agent's own step caused reaches it as that step's."
---

# act_component: extra step fields and shared keys are refused

English | [中文](guide.zh.md)

## Change

This concerns the `act_component` tool of `@deepseek-ai/dsh-experimental-component-surface` and every component plugin that marks controls with `data-component-*` attributes.

In v0.2.1-alpha.4 a step's extra fields — `name` or `value` on a `click` or a `wait`, `key` on a `set` — were dropped. A `click` whose key named several drawn controls pressed the first one in document order. A report a block sent while the agent's own `click` or `set` step ran reached the agent worded as the user's and could wake it.

In the next release such a step refuses the whole call before any step runs:

```
step 1: a click presses one control named by its key, so it takes no "name".
```

`timeoutMs` on a `click` or a `set` is still dropped. A `click` whose key names several drawn controls presses none, and the step fails naming what tells them apart:

```
- click on "press": action "press" names 3 drawn controls in the entry; name the one to press by its own key: approve, later, reject.
```

Data page cells and row operations and `toy.table` row clicks are drawn once per row; a `click` names the row with `row`, the key `read_component` prints:

```
- click on "modify": own key "modify" is carried by 3 drawn controls in the entry, one per row; name the row with `row`: 1134933624650219530, 1134933624650219531, 1134933624650219532.
```

A report a block sends while a `click` or `set` step is held carries `step` in its `/component-action` document, opens with `This report comes from step N of your own call acting on this entry, not from the user: `, and never opens a turn. A component's `describe` receives `actor`, `user` or `agent`.

Affected are skill packs and prompts passing those fields, plugins drawing several controls under one action key without distinct own keys, and `describe` functions wording every account as the user's.

## Migration

1. Remove those fields from the steps in skill packs and prompts.
2. Press a control every row draws by adding `row`, that row's key from `read_component`; do not give each row's copy its own key.
3. In a component plugin, mark each table row with `data-component-row`, and give each control sharing an action key with another in its row, or outside every row, a distinct `data-component-key`; both take 1 to 64 letters, digits, `_` or `-`.
4. In a component plugin's `describe(context)`, read `context.actor` and word the `agent` case as the agent's own (`You picked …`); the opening sentence is added either way.
5. Confirm: `read_component` lists own and row keys, a `click` naming them returns `done`, and its notice opens with the sentence above.
