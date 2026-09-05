---
description: "让 agent 拿到服务线外壳内容列的把手：一条覆盖单个目录的具名 webserver 路由、覆盖其配置页面的 content_show 工具、记录每一列正在展示什么的投影，以及为每个会话保持一个活帧的浏览器半边；面向发布自有页面的部署方与这条路径的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-content-frame

[English](README.md) | 中文

## 概述

服务形态外壳 content 栏的 `page` 类型，也是控制这一栏的两条通路：宿主机上的一个静态文件目录，通过一条 dsh 路由对外提供，由一个铺满该栏的 iframe 呈现——栏里放部署方配置的哪一个页面，既可以由 agent 通过 `content_show` 工具决定，也可以由用户直接在侧边栏的页面导航菜单（`@deepseek-ai/dsh-experimental-server-sidebar`）里点选，后者会执行 `show-content-page` 命令。里面的应用由运行 harness 的人自己编写和部署；本包既不构建它，也不关心它用什么框架。

七块拼图，各承担一项决策。node 半边把配置目录挂在 `/content-app` 下提供。`content_show` 把部署方的页面清单交给模型选择，并在它选定时追加 `content/shown`。`show-content-page` 把同一份页面清单交给执行命令的 UI，并在用户选定时追加同一个事件。`page` extractor 把每个被展示的 id 变成 [`content-surface`](../content-surface/README.zh.md) 那条流里的一条 entry，对照当下运行的页面清单解析。`content` projection 以同样方式解析最后记录的那个 id，供想要「这一栏当前的页面」而非其历史的消费者使用。browser 半边认领这一栏 kind 槽的 `page` key，并为每个（会话，页面）组合各保活一个 frame。部署方开启后，`content_read` 让 agent 把那个 frame 里的页面读成一份带编号的结构，另有三件原文读取让它按页面实际写法来读同一个页面；挂了附件仓库的部署里，`content_read_image` 还能答出某一个元素自己画出来的像素。

## 目录

