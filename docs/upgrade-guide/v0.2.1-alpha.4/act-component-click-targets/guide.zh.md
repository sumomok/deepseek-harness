---
kind: upgrade-guide
description: "act_component 的步骤带了它的动作不收的字段，或者 click 的 key 指到多个画出的控件，现在会失败，不再丢掉字段照跑或按第一个；智能体自己的步骤引起的回报，以那一步的名义送到它面前。"
---

# act_component：步骤多余字段与共用的 key 被拒绝

[English](guide.md) | 中文

## 变更

本条涉及 `@deepseek-ai/dsh-experimental-component-surface` 的 `act_component` 工具，以及所有用 `data-component-action`、`data-component-key` 给块里控件打标记的组件插件。

v0.2.1-alpha.4 里，步骤的多余字段被丢掉：`click` 带 `name` 或 `value`、`set` 带 `key`、`wait` 带 `name` 或 `value`，都当作没带照跑。`click` 的 key 指到多个画出的控件时，按文档顺序的第一个。智能体自己的 `click` 或 `set` 步骤运行期间块发出的回报，以用户的口吻送到智能体面前，还可能唤醒它。

下一个版本里，这样的步骤会让整次调用在任何一步运行之前被拒绝：

```
step 1: a click presses one control named by its key, so it takes no "name".
```

`click`、`set` 上的 `timeoutMs` 照旧丢掉。`click` 的 key 指到多个画出的控件时一个也不按，这一步失败，并说出能区分它们的东西：

```
- click on "press": action "press" names 3 drawn controls in the entry; name the one to press by its own key: approve, later, reject.
```

`click` 或 `set` 步骤被持有期间块发出的回报，`/component-action` 文档里带 `step`，叙述以 `This report comes from step N of your own call acting on this entry, not from the user: ` 开头，从不开新的一轮。组件的 `describe` 会收到 `actor`，值是 `user` 或 `agent`。

受影响的有：传了这些字段的技能包和提示词；用同一个动作键画多个控件、又没有各不相同的自有键的组件插件；总是按用户口吻写叙述的 `describe`。

## 迁移

1. 技能包和提示词里，去掉 `click`、`wait` 步骤的 `name` 和 `value`，以及 `set` 步骤的 `key`。
2. 组件插件里，凡是和同一条目里另一个画出的控件共用动作键的控件，都给它自己的 `data-component-key`：1 到 64 个字符，只用字母、数字、`_`、`-`，每个控件各不相同。
3. 组件插件的 `describe(context)` 里读 `context.actor`，`agent` 时按智能体自己做的写（`You picked …`）；开头那句无论如何都会加上。
4. 确认：`read_component` 列出每个控件的自有键，`act_component` 的 `click` 指名其中一个时返回 `done`，它引起的通知以上面那句开头。
