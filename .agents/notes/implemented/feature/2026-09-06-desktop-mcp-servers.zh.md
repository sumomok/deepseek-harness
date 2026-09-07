# Agent Note: MCP servers are added from the desktop's settings page

Status: implemented

[English](2026-09-06-desktop-mcp-servers.md) | 中文

## Problem

harness 自带一个 MCP 客户端 [`@deepseek-ai/dsh-mcp-client`](../../../../packages/mcp/mcp-client/README.zh.md),而桌面端用不上它。它按每台服务器一条编排条目工作,条目写在一个 YAML 文件里,下次重启才生效;连上之后,服务器列出的每个工具都直接注册到 `ctx.tools` 上。这个应用面向的人不开终端,所以他们根本加不了服务器;而只要服务器提供了某个工具,一个没人读过的工具就会立刻进入之后的每一次模型请求,包括那些描述在被人看过之后又被服务器改写的工具。

## Decision

`@haoran/dsh-mcp-servers` 0.1.2 加入 [`apps/desktop/README.zh.md`](../../../../apps/desktop/README.zh.md) 所列的桌面内置插件,以 `apps/desktop-server/vendor/haoran-dsh-mcp-servers-0.1.2.tgz` 的形式 vendor 进来(sha256 `e865341b97ea38d5966666b578bc4b823a4a04c01d1fc56b50c3b37a548d4751`)。它是 `dsh-plugins` 工作区里的仓外包,与其他内置插件一样,只以那个 `pnpm pack` 归档抵达载荷。

它改由设置文档驱动上游客户端,而不是由编排驱动,并在其前面摆了三个回答。把服务器存下来就是同意连它:第一次连接会把它实际提供的那一组工具记成受信的那一组,这个指纹没人能手打出来,因为只有连上的服务器才说得出自己提供什么。这份记录会带着读到它时的那个修订号写回去,所以它落地期间有人在设置页做的修改不会被覆盖:这次写入会在更新的文档上重建,或者放弃。已存的服务器同时带着有人确认过的那个目的地的指纹——命令、参数、工作目录、环境变量,或 URL 与请求头——其中任何一项改动都会停掉这台服务器并重新发问。服务器提供的那组工具发生变化则不停它:连接继续保持,只扣住其中变过的和新增的工具,已勾选、服务器没动过的工具照常可用。工具只有在它当前的名字、描述与入参 schema 被勾中之后才会被注册;服务器改写了某个工具的措辞,该工具就退回待勾列表,于是它离开的是模型看到的 schema 列表,而不只是让它的下一次调用失败。没有存下任何服务器时,这个插件不注册任何工具、不启动任何进程,也不往任何请求里加任何东西。

设置页的小节叫「外部工具」(**External tools**)。保存一台服务器就会连上它:那一行先显示**连接中**,再显示**已连接**,并列出可勾选的工具。只有目的地被改过、或者服务器改了它提供的工具之后,那一行才显示「等待确认」(**Waiting for you**),而且这两种各用各的说法发问。目的地被改过,就把目的地写明,并说明那个程序会用这台电脑自己的账号、在沙箱之外运行,由「确认并连接」(**Confirm and connect**)作答。工具组变了,就不再显示这两句,因为目的地就是已经受信的那个,由「确认这些工具」(**Confirm these tools**)作答。stdio 服务器的程序必须用完整路径指名,因为一个裸名字会对着应用碰巧启动于哪个目录去解析。

### `@deepseek-ai/dsh-mcp-client` 为什么进 desktop-server 清单

这个插件的 host 那一半导入该客户端,并按每台服务器用 `ctx.plugin(McpClient, …)` 挂载它。仓外插件里的 `@deepseek-ai/*` 导入是 peer:它对着运行中安装目录自己的依赖闭包解析,而不是装在插件旁边。profile 的扁平模块兜底目录由 `resolveModuleFallbackEntries` 建出([`packages/boot/app-boot/src/profile.ts:497`-`:531`](../../../../packages/boot/app-boot/src/profile.ts)),它从安装锚点出发,对沿途每份清单的 `dependencies` 与 `peerDependencies` 做广度优先遍历,所以闭包里没有任何清单提到的包永远不会被链接进 `$DSH_HOME/profiles/node_modules`,该插件也就加载失败。把 `@deepseek-ai/dsh-mcp-client` 列进 [`apps/desktop-server/package.json`](../../../../apps/desktop-server/package.json) 正是让它进入这次遍历的做法,`pnpm deploy` 随后会把它与其余部分一起带进载荷。

### 在 bundle 栈里的位置

这个名字追加在 `BUILTIN_WEB_BUNDLES`([`apps/desktop/src/profile-seed.ts`](../../../../apps/desktop/src/profile-seed.ts))里 `@haoran/dsh-default-model` 之后、`@haoran/dsh-btw` 之前。除了两层 patch 同一个条目 id 的情况,层与层之间的顺序不决定任何事:`@haoran/dsh-default-model` 替换掉 `agent-default-model` 与 `llm-deepseek` 两行的整个 `config`,所以其后的层不得再瞄准这两个 id,而本插件的 `cordis.patch.yml` 只在 `mcp-servers` 这个自有 id 下插入一行,没有别的层设置它。`product/server-console` 线上的 `feat/desktop-content-search` 分支追加了 `@deepseek-ai/dsh-desktop-app`,那边要求它留在末位;两条分支合到一起时,那个名字排在本列表所有名字之后。

### 挂上它,桌面端让出了什么

