---
kind: upgrade-guide
description: "视图在 `spec` 的任何映射里写了名为 `__proto__` 的键时，会在这个键上被拒绝，视图其余部分都不再受判。"
---

# 视图不能写名为 `__proto__` 的键

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.1 中，视图 `spec` 里名为 `__proto__` 的键——无论视图写在 `cordis.yml` 或 `--patch` overlay 里 `@deepseek-ai/dsh-experimental-component-surface` 的 `views` 配置中，还是写在技能包的视图文件里——会被读成它所在映射的原型。视图照常加载，键下面的内容不经按名判定就被画出来：`toy.data-page` 块的 `props` 里写 `__proto__: { readOnly: false }` 会把页面打开为可写，键下面没有组件声明的键被丢掉而不是被拒绝，表格某一行里写在这个键下面的文本单元格被丢掉，键下面的内容也都不计入 spec 的 65536 字节上限。

下一版本在这个键上拒绝这种视图，不论它出现在 `spec` 的哪个映射里（表格的行也算），并且在视图其余部分被读取或计量之前就拒绝。键下面的属性不论组件是否声明过，都因为这个键被拒；键下面的行也因为这个键被拒，而不是因为 spec 的大小。写在 `views` 配置里的视图会让这一行以 error 级别失败，部署起来后没有组件、没有视图，也没有 `show_component` 工具：

```
component-surface: views[0] "site-overview" — spec.nodes[0].props.__proto__ — is a key named __proto__, which no mapping of a view may carry: copied by assignment, the value under it becomes the mapping's prototype instead of a key, so two readers of one file would disagree on what it holds; this deployment comes up with no components, no views and no show_component tool until that view is corrected or removed
```

带着这种视图的技能包变为未激活，`GET /skill-pack/status` 会点名那个文件、那个路径和同一句话。`show_component` 调用不受这项变更影响。

## 迁移

1. 在 `cordis.yml`、`--patch` overlay 和技能包视图文件的视图 spec 里，找出每个名为 `__proto__` 的键。
2. 把写在这个键下面的每个属性移到这个键所在的映射里，然后删掉这个键：

   ```yaml
   # before
   props:
     relatedMeta: SpaceLayer
     __proto__: { readOnly: false }
   # after
   props:
     relatedMeta: SpaceLayer
     readOnly: false
   ```

   组件没有声明的属性随后会被按名拒绝，把它删掉。此时 JSON 超过 65536 字节的 spec 会因大小被拒绝，把它缩短。视图里表格的行不能带键为 `__proto__` 的单元格，把这个单元格和读取它的列一起删掉。
3. 确认：部署启动时没有 `component-surface: views[…]` 的 error 行，`GET /component-surface/views` 列出了这个视图，`GET /skill-pack/status` 显示带着它的技能包已激活。
