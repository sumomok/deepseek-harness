# Agent Note：把部署自己的数据页开进面板，用访客自己的凭据

Status: implemented

[English](2026-09-10-toy-crud-kind.md) | 中文

## 问题

[data-source 那条缝](../architecture/2026-09-06-content-component-library-v2c-data-source.zh.md)能把 `toy.table` 的内容从部署自己的后端填出来：宿主用访客的凭据取行、填进块里、把填好的整条条目记下来。对于智能体为某一个问题组装出来的一张表，把行读进日志这个代价是划算的。对于用户接下来一直在要的东西，这个代价是不划算的——他们要的是自己本来就在用的那个页面。

**一次取行是一张快照，人们想要的是那个页面。** `toy.table` 画的是某一次调用取回来的东西。要翻页，模型得再调一次。要重排序，模型得再调一次。要收窄，用户改筛选条、提交到智能体、智能体再调一次——每一次交互一个回合，每一个回合一张新的审批卡片，每一次都重新取一遍这个人的数据。部署本来就带着一个在浏览器里把这些全做完、一个回合都不用的页面，跑在同样的表上、用同样的凭据；控制台却没有任何办法把它摆到人面前。

**而且宿主取回来的每一行都是会话日志里的一行。** 一份填好的 spec 最大 65536 字节，每条在世条目一份，内容面板写的每一个检查点都要带上它。用 `dataSource` 翻一张宽表，等于每翻一页就把这个人的数据往持久日志里写一遍，而登出并不会清掉已经写下的日志。

那次为评估替代方案做的探针发现，客户的 `Crud.vue` 可以原样挂载，同时在原始源码里发现了四处缺陷：`crudCloudPermission` 调了一个内嵌桶文件上并不存在的 `axios.get`；`getCustomMode` 调了一个并不存在的 `crudService.getCustomerMode`；那个「发出去就不管」的前端事件日志一旦失败就是一次未处理的 promise 拒绝；以及 `crudUtil` 里一处打印已登录用户档案的 `console.log`。

## 决定

**把 `Crud.vue` 原样挂载成内容栏类目 `toy.crud`，并让它保留自己那层带凭据的请求层。** 数据是浏览器 → 部署，带着访客自己的令牌走的；这个类目下宿主什么都不读、不记任何一行，也从不在请求路径上。这正是全部意义所在：用户本来就熟的那个页面，在浏览器里做它本来就在做的事，其中没有一样东西经过会话日志。

**它由第二个工具包发出来，而不是靠重写任何东西。** `@sumomok/toy-crud-kit` 在工具包仓库里、挨着 `@sumomok/toy-surface-kit` 构建，出自同样那三个客户库，守同样的规矩：源码只读拷贝，改动只以补丁文件形式存在。有两条规矩让了步，每一步都写在那个包自己的 README 里。它的 `toy-comp` 垫片加宽到了 `Crud` 闭包所触及的七个深路径导入——正是这一点切掉了那三个 `main.js`，它们在模块求值时的 `Vue.use(Element, { size: 'small', zIndex: 2000 })` 会把共享运行时的默认值从面板上别的每一块内容脚下挪走——以及跟着它们的那份重复的 `theme-chalk` 导入。而「身份与令牌绝不进入组件层」变成了「组件自己不读任何存储、不读 cookie；凭据的使用收在 `toy-core` 的请求层里」，因为那层请求层就是要送的东西。执行这条规矩的门禁扫组件源码，并把八个确实要读凭据的 `toy-core` 文件冻成一份白名单。

