---
kind: upgrade-guide
description: "数据页视图关掉页面自己的新增或修改表单、却保留打开它的按钮时，会在加载时被拒绝。"
---

# 数据页视图不能保留其表单已被关掉的按钮

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.1 中，在 `dataPage: true` 的部署上，一个视图摆了 `readOnly: false` 的 `toy.data-page`，并用 `regions.addForm: false` 或 `regions.modifyForm: false` 关掉页面自己的一个表单，这个视图可以加载，页面上也保留着打开那个表单的按钮。下一版本在判定视图时拒绝这样的视图，除非视图里还摆了一个读取页面 `editing` 输出的 `toy.form-page`。`regions.toolbar` 不为 `false`、且 `toolbarButtons` 列出 `add` 或没有写时，新增按钮算保留；`rowOperations` 列出 `modify` 或没有写时，修改按钮算保留（[视图规则](../../../../packages/experimental/component-surface/README.zh.md#view-placed-components)）。

写在 `@deepseek-ai/dsh-experimental-component-surface` 的 `views` 配置里的视图会让这一行以 error 级别失败，部署起来后没有组件、没有视图，也没有 `show_component` 工具：

```
component-surface: views[0] "layers" — spec.nodes[0].props.regions.addForm — is false while the page keeps its add button, and no toy.form-page in this view reads editing of "page": the button would open nothing.; this deployment comes up with no components, no views and no show_component tool until that view is corrected or removed
```

带着这种视图的技能包变为未激活，`GET /skill-pack/status` 会点名那个文件、那个值和同一句话。

这一版本还加了别的视图规则，每一条都只判定摆了 `toy.form-page` 或 `toy.info-card` 的视图。没有哪个组件插件注册这两块，所以这样的视图会因点名了部署没有的组件而被拒绝，与 v0.2.1-alpha.1 相同；以前能加载的视图都碰不到这些规则。

## 迁移

1. 在 `cordis.yml`、`--patch` overlay 和技能包的视图文件里，找出每个摆了 `toy.data-page`、且 `regions` 写了 `addForm: false` 或 `modifyForm: false` 的视图。
2. 对每个关掉了表单却保留了按钮的地方，任选一种改法：
   - 删掉 `addForm: false` 或 `modifyForm: false` 这一项，让页面重新画出自己的表单；
   - 去掉按钮：新增表单的，从 `toolbarButtons` 删掉 `add`，或设 `regions.toolbar: false`；修改表单的，从 `rowOperations` 删掉 `modify`；
   - 不写 `readOnly`，页面因此只读，两个按钮都不画。

   改为摆一个 `toy.form-page` 块会因点名了部署没有的组件而被拒绝。
3. 确认：部署启动时没有 `component-surface: views[…]` 的 error 行，`GET /component-surface/views` 列出了这个视图，`GET /skill-pack/status` 显示每个带数据页视图的技能包都已激活。