**stdio 服务器跑在沙箱之外。**子进程由 MCP SDK 自己启动,不经过 `ctx.shell`,所以应用提供的任何沙箱模式都够不着它,它以使用这台电脑的那个人的账户与权限运行。保存这台服务器就是同意这件事,表单也因此要求填它即将启动的那个程序的完整路径。退出应用会停掉它,包括一个还在等人确认的连接。

**每个勾中的工具的定义都进入每一次请求。**工具定义不是按需加载的,所以勾中三十个工具,每一轮就要付出三十份名字、描述与入参 schema。

**审查模型会审每一次 MCP 调用。**`@haoran/dsh-llm-permission-gateway` 只跳过它 `readOnlyTools` 里点名的工具,以及有沙箱时 `walledTools` 里点名的工具;两份默认名单都没有 `mcp__*` 名字,而某台机器上会有哪些名字事先也无从知道——它们跟着这台机器装了哪些服务器走。两份名单都是 profile 层可以改写的纯字符串数组,所以想跳过某个特定 MCP 工具的部署可以把它点名写进去;这里没有任何一条是红线。所以在 `/review auto` 下,每一次 MCP 工具调用都要多一次审查调用;在 `/review manual` 下,这些调用则既没有审查也没有围墙。

**本仓库没有任何一道闸会真的拉起一台 MCP 服务器。**`verifyStagedBoot` 是对着一个用完就扔的 `$DSH_HOME` 启动载荷的,里面没有存下任何服务器,所以它证明的是这个插件能加载、能编排、能把浏览器那一半服务出去,仅此而已:没有 stdio 子进程被派生,也没有任何 Streamable HTTP 端点被访问。到那时传输层的代码甚至已经不是一个独立的包了——`bundleClosure`([`apps/desktop/scripts/bundle-closure.ts`](../../../../apps/desktop/scripts/bundle-closure.ts))只把 `@deepseek-ai/*`、声明了 `dsh.bundle` 的那些包,以及原生包名单当作 external,于是 `@modelcontextprotocol/sdk` 被内联进 `@deepseek-ai/dsh-mcp-client/lib/`。那份被内联的副本在打包后的应用里是否还能拉起进程、还能说这套协议,是一条真机验收项,不是这里的闸能回答的。

**工具描述是服务器自己的文字。**没有任何东西改写或筛查它,所以服务器可以把给模型的指令放进一段描述里,而人是读着那段描述批准的。

## Alternatives considered

**直接从桌面 profile 的 patch 层挂 `@deepseek-ai/dsh-mcp-client`。**这是更小的改动,也不引入新包。但它把「加一台服务器」留成一次 YAML 编辑加一次重启,而本产品的用户做不到这件事;而且服务器列出的每个工具都会被注册,没有任何人读过其中任何一个。

**让 Electron 壳用原生窗口来回答连接确认。**`ctx.approval` 绑定 agent、绑定回合:它只能在恰好有一个会话打开且正处在一轮之中时找到人,在这个窗口之外它拒绝作答,改由设置页发问。插件把这道缝留着——`confirm: approval` 与 `ctx.mcpServers.useConfirmer(...)`,后者不在 Remote 面上,因而无法从线上够到——出厂走的是 `confirm: settings`,已存的确认就是答案。

**改成在桌面 profile 自己的清单里声明 `@deepseek-ai/dsh-mcp-client`。**这些机器上没有包管理器,壳也从不执行安装,所以写在那里的依赖条目什么都物化不出来;被物化的只有载荷自己的闭包,而那正是 desktop-server 清单定义的东西。

**把这个插件收进 `packages/`、改用 `@deepseek-ai` 作用域。**fork 的规矩把仓外插件挡在工作区之外,只以 vendor 进来的 `pnpm pack` tarball 接纳它们,因为 `link:` 依赖会让编排里出现第二份 cordis,服务身份随之失效。

## Consequences

两份 README 表格与 notices 的 override 表都带上了新的一行,这是 [`verify-vendored-plugin-versions`](../../../../scripts/verify-vendored-plugin-versions.ts) 对每个 vendor 包在两种语言里的要求;分发了多少个插件这件事,住在 [`apps/desktop/README.md`](../../../../apps/desktop/README.zh.md) 的内置插件表里。

没有新增第三方归属条目:`@modelcontextprotocol/sdk` 经由 `@deepseek-ai/dsh-mcp-client` 自己的依赖进入载荷,`zod` 则经由它与该插件两边进入,而 `THIRD_PARTY_NOTICES.md` 里两者早已在列。

`apps/web/tests/shipped-composition.e2e.ts` 的 `EXPECTED_TOOLS` 名单原样不动,理由有两条且彼此独立:那个测试启动的是所分发的 Web 编排,里面没有桌面端 vendor 的任何插件;而且一个没有存下服务器的插件本来就不注册任何工具。

有两类从第三方指南里抄来的配置在这里不成立。以包名指名的服务器(`npx …`、`uvx …`)起不来,因为载荷只为自己的安装器把 Node 与 pnpm 放上 `PATH`,别的都没有;程序得先装好,再用完整路径指名。HTTP+SSE 端点没有对应的传输,因为上游客户端只说 stdio 与 Streamable HTTP。

## Related

[桌面安装包分发插件并把它们播种进自己的 profile](2026-08-21-desktop-builtin-plugins.zh.md) 拥有内置插件为何在载荷里、以及 profile 自己那份副本会怎样;[vendor 插件引用门禁](../process/2026-09-03-vendored-plugin-reference-gate.zh.md) 拥有让这一行与 tarball 保持一致的那些检查。
