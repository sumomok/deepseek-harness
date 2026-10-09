---
description: "控制台的「指一下」：输入框「+」右侧的按钮，指内容栏或侧栏里的一处——数据页的列、工具栏按钮、行内操作，原系统页面的控件，图片，侧栏条目，或组件视图里、原系统页面上任意一块整块——把它作为引用标签放在输入框上方；这条消息进入的那一步之前，追加一条写进日志的消息，写出每一处的键行和显示文字，从不写任何一条记录的值。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-content-point

[English](README.md) | 中文

## 概述

「指一下」让控制台的用户指着自己要问的东西。输入框「+」右侧的按钮开始拾取；点到的地方成为输入框上方的一个引用标签，发出的消息告诉模型每一处的键行和显示文字。数据页能指到列、工具栏按钮和行内操作，原系统页面能指到控件，侧栏能指到条目；其它每一块，以及指不到更细的原系统页面，按整块指。任何一条记录的值都不会进入引用，也不会到模型那里。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

客户控制台经 [`dsh-experimental-console-profile`](../console-profile/README.zh.md) 组合本包，插入行在它自己那一层；部署层不要再插一次，两行会画出两个按钮。说明仍然只追加一次：外层那一行的监听器在这一步里看到内层已经追加的说明，就跳过那条消息。

### 何时选用

控制台的用户要问内容栏里显示的东西时选用。它读控制台的 DOM——内容栏的座位和切换条、组件视图的各块、content-frame 的 iframe、侧栏条目——所以在没有这些的组合里用不上。

### 最小配置

```yaml
- insert:
    - id: content-point
      name: '@deepseek-ai/dsh-experimental-content-point'
```

这一行没有配置。

### 指一处记下什么

点按钮会在整个控制台文档上开始拾取；按 Escape 或再点一次按钮取消。拾取期间，页面上的按下、点击和激活键都传不到页面，悬停时会按控制台的语言画出点击会取到的地方和对应文字。点到的地方在附件行里成为一个标签；发送前可以移除，只有标签、没有文字的消息发不出去。按下按钮时焦点留在输入框里，指完之后按 Enter 就能发送。输入框正在提交时按钮不可用；附件行里已有 16 个它的标签时，再点会提示，因为宿主拒收带更多引用的提示；输入框终究没收下的标签会被释放并提示。

| 地方 | 引用记下什么 | 键行示例 |
| --- | --- | --- |
| 数据页的列头、格子、工具栏按钮、行内操作 | point-anchor 的描述，去掉这一行的值 | `data-page model=SpaceLayer region=table part=header column=zh_label` |
| 原系统页面的控件、格子或区域 | point-anchor 的描述 | `frame page=orders role=button name="查询" in=main` |
| 这类页面表格格子里的控件 | point-anchor 的描述，按列和角色，不带控件名字 | `frame page=orders column="名称" role=button in=main` |
| 这类页面上的图 | point-anchor 的描述 | `picture page=orders tag=canvas nth=1` |
| 侧栏条目 | point-anchor 的描述 | `nav nav=view id=space-layer-crud` |
| 组件视图里的其它任意一块 | 整块引用 | `block seat=component component=toy.info-card node=card` |
| 原系统页面上什么都没命名的地方、对不上列的格子、别的源的页面 | 整块引用 | `block seat=page page=orders` |
| 没有块的座位 | 整块引用 | `block seat=office` |

point-anchor 因其它原因拒绝的地方——弹出层、内容栏以外的地方——会在输入框上方用提示条说明，不记任何东西。凡是会改记整块引用的拒绝，悬停时都显示「指这一整块」。

-----

<a id="understand-the-implementation"></a>
## 理解实现

本包分两半，没有自己的会话事件。

