---
kind: upgrade-guide
description: "视图在 `spec` 任何位置写了名为 `__proto__` 的键时，判定时会在这个键上被拒绝。"
---

# 视图不能写名为 `__proto__` 的键

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.1 中，视图 `spec` 里名为 `__proto__` 的键——无论视图写在 `cordis.yml` 或 `--patch` overlay 里 `@deepseek-ai/dsh-experimental-component-surface` 的 `views` 配置中，还是写在技能包的视图文件里——会被读成它所在对象的原型。视图照常加载，键下面的属性不经按名判定就被画出来：`toy.data-page` 块的 `props` 里写 `__proto__: { readOnly: false }` 会把页面打开为可写，键下面没有组件声明的键被丢掉而不是被拒绝，键下面的内容也不计入 spec 的 65536 字节上限。

下一版本把这个键当作普通的键保留下来，并在这个键上拒绝视图，用的是带着同一个键的 `show_component` 调用得到的那句话：在块的属性里或对象值属性里是 `is not accepted here. Accepted properties: …`，与节点的 `id`、`component`、`props` 并列时是 `is not part of a node. …`，与 `nodes` 并列时是 `is not part of a spec. …`。写在 `views` 配置里的视图会让这一行以 error 级别失败，部署起来后没有组件、没有视图，也没有 `show_component` 工具：

```
component-surface: views[0] "site-overview" — spec.nodes[0].props.__proto__ — is not accepted here. Accepted properties: dataList, labelWidth, columnNum.; this deployment comes up with no components, no views and no show_component tool until that view is corrected or removed
```

带着这种视图的技能包变为未激活，`GET /skill-pack/status` 会点名那个文件、那个路径和同一句话。

## 迁移

1. 在 `cordis.yml`、`--patch` overlay 和技能包视图文件的视图 spec 里，找出每个名为 `__proto__` 的键。
2. 把写在这个键下面的每个属性移到这个键所在的对象里，然后删掉这个键：

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

   组件没有声明的属性随后会被按名拒绝，把它删掉。此时 JSON 超过 65536 字节的 spec 会因大小被拒绝，把它缩短。
3. 确认：部署启动时没有 `component-surface: views[…]` 的 error 行，`GET /component-surface/views` 列出了这个视图，`GET /skill-pack/status` 显示带着它的技能包已激活。
