---
description: "把控制台的 MCP 能力挂一次、且不带任何服务器，使部署方通过写明端点与凭据名称来接入外部 MCP 服务器，而不必交付代码。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-console-mcp

[English](README.md) | 中文

## 概述

`dsh-experimental-console-mcp` 是控制台组合始终携带的那一行，作用是让接入外部 MCP 服务器成为部署方的决定而非构建的决定。它接受一份清单——每一项由一个端点和一个凭据的**名称**组成——并为每一项挂载一个 [`dsh-mcp-client`](../../mcp/mcp-client/README.zh.md) 桥接。空清单就是出厂交付的常态：该行照常加载，不建立连接，不注册任何工具，也不向任何模型请求添加内容。控制台的终端用户无法添加服务器，因为这一行读取的任何内容都不来自他们能打开的页面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

控制台 bundle（[`cordis.patch.yml`](../console-profile/cordis.patch.yml)）已经以 `servers: []` 挂好了这一行。需要接入 MCP 服务器的部署在自己的层里给这份清单打补丁，其余不动。

### 写明一个服务器

```yaml
- id: console-mcp
  name: '@deepseek-ai/dsh-experimental-console-mcp'
  config:
    servers:
      - id: iot
        url: https://mcp.example.internal/mcp
        auth:
          header: Authorization
          credential: IOT_MCP_TOKEN
          scheme: 'Bearer '
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `servers` | `[]` | 服务器清单，按书写顺序。空清单即能力已挂载且处于空闲。 |
| `servers[].id` | 必填 | 该服务器的工具命名空间：其工具以 `mcp__<id>__<工具名>` 抵达模型。须匹配 `[A-Za-z0-9_-]{1,32}`，且在清单内唯一。 |
| `servers[].url` | 必填 | 绝对的 `http`/`https` Streamable HTTP 端点，不得携带用户信息与 fragment。 |
| `servers[].auth` | — | 每个请求携带的凭据；端点无需凭据时省略。 |
| `servers[].auth.header` | 必填 | 凭据所花费的请求头。 |
| `servers[].auth.credential` | 必填 | 凭据**引用**——一个环境变量名，绝不是值本身。 |
| `servers[].auth.scheme` | `''` | 置于解析出的值之前的文本，例如 `Bearer `。 |
| `servers[].toolCallTimeoutMs` | 桥接自身的默认值 | 单次工具调用的超时毫秒数。 |
| `servers[].failOnStartupError` | 桥接自身的默认值 | 首次连接失败是否令启动失败。 |

### 秘密存放在哪里

`credential` 写的是秘密的名字，而不是秘密本身。[凭据缝](../../credentials/credentials/README.zh.md)会用组合所携带的提供方去解析这个名字——出厂提供方读取 `$DSH_HOME/.credentials.yaml`、进程环境以及 `.env` 文件。因此这份组合文件可以流转、可以 diff、可以被诊断信息引用，而始终不携带那个值。

若引用的名字下没有存过值，该行会在加载时失败，并只点出引用名、不点出值：

```
console-mcp: server "iot" names credential "IOT_MCP_TOKEN", which nothing has stored a value for
```

### 请求被识别为谁，有两条路

经由 `auth` 抵达的服务器，是以**本部署自己的服务凭据**抵达的——对所有使用控制台的人都是同一个身份。若该请求应当携带已登录访客本人的令牌，则把 `url` 指向 [`auth-gate`](../auth-gate/README.zh.md) 的转发路由，并且不写 `auth`：

```yaml
- id: auth-gate
  name: '@deepseek-ai/dsh-experimental-auth-gate'
  config:
    mcpUpstreams:
      iot: https://mcp.example.internal/mcp
    # …

- id: console-mcp
  name: '@deepseek-ai/dsh-experimental-console-mcp'
  config:
    servers:
      - id: iot
        url: !!js `http://127.0.0.1:${process.env.DSH_PORT}/auth-gate/mcp/iot`