**第一版是只读的，而且是两重只读。** 宿主在调用写下的东西后面铺开一份冻结的 `CRUD_READ_ONLY_PROPS`——所有写入、导入、导出的开关全部隐藏，菜单与卡片子树关掉，`isReadOnly` 打开，`type` 写死，`urlConfig` 为 null——而工具包的构建把六个写入对话框编译成了空桩，所以没有任何属性能打开一个。只读说的是表里的数据：这个页面仍然会写的东西是每次查询一条审计记录，记在「已知限制」里。模型能决定的是八个属性：`relatedMeta`、`metaLabel`、`conditions`、`matchMode`、`querySort`、`selectMode`、`isExpandQuery`、`isInitQuery`——其中七个到得了页面，因为 `metaLabel` 是卡片上的名字，止步于宿主。它们一个都不能从另一块里读，因为每一个都在用户要回答的那张卡片上，而卡片是在另一块能解析出任何东西之前就画出来的。

**用户在摆放时被问一次，走的是 data-source 那条路用的同一条缝。** 同一个服务、同一个 `allowed-once`、同一个顺序——先把整次调用判完，再问，再记，最后才画：

```
用您的账号打开「图层配置」的完整数据页，可以在里面查询、翻页、排序；小助手看不到表里的内容，只会知道有哪些列、每次查到多少条，以及您点到的那一行。
数据表：SpaceLayer
```

那个标识符写在自己一行上，也画在自己一行上：审批面板把理由里的换行画出来而不是折掉，改的是 `ui-approval` 里的一行 CSS，取行那张卡片在同一处一起修好。预设的筛选条件在第一行里只报个数、从不显示，因为条件的值是模型写的文本，页面自己一个字都不画。这条路与取行那条路的不同之处在于：**在回答之前，没有任何人请求过任何东西**——宿主没有，因为这个类目它从来什么都不请求；浏览器也没有，因为那块内容还没上屏。被拒时什么都不画。用户随后在页面里跑的查询不再问任何人；页面一旦打开就是他的，卡片承诺的就是这件事。

**调用自己的 `tool/call` 不记条目。** `recordsEntry` 把带数据页的 spec 同时挡在抽取器和不变式伴生之外，所以条目是工具在回答之后追加的那条 `content-component/resolved`，在那之前什么都不是。从调用里画出条目，等于在问题被回答之前就把页面推上屏——连同它第一个带凭据的请求——而且被拒之后还留在那儿。同理，部署写的视图也不能摆一个：侧栏上的一次点击谁都没问，所以这样的视图在加载时按 id 被拒掉。

**给模型的回音是列和计数，绝不是行。** 三份读数经现成的 content-component 动作通道离开这块内容，档位都是 `context`，不新增任何会话事件类型：`load` 说出这张表和页面查询方案画出来的前 20 列；`query` 带的是命中的总数、显示的行数、第几页；`cell-click` 带的是被点的那一列和那一行画出来的各格，与 `toy.table` 上报选中行是对称的。同一次调用里，与某块内容上次上报过的完全相同的 load 或 query 不会再报一遍，所以切换标签页把这块内容拆掉重画，不会把同一件事说两次。这些读数里的每一个列头都来自部署自己的方案，所以关于它的两份说法——通知与摆放调用的结果行——都经同一个函数把它读回成一行。

**摆放它的那次调用还在等的那份 load 报告，落进那次调用的结果行，别处都不去。** 调用最多等 `crudLoadTimeoutMs` 让某个浏览器报上来；`PendingLoads` 是一次性落定的，等待中的调用取走的报告不会再作为通知投递，所以智能体正好读到一次。这张表先按会话、再按条目 id 索引，因为一个插件实例服务着控制台跑着的每一个会话，而条目 id 是模型自己起的字符串：两段对话里的 `layers` 是同一个字符串、两个不同的页面，一份报告属于发出它的那个席位所在的会话。同一个会话里，后一次调用的等待者会顶替同名条目上前一次的，而每次调用只撤自己那一个，所以顶替了条目的那次调用照样收得到它这一页的报告。超时那句话说明了后面还会有什么——页面加载后列与计数会以通知的形式到——因为一个只被告知「没人报上来」的模型会再摆一次，把同一个问题再问用户一遍。

