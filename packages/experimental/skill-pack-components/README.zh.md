---
description: "一套部署组合起来、架在组件目录与它的技能包根目录之间的适配器：它把这套部署交出去的组件发布成技能包所要求的部件，于是一个技能包在它要摆的界面存在之前会一直被扣下；面向发放技能包的部署方，以及这条缝的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-skill-pack-components

[English](README.md) | 中文

## 概述

两个互相不能依赖的包在这里碰头。[`component-surface`](../component-surface/README.zh.md) 拥有 `ctx.componentCatalog`——一套部署注册了哪些组件、其中又交出去哪些——而它对技能包一无所知。[`skill-pack`](../skill-pack/README.zh.md) 在一个技能包的视图要摆的组件部件存在之前一直扣着它，声明了回答「有哪些部件」的那个服务键，并且不伸手进任何组件包去回答它。这一行就是一套部署用来把两者接起来的东西，也是这条边唯一双向跑的地方。这个包还写出[组件目录文件](#the-component-catalog-file)，供写技能包的人拼视图时读。

## 目录

- [怎么挂](#mount-it)
- [一个部件带着什么](#what-one-part-carries)
- [交出去的，不是注册了的](#offered-not-registered)
- [判定一个技能包的视图](#judging-a-packs-views)
- [把它们摆出去](#placing-them)
- [组件目录文件](#the-component-catalog-file)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="mount-it"></a>
## 怎么挂

它发布的是这套部署**交出去**的组件，而不是注册了的组件。一个部署没有打开的组件画不出来，所以需要它的技能包必须保持未激活——把 `dataPage` 关着的控制台上那个部署自己的完整数据页就是这种情况，这也正是组件目录为什么要回答一份「交出去的」名单。

视图走的是反方向。每个已激活技能包的视图都作为一个来源交给 `ctx.componentViews`，并在技能包集合一动就重新交一次，于是技能包一激活它的视图就进侧栏、一失活就从侧栏消失，不用重启。`ctx.skillPackIntake` 装进来的组织集里的技能包也走同一条路，经 `ctx.skillPacks.activeViews()` 进来，那份集合撤下时离开。

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

已经被交出去的 id 也按同样方式拒绝。部署自己配置的视图拥有它们的 id，所以认领其中之一的技能包会被扣下，而不是丢掉那个视图。两个技能包认领同一个 id 则不是这一行回答的问题：技能包根目录把**两个**都扣下，因为一条菜单项不能有两个归属者，而把这个 id 留给先被读到的那个，就等于让一套部署交出什么取决于它的文件系统。

同一份判定也跑在一份发放替换技能包根目录之前，不只是之后。`SkillPackRegistry` 把暂存出来的每个技能包交给这一行的 `judgeView`，而一份这套部署画不出来的视图——出现在一个它**已经**有了部件和插件版本的技能包上——会带着技能包、文件和这一行自己的那句话拒掉整份发放。还在等插件的技能包会被装进去并保持未激活，因为判它视图的那个表面还没到齐。

<a id="placing-them"></a>
## 把它们摆出去

技能包确实交出来的东西，会以本包名义作为一个来源注册进 `ctx.componentViews`。读是异步的而注册不是，所以每次读取都带着提出它的那次刷新的编号：被后一次刷新取代的读取，以及在这一行已经走了之后才回来的读取，都会被丢掉。

从那里往后走的就是配置视图早已走过的那条路——侧栏从 `GET /component-surface/views` 列出它，一次点击执行 `/show-content-view`，落进内容栏的是配置视图被点击时写下的那条同样的会话事件。

<a id="the-component-catalog-file"></a>
## 组件目录文件

`tests/expected/component-catalog.json` 给不在任何部署旁边写技能包的人用来拼视图：里面有组件包注册的每个组件、判视图文件的规则，以及读技能包和它的 `.dshpack` 发放包时的规则。改了目录条目、组件表面的上限或技能包规则之后，以及组件包或它 vendor 进来的 kit 版本变了之后，都要重新生成它。`scripts/release/bump.ts` 会把组件包的版本和其他私有包一起改掉，所以升版本之后也要重新生成：

```sh
pnpm --filter @deepseek-ai/dsh-experimental-skill-pack-components run component-catalog
```

有一条测试会重新生成这个文件，入库的副本差一个字节就失败，所以改动了目录却没有重新生成的提交过不了。

| 键 | 内容 |
|---|---|
| `header.catalogFormat` | `1`，文件格式号。任何键改名、删除或换了含义都要换号；读的一方不认识这个号就不读这个文件。 |
| `header.componentKit`、`header.toyCrudKit` | 组件包的 npm 名和装上的版本（技能包 `requires.components` 的区间就拿它来匹配），以及组件包为画完整数据页 vendor 进来的 kit 的 npm 名和版本。 |
| `header.bodySha256` | `JSON.stringify(body)` 的 UTF-8 字节的 SHA-256，小写十六进制：不带空白，键按文件里的顺序。读的一方从解析出来的文件重算它；不用 JavaScript 重算时，序列化结果必须与 `JSON.stringify` 写出的逐字相同，包括非 ASCII 字符不转义，否则摘要对不上。 |
| `header.exampleViewSha256` | `null`，因为这个文件还不带示例视图。 |
| `body.components` | 每个组件：`id`、`label`（用户看到的中文名）、`purpose`、`placement`、`deploymentSwitches`、`props`、`outputs`（`id`、`summary`、`shape`）、`actions`（`id`、`report`），以及组件把某个字符串读成路径、颜色或渲染器名时的 `sanitize`。 |
| `body.rules` | `view`（id、标题、spec 大小、spec 和节点能带的键、节点数与节点 id，以及判 spec、节点和完整数据页的规则）、`layout`（根的种类、方向、间距、层数、一个 stack 的子项数、`flex`、stack 和放进布局的块能带的键，以及判它们和摆放的规则）、`binding`（`$from`）、`param`（`$param`）、`viewFile`、`manifest`（frontmatter 键、字段，以及 `pack.viewFormat` 与 `pack.anchorFormat` 何时必须写）、`packFiles`（技能包能带的扩展名）和 `archive`（`.dshpack` 的格式和默认读取上限）。 |

每个属性写出：`summary`，工具描述给它写的记法；`required`；`viewOnly`，为真表示只有视图文件能设它；`unbindable`，为真表示它不能写成 `$from` 引用，取自组件表面的 `unbindableReason`，所以组件把它读成路径、颜色或渲染器名的属性，即使没有声明不可绑定，也写为真；`schema`，它的类型和全部上限、名单、字符集，字符集写成带标志位的正则字面量。对象属性里面的字段只写 `summary`、`required` 和 `schema`：对象属性里面的 `$from` 一律被拒，`viewOnly` 也只对组件自己的属性判。`deploymentSwitches` 列出部署要打开哪些 `show_component` 开关才会交出这个组件，从组件表面的 `withheldComponents` 读出；某套部署有没有打开它们，文件里不写。每个组件的 `placement` 都是 `call`：目录还没有声明放置方式，所以视图能放的组件，调用也都能放。有一条测试列出目录条目能带的每个键，类型按条目定义，所以条目新加一个键（比如放置方式），在生成器写出它之前类型检查不通过。

组件、所有上限、名单和键都从执行这条规则的模块读出。其余几项没有模块把它们作为值导出，由生成器自己写：`view.nodes`、`layout.children` 和 `layout.flex` 的下限、`layout.flex.integer`、`layout.root`、两个 `otherKeys` 的取值，以及各处的 `rules` 句子，这些句子复述组件表面怎样判视图、技能包根怎样读清单。测试拿这些值复述的判定逐一核对它们；每一句 `rules` 的原文也由测试逐字钉住，并核对这句话说的判定，所以改了句子或者改了判定，都会有测试失败。

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
- **在与部署自己视图的 id 冲突里输掉的技能包只能从状态路由知道这件事。** 那条拒绝点名这个 id 并说它已经被交出去了；它不点名是哪个配置视图占着它，因为判定跑在索引建起来之前，而只有索引知道占着的人是谁。运维手上有的是这两份文档摆在一起。两个技能包之间的冲突由技能包根目录在两边都点名，因为它两个都看得见。
- **没有示例视图。** 组件目录文件的头写着 `exampleViewSha256: null`，也没有测试判示例视图。示例要放一个完整数据页和一张绑定数据页 `opened` 输出的信息卡，而信息卡和这个输出现在都还不在目录里。两者进了目录之后，示例放进 `tests/expected/examples/`，它的摘要写进头里，再由一条测试替换它的 `params`、用组件表面的 `judgeView` 判它。
- **没有被组装快照覆盖** —— 这一行由它自己的真实组合用例覆盖；快照泳道重放的是发行组合，而那里不组合任何 experimental 行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
