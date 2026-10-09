---
kind: upgrade-guide
description: "数据页视图关掉一个表单却保留它的按钮时会在加载时被拒绝；可写的视图没写按钮名单时会多出批量按钮和行内删除按钮。"
---

# 数据页视图：关掉的表单需要表单页，缺省按钮多了批量与删除

[English](guide.md) | 中文

## 变更

两处变化都针对在 `dataPage: true` 的部署上、摆了 `readOnly: false` 的 `toy.data-page` 的视图。

在 v0.2.1-alpha.1 中，这样的视图可以用 `regions.addForm: false` 或 `regions.modifyForm: false` 关掉页面自己的一个表单，同时保留打开它的按钮。下一版本在判定视图时拒绝这样的视图，除非视图里还摆了一个读取页面 `editing` 输出的 `toy.form-page`。`regions.toolbar` 不为 `false`、且 `toolbarButtons` 列出 `add` 或没有写时，新增按钮算保留；`rowOperations` 列出 `modify` 或没有写时，修改按钮算保留（[视图规则](../../../../packages/experimental/component-surface/README.zh.md#view-placed-components)）。写在 `@deepseek-ai/dsh-experimental-component-surface` 的 `views` 配置里的视图因此会让这一行以 error 级别失败，部署起来后没有组件、没有视图，也没有 `show_component` 工具：

```
component-surface: views[0] "layers" — spec.nodes[0].props.regions.addForm — is false while the page keeps its add button, and no toy.form-page in this view reads editing of "page": the button would open nothing.; this deployment comes up with no components, no views and no show_component tool until that view is corrected or removed
```

带着这种视图的技能包变为未激活；`GET /skill-pack/status` 会点名那个文件、那个值和这句话。

没写 `toolbarButtons` 的视图原来画 `add`、`exp`、`gridexp`、`search` 和 `clear`，现在还画 `batch`，即放着批量修改和批量删除的菜单。没写 `rowOperations` 的视图原来在每一行画 `modify`，现在还画 `delete`。视图不写 `1` 或 `2` 时，删除会保留仍绑着空间资源的记录（`deleteGisResource: 3`）。部署规则表不允许的入口，仍会按访客的权限去掉。

这一版本的其他视图规则只判定摆了 `toy.form-page` 或 `toy.info-card`、或写了 `infoCardLinks` 的视图，以前没有视图能带着这些加载。

## 迁移

1. 在 `cordis.yml`、`--patch` overlay 和技能包的视图文件里，找出每个摆了 `readOnly: false` 的 `toy.data-page` 的视图。
2. 对 `regions` 关掉了表单却保留了按钮的地方，任选一种改法：
   - 摆一个 `toy.form-page`，`relatedMeta` 与页面相同，写 `request: { $from: "node:<页面 id>.editing" }`，并把 `addForm: false` 和 `modifyForm: false` 都写上；
   - 删掉那一项 `false`，让页面重新画出自己的表单；
   - 去掉按钮：从 `toolbarButtons` 删掉 `add` 或设 `regions.toolbar: false`，或从 `rowOperations` 删掉 `modify`。
3. 没写 `toolbarButtons` 或 `rowOperations`、又想保留原来的按钮时，写上 `toolbarButtons: [add, exp, gridexp, search, clear]` 和 `rowOperations: [modify]`。
4. 确认：部署启动时没有 `component-surface: views[…]` 的 error 行，`GET /component-surface/views` 列出了这个视图，`GET /skill-pack/status` 显示每个带数据页视图的技能包都已激活。