**基础路径是一个经过校验的 `Config` 字段，而且在页面能请求任何东西之前就已生效。** `toy-core` 在它自己的模块求值时读一次 `window.$toy_env.VUE_APP_BASE_URL`，而那个模块正是随组件行的浏览器产物一起求值的——宿主没有任何时刻能赶在它前面把值写进去。于是这一行的 node 半边把 `bizBasePath` 放在 `/component-kit/settings` 上，浏览器半边启动时读一次交给工具包的 `setBizBasePath`，由它同时改写那个已被捕获的默认值和活着的那个请求实例，而 `CrudRenderer` 在这次读落定之前什么都不挂载。这个值是一条路径，仅此而已；node 半边在加载时判一次，浏览器半边在它过了进程边界之后再判一次。光读这个字符串不够：浏览器那套 URL 解析器在特殊协议下把 `\` 当 `/`，于是 `/\host/` 指的是另一个源；它还会把百分号编码的点段归一掉，于是 `/%2e%2e/api/` 请求的不是字面写的那条路径。所以两边都拿同一套解析器把规范化后的值对着一个探测源解一遍，origin 与路径没有原样回来就拒收。

**页面往 `document.body` 上追加的一切都被收进这块内容自己的盒子里。** `containCrud` 标记盒子、把它变成定位祖先、把 `nprogress` 指向它，并把 body 上的 element-ui 提示搬进来；tgz 自带 `toy-core` 那两个 loading 与 message 辅助模块的副本，`$notify` 按实例覆盖，于是方案取失败时那条通知画在块内。tgz 送出来的每一条 CSS 规则都在构建时按盒子自己的属性选择器加了前缀，`theme-chalk` 不再送第二份，而装载这个包之后 `$ELEMENT` 仍是 `{ size: 'small', zIndex: 300 }`。

**探针发现的四处缺陷里，两处打了补丁，两处记录在案。** `0005` 去掉打印已登录用户的 `console.log`；`0006` 给那处前端事件日志补上 `.catch`，它的拒绝本来没有任何人接。`crudCloudPermission` 和 `getCustomMode` 这两处在只读页面里是死代码——一处要 `useCloudPermission`，另一处根本没有调用点——所以按「补丁是一份维护义务，一份够不着的补丁什么都换不来」这条既定规矩，它们连同各自的触发条件记在工具包的 README 里，而不打补丁。

**请求层不从地址栏里取凭据。** `0007` 切掉 `toy-core` 的 `getToken` 与 `getToken4a` 里读 `?token=` 与 `?token4a=`、再把读到的写进 `accessToken` 的那两处分支——`accessToken` 正是 `auth-gate` 用来读回「已登录的这个访客」、并镜像进反代转发的那个 cookie 的键。那两处分支属于部署自己的登录页：它把新令牌交给自己重定向过去的那个应用；控制台不是那个页面，所以它地址栏里的 `token` 只可能来自别人给的一条链接，而一个已经登录的访客打开这样一条链接，存着的凭据会被这一块内容的第一个请求换掉，之后每个请求都以被塞进来的身份留下审计。和那两处死代码不同，这一处在每次挂载的路径上，所以是打补丁而不是记录在案；工具包的第 11 条门禁现在也拒收任何还从 URL 里取 token 的闭包。

### 判据表 —— 把部署自己的页面开进面板

| 格 | 内容 |
|---|---|
| **0 —— 哪条已定原则本来就说了不** | 「模型可见 ⟺ 已记录」是三份读数只做归约而不带行的原因：智能体能看到这个页面的一切，都可以从命令注册表本来就记着的那些动作文档里还原，而这个页面别的部分对模型都不可见。「插件里不写死可调项」把基础路径和加载期限做成了 `Config` 字段而不是常量，同时把上报的各项上限留作两边一起编译的协议常量。「配置错误要在加载时大声失败」是那个不是路径的基础路径、以及为零的期限都在加载时按字段名抛错的原因。「包边界上显式优于隐式」把那些只读属性放进工具包导出的一份冻结记录里、铺在模型那份后面，而不是在渲染器内部一处属性一个 `??`。 |
| **1 —— 新碰的东西：8** = 0 + 1 + 1 + 1 + 3 + 0 + 1 + 1 | 数据源 **0**（这个类目下宿主什么都不读）；UI 面 **1**（内容栏里的 `toy.crud`）；工具或参数 **1**（一个目录组件和它的八个属性）；路由或 RPC **1**（`/component-kit/settings`）；`Config` 字段 **3**（`crud`、`crudLoadTimeoutMs`、`bizBasePath`）；事件类型 **0**（`content-component/resolved` 与现成的动作通道就能承载）；审批闸 **1**（摆放时一张卡片，走现成的缝）；依赖 **1**（内嵌的 `@sumomok/toy-crud-kit` tgz）。 |
| **2 —— 能证明它的最小版本** | 模型摆一个页面。卡片在屏上，而桩后端一个请求都没见过。点了允许之后，页面用方案自己的表头画在块内，`#is-loading-full-overlay` 与 `#nprogress` 从不出现在块外，一个写入按钮都不画，点一个格子会作为一个动作到达模型。在真实浏览器里，对着构建产物。 |
| **3 —— 做成缝还是写死** | **审批做成缝，页面的一切写死。** 那个问题走的是取行用的同一个审批服务，所以按自己方式答审批的部署，答这一个也是自己的方式。页面就是这家客户库里的 `Crud.vue`、它是只读的、回来的正好是三份读数——这些是写死的：这样的页面只有一个，为它而设的部署也只有一个，第二条规矩需要第二个部署来撑。复核触发条件是第二家客户想把自己的页面摆进面板。 |
| **4 —— 每个方向一行** | *邻居*：某一份目录里多一个组件；不新增会话事件、不新增命令、不新增服务。*契约*：回答之前没有任何人请求过任何东西，而卡片只照着这次调用画。*诱惑*：不去轮询挂载好的页面找一个它并不 emit 的选中态，也不为了「给卡片配个标签」在宿主侧读一次。*红线*：没有 `allowed-once` 页面就不开，而调用自己的记录不画任何条目。*天花板*：页面在没有令牌或被答 401 时会把整个窗口导航走，这只有在认证闸后面才可接受。 |