浏览器一半把按钮注册到 ui-conversation 的 `conversation.input.left` 槽，并在控制台文档上写 point-anchor 的页面标记。指一处时以引用用途运行 point-anchor 的拾取器（`createPicker(document, { purpose: 'reference' })`），所有文字——地方的标签、拒绝原因——都取自本包词典。它能描述的地方，先由 `src/place.ts` 去掉引用不能带的东西，再由 `toPromptReference` 限到 8192 字节：数据页的行；原系统页面上落在表格格子里的控件的名字、标记和位置，因为格子里的文字就是记录本身，所以这个控件按它的列和角色命名。在座位里因 `unsupported-component`、`kit-too-old`、`not-ready`、`unknown-point`、`unknown-model`、`nameless`、`no-column` 或 `unreadable-frame` 被拒的地方，改记点击处所在的整块（`src/block.ts`）：座位里离点击处最近的带 `data-component-node` 的元素及其 `data-component-block`；原系统页面的 content-frame 页面 id；都没有时记座位本身；显示文字取切换条选中项的标题和词典里的显示名。拾取器拒绝时不报元素，所以在拾取器自己的监听器之前，先在控制台窗口和够得着的每个框架窗口上加捕获阶段监听器，读出拾取所取的那次点击；点在拾取器盖在别的源的页面上的遮罩上时，按点击坐标找位置。点在按钮本身上的受信点击就地取消这次指向，不等拾取器把它拒掉。引用经 `createReferenceDraft` 以来源 `content-point` 登记；发送时原样解析出数据，宿主把它记在收下的消息来源上。

宿主一半是一个 `agent/pre-step` 监听器。进入这一步的每条用户消息，只要来源里记有 `content-point` 来源的引用，就在它后面紧接着插入一条用户消息，来源是 `content-point` 种类（`{ kind: 'content-point', message: <那条用户消息的 id>, form: 'notice', summary }`）。正文每个引用一段，最多前 16 个，即协议对一条提示的上限。point-anchor 的描述用 `parsePointData` 读回，不管日志里的数据带了什么，都由 `src/place.ts` 照浏览器的方式去掉一遍，再用 `renderPointText` 写；表格格子里的控件，用同样的三行写，标签用本包的；整块引用严格读回（`parseBlockData`），写成同样的三行。本版本读不了的格式，写一句话说明所写的格式和本版本读的格式，标签用记下的标签，不丢弃。一步里已经有指名某条用户消息的 `content-point` 消息时，不再为它追加；每条用户消息只进入一步，所以每条消息里指的地方只写一次。这一行不写 `content-component/shown`，不追加会话事件。

### 格式

point-anchor 的描述带 `v`（描述格式）和 `anchorFormat`；本版本读 vendor 进来的 point-anchor 读的那些，即 `DESCRIBE_FORMATS_READ` 和 `ANCHOR_FORMATS_READ`。整块引用带 `v: 1` 和 `kind: 'block'`；本版本只写、只读格式 1。日志里别的格式的引用，按读不了告诉模型，两个格式号都写出。

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@haoran/dsh-point-anchor`](vendor/)——拾取器、描述和键行，以 `vendor/haoran-dsh-point-anchor-0.1.0.tgz` vendor 进来。
- [`dsh-client-ui-conversation`](../../client/ui-conversation/README.zh.md)——引用草稿与附件行。
- [`dsh-experimental-component-surface`](../component-surface/README.zh.md)——指一处时说出的那些块所在的组件视图。
- [`dsh-experimental-console-profile`](../console-profile/README.zh.md)——挂载这一行的组合。

-----

<a id="model-experience"></a>
## Model Experience

### 指一处的说明

#### What the model sees

在带有指向的用户消息后面，一条用户消息，每一处一段，段与段之间空一行：标签、键行和显示文字。原系统页面表格格子里的控件按列和角色写，如「「名称」列里的按钮」，键行里不带名字。没有锚点的地方写 `锚点：没有（…）` 和原因；本版本读不了的引用写一句话，说明所写的格式和本版本读的格式。任何一段都不写一行的值。用户看到的标签不在用户写的消息里；这条消息是它们在模型那里的唯一痕迹。

##### 一个列头和一整块的说明

```markdown
用户在内容栏里指着「列「名称」」。
锚点：`data-page model=SpaceLayer region=table part=header column=zh_label`
显示：数据页「图层配置」 · 列「名称」

