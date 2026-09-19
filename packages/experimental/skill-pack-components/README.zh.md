---
description: "一套部署组合起来、架在组件目录与它的技能包根目录之间的适配器：它把这套部署交出去的组件发布成技能包所要求的部件，于是一个技能包在它要摆的界面存在之前会一直被扣下；面向发放技能包的部署方，以及这条缝的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-skill-pack-components

[English](README.md) | 中文

## 概述

两个互相不能依赖的包在这里碰头。[`component-surface`](../component-surface/README.zh.md) 拥有 `ctx.componentCatalog`——一套部署注册了哪些组件、其中又交出去哪些——而它对技能包一无所知。[`skill-pack`](../skill-pack/README.zh.md) 在一个技能包的视图要摆的组件部件存在之前一直扣着它，声明了回答「有哪些部件」的那个服务键，并且不伸手进任何组件包去回答它。这一行就是一套部署用来把两者接起来的东西，也是这条边唯一双向跑的地方。

它发布的是这套部署**交出去**的组件，而不是注册了的组件。一个部署没有打开的组件画不出来，所以需要它的技能包必须保持未激活——把 `dataPage` 关着的控制台上那个部署自己的完整数据页就是这种情况，这也正是组件目录为什么要回答一份「交出去的」名单。

视图走的是反方向。每个已激活技能包的视图都作为一个来源交给 `ctx.componentViews`，并在技能包集合一动就重新交一次，于是技能包一激活它的视图就进侧栏、一失活就从侧栏消失，不用重启。

## 目录