## 考虑过的其他方案

**用目录里的块把这个页面拼出来。** 按代价、以及拼出来仍然不是那个东西，否掉。零件都在——一条筛选条、一张表、翻页做成反复调用——但每一次交互都变成一个模型回合，每个回合一张新卡片，每一页行都是这个人的数据在持久日志里的又一份副本。用户拿到的会是一个更慢、更弱的仿制品，仿的还是他本来就熟的页面，而控制台还要从零开始拥有它的 bug 历史。

**用 React 重写 `Crud.vue`。** 按前一份工具包为自己那些组件记下的同一个理由否掉，只是规模更大：这个页面通篇直接写 element-ui，还把请求层、方案读取和查询构造一起带着。重写等于把客户已经付过账的 bug 历史重来一遍，而且他们的页面下次一变就得再来一遍。

**让宿主代理页面的请求，把凭据留在服务端。** 否掉。那会把每一次查询的每一个格子重新塞回宿主——而这整个类目存在的意义正是躲开这笔代价——而且那样一来读它们的就是宿主，卡片就得这么写。从浏览器同源发出去，才是卡片上那句承诺成立的原因。

**按每次查询问，而不是在摆放时问一次。** 否掉：跑那些查询的人就是用户本人。一次查询一张卡片，等于请一个人为自己敲的字审批一次；而他真正同意的那件事——这个页面、这张表、以他的身份打开——是一个摆放时的事实。