用户在内容栏里指着「指标」这一整块。
锚点：`block seat=component component=el.metric node=rate`
显示：图层配置 · 指标
```

#### Token effect

每一处约 40 到 80 个 token，只出现在带有指向的消息里；每条消息最多 16 处。

#### KV Cache effect

只追加：这条消息插在它对应的用户消息后面、那条消息进入的那一步里，之前的请求前缀都不变。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **表单页和信息卡只能整块指。** 它们在数据页以外，外面没有 `.toy-data-page`，point-anchor 把其中的字段拒成 `unsupported-component`，于是指到的是整块（`block … component=toy.form-page`），不是字段。数据页自己的表单字段可以逐个指。
- **悬停整块时用的是 point-anchor 的拒绝样式。** point-anchor 把被拒的地方画成红色虚线框，盖在拒绝所指的元素上，即整个座位，文字用本包的「指这一整块」；记下的引用指的是点到的那一块。用接受样式把框画在那一块上，要在 point-anchor 里做（T05）。
- **任何一条记录的值都不进入模型。** 数据页的格子、整行和行内操作按列和操作命名。原系统页面表格格子里的控件只按列和角色命名，所以同一格里的两个按钮，比如「操作」列里的「编辑」和「删除」，读起来一样；引用也保留 point-anchor 判定不是记录本身的名字，即它的 name-in-data 检查，要在 point-anchor 里做（T05）。模型不知道用户指的是哪一条记录。
- **数据页的删除操作只能按整页指。** kit 0.5.0 会描述行内删除图标，vendor 进来的 point-anchor 0.1.0 读不了（`unknown-point`），于是指到的是数据页那一块；读它计划放进 point-anchor 0.2.0（T05）。
- **别的源的页面只能按整页指，按指针位置找。** 拾取器给这种框架加遮罩，按 `unreadable-frame` 拒绝；本包按点击坐标找到下面的页面座位。
- **被遮罩的跨源框架里的键盘激活。** 焦点留在别的源的框架里的控件上时，拾取期间按 Enter 和空格会传到那个控件；见 point-anchor 的 README。把焦点移出计划放进 point-anchor 0.2.0（T05）。
- **拾取后的守卫最长约三秒。** 拾取后 `PICK_TAIL_GUARD_MS`（400 毫秒）内，每吞掉一个事件就再续一次，最长到 `PICK_GUARD_LIMIT_MS`（3 秒），点击和激活键都传不到，按钮和 Enter 也一样。这是 point-anchor 的行为（T05）。
- **按钮跟着输入框的提交走，不跟其它锁定状态。** 输入阶段不是 `plain`、输入框拒收附件时，按钮不可用；输入框因别的原因锁定——会话已删除、没有工作区、被别的组件挡住、父会话离线——时，它把 `locked` 传给权限和计划两个槽，但不传给 `conversation.input.left`，要跟上得改 ui-conversation。
- **宿主不在 JSON 边界重新检查引用。** 引用在这一行看到之前，已由 session controller 记在用户消息的来源上；要在那里过滤，得在 `session-controller` 加核心接口。这一行写说明时严格读每份数据，所以它不会写出的数据会按读不了告诉模型。
- **在带有指向的消息处分叉，子会话里只有消息、没有说明。** 说明是在那条消息进入的那一步里追加的，在分叉点之后。
- **交付集检查还没有与 skill-pack 的读取器对照。** `tests/equivalence.spec.ts` 让锚点格式、发放包字节以及名字和路径的拒绝与 skill-pack 一致；vendor 进来的 point-anchor 0.1.0 没有 `checkDeliverySet`，两边对同一份交付集判定一致的测试，等 point-anchor 0.2.0（T05）。
- **vendor 的 tarball 里类型声明指向它不带的 source map。** 每个 `.d.ts` 末尾都有 `sourceMappingURL` 注释，指向包的 `files` 没收进去的 map；去掉这些注释要在 point-anchor 里做（T05）。
- **没有组装快照覆盖。** `snapshots/console` 走 ACP，ACP 的提示不带引用；证据是本包的单元测试、console-profile 的组合测试和 `content-point` Web 场景。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>写给维护者的工作上下文——点击展开</summary>

- vendor 进来的 point-anchor 是插件仓 `feat/point-anchor` 在 `0eca54e` 打出的 0.1.0（tarball sha256 `ab5ae311d315234eeea1aaf567690d048f09cc848887671ce493aea70d06be42`），0.2.0 出来后替换。
- 按钮的图形是 ui-primitives 的 `IconGoalOutlineMedium`，一个靶心，是共用图标里最接近「指着某处」的；这套图标里没有画指针或准星的。
- `src/client/PointButton.module.css` 在工具行的模式框里两个标签槽（`conversation.input.permission`、`conversation.input.plan`）都空着时，让按钮收回工具行的一个间距：按 `data-slot` 属性认出这两个槽，间距照抄 ui-conversation `InputBar.module.css` 里工具行的 12px 和窄卡片的 8px。ui-conversation 会把空的模式框留在行里，行在它两边各留一个间距，不收回的话按钮离「+」就是两个间距。`content-point` Web 场景让这段距离等于行的间距；等 ui-conversation 不再给空的模式框留间距，这条规则就删掉。

</details>
