---
description: "三个带凭据的读，让智能体认得本部署自己的业务系统 —— 它把数据分成哪些专业、一个专业下有哪些数据模型、一个模型的全部属性与表单以及当前登录者对它的权限；面向把本框架接到业务后台的控制台组合，以及这一行的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-system-map

[English](README.md) | 中文

## 概述

一个叫不出本部署数据模型名字的控制台助手，回答不了关于它们的问题。有人用自己的话问起「图层配置」，它只能猜一个英文表名，或者提议一个那个人根本按不动的按钮。这一行用三个读本部署自有配置的读来补上这一段，分层是因为整份目录大到带不动：专业、一个专业下的数据模型、一个模型的全部。

只做感知，别的都不做。三个读都不写任何东西、不问任何人、不看屏幕，所以都不先问人。它们答的是本部署自己的配置和当前登录者自己的权限 —— 永远不是某一行里的值，也永远不是此刻摆在谁面前的画面。

## 目录

- [三个读](#the-three-reads)
- [一份清单是怎么写的](#how-a-listing-is-written)
- [上限](#the-ceilings)
- [组合这一行](#composing-the-row)
- [读失败后模型看到什么](#what-a-failed-read-becomes)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="the-three-reads"></a>
## 三个读

| 工具 | 参数 | 答什么 |
|---|---|---|
| `system_map_domains` | `after` | 装着当前登录者可以查看的数据模型的每个专业，每个专业显示什么名字、下辖多少个这样的模型。 |
| `system_map_domain_models` | `domain`（必填）、`after` | 一个专业下当前登录者可以查看的数据模型：英文名、给人看的名字、行存在哪张表、本部署对这个模型记了什么，以及当前登录者可以对它做哪些操作。 |
| `system_map_model` | `model`（必填）、`after` | 一个模型的全部：每个属性的存储类型与长度、一行能不能留空、是不是行的标识、缺省值、表单把它归在哪一组、它提供哪些固定取值、它取哪个模型的行，再加上本部署自己的哪些表单会画它、哪些表单不填不让存、以及会不会让这个人改它 —— 然后是这个人对这个模型的权限。 |

`domain` 既收本部署归档用的专业编码，也收它为这个编码显示的名字；`model` 既收英文名，也收给人看的名字。不归在任何专业下的模型列在编码 `UNFILED` 下，`domain` 收它和收别的一样。

每个读都经 [`dsh-experimental-biz-backend`](../biz-backend/README.zh.md)，除此之外什么都不经。本包不持凭据、不开连接、不知道地址：它够得着的全部，就是那道缝的四个具名读 —— 目录、当前登录者的权限、一个模型的属性、一个模型存下的方案。

那道缝的权限判定允许对某个模型做 `metadata_read` 时，这个模型就对当前登录者可见；在缺省规则表下，这意味着权限表里有这个模型的一行。每个读在分组、解析或列出任何东西之前，都先把目录收窄到可见的模型：`system_map_domains` 只数它们，一个都不装的专业不列；`system_map_domain_models` 只列它们；`system_map_model` 只读它们。登录者不能查看的模型，用的是与「本部署没有这个模型」相同的那句话拒回，于是拒绝不透露它是否存在。权限读取失败时，这次调用以那种失败对应的那句话结束；权限表一个模型都没点名时，一个专业都不列；两者都不退回整份目录。规则本身属于那道缝，只在 [`dsh-experimental-auth-gate`](../auth-gate/README.zh.md) 上以 `bizOperationRules` 配置一次，所以这一行不另存一份。

<a id="how-a-listing-is-written"></a>
## 一份清单是怎么写的

每个答案是一段抬头，再每条一行。抬头一次说清这些行上每个键是什么意思，本部署没写的字段就整个不出现，而不是留一个占位 —— 这就是一份上千个模型的目录读得起的原因。

```markdown
Subject area TRANSO (传输专业) holds 1 data models the signed-in person may look at. Each line is a model's English name, then, where this deployment states them, `name=` the name shown and `table=` where its rows are stored, then `may=` the operations the signed-in person may perform on it (from read, metadata_read, create, update, delete, import and export), and, where this deployment records one, `note=` what it records about it.
SpaceLayer name=图层配置 table=SPACE_LAYER may=read,metadata_read,create,update,import,export note=每个图层的配置与归属专题
```

`may=` 带的是那道缝的权限判定对这个模型允许的操作，取自 `read`、`metadata_read`、`create`、`update`、`delete`、`import`、`export` 这七个并按这个顺序 —— 即本部署后端计划据以校验的操作码，而不是它权限表拼写的标志名。每个列出的模型至少带 `metadata_read`，因为正是它让模型被列出，所以每一行都有 `may=`。每个操作要哪些标志由规则表决定，所以部署改了规则，`may=` 随之改变，这边不用改。

排序按码位，从不按区域设置：同一个答案在每台机器上都化成同一份清单，这正是游标能在两次调用之间安全接续的原因。专业按编码排，模型按英文名排，属性按英文名排。

超出本部署预算的清单会停在最后一条放得下的条目上，并以接续用的游标结尾：

```markdown
Cut after 77 of 400; pass "Model076" as `after` to continue.
```

比整个预算还长的一条会单独带上，清单照样标为截断 —— 因为一条都不带的清单会把收到的游标原样还回去，跟着它走的调用方永远前进不了。

<a id="the-ceilings"></a>
## 上限

| 字段 | 缺省 | 限住什么 |
|---|---|---|
| `listingChars` | `12000` | 一份清单的各行之间总共能花多少字符。 |
| `valuesPerAttribute` | `12` | 一个属性带多少个固定取值，其余只计数，写成 `values=1=在用\|0=停用\|+17 more`。 |
| `noteChars` | `80` | 本部署记的一条说明带多少字符。 |

三个都是部署侧的，因为一份清单值多少钱，取决于那个部署有多少个数据模型，而两个部署之间能差一个数量级。写了低于 200 的 `listingChars` 的组合在装载期就失败，而不是让每次调用都只答一行截断。

完整答案 = `listingChars` 加上它的抬头。抬头是一句固定形状的话，加上本部署给这个专业或这个模型的名字，再加上最多 `noteChars` 个字符的一条说明；实测数字见 [Model Experience](#model-experience)。

<a id="composing-the-row"></a>
## 组合这一行

```yml
- id: system-map
  name: '@deepseek-ai/dsh-experimental-system-map'
```

这一行注入 `tools` 与 `bizBackend`。后者是部署方要安排的：`ctx.bizBackend` 由 [`dsh-experimental-auth-gate`](../auth-gate/README.zh.md) 构造，且只在那道门配了 `bizUpstream` 时才构造，所以没配的组合根本拿不到读，而不是拿到三个每次调用都拒绝的读。`overlay/system-map.patch.yml` 是这一行的 overlay 形态，按控制台 overlay 对它留白那些行所给的同一条理由，不塞进控制台 overlay：控制台让不让智能体读本部署自己的配置，是那个部署自己的决定。任何出厂 profile 都不组合它。

不需要审批行，也不问任何人。三个读同样是刻意不进审查网关只读名单的：它们确实离开本机，而[分类笔记](../../../.agents/notes/implemented/architecture/2026-09-06-content-tools-review-gate-classification.zh.md)正是把这种情况暂缓到判官成本实测超预算之时。

<a id="what-a-failed-read-becomes"></a>
## 读失败后模型看到什么

后端那道缝以值作答而不是抛异常，它的四种失败各化成一句话，说明这次调用为什么被拒。没有一句点名可以用来补救的工具，而两种参数拒绝各自点名了能修好这次调用的那个参数。

| 读答了什么 | 模型读到 |
|---|---|
| `unauthenticated` | `Nobody is signed in to this deployment, so nothing about its business system could be read.` |
| `refused` | `This deployment refused the signed-in person's credential (HTTP 401), so nothing about its business system could be read.` |
| `rejected` | `This deployment refused the request (HTTP 200, code 4): 没有权限.` |
| `unreachable` | `This deployment's business system did not answer: the answer listed no resource models.` |

一个不装任何登录者可查看模型的专业 —— 不管本部署有没有这个名字 —— 会连同装着这类模型的那些专业一起拒回，最多二十四个，然后是一个计数，于是打错的编码靠手上已有的答案就能改对，不必再调一次：``No subject area the signed-in person may look at is called "TRANSMISSION". Pass `domain` as one of those: …``。登录者不能查看的模型，以及本部署没有的模型，都不带清单拒回，因为一个部署的数据模型比一句话装得下的多，而且两者用同一句话：``No data model the signed-in person may look at is called "SITE". Pass `model` as either the English name this deployment keys a model by or the name it shows a person for one.``

## Model Experience

### The three offers

#### What the model sees

三个工具，它们之间共五个参数，只要这一行被组合就一直在。每段描述都说自己这个工具答什么、什么时候该找它，说明回来的是本部署的配置而不是屏幕上的任何东西，并且不点名任何同伴。`system_map_domains` 只有可选的 `after`；`system_map_domain_models` 有必填的 `domain` 与可选的 `after`；`system_map_model` 有必填的 `model` 与可选的 `after`。这里没有任何东西随部署而变，本包也不贡献系统提示分节；这一行不进任何出厂 profile，所以生成的工具目录里也没有它们。

#### Token effect

固定：2269 个字符的描述 —— 686、731、852 —— 加五段参数描述，在这三个可见的每一次请求上。按 DeepSeek 的算法，CJK 字符 0.6 token、其余 0.3 token，描述约合 681 token。

#### KV Cache effect

这些描述是常量，在一个部署内从不改变，所以工具块在各次请求之间逐字节相同，前缀保持有效。

### The three results

#### What the model sees

一个文本块：抬头、每条一行、以及清单被截断时的那行截断说明。抬头点名它的各行用到的每个键，本部署没写的字段在行上是缺席而不是留空，而本部署给不出的答案是一句说明原因的话。

##### The heading of a model listing

```markdown
Subject area TRANSO (传输专业) holds 1 data models the signed-in person may look at. Each line is a model's English name, then, where this deployment states them, `name=` the name shown and `table=` where its rows are stored, then `may=` the operations the signed-in person may perform on it (from read, metadata_read, create, update, delete, import and export), and, where this deployment records one, `note=` what it records about it.
```

##### The line a cut listing ends with

```markdown
Cut after 77 of 400; pass "Model076" as `after` to continue.
```

#### Token effect

由 `listingChars` 加抬头限住，并针对这一行所服务的那个部署实测 —— 103 个专业下 1219 个数据模型，参考模型有 61 个属性、其中 27 个提供十项字典 —— 按同一算法计。列全部 103 个专业是 3466 个字符，约 1163 token。列一个典型专业下 12 个模型、每个带 80 字符说明，是 2332 个字符，约 856 token；同样的清单对一个 400 模型的专业会在 `12000` 上限处停在第 77 个模型，12345 个字符、约 4698 token，并交回一个游标。把 61 个属性的参考模型整个读下来是 8047 个字符、约 2733 token，其中光抬头就是 1023 个字符、约 317 token。所以一次会话靠这三个读摸到一个模型，结果一共在四千 token 量级，只付一次，换来的是一份任何请求都常驻不起的目录。

#### KV Cache effect

追加式：一个结果跟在可复用的请求前缀之后，不作废任何已缓存的内容。把同一个模型读两次是两个结果而不是对第一个的改写 —— 本部署的配置在两次之间可能已经变了，这里也不声称没变。

## Known Limitations and Deferred Work

- **什么都不缓存，所以每次调用都重读整份目录。** `system_map_domains` 与 `system_map_domain_models` 各读一次整份目录 —— 在实测的那个部署上是一个上千模型的答案 —— 而 `system_map_model` 为了先把名字解出来还要再读一次；三者各自还会在旁边读一次登录者的权限。做进程级缓存需要一条本包无从校验的过期规则，而且本部署自己的前端本来就是先给缓存再后台回源，配置从一开始就不是强一致的。触发条件是实测单次调用成本超预算。
- **索引不常驻，这是决定。** 不往系统提示里放任何东西，也不往回合里追加，所以从不调第一个读的模型对这些一无所知。让专业常驻这件事被压到「先量出一次会话首次调用值多少钱」之后，上面那些数字就是这次测量。
- **一份清单是配置的快照，不是屏幕的快照。** 它说的是本部署的表单被配成什么样，这既不等于此刻摆在谁面前的东西，也不等于后端会接受什么：本部署自己的权限层在找不到档案时是放开而不是收紧的，所以 `may=` 是界面会给出的东西，而不是服务端会照此执行的保证。上面的清单数字是在 `may=` 改带七个操作名、目录改为收窄到登录者可查看的模型之前量的；现在一个列出模型的行里 `may=` 最多占 57 个字符，而清单会略去登录者不能查看的每一个模型。
- **这里报的权限属于进程，不属于某一次请求。** 凭据是整个进程持有的一个 token，所以一份清单描述的是最后登录的那个人。这正是本 fork 跑的部署形状 —— 一个登录者一个进程，前面挡一个验 token 的反代 —— 而一旦一个进程服务多个人，这个前提就不成立，那时这些答案必须改为按会话而不是按进程重算。
- **一个给人看的名字可能属于两个模型。** `model` 收给人看的名字，而两个模型可能叫同一个名字；读会解到按英文名排在前面的那一个。答案里点名了它读的是哪个模型，所以这个误会看得见，但不会被拒绝。
- **中文控制台上，卡片是英文的。** 宿主侧的展示件把每次调用的标题写成英文，本仓其余每一个宿主展示件都是这么做的。没有 Client 插件，所以浏览器退回通用行，显示工具名与结果正文。
- **没有写，而且写也不会从这里走。** 读一个部署的配置和改它不是同一件事的两个方法：写要拿一个人的凭据去改他自己的系统，需要它自己的同意问询和它自己的记录，这一行两样都没有。

**运行时不变量：** 不发布伴生件。本包不注册服务、不追加会话事件、不拥有任何持久数据、不保存任何可变状态：三个工具、三组纯归约、以及它们渲染出的文本，全都是一个后端答案的函数。这里没有任何两个观察者可能分歧的自有关系，而那是 `./invariant` 唯一要校验的东西。

<a id="dev-note"></a>
### 开发备注

`reduce.ts` 装下全部计算，且只 import 类型；`text.ts` 装下模型读到的每一句话；`tools.ts` 把两者接到注册表上。这个拆分正是 `tests/reduce.spec.ts` 能逐字断言顺序与截断的原因，也是 `tests/text.spec.ts` 能对整套文案一次性断言两条「关于缺席」的规则 —— 没有描述点名别的工具、没有拒绝点名补救用的工具 —— 的原因。

`tests/composition.spec.ts` 经 vendor 里的 Loader 启动一份只用于测试的 `cordis.yml`，每条断言都观察组合起来的应用：有后端时三个读全被提供、没有后端时一个都不提供，每段描述与参数以什么形态抵达模型，以及一个写不出任何清单的预算会在装载期失败。`snapshots/console/system-map-turn` 是成套证据 —— 一个回合先读一个专业再读一个模型，走出厂的 `acp` 接口、对着这条线自己的假后端。那份夹具同时钉住了一处缺席：同一个后端答案里带着当前登录者的账号、工号、手机号与邮箱，而它们在整份记录里一个都找不到。