**为页面的读数新增一个会话事件。** 否掉：命令注册表本来就把每一份动作文档原样记成 `command/run`，而那三份读数正是动作文档。新增事件等于给一条已经存在的记录再做一份持久副本，`SESSION_FORMAT_VERSION` 保持不动。

**在工具包模块求值之前由宿主写 `window.$toy_env`。** 否掉的理由是做不到而不是不想做——工具包模块是随这一行的产物一起求值的，浏览器半边里没有更早的时刻。事后用 `setBizBasePath` 把路径打上去、并把挂载卡在它上面，才是让这个先后次序可被证明的做法。

**那两处死代码还是打上补丁。** 否掉：在只读页面里两处都够不着，而一个补丁文件是一份维护义务，tgz 每次重建都要重新打一遍。改为连同触发条件记录在案。

## 后果

**买到了。** 用户拿到部署自己那张表的完整页面，以他自己的身份打开，查询时不再一次交互一个模型回合。智能体知道这个页面在显示什么——这张表、它的列、每次查询的计数、用户点到的那一格——而没有一整页的行进对话或会话日志。一次查询报的是三个计数；唯一会离开页面的行，是用户点到的那一行画出来的那些格子，一次点击一行，它们确实会原样到达智能体和 `command/run` 的记录里。这个类目下宿主一个请求都不发。

**付出了。** 一份 256 KB 的内嵌 tgz，带一份手写、没有编译期背书的 `.d.ts`，其源码没有可供比对的上游历史，里面还编进了四十个第三方 npm 库——这个仓库的 manifest 与 lockfile 里都没有它们的名字，所以由 tgz 自己声明，`THIRD_PARTY_NOTICES.md` 从那份声明生成；连同它没编进去、只有 tgz 自己的 manifest 才写着的那两个。它是静态 import 的，所以不管部署有没有开这个功能，每一个控制台都要下载这个 878 KB 的页面，以及它底下 553 KB 的 `lodash` 与 `dayjs`。一个在令牌缺失或被拒时能把整个控制台导航走的页面。在没有浏览器接入的组合里开页面的调用，要付满整个加载期限。用户跑的每一次查询，都会以他自己的身份在部署的后端写下一条持久的审计记录，里面带着模型写的隐藏条件，而卡片没有提这件事。以及第二个要与第一个保持同步的工具包。

**证据。**

