---
kind: upgrade-guide
description: "act_component 的步骤带了它的动作不收的字段，或者 click 的 key 指到多个画出的控件，现在会失败；click 用行键点名表格的一行；智能体自己的步骤引起的回报，以那一步的名义送到它面前。"
---

# act_component：步骤多余字段与共用的 key 被拒绝

[English](guide.md) | 中文

## 变更

本条涉及 `@deepseek-ai/dsh-experimental-component-surface` 里的 `act_component`，以及所有用 `data-component-*` 属性给控件打标记的组件插件。

v0.2.1-alpha.4 里，步骤的多余字段——`click` 或 `wait` 上的 `name`、`value`，`set` 上的 `key`——被丢掉。`click` 的 key 指到多个画出的控件时，按文档顺序的第一个。智能体自己的 `click` 或 `set` 步骤运行期间块发出的回报，以用户的口吻送到智能体面前，还可能唤醒它。

下一个版本里，这样的步骤会让调用在任何一步运行之前被拒绝：

```
step 1: a click presses one control named by its key, so it takes no "name".
```

`click` 或 `set` 上的 `timeoutMs` 照旧丢掉。`click` 的 key 指到多个画出的控件时一个也不按，这一步失败，并说出能区分它们的东西：

```
- click on "press": action "press" names 3 drawn controls in the entry; name the one to press by its own key: approve, later, reject.
```

数据页的格子与行操作、`toy.table` 的行点击，每行各画一份；`click` 用 `row` 点名那一行，值是 `read_component` 打印的行键：

```
- click on "modify": own key "modify" is carried by 3 drawn controls in the entry, one per row; name the row with `row`: 1134933624650219530, 1134933624650219531, 1134933624650219532.
```

`click` 或 `set` 步骤被持有期间块发出的回报，`/component-action` 文档里带 `step`，叙述以 `This report comes from step N of your own call acting on this entry, not from the user: ` 开头，从不开新的一轮。组件的 `describe` 会收到 `actor`，值是 `user` 或 `agent`。

受影响的：传了这些字段的技能包和提示词；用同一个动作键画多个控件、又没有各不相同的自有键的插件；总是按用户口吻写叙述的 `describe`。

## 迁移

1. 去掉技能包和提示词里步骤上的这些字段。
2. 按每行都画的控件时，加上 `row`，值取 `read_component` 给那一行打印的行键，而不是给每一份控件各配一个自有键。
3. 组件插件里，给表格的每一行标 `data-component-row`；凡是和同一行里、或所有行之外的另一个控件共用动作键的控件，都给它各不相同的 `data-component-key`；两者都是 1 到 64 个字符，只用字母、数字、`_`、`-`。可选：在一行里字能当行名的那个元素上写 `data-component-row-name`。
4. 组件插件的 `describe(context)` 里读 `context.actor`，`agent` 时按智能体自己做的写（`You picked …`）；开头那句无论如何都会加上。
5. 确认：`read_component` 列出自有键与行键，`act_component` 的 `click` 指名它们时返回 `done`，它引起的通知以那句开头。