```

网关会把 `Authorization` 换成浏览器投递的那个令牌，于是写入落在提出要求的那个人名下。两条路的差别在于服务器记录下的是谁的身份，所以这个选择属于组合部署的人，而不属于这一行的默认值。

### 什么会失败，以及在什么时候

凡是一份组合文件自身就能判定的，都在该行加载时抛出，并且整份清单被拒绝、而不是丢掉出问题的那一项——一个悄悄跳过了某个服务器却照常启动的控制台，是一个让运维以为它接着某个服务器的控制台。这包括：id 不符合命名空间文法、两项声明同一个 id、url 不是绝对 `http(s)`、url 携带用户信息或 fragment、header 名不是合法的头名、凭据引用不符合引用文法。唯一需要服务参与的检查——所点名的引用是否存有值——紧随其后，在同一次加载中完成。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内情——点击展开</summary>

### 为什么是一行，而不是每个服务器一行 `dsh-mcp-client`

`dsh-mcp-client` 每行恰好一个服务器且要求 `serverName`，因此一个不接任何服务器的组合根本写不出任何一行——于是"能力缺席"与"能力在场但未配置任何东西"变成了同一份文件。控制台需要区分这两者：组合的承诺是 MCP 已挂载，而部署的贡献仅仅是那份清单。一行加一份清单正好表达这一点，且空清单是部署方看得见、可编辑的值，而不是一行它必须知道要去补上的配置。

第二个理由是凭据。`dsh-mcp-client` 的 `headers` 是字符串表，于是今天的组合要靠 `!!js process.env.X` 取到秘密——一个在加载时求值的表达式，其失效方式是某个请求头悄无声息地什么也没带。改为点名一个引用，就把这次读取移到了凭据缝上，在那里"没有值"是一条会点名它的诊断。

### 请求与规格

[`src/servers.ts`](src/servers.ts) 是 `resolve(request): Spec` 这一步：所有自足的检查都在那里、针对整份清单完成，早于 `apply` 触碰任何服务。随后 [`src/index.ts`](src/index.ts) 逐项解析凭据，并为每份规格挂载一个子 `ctx.plugin(mcpClient, …)`，且逐个 await——桥接会在激活返回之前发布它的第一代工具，因此控制台的第一个回合看到的就是它将一直持有的那份工具册。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 模式、凭据解析、逐服务器子挂载 |
| [`src/servers.ts`](src/servers.ts) | 自足检查，以及它们产出的 `ServerSpec` |

### 只支持 Streamable HTTP

stdio 服务器是宿主启动的本地程序，位于本产品施加的一切沙箱之外，以运行宿主的那个账户身份运行。这是一个实打实的部署决定，而它不该由"在服务器清单里加一行"来做出——所以这一行不提供它。确有需要的部署直接组合 `dsh-mcp-client`，并显式地为那个选择负责。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [MCP 客户端桥接](../../mcp/mcp-client/README.zh.md)——这一行所挂载的命名、工具执行、重连与结果约定。
- [凭据缝](../../credentials/credentials/README.zh.md)——引用是什么，以及哪些层解析它。
- [身份网关](../auth-gate/README.zh.md)——逐访客令牌转发，供必须记录登录者本人的服务器使用。
- [服务台侧栏](../server-sidebar/README.zh.md)——交付这一行的控制台组合。
- [实验性包](../README.zh.md)——孵化状态与发布排除。

-----

<a id="model-experience"></a>
## 模型体验

### 桥接过来的 MCP 工具

#### 模型看到什么

清单为空时什么也看不到——这一行不贡献任何工具、任何提示段落、任何会话事件。对每个已配置的服务器，模型看到的恰好是 `dsh-mcp-client` 所注册的：该服务器公告的每个工具，名为 `mcp__<id>__<工具名>`，带着服务器自己的描述与入参模式。

#### Token 影响

清单为空时为零。否则，只要服务器处于注册状态，其公告的每个工具的描述与模式都会进入每一次请求——这一行不做任何过滤，因此一个公告三十个工具的服务器每回合就要花掉三十份定义。

#### KV Cache 影响

在已配置集合与各服务器公告清单不变期间，前缀稳定。向清单添加服务器，或某个服务器重新公告了变更过的工具，都会替换定义，并可能从第一个变化的模式 token 起使复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **凭据只在加载时读取一次。** `dsh-mcp-client` 在其行加载时解析请求头，因此这一行交给它的值在该进程内是固定的。在同一个名字背后轮换秘密，要到重新加载后才抵达服务器——这与凭据缝自身"每次操作重新解析"的规则不同，而这一行无法透过字符串请求头表兑现那条规则。
- **工具描述原样来自服务器。** 这里不改写、不筛查，因此服务器可以透过描述把指令摆到模型面前。
- **不支持逐工具挑选。** 已配置服务器公告的每个工具都会被注册。公告了超出部署所需的服务器，应当去少公告一些；这一行不提供白名单。
- **仅 Streamable HTTP**——见[理解实现](#understand-the-implementation)。
- **该能力不区分人。** 一个控制台进程服务于其部署放进来的任何人，而经由 `auth` 抵达的服务器记录的是本部署、不是那个人。要让请求携带访客本人，靠的是 auth-gate 路由。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

- 逐工具挑选、以及一份由人确认并持久化的工具集合，存在于仓外的 `@haoran/dsh-mcp-servers`，它为桌面端以设置文档驱动同一个桥接。那套设计在此刻意不复用：它的全部表面就是一个设置页面，而控制台的终端用户不该有这样一个页面。
- 控制台的 `failOnStartupError` 是否应当默认为 true——毕竟点名了服务器的部署多半是打算接上它——尚未定论；目前沿用桥接的 `false`。

</details>