| 主张 | 证据 |
|---|---|
| 卡片在任何后端请求之前就出现，而被拒时什么都不画 | `apps/web/tests/component-surface-crud.e2e.ts`，卡片在屏上时桩后端一个请求都没见过；`packages/experimental/component-surface/tests/crud.client.spec.ts` —— 「records nothing and draws nothing when the user refuses」 |
| 点了允许之后页面用方案的表头画在块内，遮罩与进度条从不离开它 | 同一个 web 场景，以及 `.artifacts/web-e2e-component-crud-*.png` |
| 一个写入按钮都不画，任何对话框都打不开 | `packages/experimental/component-kit/tests/crud-renderer.client.spec.tsx` —— 「draws a read-only page: the query and clear buttons beside the pager, no write button, no dialog」，它把这块内容画出来的每一个按钮都列了出来、只有图标的也算；工具包自己的构建把六个写入对话框编译成了空桩 |
| 宿主写死的属性盖过调用写的任何东西，别的属性一个都到不了页面 | `packages/experimental/component-kit/tests/crud-read.client.spec.ts`；`crud-renderer.client.spec.tsx` —— 「hands the page every property a call may choose, and nothing it may not」 |
| 装载这个包之后，共享运行时的 element-ui 默认值还在这一行设的地方 | `crud-renderer.client.spec.tsx` —— 「requests its table under the configured base path with the token the page carries, inside a contained box」在页面挂载后断言 `$ELEMENT` 是 `{ size: 'small', zIndex: 300 }`；安装本身归 `element-ui.client.spec.ts` |
| 没有任何请求是按内置基础路径发出去的，而每个请求都带着访客自己的令牌 | `crud-renderer.client.spec.tsx` —— 「mounts nothing before the base path is in force」与「requests its table under the configured base path with the token the page carries, inside a contained box」；web 场景对着活桩把两件事都验了 |
| 控制台自己地址栏里的令牌，既上不了线，也改不了访客存着的凭据 | `crud-renderer.client.spec.tsx` —— 「sends the stored token and leaves it stored, whatever token the page URL carries」；工具包的补丁 `0007` 切掉了读它的那两处分支，第 11 条门禁拒收任何还读它的闭包，探针则把产物挂在一个带着它的地址下 |
| 基础路径在加载时判一次、过线时再判一次，坏值让这一行大声失败 | `packages/experimental/component-kit/tests/route.client.spec.ts`、`host-settings.client.spec.ts`、`crud-settings.client.spec.ts` |
| URL 解析器会解到别的源或别的路径上去的基础路径，两边都拒收 | `route.client.spec.ts` —— 「refuses a backslash form that a hand-written reading would let through」以及那四个会被解析器归一掉的用例；工具包自己的探针对 `setBizBasePath` 断言同一件事 |
| 调用还在等的那份 load 报告落进结果行、别处都不去；没人等的那份就是一条普通通知 | `packages/experimental/component-surface/tests/crud.client.spec.ts` —— 「puts a report the call is still waiting for into that call's result line, and nowhere else」、「delivers a report nobody is waiting for as a notice」 |
| 点一个格子会作为一个动作到达模型 | web 场景的第二个用例，它那句脚本回复只有在活请求里有那条通知时才写得出来 |
| 调用自己的记录不画条目，回答那条才画 | `crud.client.spec.ts` —— 「folds no entry out of the call's own record, and one out of the answer」 |
| 配置出来的视图不能摆页面，一次调用里的第二个页面被拒 | `crud.client.spec.ts` —— 「may not place the page, because a click asks nobody」、「refuses a second page in one call」 |
| 卡片的措辞、预设条件只报个数不显示，以及那行标识写在哪一行就画在哪一行 | `crud.client.spec.ts` —— 「asks in the user's own words, with the table's backend name written on its own line」、「counts the hidden conditions rather than showing them」；网页场景对着审批窗画出来的文本断言整张卡片，连那个换行一起 |
| 一份报告只落定发出它的那个席位所在会话里的调用；被顶替的条目，其报告到的是顶替它的那次调用 | `crud.client.spec.ts` —— 「leaves another session's call alone, even under the same entry id」、「gives a replaced entry's report to the call that replaced it, not to the one it replaced」 |
| 后端来的列头进结果行时是一行，跟它进通知时一样 | `crud.client.spec.ts` —— 「reads a backend header back on one line, the way a notice does」 |
| 画这块内容的那一行对自己设的每一条上限与字符集，都是这份目录对数据页声明的那一条，而这一行造出来的报告没有一份是目录会拒的 | `packages/experimental/component-surface/tests/catalog-actions.client.spec.ts` —— 「are the ones this catalog declares of the data page, value for value」，直接从三个动作自己的 payload 声明里读；以及 `catalog-actions.client.spec.ts:663` 的「are the numbers this catalog exports under its own names」，它钉的是其中六个值；`crud-read.client.spec.ts` —— 「reports an attribute the scheme draws twice once, under the header it draws first」、「leaves out a cell whose number is wider than a report carries, and keeps one at the edge」，还有总数超过报告上限的那一条查询用例 |
| 没写表名的块画它自己那条提示，而不是把页面开在空表上，也不是画那条讲地址的 | `crud-read.client.spec.ts` —— 「refuses a block that names no table rather than opening the page on nothing」；`crud-renderer.client.spec.tsx` —— 「draws the line saying the block names no table, rather than the one about an address, and waits on nothing」 |
| 页面正在被销毁的过程中，盒子还是盒子 | `crud-renderer.client.spec.tsx` —— 「keeps the box a box until the page has finished being destroyed」 |
| 编进内嵌产物的每一个第三方库都连同条款一起披露 | `THIRD_PARTY_NOTICES.md` 的「Third-party code bundled into vendored payloads」，由 tgz 自己的 `BUNDLED.json` 生成；`pnpm run verify-third-party-notices`；工具包第 15 条门禁会让一份带着无条款或无正文的库的构建失败 |
| tgz 只 import 而没编进去的那两个，和运行时那一档的其他库一起披露 | `scripts/gen-third-party-notices.spec.ts` —— 「reads what a payload leaves external, which its consumer's bundle compiles in」与「discloses, in the committed notices, what the vendored data page leaves external」；生成器读的是装好的载荷自己的 manifest，这里只有它写着这两个名字 |
| 模型被提供了什么，以及只有部署要了才提供 | `crud.client.spec.ts` —— 「lists the page and explains it only where the deployment asked for it」；整段描述在 `snapshots/console/show-chart-turn/tool-schemas.expected.json` 里 |
| 部署没开这个页面时就说没开，哪怕这次调用同时带着 `dataSource` | `crud.client.spec.ts` —— 「refuses a page beside a data source by name where the deployment does not offer the page at all」；把页面挪到单独一次调用里会被同样的话拒掉，所以给模型的就是这一条 |
| 模型看到的整个回合——提供、卡片、`allowed-once`、记录、结果行 | `snapshots/console/show-crud-turn/` |