- [信任边界](#trust-boundary)
- [提供文件](#serving-the-application)
- [谁把页面放上台面](#who-put-a-page-on-display)
- [agent 可展示的页面](#pages-the-agent-may-show)
- [每个（会话，页面）各一个活着的 frame](#one-live-frame-per-session-and-page)
- [读取 agent 放进去的那个页面](#reading-the-page-the-agent-put-there)
- [按页面原样读取](#reading-the-page-as-it-was-written)
- [读页面上的一张图](#reading-one-picture-on-the-page)
- [在用户正看着的页面上动手](#acting-on-the-page-the-user-is-looking-at)
- [读取 frame 里的页面](#reading-the-page-in-the-frame)
- [agent 对这一栏知道些什么](#what-the-agent-knows-about-the-column)
- [读一个还没画完的页面](#reading-a-page-that-has-not-finished-drawing-itself)
- [在聊天记录里隐藏 `show-content-page` 命令](#hiding-the-show-content-page-command-from-the-chat-transcript)
- [组合方式](#composition)
- [工具说什么，以及永远不说什么](#the-copy-rule)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="trust-boundary"></a>
## 信任边界

**被托管的页面拥有与外壳相同的权限。** 它们由 dsh 同源提供，且 iframe 不带 `sandbox` 属性，这使每个文档都与外壳同源：它可以直接调用 dsh HTTP API——会话、工具、设置，浏览器能触及的一切——无需任何额外授权。因此 `root` 必须指向一个「与 harness 本身同等可信」的目录。

这是设计本意而非疏漏。content 栏里的第一方应用本就应当与 harness 对话，而 opaque origin 做不到：API 的 Origin 校验会拒绝 `null`，所以不带 `allow-same-origin` 的 `sandbox` 会让这个 frame 什么都做不了，带上它则等于什么都没限制。要托管**不该**拥有这份权限的内容——agent 生成的页面、第三方产物、用户随手投放的东西——需要另一个带沙箱的插件，而不是本包上的一个开关。

<a id="serving-the-application"></a>
## 提供文件

`root` 必填且无默认值：部署方托管哪个应用，正是本插件承担的全部决策。它必须是指向已存在目录的绝对路径；否则该行在加载时就失败，而不是提供一个空 frame。该路径经 `realpath` 解析一次，之后每个请求都对照这个解析结果校验。

这条路由刻意不同于占据 webserver fallback 座位的 dsh SPA dist 服务：

- **未命中即 404，绝不回落到 index。** 回落会让一个错误的资源路径拿到 HTTP 200 的 dsh 外壳，故障只会在 iframe 里表现为空白页，而网络日志里读不出任何线索。
- **content type 覆盖真实的静态构建产物**——四种字体格式、位图与图标，以及 HTML/JS/CSS/JSON。未知扩展名为 `application/octet-stream`。
- **路径穿越与符号链接越界均为 403。** 词法路径必须落在 root 内，文件的真实路径同样必须落在 root 内，因此目录里被植入的符号链接读不到外面。
- **目录解析到自身的 `index.html`**，裸前缀也一样；没有 index 的目录是 404。
- **只接受 GET 与 HEAD**；其余为 405，并带 `Allow: GET, HEAD`。
- **`cache-control: no-cache`**，因为该目录在固定 URL 下就地更新，缓存住的入口文档会持续提供上一次构建的结果。

第二条 exact 路由 `/content-frame/settings` 把 browser 半边必须遵守的配置值提供给它：`cacheSize`、整份 `pages` 清单，以及部署方配置了页面读取时，读取器的预算与它工作所在的两道截止时间。它之所以存在，是因为 browser 半边根本收不到任何 cordis 配置：boot manifest 携带的是插件名，不是它们的 `config` 块。settings 文档不可达或不可用时，browser 那一行直接失败，而不是让这一栏跑在一个没人选过的上限上。页面清单也走这同一条路由而不是新开一条——侧边栏的页面导航菜单是这条路由的第二个读取方，它按约定（写死路由路径与 JSON 形状）而非导入本包来匹配这份数据，因为跨包直接导入符号并非本仓库为两个客户端相邻插件设计的耦合方式。

<a id="who-put-a-page-on-display"></a>
## 谁把页面放上台面

`content/shown` 携带一个 `by: 'agent' | 'user'` 字段：`content_show`（模型的工具）写 `'agent'`，`show-content-page`（侧边栏菜单的命令）写 `'user'`。这个字段出现之前写下的日志两者都没有，任何读取方都把这种情况默认成 `'agent'`——那时候工具是唯一的写入者。两个写入者追加的是同一类型下完全相同的事件，因此用户点开的页面与模型选定的页面，在 `content-surface` 的流里占据同一条 entry（按页面 id 去重），在 `content` projection 里也是同一个值；用哪个既有 kind、哪个既有 projection 都不因写入者而变。

`content` projection 刻意丢弃了 `by`——它回答的是「这一栏当前展示什么」，不需要区分写入者——而 `page` extractor 在其存储值与解析后的 payload 里都保留了它，留给以后想要展示这一区别的渲染器；目前的 frame 渲染器还没有这么做（见「已知限制」）。

<a id="pages-the-agent-may-show"></a>
## agent 可展示的页面

`pages` 是这一栏在部署里的全部词汇，且至少要有一项——`content_show` 存在的意义就是在其中挑选。每个页面声明 agent 传入的 `id`、用户读到的 `title`、以 agent 的语汇写成的 `description`（它会成为工具描述里的清单行），以及同源的 `url`。带协议或主机名的 URL 会让该行在加载时失败：这个 frame 携带外壳权限，因此只能寻址 dsh 同源地址。

`defaultPage` 指定 `content` projection 在 agent 尚未选择任何页面时、以及它清空这一栏之后所报告的页面。**这一栏本身不展示它**——它列出的是某个会话产生了什么，而默认页面并非任何会话产生的东西，因此什么都没展示过的会话得到的是这一栏的空状态提示。`id` 不得为 `none`，那是工具保留给「清空」的。

`homePage` 指定 `@deepseek-ai/dsh-experimental-server-sidebar` 的工作台第一次落到空稿时自动展示的页面。与 `defaultPage` 不同，这不是一个被动读取的 projection 值——侧栏会真的发起一次 `/show-content-page` 调用，因此这一栏确实会展示该页面，并留下通常那条 `content/shown` 日志记录。确切差异见本包 `Config` 类型的说明；侧栏包是这个字段唯一的消费者。

<a id="one-live-frame-per-session-and-page"></a>
## 每个（会话，页面）各一个活着的 frame

这一栏的 kind 槽是 `root` 作用域，且别的 kind 上台时这一栏仍保持本座位挂载，因此 browser 半边把每个被缓存的 frame 全部挂着，只显示当前那一个。用户回到某个页面时，它还是被离开时的样子——滚动位置、表单状态、文档持有的一切——因为那个元素从未被销毁；换页面、换成图表、换会话都一样。`cacheSize` 限定能存活多少个，按（会话，页面）组合计；超出后最久未展示的那个被丢弃，再次回来时重新加载。正在展示的 frame 永远不会是被丢弃的那个。

<a id="reading-the-page-the-agent-put-there"></a>
## 读取 agent 放进去的那个页面

`pageAccess` 把 `content_read` 交给 agent：一次调用把用户正在看的页面答成一份带编号的结构——容器、控件、标题与文本，每个控件都带一个像 `e12` 的 ref，后续调用可以指着它。结构进模型，数据不进：表格只报表头、规模和一行样例，只有当某次读取按 ref 点名这张表、或按文本匹配到某一行时才列行。

**密码框装着的东西，是本包所有工具都不打印的那一样。** 每一种读取都报「这个框在那里」，没有一种报它装着什么：清单在值的位置上印 `= (hidden)`，`content_read_attrs` 对 `value` 回 `(password withheld)`，树形行与整文读取对一个在 `autocomplete` 里声明了密码的 `textarea` 把值存在其中的那段文本也回同一句。往这种框里 `content_act` `fill`，只报「填了」，从不报填了什么。一个控件是不是密码控件，看的是它的 `type` 或那个属性，在 HTML 给了自动填充字段名的那三种标签上都算；这一条规矩就是本包为凭据所做扣留的全部——显示着登录表单的页面，读与动手都和别的页面一样。

**缺席即关闭，而缺席是默认。** 没有这个块，六件工具一件都没有，没有路由、没有待办 projection、settings 文档里没有 `pageAccess` 字段、浏览器里也没有读取器——只展示页面的部署不必为一项没要过的能力付账。写成空对象即取全部默认值。八个字段——`claimTimeoutMs`、`readTimeoutMs`、`pinMs`、`settleQuietMs`、`outlineChars`、`actTimeoutMs`、`maxSteps`、`settleMaxMs`——文档在 `Config` 类型上；其中 `outlineChars` 决定一次读取花多少上下文，因为它就是渲染这份列表的字符预算。它有一道 1000 的下限，低于它会在加载时被拒：列表的第一行不管多长都会整行渲染，而低于这道下限时，一张普通表格的第一行就已经超过回报路由能收的量了。`readTimeoutMs` 另有一道 8 的下限，同样在加载时拒、也同样是这类理由：读图把它的八分之一四舍五入到毫秒后给导出，低于这道下限时这份预算不是零毫秒就是一毫秒，于是每一张图都会被当成「控制台没画完」而拒绝。另有三道是上限而非下限，都在加载时拒：`settleQuietMs` 必须装得进 `readTimeoutMs` 的静默份额，因为一个预算容不下的静默窗口会让每一次读取都报「页面还在变」；`settleMaxMs` 必须不小于 `settleQuietMs`，而 `maxSteps` 个它加起来必须少于 `actTimeoutMs` 的四分之三——那是步骤自己那一份——因为每一步都可能等满这个上限的部署，就是一次调用把整条截止都花在等页面静下来、永远到不了最后一步的部署；`maxSteps` 封顶 100，正是它把一次「跑了哪些步骤」的回报保持在回报路由允许的信封之内。

<a id="reading-the-page-as-it-was-written"></a>
## 按页面原样读取

同一个块再交给 agent 三件读取，三件回答的都是原文而不是含义：`content_read_dom` 把一棵子树打成缩进的树——一行一个元素，带它的标签名、`#id`、以 `{class: …}` 形式给出的 class 词元、它自己的 ref，以及它直接持有的文字的开头；`content_read_attrs` 打印一个元素的全部属性，名与值按页面写的原样给出；`content_read_dom_content` 打印一个元素的全部可见文字，页面在哪里换行就在哪里换行，且从不截断。

**它们是为 `content_read` 叫不出名字的那一行而存在的。** 一个组件库的行内命令没有 role、没有名字、没有 title、也没有指针光标，于是清单把那一列打成空的，而用户在那里看见两个图标。`content_read` 仍是一页从那里起手的读法——它是页面按 HTML 与 ARIA 所描述的样子，比其下的原文小一个数量级，并且是 ref 的唯一来源——但没有任何一段描述这么说，因为[这里每段描述只描述自己那件工具](#the-copy-rule)。挡住「整页原文」的是 `content_read_dom` 必填的 `scope`：它让「先读一次」成为调用它的唯一途径。

**任何时候都不解读。** 标签名、id、class 词元与属性值，按文档的拼写、按文档持有的顺序原样打印。`op-a` 或 `el-icon-edit` 是什么意思，该由一份关于那个应用的技能来说；本包只打印，绝不猜。树形行打印的 class 词元，与清单为无名行打印的是同一个 `elementMark`，因此一次 `content_act` 步骤点名树里找到的行时，带的就是树给它看的那串字符，座位会逐字符比对两者。

**各自的天花板与做法。** 树与清单一样按 `outlineChars` 渲染，并为其余部分给出游标——把它连同同一个 `scope` 一起作为 `after` 传回。另外两件从不裁断：一个元素的属性与一个元素的文字，要么整份答出、要么不答；超出回报路由所能承载的答案会被拒绝，并报出它的字符数与它越过的那个预算。树打印的每个元素都保留一个 ref，因此对某一行做一次 `content_read_dom`，也是模型够到某个清单从未给过它把手的元素的方式。

只读，条件与清单完全相同：同样的认领与回报路由、同样的待办 projection、同样的「面前那个页面」、以及同样地扣留密码控件装着的东西。

<a id="reading-one-picture-on-the-page"></a>
## 读页面上的一张图

同一个块还给 agent 一件 `content_read_image`，它回答的是前面四件都答不了的那个问题：页面**画**出来的是什么。一个二维码、一张验证码、一幅画进 canvas 的图表、一个以形状而非字符画成的图标——清单顶多为它打出一行，原文打出的是 `<img src="/pairing?ts=…">`，两者都没说里面是什么。一次调用取走前一次读取给出的一个 `ref`，把那个元素自己渲染出来的像素作为一张图答回去，让模型直接看，旁边配一行关于「导出的是什么」的事实。

**四种标签，各自导出什么。** `img` 与 `canvas` 导出自己存着的那份栅格——`naturalWidth × naturalHeight` 与画布后备存储的 `width × height`。`picture` 导出它实际渲染的那个 `img`，标签仍记外层那个。`svg` 没有存着的栅格，于是按它的布局盒栅格化。其余标签按标签直接拒绝。

**很小的图会被放大，放到不再免费为止。** 供应商按它投射出来的那张网格计价，而它会先把任何小于自己那道下限——`MIN_PIXELS`，384 × 384 总像素，见 `packages/llm/llm-deepseek/src/image-tokens.ts`——的图，放大到正好那个面积。于是同一比例、面积都在下限之内的两张图落在同一张网格上，token 数相同；越过下限的图则按自己的像素计价：在下限及以下是 117 tokens，面积到下限两倍是 201，占满整个像素预算是 349，对着供应商 384 tokens 的上限。所以导出朝这道下限的面积放大，且绝不越过它。矢量栅格化到这个面积，比例按它的布局盒。位图则按仍能装进这个面积的最大整数倍绘制——一枚 32 × 32 的标识放十二倍，一枚 100 × 100 的图标放三倍，而超过下限四分之一的一律一倍、原样不动——并关掉平滑，于是每个存下来的像素成为一个方块，没有一条边落在两个像素之间。这个整数倍就是放大的全部：下限的面积只是请求自身像素预算（640,000，`DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET`）的一小部分，所以放大之后不会再有任何缩放。预算仍然压着越过它的图，按附件层投射请求图片所用的同一套几何，而这些图是开着平滑缩小的。

**PNG，以及 2 MiB。** 导出要 PNG，因为这个答案必须无损（二维码丢一点都不行），因为图标的 alpha 通道要活下来，也因为它正是 canvas 对任何引擎不支持的类型所退回的格式——于是点名要它，是唯一一个不会被引擎换成别的东西的请求。模型最终收到的是附件层为那条路由自己做的重编码，所以这里的格式花掉的是一次同源投递和磁盘上的字节，不是保真度。超过 2 MiB 的导出会带着它的大小被拒，而不是压低质量重编码；这道上限是供应商单图请求预算的两倍，正是无损所需要的余量。

**像素走自己的路由。** 座位把它们以 base64 装进 JSON，投到 `POST /content-frame/image`——与另外两条路由同一道 same-site、`application/json` 的围栏——而这条路由有自己的一道字节上限，按一次导出可携带的字节算出，而不是按部署的字符预算。让图片走回报路由，等于把每一次文字读取的上限也一起抬高。宿主在调用落定**之前**把字节交给 `ctx.attachments`，于是会话日志记下的那个引用，指向的是一个已经在磁盘上的对象。

**导出任何东西之前的两道闸。** 先核 `ref` 的写法，再把这次会话自己的路由交给 `access/model-switch.ts`。第二道之所以是闸而不是降级，是因为它的失败不可回收：图片经由一份存下来的附件到达模型，仓库对交给它的东西一律长期保留，而一条纯文字路由会在像素已经落盘之后，把图片块从请求里丢掉。这道闸有三个结局。声明了图片输入的路由直接放行。没声明、而部署里另有路由声明了的，就在用户面前竖一张卡，问要不要换掉这次会话的模型——用户选了哪一个，会话就经 `sessionController.selectModel` 换到那一个，换到的那条路由再过一遍这道闸自己的判据，读取随即继续。其余任何回答都拒绝这次调用，且什么都不改。卡问在等待注册之前、浏览器被要求作画之前，因为被用户拒掉的切换不得留下任何已存的图；一次会话只问一次，因为被拒的读取是模型会重试的读取。只有卡自己作出的决定才算作答：被用户关掉的卡，以及为「永远够不到人」的调用者竖起的卡，之后不再问；而当时没有任何控制台开着可作答的，或卡竖着时通道断了的，都不留记号，下一次读取照样再问。

换过去是持续的：这次会话余下的轮次都跑在选中的模型上，直到用户自己换回来；`selectModel` 还会把这个选择存成部署默认，于是之后新开的会话也从那里起步。卡上写了前一件，没写后一件。

**这道闸判的是哪条路由。** 三级：控制台做过、但还没有任何请求消费掉的模型选择，其次是会话上一条请求头记下的路由，最后是这个 agent 建立时的选项。前两级及其顺序取自 `selectionFor`（`packages/api/session-controller/src/agent.ts`）；第三级不是——控制器在那里回落到部署默认，而本包的 Client 面程序读不到它；工具执行也永远到不了这一级，因为有工具调用就有请求，有请求就有请求头。第一级正是「用户刚在选择器里换了模型、再问一次就不该被拒」的原因，也是「并行两次读取的第二次不会再弹一张卡」的原因。

**卡上列的是哪些模型。** 每个已注册供应商目录里声明了 `image` 输入的每一个模型，按供应商注册顺序与适配器偏好顺序排列——经由 `ctx.llm` 读取，因为控制台选择器渲染的那份模型目录不带模态。判据只有 `inputModalities` 一条，缺失一律当否定。某个供应商的目录读不出来，就把它整个略过，卡上其余的照常。若没有任何已配置模型声明图片输入，则根本不弹卡，直接如实拒绝；而没人可问的组合在读任何目录之前就拒绝。

目录是部署的宣称，而 `selectModel` 校验的是选中的路由能不能解析出来、不是它接受什么，因此会话换过去之后，那条路由会被重新解析并读一次 `image`，然后读取才继续。目录与解析结果不一致的部署，最终得到的是一条纯文字路由本该得到的那句拒绝：切换已经做了，图一张也没导出。

**告诉模型的话里从不出现这张卡。** 被拒掉的切换、被用户关掉的卡、无人可问的组合，答的都是这次读取原本就有的那句拒绝——这次会话的模型不声明图片输入。它仍然是真话，也不给模型任何可以再把卡弹起来的把手。

**卡上写了什么。** 本包唯一由人而不是模型读的那一面，出现在控制台的提问组件里，是主机侧的中文字面量：

```
内容区的图
当前模型看不了图片，换一个能看图的模型吗？
换过之后，这次对话接下来都用你选的那个模型；你随时可以自己换回来。

  1. DeepSeek：DeepSeek-V4-Flash-Vision-Exp
  2. 先不换  这次就不看这张图了
```

一个模型一项，label 是 `厂商：模型`，凡两项会读起来一样的就再带上模型 id；最后一项是「什么都不改」。单选，不声明 presentation intent，因此控制台渲染它的通用选项列表。

**没有仓库，就没有这件工具。** 这一读注册在 `ctx.inject(['tools', 'attachments'], …)` 里，所以没挂附件仓库的部署拿到的是五件文字工具，既没有这一件、也没有它那条路由。出厂的 `base` bundle 挂了一个。

<a id="acting-on-the-page-the-user-is-looking-at"></a>
## 在用户正看着的页面上动手

同一个块把 `content_act` 交给 agent：一次调用最多带 `maxSteps` 步——`click`、`fill`、`select`、`press`、`wait`——按顺序跑在用户面前的那个页面上，首个失败即停。除 `wait` 外每一步都要两次点名它的元素：一次是某次读取给出的 `ref`，一次是那次读取印出的 `label`——那次读取没印出名字的行，则是它印在名字位置上的 `mark`；浏览器在动手之前先核对拿到的这一个，而且是用清单印它时的同一套算法算出来的——一个取名函数，读取每印一行调一次，浏览器每跑一步调一次，因为名字要是算两遍，凡是两者算不到一块儿的元素，点名它的每一步都会被拒。上次读取之后重绘过表格的页面，同样的 ref 指的已是别的行，这道核对正是让调用停下、而不是去按此刻占着那个位置的东西的原因。另有四种结局会让某一步停下：页面上已经没有的元素、页面已经不再显示的元素、被页面挡在用户面前的对话框后面的元素、以及页面已经禁用掉的元素。

每一步跑在它那个元素所在的文档里，而那未必是 frame 自己的文档：读取器会走进页面自己挂着的同源 frame，因此它的 ref 可以指到那里的元素，事件、赋值器、对话框核对与沉降等待也都跟着元素走。事件是页面自己的那一套。一次 click 是用户会产生的整串指针事件，因为只听 `mousedown` 的框架永远看不见一个光秃秃的 `click`；一次 fill 走原型上的 value setter，因为 React 和 Vue 都记着自己上一次写进去的值，直接赋 `el.value` 是它们下一次渲染就会撤销的改动；一次按键是三个事件，背后不提交任何表单，因为 Enter 是什么意思由页面决定。`select` 要么是平台自己的 `<select>`，要么是一个自绘选择器需要的两次点击。步与步之间给页面 `settleQuietMs` 静下来，每步以 `settleMaxMs` 封顶，再受这次调用自己的截止封顶：步骤拿的是 `actTimeoutMs` 的四分之三，越过那一刻才轮到的那一步直接失败、其余报为没跑过，因为收尾读取与带着它回去的那趟路要用掉剩下的四分之一。

**一次调用就是一次审批请求。** 一个 `tools/pre-execute` 监听器把这个工具的每一次调用都升格成一次请求，而请求只由参数生成：写这句话的时候还没有任何浏览器被够到，所以它按用户看见的样子称呼这一栏最前面的那一项，而不是宿主根本没拿到的页面标题。这也是每一步都必须带 `label`、label 为空处还必须带 `mark` 的另一个理由——要告诉用户将要点什么、填什么，读取没给名字的行到用户眼前是它带的那个标记而不是「」，而这两样都只可能来自调用本身。监听器先委派，所以本来会拒掉这次调用的策略照样拒得掉；没有组合审批服务的部署一步都不会跑，这是内核对「需要审批的调用」自己的降级。

**审批针对的是当时在前台的那一项。** 一次调用要等用户答完审批才去注册等待，所以宿主在那一刻把内容栏前台的条目记下来，随认领一起交给认领它的控制台。控制台发现前台已经换了页，就一步都不跑，并说清现在前台是哪一页、这些步骤当初是针对哪一页批的：切换条只要一次点击，而在犹豫期间换了页的用户，并没有同意在那一页上做这些事。至于此后变空、或换成别的种类的内容栏，由原来那几条拒绝来答——它们更能说明下一步该干什么。

**浏览器替页面做了什么，随答案一起回来。** 在这次调用期间——且仅在这期间——座位监听路由变化，并给 `confirm`/`alert`/`prompt` 与 `window.open` 各派一个替身：前三个因为它们会卡住 frame 的事件循环直到有人作答，而座位就是那个人；最后一个因为在控制台背后开出来的窗口没人会去看。两个替身在调用结束时都被放回去，某一步抛了异常也一样。`dialogs` 说的是原生对话框怎么答——默认 `cancel`；`accept` 只有在用户读到的那份审批请求写明「并确认页面弹出的确认框」时才被允许，而任何长期放行与任何从不发问的策略都造不出那句话。

页面自己画出来的东西不去盯：toast、横幅、底下重绘的列表，正是收尾那次读取要回答的；而要把它们和框架自己的重绘分开，只能靠猜。答案永远是三段，顺序固定：跑了什么、页面自己做了什么、以及一份按部署自己的预算重新读的整页。最后一段正是让下一次调用不必再读一遍的东西，因为它点名的 ref 是当下的。

### 通道

宿主无法指名某个浏览器，所以调用是反向走的。两个工具共用这条通道。工具体不写任何东西：它登记一次等待，并把这次调用发布到该会话自己的 `contentAccess` projection 上，而每个已连接的浏览器本来就在接收它。正在展示该会话的 page 座位在 `POST /content-frame/claim` 上认领这次调用，把活干完——遍历 frame 的文档，或者把步骤跑在它上面——再把答案 `POST /content-frame/report` 回来。只有认领方那个标签页的回报会被接受——这也是「认领」是一次往返而不是一次通告的原因，也是同一个会话上开着的两个控制台只会跑一份步骤而不是两份的原因。两个工具的差别只在回传的那份文档，由它自己的 status 区分；开出这次等待的那个工具，才是判断手上这份文档答不答得了自己这次调用的那一方。

两道截止时间，因为「没有打开的控制台」和「应答过的控制台失联了」是两个不同的事实，模型对二者的下一步也不同。`claimTimeoutMs` 内无人认领的调用被告知没有控制台在展示这个会话；已认领但 `readTimeoutMs` 内没有回报的调用被告知控制台没有作答。同一会话连续的读取黏在同一个标签页上：上次应答的标签页在 `pinMs` 内优先，别的标签页的认领会被短暂挂起，好让优先的那个先拿。ref 指的是某一份文档里的元素，两个控制台轮流应答会把指不到任何东西的 ref 交给模型。

两道截止时间都不是一次尝试就用完的。宿主还不知道的那次认领会一直重新出价——只要这次调用还在该会话的待办列表上——间隔从 200ms 翻倍到一秒：座位这一侧的竞领由「调用还在等」界住，而不是由那两道截止界住；此外还有一道十分钟的上限，过了就彻底放手：写到一半停下的宿主会留下一个开了却永不结束的调用，而一份人打算去答的审批，到那时早就答完了。审批需要的正是这一点：`content_act` 要等有人答完请求之后才登记等待，所以在那之前每一次认领都被答「不知道这次调用」，而一个在宿主认领窗口就放弃的座位，会在用户还在读那份请求的时候停止竞领。认领没能送达——请求丢了、断网了一下——同样这么重投；列表的第一次回报没能送达时会再发一次：用户眼前一直摆着控制台，不该由一次丢包去告诉模型这里没有控制台。座位放弃过的调用——出价被拒、认领被别的标签页拿走、到了上限、待办列表在底下抖空了一帧——不会被记成「已回答」，而是被遗忘，因为它在宿主那儿还开着：下一帧带着它的投影，就是这个座位重新出价的那一帧。在回报截止时间之内，座位最多花一半等一个还在加载的页面，因为宿主从授予认领那一刻就开始计时，遍历与回程需要剩下的那一半。

读取这一半住在 page 座位里，因为只有这个位置持有 frame 元素。可见性与几何都向元素自己的 window 询问，而不是顶层的那个——frame 的布局属于那个 frame——并且不可见的标签页不认领任何调用，因为读取的定义就是「用户眼前的那个页面」。这样的标签页唯一不会停下的，是遗忘它放弃过的那些调用；隐身的座位若把这一步也跳过，丢掉的那次调用在它余下的生命里就再也认领不到了。

<a id="reading-the-page-in-the-frame"></a>
## 读取 frame 里的页面

`src/client/access/` 把 frame 里的文档读成带编号的结构——各个区域、各个控件、每张表的形状——交给看不见它的模型。它依据的规则、以及每条规则各自舍弃了什么，记在[阅读 Agent Note](../../../.agents/notes/implemented/feature/2026-09-02-content-snapshot-engine.zh.md) 里。里面没有任何一条挂在 class 名、组件库或命名习惯上：页面用 HTML 与 ARIA 说了什么就读什么；规范没有定义的部件——给表分页的分页条、说明「用户在哪儿」的面包屑——按页面把它们画成的那段文字打出来。

### 一张控制台表格读出来是什么

- **页面写下的每一张表，各读各的。** 组件库固定一列的做法是把整张表在自己上面再画一遍，冻结表头的做法是把表头单独画成表体上方的一张表，于是用户看见一张表，页面上却有好几张。每一张都按它本来的样子读出来、打出来：既不合并成文档里并不存在的那张表，也不把任何一张当成另一张的副本丢掉。用户眼里的一张表，因此以页面用来搭出它的那几张表的样子到达模型，每一张各带它自己画出的那些列。
- **表报的是它自己装着的行数。** `e30 table 20 rows × 21 cols` 说的是页面已经画出来的这二十行；对于一页一页画的表，那就是当前这一页。旁边那条分页条说的话——`共 89 条`——按它本来的样子、在页面画它的位置打成一行文字；一共多少行，是要从这些字里读出来的东西，而不是这个读取器替谁下的判断。
- **格子里页面画出来供人操作的东西，格子会交出来。** 页面用指针光标标记的可点目标，在格子里同样记作 `clickable` 并给一个 ref，与页面别处口径相同。行内命令若既没有 role 也没有光标——组件库那种 `<i class="el-icon-edit">`——规范定义的东西里就没有它，格子按文档所说读成空列。

### 页面没给名字的控件读出来是什么

- **名字的位置上打的是这个元素的 class token。** `e17 clickable {class: el-tooltip operation-modify el-icon-edit}`——元素携带的全部 token，按它自己携带的顺序；元素没有 class 就什么都不打。一个字都不裁：这串 token 同时是这一行的标记，步骤要原样带回来、座位要逐字比对，裁短了就对不上任何东西。只对「页面提供出来供人操作、却没给名字」的行打：可点目标、按钮、链接、可填的框；别的不打——标题和区域用自己的 role 说清了自己是什么。
- **这些 token 一个字都不解读。** 这一行的名字仍然是空的：指向它的步骤传 `label: ""`，并把同一串 token 作为 `mark` 带回来；动手之前座位把两样都重算一遍——页面现在仍然没给它名字，也仍然这样标着它。标记就是这串 token 本身，外面那层什么都不带：清单打出 `e7 clickable {class: row-action danger}` 时，步骤带的是 `ref: "e7"`、`label: ""`、`mark: "row-action danger"`；带上花括号、或带上清单印在 token 前面那个 `class:` 的标记会被拒绝并给出这个例子——class token 里不可能有这两样，那只能是把整行原样抄了进去。`el-icon-edit` 是什么意思，由懂这个应用的技能去说，本包绝不猜。

### 一张控制台表单读出来是什么

- **字段的名字，是画在它前面的那个 `label`。** 表单不把标签绑到字段上时，字段由「在同时容纳两者的最小元素之内、画在它之前的最后一个 `label`」来命名，向外最远找到字段所在的那个区域为止；这个标签随后只印一次，作为字段的名字——写的是什么、有多长，都照印。只要有别的、读者能操作的东西横在两者之间，搜索就停下；页面自己的其他文字——公告、标题、说明——一律不作名字，各自照常印出自己那一行。
- **页面要求填写的字段会说出来。** 只有页面用 `required` 或 `aria-required` 标过的字段，行尾才跟一个 `(required)`。表单换一种说法——用样式表在标签前面画一颗星——那是画在屏幕上的、不在任何属性里；哪些字段是必填的，属于「关于这张表单要懂的事」，不是能从文档里读出来的事。
- **画成两半的选择器是一个字段。** 读者不能键入的框标 `(readonly)`；页面画在同一个元素之内、用来打开候选项的那个无名箭头，印在字段那一行上作为 `[e4 opens]`，而不是自己单独成行。

<a id="what-the-agent-knows-about-the-column"></a>
## agent 对这一栏知道些什么

这一栏由浏览器绘制，因此除非本包把它送过去，否则里面的任何东西都到不了模型。有三件事到得了，各走各的通路，选哪条取决于它变得有多勤。

**用户打开的页面，在对话里通告一次。** `show-content-page` 会注入一句话——`The user opened the page "<title>" in the content column (内容区); it is in front now.`——作为一条来源为插件的 `user/message`，注入发生在 `content/shown` 落库之后，好让日志先有事实、再有关于事实的那句话。`inject` 把它排给下一个 pre-step 而不唤醒驱动：打开一个页面不是一个问题，闲着的 agent 在用户开口之前继续闲着。它从入队那一刻起就是持久的——承载它的那次收件箱 splice 本身就是一条会话事件——并在某个驱动认领它时成为一条 `user/message`。`content_show` 不注入任何东西——agent 本来就知道自己干了什么。

**应用自己的路由是一条会话事件。** browser 半边盯住在前面的那个 frame 的 `load`、`hashchange` 与 `popstate`，并且——因为这三者对 `history.pushState` 一个都不触发，而 history 模式下每个当代路由器都用它换路由——每隔 `navigationPollMs` 轮询一次 frame 自己的 `location.href`。四路信号产出的一切都先过一个 300ms 的沉降窗口，再与该 frame 上一次报告过的地址比对，最后成为一条 `content/navigated`，带着页面 id、路径、文档标题和 `by: 'user'`。离开了 dsh 源的 frame 对每一次读取都以 `SecurityError` 作答，此时监视什么也不报；本包从不给 frame 自己的 `history` 打补丁，因为那份文档属于部署方，而随后包裹它的应用会把补丁原样拆掉。

**这一栏站在哪里，是一段 prompt 上下文，不是一条消息。** `content:column`（order 130）按由新到旧列出这一栏装着什么，标出在前面的那一项，并且——当某个页面的 frame 已经离开它配置的地址时——附上它此刻所在的地址。它花多少由部署方定：`contextEntries` 限住列几条，`contextFieldChars` 限住每行带多长的名字，因为这一段搭在每个请求上，用户习惯同时开一打东西的控制台，每个请求都要为它付账。它注册为 *context* 而不是 section，理由与 `approval:policy` 相同：这个值随用户干活而变，而 context 在保留历史之后才被具化，因此挪动过的一栏不会改写供应商缓存的那段稳定 system-prompt 前缀。里面没有任何时间戳：相对时间在实跑与回放之间会不一样，而对话本身已经带着事情发生的先后。

三者都是从该会话自己的日志折出来的——`contentSurface` 的 entry 流，以及本包的 `contentPages` 状态，后者记录每个页面是谁打开的、它的 frame 又去了哪里。`contentPages` 只在宿主：没有浏览器读它，因此它不带 `wire`。

<a id="reading-a-page-that-has-not-finished-drawing-itself"></a>
## 读一个还没画完的页面

触发过 `load` 的 frame 并不等于画完了的页面：单页应用会取数、绘制、再重绘，要多久有多久，而落在这中间的一次读取，读到的是用户从未见过的那个页面。所以一次读取会等：在加载等待之后、遍历之前，对 frame 的文档挂一个 `MutationObserver`，只要文档静止满 `settleQuietMs` 就立刻作答，到 `readTimeoutMs × 0.25` 就放弃。回报截止时间的这两份份额——一半给还在加载的页面，四分之一给还在绘制的页面——把剩下的留给遍历与回程。

这次等待的两种结局都会到模型那里。始终没静下来的页面照读不误，只是表头多一行 `The page was still changing when this read ran; read again for the settled page.`：下面那份列表是那一瞬间的真实读取，而再读一次才是把它变成用户手上那个页面的列表。另外，页面上凡是可见且标了 `aria-busy="true"` 的，都会用表头里单独一行点名，至多三个，走的是列表本身那套命名阶梯。`role="progressbar"` 不算忙碌标记——页面可以把它当作正文来画——任何框架的 loading class 也一概不读，因为这个读取器从没听说过它们。

`content/navigated` 不等：地址一变，frame 一沉降就报，等这个地址背后的页面画完是「读它」的事。ref 的失效由引擎按自己的规则处理——frame 加载新文档时 ref 表被重置，元素已离开文档的 ref 解析为空，过期的 `scope` 或 `after` 会被拒绝并告诉模型重新读一次。

<a id="hiding-the-show-content-page-command-from-the-chat-transcript"></a>
## 在聊天记录里隐藏 `show-content-page` 命令

用户点一次页面就是一次命令调用，每条命令都会在日志上留下一对 `command/run`/`command/done`——侧栏菜单和一切回放都依赖这条持久记录。放任不管的话，`dsh-client-ui-conversation` 的聊天视图会把这一对渲染成一条普通的命令行（"Now showing `<title>` in the content column."）：对 agent 自己发出的命令这条信息有意义，对用户刚点出来的这次点击却是多余的。browser 半边在 `conversation.chat.commandview` 这个每条命令行都要经过的 keyed 槽的 `show-content-page` 键位上注册一个空组件，让这一行的业务内容永不出现。

一个空组件仍然会在聊天列里留下一个零高度的 flex 项，而列的 `gap: 16px` 不管高度多少都会为它留一份间距。browser 半边因此还注入了一条 CSS 规则，把这一整行折叠掉（`[data-chat-flow-kind="command"]:has([data-slot="conversation.chat.commandview"]:empty)`），它耦合了两个本包并不拥有的 DOM 结构——`dsh-client-ui-conversation` 的 `data-chat-flow-kind` 属性和 `dsh-client-ui-renderer` 的 `data-slot` 锚点包装——见 Known Limitations。

<a id="composition"></a>
## 组合方式

本包与外壳都不属于任何出厂 bundle。`overlay/content-column.patch.yml` 把四者一并叠加到 Web 形态上——外壳替换 `ui-layout`，`content-surface` 把该会话已记录的事件折叠成 entry 流，`content-column` 占据外壳开出的那一栏，本行贡献 `page` 类型：

```yaml
- id: ui-layout
  name: '@deepseek-ai/dsh-client-ui-layout'
  disabled: true

- insert:
    - id: server-layout
      name: '@deepseek-ai/dsh-experimental-server-layout'
    - id: content-surface
      name: '@deepseek-ai/dsh-experimental-content-surface'
    - id: content-column
      name: '@deepseek-ai/dsh-experimental-content-column'
    - id: content-frame
      name: '@deepseek-ai/dsh-experimental-content-frame'
      config:
        root: !!js process.env.DSH_CONTENT_APP_ROOT
        pages:
          - id: home
            title: Home
            description: The hosted application's entry page.
            url: /content-app/
        defaultPage: home
        pageAccess: {}
```

读图这道闸竖起的卡，需要同一个组合里既有 `userQuestions` 的应答者，也有 `ctx.sessionController`；Web 形态两者都挂。缺任一，读图就按卡出现之前的方式拒绝一条纯文字路由，其余六件工具不受影响。

用 `dsh --profile web --patch <path>` 应用。overlay 从环境变量读取目录，使同一个文件可以服务任意应用；托管固定应用的部署把字面绝对路径写在那里即可。所有包都必须能从 profile 目录解析到——对树外插件而言即 `dsh plugin --profile web add <path>` 或等价的链接；发布 bundle 不得声明实验性包。

空的 `pageAccess` 块是这条服务线自己的选择：它取全部默认值，也正是它让 agent 能看见自己推到用户眼前的页面。删掉这一行，这一栏的行为与从前完全一样。

工具、命令、各 projection 与 page extractor 都是可选子节点：没有 `ctx.tools`、`ctx.commands`、`ctx.sessionProjections` 或 `ctx.contentSurface` 的组合仍保留路由，只是这一栏里什么都不显示；任何一项缺席都不会让该行失败。

<a id="the-copy-rule"></a>
## 工具说什么，以及永远不说什么

这个包的工具文案受两条规则约束——每段工具描述、每段参数说明、每句拒绝与失败文案、每条结果提示、输出 schema 的每个字段说明——理由归 [self-contained-copy Agent Note](../../../.agents/notes/implemented/feature/2026-09-04-self-contained-tool-copy.zh.md) 记载。`src/perception/text.ts` 里的请求上下文行不在这两条规则之内，仍然点名 `content_read` 和 `content_show`：它们是[内容栏上下文](#the-content-column-context)，是模型对这条通道的地图，而不是某一件工具自己的文案；它们归该 Note 的 [Where the rules do not reach](../../../.agents/notes/implemented/feature/2026-09-04-self-contained-tool-copy.zh.md#where-the-rules-do-not-reach) 一节管辖。

**一段描述只描述它自己那件工具，或者它自己那个参数，不点名任何别的工具。** 没有哪段描述会说某个同伴更便宜、是起手那一读、或者 ref 从哪里来；每段只说它收什么、打印什么、答什么。模型是读完全部描述之后挑工具的。

**一句失败只说这次调用为何被拒，别的都不说。** 没有哪句拒绝会点名该改调哪件工具、要求去问用户、或者叫人重试：栏是空的、在前面那一项不是页面、等待窗口内没有可见的控制台标签页认领、答案超出了预算。拒绝确实会点名这件工具自己的参数——比如 `scope must be a ref like "e12" printed by an earlier read of this page`——因为那正是理由，而不是补救。

两条规则是在一次真机 A/B 之后一起改的：两条提示，每格一个全新会话，互相点名的文案对只写自己的文案。互相点名那一臂里，提示 A 被拒的那一次调用是 `content_read` 传 `mode: "dom"`，提示 B 是 `content_read` 传 `scope: ""`，各一次。只写自己那一臂里，提示 A 直接调了 `content_read_dom`，但另花两次调用给 `content_read` 传 `mode: "find"`；提示 B 首调 `content_read` 传 `scope: "__page__"`——被拒调用分别是两次和一次。这次改动针对的那个误路由没有复现；两臂都仍然在首调时自己编了一个 `scope` 值，也都把一个词当成了 `mode` 的取值，所以那一行参数说明现在写明「不传 `scope` 即读整页」。调用总数从 13→11、11→9，整树 DOM 读取从 3→1、2→1，四格答案全部正确；每格 n = 1 且温度未控，这些数字是观察，不是测量。[`tests/self-contained-copy.client.spec.ts`](tests/self-contained-copy.client.spec.ts) 走遍两个文案模块的全部导出、一次读取回复的清单，以及七件工具装配后定义里的每一段描述，其中出现任何工具名都会失败。

<a id="model-experience"></a>
## Model Experience

### The `content_show` offer

#### What the model sees

一个工具 `content_show`，一个必填的 `string` 参数 `page`。它的描述以 `id — title — description` 行携带部署方的完整页面清单，因此不需要别的东西告诉模型可以展示什么——本包不贡献任何 system prompt section。

#### Token effect

一段固定描述，加每个配置页面一行清单，出现在工具可见的每一次请求里。十个页面约合十行短文本。

#### KV Cache effect

描述在该行加载时装配一次，在一个部署内不会变化，因此工具块在各次请求间逐字节一致，前缀得以保持。编辑 `pages` 会改变这个块并使其之后的复用失效——那是一次配置改动，不是会话能触发的事情。

### Tool-call result and column state

#### What the model sees

调用成功时回复恰好是 `Now showing <title> in the content column.` 或 `Content column cleared.`。部署未配置的 id 回复 `Error: unknown page "<id>". Available pages:` 后接完整清单，因此模型从结果里自纠错，而不是靠猜测重试；这次调用不改变任何东西。没有归属会话的调用回复 `Error: This call has no owning agent session`。每次成功调用追加的 `content/shown` 事件属于 UI 与重放状态，不是第二条模型消息。

#### Token effect

成功路径小而定形。被拒绝时多付一份清单，这正是让它可自纠错的代价。

#### KV Cache effect

只追加；结果跟在可复用的请求前缀之后，不会使任何已缓存内容失效。

### The `content_read` offer

#### What the model sees

一个工具 `content_read`，只在部署方配置了 `pageAccess` 时才提供。四个可选参数：`mode`（默认 `outline`，或 `map`）、`scope` 与 `after`（来自上一次读取的 ref）、`find`（大小写不敏感的文本过滤）。描述用产品自己的中文名和它在屏幕上的位置来称呼这一栏，模型正是靠这个找到它的：在提示里没有任何地方出现「右边」这个说法的前提下问「右边这个表」，模型十次有十次找到了这一栏。位置加上上下文自己列出的条目清单之外，方位别名没有换来任何东西，因此一个都不给。描述还写明一次读取可能给出的三种答案，让第一次调用就知道怎么接着读。本包不为它贡献任何 system prompt section。

#### Token effect

一段固定描述加四行参数说明，出现在工具可见的每一次请求里。

#### KV Cache effect

描述是一个常量，在一个部署内不会变化，因此工具块在各次请求间逐字节一致，前缀得以保持。

### The read result

#### What the model sees

读取成功时回复一个文本块：一行 `Page: <title> — the app is at <path>, title "<document title>"`；随后各占一行的是页面打开着的对话框名称、页面自称还在加载的东西、以及这次读取时它是否还在变；再往下是列表本身。整页超出预算时回的是页面骨架，并在第一行说明这一点；被截断的列表末尾给出接着读的游标，作为 `after` 传回。其余每一种结局都是一句只写明这次读取为何被拒的错误，别的什么都不写——栏是空的、在前面那一项不是页面、第一块就超出了预算、认领窗口过去了。其中一种有两副面孔，因为「栏里装着东西」本身就是理由的另一半：空栏上的认领超时只说这次等待；已经有东西在前面的栏上，那一项按它自己的 kind 词点名——图表就是 `the chart "…"`——因为这一栏的 key 域是开放的。没有组合 projection registry 的装配读不到栏，走第一副面孔。

##### The claim timeout over an empty column

```markdown
No open, visible console tab is showing this session's content column (waited 3s).
```

##### The claim timeout over a column with an entry in front

```markdown
No open, visible console tab is showing this session's content column (waited 3s); the page "点位信息" is already in front.
```

#### Token effect

以 `outlineChars` 为界——列表在这个预算下渲染，因此一次读取最多花这么多，加上那一行表头。让读取永远不是一次盲截的两种答案（骨架与游标），正是这份预算买来的。

#### KV Cache effect

只追加。列表是关于页面在那一刻的事实；对已变化页面的第二次读取是一份新结果，而不是对第一份的改写。

### The three markup-read offers

#### What the model sees

在 `content_read` 旁边再提供三件工具，开启条件与它同为 `pageAccess`。`content_read_dom` 收 `scope`（必填）与 `after`；`content_read_attrs` 与 `content_read_dom_content` 各收一个 `ref`（必填），别的都不收。每段描述都写明这件工具打印什么、答的是什么问题、其中没有任何解读，并且不点名任何同伴。这条规则放弃点名所换来的风险是真的：一个刚被展示了「有办法读到页面真正原文」的模型可能先伸手去拿，而整页原文比它本可以拿到的清单大一个数量级。仍然挡在那里的是 `content_read_dom` 必填的 `scope`：它让「先读一次」成为调用它的唯一途径。

#### Token effect

三段固定描述，加上它们之间共四行参数说明，出现在这些工具可见的每一次请求里。

#### KV Cache effect

这些描述都是常量，在一个部署内不会变化，因此工具块在各次请求间逐字节一致，前缀得以保持。

### A markup read's result

#### What the model sees

一个文本块，开头是 `Page: <title> — the app is at <path>`；适用时另起一行的是与清单相同的那句「页面仍在变化」；再往下是树、属性或文字。这个页首比清单的短，少的正是这三件读取不回答的三件事：文档怎么称呼自己、它开着哪个对话框、它标记了什么还在加载，都是关于页面的问题，而回答它们的读取是 `content_read`。

##### A tree of the rows a listing named nothing

```markdown
Page: 点位信息 — the app is at /content-app/points/
e33 tbody {class: el-table__body}
  e34 tr {class: el-table__row}
    e35 td {class: el-table__cell}
      e36 i {class: el-tooltip operation-modify el-icon-edit}
```

##### One element's attributes

```markdown
Page: 点位信息 — the app is at /content-app/points/
e36 i
  class="el-tooltip operation-modify el-icon-edit"
  data-op="edit"
```

##### A text too large for one result

```markdown
The text of e12 comes to 61204 characters, past what this deployment's report route carries (pageAccess.outlineChars is 12000).
```

#### Token effect

树与清单一样以 `outlineChars` 为界并返回游标。另外两件不受任何它们会裁断的东西约束：一个元素的属性与一个元素的文字整份抵达，超出回报路由所能承载者被拒绝并报出字数、而不是被截短，因此这两种调用的开销就是它所索要之物的大小。

#### KV Cache effect

只追加。每一份答案都是关于页面在那一刻的事实，因此第二次读取是一份新结果，而不是对第一份的改写。

### The `content_read_image` offer

#### What the model sees

一件 `content_read_image`，按同一个 `pageAccess` 条件出现，且只在挂了附件仓库时出现。一个必填参数 `ref`。描述写明那个元素必须是什么——`img`、`canvas`、`svg` 或 `picture`——以及导出会对它做什么，因为这两样都是答案的前提而不是建议：页面把自己的码和图标画在这四种标签里，别处没有；而浏览器不肯让这个控制台导出的图，根本没有答案。最后一句写明本次会话的模型必须接受图片输入，这是唯一一条与页面无关的前提。

#### Token effect

一段固定描述加一行参数说明，出现在每一次这件工具可见的请求里。

#### KV Cache effect

描述是常量，在一个部署内从不变化，因此工具块在各次请求间逐字节一致，前缀成立。

### The picture result

#### What the model sees

两个块。第一个是文字：与每件原文读取开头相同的那行 `Page: <title> — the app is at <path>`、适用时那句「还在变」，以及一行事实。两个尺寸都写在那一行上，因为它们回答不同的问题：natural 是页面画成什么样，exported 是模型正在看的是什么样，于是「为保持可读而被放大的小图」和「被压到预算里的大图」，都表现为这两者不一致。第二个块是图本身，一个指向已存附件的 image 块。凡不是图的结局都是一行，只点名它撞上的那个条件，别的都不说——ref 指的不是图、元素不可见（`e12 is not visible on the page, so it has no rendered pixels.`）、还没加载完（`e12 has not finished loading its image.`）、画出来是零（`e12 is drawn at zero pixels.`）、由另一个源画出、太大、控制台没能在导出所分到的那份读取截止时间之内画完——`readTimeoutMs` 的八分之一，按默认值就是 `e12 did not finish exporting within 1.875s.`——或者这次会话的模型根本不收图。

##### One picture, and the line above it

```markdown
Page: Home — the app is at /content-app/
e12 <img> 240×240 px, exported 240×240 as image/png, 3182 bytes
```

##### A ref that names no picture

```markdown
e12 is a <div>, which carries no picture of its own.
```

##### A picture the browser will not export

```markdown
e12 is drawn from another origin, and a browser does not let those pixels be exported.
```

##### An export too large for one result

```markdown
e12 exports to 3145728 bytes, past the 2097152 bytes one image may carry.
```

##### A session whose model takes no pictures

```markdown
The session's model "deepseek-v4-flash" does not declare image input.
```

##### A deployment where no model takes pictures

```markdown
The session's model "deepseek-v4-flash" does not declare image input, and no configured model does.
```

##### A model change the host would not make

```markdown
The session's model could not be changed. no adapter registered for provider "deepseek-official"
```

#### Token effect

文字块两行。图按供应商的计价算：经过它自己那道下限后不超过 384 × 384 的一律 117 tokens，512 × 512 是 201，占满 640,000 像素预算的方图是 349——一律不超过供应商自己那道 384 tokens 的上限（`MAX_IMAGE_TOKENS`）。对着一棵原文子树，这很便宜，但它不是子树的替代品：它答的是某一个元素画了什么，关于这个页面是什么则一个字都没有。

#### KV Cache effect

图作为一条合成的 `user` 消息，紧跟在产出它的那条工具结果之后进入请求（`packages/llm/llm-deepseek/src/serialize.ts`），因此从第一次读图起请求后缀就变了，而它前面的前缀仍然成立。

### The `content_act` offer

#### What the model sees

一个工具 `content_act`，凡部署方配置了 `pageAccess` 的地方就与 `content_read` 并排提供。两个参数：`steps` 必填，每一步是 `{action, ref, label, mark?, text?, value?, key?}`——`mark` 是「读取没给名字的那一行」的点名方式：`label: ""` 加上那次读取为它印出的 class token 本身、外面什么都不带——`action` 五选一 `click`、`fill`、`select`、`press`、`wait`；以及 `dialogs`，`cancel` 或 `accept`，用于步骤运行期间页面自己弹出的原生对话框。描述里写明浏览器会在动手之前拿 label 与页面核对，好让模型知道一份过期的读取会让调用停下、而不是动到错的元素；也写明一次调用就是一次审批请求，这是「把该在一起的步骤放进一次调用」背后的成本模型。

#### Token effect

一份 schema，只要这个工具还提供着就随每个请求列出——约 120 词的描述、`steps` 里的六行参数说明、外加 `dialogs` 一行。

#### KV Cache effect

稳定：schema 在加载时定死，不随会话、也不随这一栏里有什么而变。

### The result of a set of steps

#### What the model sees

三段，顺序永远是这个：跑了什么、或哪一步让调用停了下来；步骤运行期间页面自己做了什么；以及一份重新读的整页。第三段就是同一个页面、同一份预算下的一次 `content_read`，所以里面的 ref 正是下一次调用可以指着的那些。

##### A call whose steps all ran

```markdown
Done 2/2 on 点位信息: fill "名称" ← "东风"; click "查询" (settled after 0.8s).
Page events during these steps: none.
Page now:
1 main
  2 heading "点位信息"
  3 table "点位列表" — 名称, 状态, 操作 · 24 rows · e14
```

##### A call one step stopped

```markdown
Step 2 failed: e5 is now "重置", not "查询" — the page changed. Step 1 ran; later steps were skipped.
Page events during these steps: none.
Page now:
1 main
  2 heading "点位信息"
```

##### The console claimed the call and went quiet

```markdown
The console claimed this call but did not report within 60s; the steps may have run partially or fully.
```

#### Token effect

收尾那次读取以 `outlineChars` 为界，再加第一行里每步一个短句，再加浏览器替页面做了什么的至多八行、每行裁到 200 字符。也就是说，一次改动了页面的调用，花费大致等于读一次它——这正是要点：模型不必为了看见自己做了什么再读一遍。

#### KV Cache effect

只追加。每份结果都是页面在那一刻的事实，所以第二次调用是一份新结果，而不是对第一份的改写。

### The content-column context

#### What the model sees

每个请求上一段 `content:column`，按由新到旧列出这一栏装着什么——`- "<title>" (<kind>, opened by the user|you)`，在前面的那一项标着 `← in front`；frame 已经挪走的页面另起一行给出它此刻的地址。它列出 `contextEntries` 条（默认 10），并说明还有多少条没列；每个名字裁到 `contextFieldChars`（默认 120）。空的一栏用一句话说明。收尾那行说明该调什么：`content_show puts a page in front.`；部署提供了读取器时，前面还有 `content_read reads the entry in front`，以及那条把模型自己的把手挡在答复之外的规则——像 `e12` 这样的 ref 是给 `content_read` 的 `scope` 与 `after` 用的，回答用户时要说页面上写着什么。这条规则放在这里而不是工具描述里，因为它管的是答复而不是调用：选中工具的模型早已读过描述，而它随后写下的那句话是就着这次请求带的东西写的。

#### Token effect

这一段是：一行表头，每条被列出的条目一行——frame 已经挪走的页面再多一行——当这一栏装的条目多过 `contextEntries` 所列时多一行计数，最后是一行收尾；部署提供了读取器时是两行，第二行是 ref 规则。展示过两个页面、其中一个自行路由过的会话，每个请求五行：表头、两条条目、一行地址、一行收尾。这里按行与字符而不按 token 计，是因为 token 数是部署方所用供应商那个分词器的性质，本包既不加载它也预测不了它，而 `contextFieldChars`（默认 120）是一道始终成立的、以字符为单位的界。

#### KV Cache effect

它是 context 而不是 section：在保留历史之后才具化，因此这个值随用户干活而变，永远不会改写已缓存的 system-prompt 前缀。这一段本身随这一栏而变——这正是它的用处。

### The notice a user's page click injects

#### What the model sees

一次点击一句话，作为注入的上下文消息：`The user opened the page "<title>" in the content column (内容区); it is in front now.` 它在 agent 的下一个 pre-step 抵达，不唤醒任何东西。

#### Token effect

每次点击一句短句，此后长驻对话。

#### KV Cache effect

只在对话末尾追加，因此不会让已缓存的任何内容失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


- **会话卡片显示的是那一行，不是那张图** —— 上游的 `tool.call.images` 子槽有且只有一个声明者（`packages/client/ui-tool` 的 `read-image` 行，而 `packages/client/ui-slots` 会在第二份声明加载时直接抛错），所以本包不注册 toolview，落定后的卡片退回通用卡片，显示的是那行标题。图照样到达模型；要让卡片也显示它，需要那个槽改成按 key 分发或允许多份声明，那是本包不做的上游改动。
- **WebGL canvas 可能导出一张空帧** —— 没有 `preserveDrawingBuffer` 创建的上下文，在合成之后已无内容可回读，而页面是否创建了这样一个上下文，从外面看不出来。导出照样成功，像素是空的；这里没有任何东西能把它与「页面本来就什么都没画」区分开。
- **指向自身之外的矢量，栅格化时不带它指的东西** —— `svg` 按原样序列化，因此外部样式表、webfont 字形、外链图片都不属于被画出来的内容。元素内联持有的东西，才是导出来的东西。
- **不读 `video`，也不读子树** —— 没有抓帧，也没有办法把页面的某一块区域栅格化：这一读取的是一个自己就有像素的元素。把任意标记栅格化意味着引入一个 DOM 转 canvas 的依赖，本包不引入。
- **存下来的图是永久的** —— 附件仓库对交给它的东西一律保留、从不回收（`packages/attachment/attachment-local/README.zh.md`），因此这一读导出的每一张图，都在 `$DSH_HOME/attachments/` 里活到那个 home 的尽头，并随会话日志的任何一次导出一起走。读过一次的登录二维码，就是永久留着的登录二维码。
- **卡是中文的，不随控制台语言变** —— `locale` 是浏览器侧服务，主机没有，因此卡上那四行是主机侧字面量，与 `content_act` 的审批请求同一做法。英文控制台会原样看到它们。
- **没有任何东西把模型换回去** —— 换到视觉模型的会话就留在那里，而它离开的那个模型对这场对话余下的部分可能更合适。`selectModel` 还会把这个选择存成部署默认，于是之后新开的会话也从新模型起步；卡上说了这场对话会一直用它，没说部署默认也变了。
- **「只问一次」的记号是每进程的** —— 拒过一次的用户在这次会话里不会被再问，但记号存在内存里，因此重载会话或重启主机之后会再问一次。凡不是以「作出决定」收场的卡——当时没有控制台开着、连接断了、应答者抛了——一律不留记号，于是模型下一次尝试会再竖一张卡。
- **卡把每一条能看图的路由都列出来，不设上限** —— 不裁剪、不排序、不推荐。配了很多视觉路由的部署会得到一张每条路由各占一项的卡。
- **同一个显示名下注册的两个供应商在卡上分不开** —— 一项的 label 是供应商显示名、模型显示名，以及「两项会读起来一样时」再加上的模型 id。因此以同一个显示名注册、又列出同一个模型 id 的两条供应商路由，会产生两项读起来一样的选项，其中第一项代表两者作答。
- **`content/navigated` 与 `content/shown` 一样，读取时必需** —— 两条事件都不带 `ignorable` 标记，因为今天的 `Session.append` 没有办法设置它；会话词汇表里没有本包的运行时会拒绝整份日志，而不是跳过这两条。
- **一次路由变化要花掉一个轮询间隔** —— `pushState` 什么都不触发，因此路由完就静止的应用要到下一次轮询（默认一秒）加上沉降窗口才被察觉。调小 `navigationPollMs` 买到的是延迟，付出的是每个 frame 每个间隔一次同源属性读取；本包刻意不给 frame 自己的 `history` 打补丁。
- **导航监视只覆盖在前面的那个 frame** —— 被缓存、已隐藏的 frame 自行路由不在监视之内，这次移动要等该页面回到前面才被察觉。
- **自己改标题也算移动** —— 这里的地址是路径与文档标题合起来的一对，轮询与比对都按这一对来，因为取完数就给自己改名的应用，在模型看来已经动了。于是标题里挂着实时计数器的页面，每一次它静止下来的变化都会产出一条 `content/navigated`，节奏由 `navigationPollMs` 限住，而不是由页面决定。
- **沉降等待看不见按定时器绘制的页面** —— 每秒重绘一次的文档永远不会静止满静默窗口，对它的每一次读取都会带上「还在变」那一行。这是诚实的答案而不是失败：预算限的是等待，不是页面。
- **只读 `aria-busy` 这一种忙碌信号** —— 什么都不标的页面转多久都不会有忙碌行，因为这里不认识任何框架自己的 loading class。
- **`contentPages` 不带 wire** —— 它只是宿主侧的一次折叠；想知道 frame 去了哪里的浏览器，直接读那个 frame。
- **`content/shown` 是读取时必需的** —— 该事件不带 `ignorable` 标记，因此会话词汇表里没有它的运行时会拒绝整份日志，而不是跳过这条事件。本仓库的任何构建都认识这个类型；单独构建、且排除了本包的运行时则不认识。
- **on-display 规则不区分写入者** —— [`content-surface`](../content-surface/README.zh.md) 那条与 kind 无关的 prompt 规则告诉模型，要在原地更新「你已经产出并放上台面的东西」。用户通过侧边栏菜单打开的页面，与 agent 选定的页面在「放上台面」这件事上完全一样，因此这条规则的措辞仍然读起来像是 agent 产出的。`by` 字段的存在是为了让以后的 prompt 或渲染器能够区分这一点；规则本身的措辞刻意保持不变（它是一段钉死、经过测量的文本——见其自身的模块文档），不为这一种情况单独打补丁。
- **`page` extractor 解析出的 `by` 尚未被渲染** —— 浏览器这一栏的 frame 渲染器不论谁展示的都画同一个 iframe。这个字段被一路带到 payload 里，是为了让以后的改动不用再一次提升 `dataVersion` 就能展示它。
- **一个目录、一个源** —— 路由只提供单个配置目录，且每个页面都必须是 dsh 同源内的路径。没有第二个应用、没有外部 URL，agent 也无法指名部署未配置的页面。
- **frame 自己仍然什么都不报** —— 没有 `postMessage` 协议、也没有共享状态：agent 对这个页面的了解，来自读它或者在它上面动手，而用户在两次调用之间在 frame 里做了什么，谁也收不到。该页面回到 harness 的唯一通路是它自行调用的 dsh HTTP API。
- **动手只有五个动作，没有手势** —— 没有拖拽、没有滚动、没有悬停、没有文件上传、没有右键，也没有办法作用在一次读取没有编号过的东西上。需要其中任何一样的页面，需要的是用户。
- **页面哪儿都没给名字的控件，只能靠它的 class token 动** —— 模型只能抄列表印出来的东西，而座位核的就是它抄的那个。一个框的名字来自它的 label、`aria-label`，或者写在框里的那个词（`placeholder`、`aria-placeholder`）；三样都没有的控件改印它的 class token，步骤把这串东西作为 `mark` 带上。既没名字、也没有 class 的控件印不出任何可抄的东西，没有哪一步点得到它。
- **一步的目标按名字核对，而名字不是身份** —— 两行里都叫「编辑」的按钮，或者两行里 class token 一模一样的无名图标，在这道核对看来都是同一个，所以一次把它们换了顺序的重绘能过关。ref 是点名元素的那一半，名字是抓住页面已经变了的那一半；两者单拿出来都不是身份，而一个同时改编号又改名字的页面，就是必须重新读一次的页面。
- **对话框替身是对页面的唯一注入** —— 在一次调用期间，`confirm`、`alert`、`prompt` 与 `window.open` 是本包的：frame 自己的文档里是，读取器走进过的每一个同源 frame 里也是，调用结束即还原。在调用之前就把它们自己存了一份引用的页面，调的仍是原件；而在调用之外弹对话框的页面，照旧卡住它自己的 frame。
- **来了又走的 toast 哪儿都不留** —— 只上报浏览器替页面做的事：它弹的对话框、它跳去的地址、它想开的窗口；每次调用至多八条，每条裁到 200 字符。步骤运行期间页面画出来又撤掉的文字，不在任何一次读取里，也不在报告的任何一行里；只用一条 toast 说事的页面，等于没跟谁说。
- **一次调用的范围，是它开跑时的那些文档** —— 替身、路由观察、`wait` 步与沉降等待，覆盖的都是调用开始时读取器走过的那些同源文档。步骤跑到一半页面才添的 frame 不在其中：它画的东西只会被收尾快照读到，它弹的对话框卡住整个标签页，和没有本包时一样。
- **`dialogs: accept` 由被问过的那次调用花掉** —— 这条记录用一次即消，所以同一次调用的重试会取消页面的对话框而不是确认它，并重新问用户一次。
- **`content` projection 在树内没有消费者** —— 这一栏改读 entry 流，`content` 只作为「已解析的当前页面」值（`shown`/`default`/`empty`/`missing`）留给其他读取 wire 的一方。它也是 `defaultPage` 唯一还会出现的地方。
- **frame 缓存按浏览器标签页计，且在时间上无上限** —— `cacheSize` 限定的是同时存活多少个 frame，不是存活多久。一个长期打开的标签页会让被缓存的文档持续运行，包括它们持有的轮询与套接字。
- **settings 路由假定存在 HTTP 载体** —— browser 半边以页面 origin 为基准请求 `/content-frame/settings`。如果某种传输提供了外壳却没有把 harness 暴露在 HTTP 上，该行会失败——与 iframe 自己那条路由的处境相同。
- **没有面向不可信内容的沙箱档** —— 见上文信任边界。托管不应携带外壳权限的内容属于另一个插件，本包不为此提供开关。
- **只有 `label` 能给「页面没绑定任何标签」的字段命名** —— 页面把这些字画在 `div` 或 `span` 里时，字段宁可保持无名，也不冒「拿旁边一条公告当名字」的风险；`label` 有多长都照用。名字取自画在一段更长文字里的 `label` 时，那一整段仍然印成一行，于是这些字到达读者两次。
- **样式表画出来的星在这里什么都不说** —— 只用画出来的 `*` 标必填、不写 `required` 属性的表单，读出来是一张全是选填字段的表单。
- **页面只用自家 class 画出来的命令，在这套读法里等于不存在** —— 组件库的行内命令（`<i class="el-tooltip operation-modify el-icon-edit">`）没有 role、没有名字、没有 title、也没有指针光标，于是不为它们打任何一行，它们所在那一列读出来是空的。2026-09-03 在那台控制台上实测：整页读取是 2507 字符、六张表，其中 `e33`——固定在右边、画着 操作 列的那张表体——打出二十行，每一格都是空的。页面若确实把这类元素标成了可点的，那一行会带上它的 class token、没有名字；同一次读取为一个画成按钮的命令打出 `e3 button {class: el-button el-tooltip head-btn el-button--text …}`——那次读取把 token 裁到四个，这个版本不再裁。两者是什么意思都由技能去懂：读取器只说文档说了什么，不从厂商的拼法里猜。
- **组件库分片画出来的表，到模型那儿就是这些片** —— 冻结表头是一张表，它下面的表体是另一张，固定列是第三张；把列表画了六遍的页面读出来就是六张表，各列分散在它们之间。不做任何合并：用户眼里的那一张表由哪几片拼成，交给技能去懂。
- **录制归语料库，重放归浏览器车道** —— 四个 content 场景位于 `snapshots/web/` 下并各带清单，清单声明的组合是 `web-content`，因此 `pnpm run test:snapshot` 会遍历到它们并守住它们的存储不变量；重放本身归 Web 浏览器车道，因为这些场景启动的是一份打过补丁的组合，而出厂组合不会组合实验性行。除此之外，模型可见文本仍由单测逐字钉住。
- **两条读取路由不带 Host 栅栏** —— 与外壳自己的 `/api` 一样，它们拒绝浏览器标记为 `sec-fetch-site: cross-site` 的请求并要求 `application/json`，但这两道检查都挡不住 DNS rebinding，而 webserver 自身没有 Host 白名单（`trustedHosts` 只守 `/api`）。顶替它位置的是 callId：能打到路由的攻击者，若不知道宿主铸出、且只发布进该会话自己 projection 流里的那个 id，既认领不了读取也回报不了；针对未知 id 的认领与回报什么都不改变。这个 id 猜不出来是 LLM 供应商的性质，不是本包的：DeepSeek 铸出的是 `call_00_` 加 24 位字母数字（末四位为数字），code-mode 子调用是同一个 id 再加 `:code:<n>`；本包既不校验这个格式也不为它补强，所以换一家把调用编成 `call_1`、`call_2` 的供应商，这两条路由就等于对任何能打到本机的页面开放。把 harness 暴露在不可信网络上的部署需要在自己的反向代理上设栅栏——这一栏与其他每一条路由并无不同。
- **「在前面的那一项」是 page 座位的判断，不是日志的** —— 用户选中了哪一项是一次观看决定，这一栏把它留在组件状态里，因此当某个会话的内容区里还有好几个别的 kind 时，读取只会说「在前面的不是页面」而不点名是哪一个。
- **一次读取携带结构，绝不携带数据** —— 没有任何模式会返回一张表的内容，本包也不打算加：列表是模型指着页面所需要的东西，它背后的数据属于产出它的那一方。
- **一棵原文树止于它出发的那个 frame** —— `content_read_dom` 会用打开的 shadow root 顶替它所渲染的 light children，并把 `iframe` 当作它本身那一个元素打印，而不下潜进那个 frame 的文档。同源 frame 里的 ref 仍然可以当 `scope` 用，因为清单会走进那些 frame 并给里面的东西编号；没有 ref 的东西就没有入口。
- **一棵原文树会打印页面藏起来的东西** —— 可见性是清单的过滤器，并且刻意不是树的：清单因不可见而丢掉的那一行，恰恰是读者到树里来找的东西。因此一个带大片隐藏子树的页面会把预算花在上面，而游标是唯一约束它的东西。
- **树形行的文字额度是阅读器自己的数字** —— 80 个字符，是对着「这一行的职责是说清这是哪个元素」选的；超出后该行会说明这一点，并点名由 `content_read_dom_content` 从哪个 ref 打印其余部分。它不是 `Config` 字段，理由与清单自己那 200 字符的文本段不是字段相同。
- **一个元素的属性没有更窄的读法** —— 这件工具要么全给、要么拒绝。一个带着 data URI 或内联样式表、且大过回报路由所允许量的元素，在那个部署的 `outlineChars` 下就是读不出来的，而拒绝语直说这一点，不去给一个帮不上忙的调用。
- **`content_read_dom_content` 是在替 `innerText` 站位，而不是在调用它** —— 座位要为一个没有布局的 DOM 实现里的文档作答，因此行在元素不是行内元素处以及 `<br>` 处结束，这是页面原文所陈述的规则，而不是它的样式表所产生的结果。一个把 `span` 改成块级、或把 `div` 改成行内的页面，是按它的原文而不是按它被画出来的样子断行的。行内元素这一集合是本包自己的——短语内容减去浏览器自己绘制的那些，再减去用户可操作的那些——因此 `del`、`ins`、`button`、`input`、`output`、`select` 与 `slot` 在这里会断行，而浏览器本会把它们留在同一行里。
- **jsdom 顶替不了真实 frame** —— 它没有布局，也永远不会加载指向真实路由的 frame，因此本包自己的测试读的是手工挂载的文档，真实路径只由浏览器车道覆盖。
- **空命令行的 CSS 折叠是 DOM 结构耦合，不是契约** —— 它依赖 `dsh-client-ui-conversation` 的 `data-chat-flow-kind` 属性和 `dsh-client-ui-renderer` 的 `data-slot` 锚点包装，两者都不是本包拥有、也不是对方承诺维持的结构。任一形状将来发生变化都会悄悄解除这次折叠（该行连同它的 16px 间距一起重新出现），而不是显式报错；`server-sidebar.e2e.ts` 里断言该行始终不可见的场景是这个耦合唯一的绊线。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