- [怎么挂](#mount-it)
- [一个部件带着什么](#what-one-part-carries)
- [交出去的，不是注册了的](#offered-not-registered)
- [判定一个技能包的视图](#judging-a-packs-views)
- [把它们摆出去](#placing-them)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="mount-it"></a>
## 怎么挂

挂在组件表面和技能包根目录提供方之后的任何位置。这一行没有配置：它发布什么，是从旁边那两个服务读出来的。

```yaml
- name: '@deepseek-ai/dsh-experimental-component-kit'
- name: '@deepseek-ai/dsh-experimental-component-surface'
  config:
    dataPage: true
- name: '@deepseek-ai/dsh-experimental-skill-pack'
  config:
    root: /var/lib/dsh/packs
    platformVersion: 0.5.2
- name: '@deepseek-ai/dsh-experimental-skill-pack-components'
```

`ctx.componentCatalog` 是必需依赖，而不是可选等待：没有组件目录就没有什么可适配，而一行发布空部件表的行，会对一套根本没组合过组件表面的部署回答「没有组件插件注册了这个部件」。只组合了技能包根目录、没组合这一行的部署，会从 `skill-pack` 自己那里拿到同样 fail-closed 的答案，而它的状态路由会说出每个技能包在等哪个部件。

<a id="what-one-part-carries"></a>
## 一个部件带着什么

一个交出去的组件就是一个部件：技能包在 `requires.parts` 里点名的那个目录 id、注册它的那个包的 npm 名，以及那个包自己的版本——后者正是技能包 `requires.components` 里的范围要去匹配的东西。

| 部件字段 | 从哪里读来 |
|---|---|
| `id` | 组件自己的目录 id，例如 `toy.data-page` |
| `plugin` | 贡献方包的 npm 名，注册时从那个包自己的清单读出来 |
| `version` | 同一份清单里的版本 |

这个身份是贡献方包自己的，而不是这里写下来的任何东西，所以一个技能包和它所针对写的插件对版本达成一致，谁也不用把它写第二遍。

变更通知就是组件目录自己的订阅，连同它的销毁器一起。组件插件挂上或撤走，正是一个技能包状态翻转所依据的那个事件；再包一层通知器只会多出一条让两者对「这件事什么时候发生」各说各话的路。

<a id="offered-not-registered"></a>
## 交出去的，不是注册了的

`ctx.componentCatalog.offered` 是注册了的组件减去这套部署不会摆的那些。注册一个组件是贡献插件的动作，交出它是部署方的动作，而只要某个组件需要部署方没有打开的东西，两者就会不一样。

今天有一个组件处在这个位置：`toy.data-page`，也就是部署自己的完整数据页——除非 `dataPage: true`，否则每套 `show_component` 组合都会把它排除在模型看到的名单之外。一套组合了组件插件却把 `dataPage` 关着的控制台注册了这个页面而画不出它，于是视图里摆了它的技能包谁也拿不到：模型永远不会被告知这个技能存在，而 `GET /skill-pack/status` 会说 `no component plugin registers the part toy.data-page`。

<a id="judging-a-packs-views"></a>
## 判定一个技能包的视图

技能包根目录在交出任何东西之前先问：技能包声明的每一份视图文件都会被交给 `ctx.componentViews.judge`，而那正是一次真实 `show_component` 调用所走的判定。组件目录画不出来的视图会让**整个技能包**未激活，并在 `GET /skill-pack/status` 上点名文件、文件里的那个值，以及模型本来会收到的那句拒绝。带着一个谁也画不出来的视图的技能包，比根本不在那里的技能包更糟——这就是拒绝落在技能包而不是落在那个视图上的原因。

已经被交出去的 id 也按同样方式拒绝。部署自己配置的视图拥有它们的 id；认领其中之一的技能包会被扣下，而不是丢掉那个视图；两个技能包认领同一个 id 时后面那个也一样，而这由技能包根目录按技能名顺序决定。

<a id="placing-them"></a>
## 把它们摆出去

技能包确实交出来的东西，会以本包名义作为一个来源注册进 `ctx.componentViews`。读是异步的而注册不是，所以每次读取都带着提出它的那次刷新的编号：被后一次刷新取代的读取，以及在这一行已经走了之后才回来的读取，都会被丢掉。

从那里往后走的就是配置视图早已走过的那条路——侧栏从 `GET /component-surface/views` 列出它，一次点击执行 `/show-content-view`，落进内容栏的是配置视图被点击时写下的那条同样的会话事件。

<a id="model-experience"></a>
## 模型体验

间接地，经由 [`skill-pack`](../skill-pack/README.zh.md#model-experience)：这一行自己不注册任何提示词、schema、工具或结果，它改变的是哪些技能包的要求得到了回答——这一行答得上的技能包会以普通技能的身份进入合并技能目录，答不上的则一直不在。

#### KV 缓存影响

只经由技能注册表的消费者。会话中途挂上或撤走一个组件插件会翻转某个技能包的状态，从而让那个消费者的持久目录失效；消费者会追加一条替换件，而不是重写前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **一份组件目录，一个技能包根目录。** 这一行把唯一的 `ctx.componentCatalog` 适配到唯一的 `ctx.skillPackParts` 键上。有两个技能包根目录的部署会挂两行 `skill-pack`，而两行读到的是同一份部件——这在今天是对的，一旦技能包根目录按用户划分，它就不再对了。
- **部件的粒度就是组件，再小就没有了。** 技能包要求 `toy.data-page`，得到的答复是这个组件在不在；它没法要求组件的某个属性、某个动作，也没法要求组件自身的版本。组件的版本就是它所在包的版本，所以一个包发的两个组件永远不可能被要求在不同版本上。
- **范围匹配的是包的版本，不是组件的版本。** 一个在补丁版里改名或去掉了某个组件的插件，照样满足 `>=0.4.0`，于是技能包会激活到一个在它脚下变过的组件上。今天挡住这件事的是 `requires.parts`：它点名 id，并检查它在不在。
- **在 id 冲突里输掉的技能包只能从状态路由知道这件事。** 那条拒绝点名这个 id 并说它已经被交出去了；它不点名是哪个配置视图或哪个别的技能包占着它，因为判定跑在索引建起来之前，而只有索引知道占着的人是谁。运维手上有的是这两份文档摆在一起。
- **没有被组装快照覆盖** —— 这一行由它自己的真实组合用例覆盖；快照泳道重放的是发行组合，而那里不组合任何 experimental 行。

**运行时不变量：** 不发布伴生件，因为这个包不持有任何状态：两个读都是在调用那一刻从 `ctx.componentCatalog` 算出来的，没有任何东西能被一次独立观察所否定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