`pnpm run typecheck`、`pnpm run build`、`pnpm run lint` 与 `pnpm run doc-sync`（33 道门禁全过）全绿。`pnpm vitest run --coverage` 跑 `packages/experimental/component-kit` 与 `packages/experimental/component-surface`、范围限定在它们自己的 `src`：46 个文件、904 个用例，每个文件的行、语句、函数、分支都是 100%。`pnpm run test:snapshot snapshots/console`：19 个用例，含 `show-crud-turn`。`pnpm vitest run --config vitest.web.config.ts apps/web/tests/component-surface-crud.e2e.ts` 对着构建产物跑：三个用例。

## 已知限制与未尽事项

- **页面在手里没有令牌、或者被答 401 时会把整个窗口导航走。** `toy-core` 的请求拦截器把浏览器送去部署的登录地址，控制台跟着一起走——这个页面是画在外壳里的，不在自己的框架里。记录在案，不修；只有在这个类目面向的同源部署里才可接受，那里认证闸会在每个请求前面把令牌保持新鲜。不带那道闸就打开 `crud` 的部署，是接受了一个能把用户从对话里导航走的控制台。
- **加载遮罩和进度条是模块级单例。** `containCrud` 把两者都指向最后登记的那个盒子，所以屏上同时有两个数据页时，一个页面的加载态会画进另一个页面的盒子里。一次调用一个页面是强制的；两次调用照样能在列里留下两个条目。
- **提示收纳假定页面上每一条 element-ui 提示都是这个工具包的。** 那个接管 body 上 `.el-message` 与 `.el-notification` 的观察器不问是谁弹的。
- **选中态到不了智能体。** 页面能勾选行，而勾选变化时它什么都不 emit。要读它就得按定时器轮询挂载好的实例；v1 不做，重启这件事的触发条件是有用户真需要那些勾选有意义。
- **七个查询控件是禁用的替身，** 跟前一份工具包里一样，所以查询没法按关联属性收窄。**图标画成空框，** 因为没有送图标字体；只读页面里一个都看不见。
- **`crudCloudPermission` 与 `getCustomMode` 是故意留着坏的。** 两处在只读页面里都够不着——第一处要 `useCloudPermission`，第二处根本没有调用点。触发条件记在工具包的 README 里，不先打补丁就去碰任何一处都会抛错。
- **工具包的类型是对着一份 JavaScript 构建手写的，** 所以构建出来的组件自身属性一旦漂移，这边照样编译通过，等画这块内容时才炸。
- **`load` 报的表不是这块内容自己那张时，它谁都不报，而且会在屏幕上说出来。** 同一条目 id 下更晚的一次调用就是另一张表的页面。它不是沉默：命令答给座位的是 这个动作没能记下来。，聊天行把这句拒绝画出来——为一个用户根本没做过的手势，画在一个正开着、也在正常工作的页面旁边。窗口很窄，代价是一行看起来不对的话，而不是给智能体的一句错话。
- **每一次答完的查询都会在部署的后端写下一条审计记录。** `Crud.vue` 每次查询后调 toy-core 的 `crudEventLog`，它带着访客自己的令牌 POST `<bizBasePath>/nrms-resourcehistory/api/log/frontevent/`：`app_enname` 是控制台自己的路径，事件是 查询，还有表名，以及这次查询的参数——模型写下的隐藏 `conditions` 也在里面——作为事件数据。这是部署自己的前端审计流水，以访客的身份写下，而卡片和卡片上的承诺都没有提它。记录在案，不修：这与部署自己那个页面拿同一份凭据做的事一样，要压掉它就得在页面挂载前顶掉 `core/log` 的那个出口。**触发条件是有部署不愿意让控制台里的查询进那条流水。**
- **页面会在浏览器自己的存储里留下三个键，退出登录只清掉其中一个。** 挂载一次、查询一次就会写下 `localStorage.userInfo`——`toy-core` 取回来、再用它自己的 `setUserInfo` 存回去的访客档案，记录的 `token` 字段里逐字带着那枚令牌——外加两条 localforage 记录：`localforage//console/_schemaall_<meta>` 放着部署给这张表的查询、新增、修改三套方案，`localforage//console/_meta_<meta>` 放着它的属性字典。三个键都是 jsdom 探针对着内嵌产物记下来的；真浏览器里那两条 localforage 记录进的是 IndexedDB，不是 `localStorage`。写下它们的都是页面自己那层请求层，不是宿主代码。`userInfo` 已经在 `server-sidebar` 的退出键表里，访客退出时会被清掉；那两条 localforage 记录不在表上，会留下来，于是在共用的机器上，一张表的方案和字典活得比这次会话长。记录在案，这里不修：清空 localforage 那个数据库该做在 `server-sidebar` 的退出流程里、挨着它已经有的那张键表，这次改动没有碰它。**触发条件是共用机器上的控制台——上一个访客的表长什么样，下一个访客读得到。**
- **在没有浏览器接入的地方开页面，要付满整个期限，** 每次这样的调用付一遍。ACP 快照泳道正因为这个把它设成一秒。
- **不管部署有没有开这个功能，每一个控制台都要下载这个内嵌页面。** 878 KB（gzip 后 222 KB）躺在这一行的浏览器包里，加上 tgz 只 import 而没编进去的 `lodash` 与 `dayjs` 的 553 KB（gzip 后 100 KB），每次启动都下，包括默认的 `crud: false`。记录在案，不修：一个插件的浏览器包就是加载器按名字取的那一个闭包工厂文件，动态 `import()` 没有第二个分块可落，就算落了也没有人去取。要推迟这个页面，得让每个插件能有第二个可取的产物，那是加载器的改动。**触发条件是有部署以 `crud: false` 跑控制台并量到启动代价。**
- **工具包的构建不是逐字节可复现的。** 同一棵树连着构建三次给出两份不同的产物，差别只在压缩器给局部符号起的名字上；`FormItemComp.vue` 对 `DisabledInputStub.vue` 同时有静态与动态 import，vite 每次构建都会报这一条。行为上没有任何差别，但重跑一次构建对不出某个 tgz 的 sha256，所以记下来的哈希只是那一次打包的哈希。
