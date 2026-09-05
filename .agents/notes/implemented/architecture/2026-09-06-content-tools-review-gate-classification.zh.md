# Agent Note: 内容区的读工具是被归类的，不是被判官判的

Status: implemented

[English](2026-09-06-content-tools-review-gate-classification.md) | 中文

## Problem

服务线控制台在每一次工具调用前都挂着 `@haoran/dsh-llm-permission-gateway`。装的是它 0.1.5 那一版时，内容区的读被拒了。是那一版的三个事实叠在一起造成的。

**不在表里的工具一律进判官。** 0.1.5 只有 `readOnlyTools` 一张分类表，默认七项——`read, read_image, glob, grep, todo_write, plan, ask_user_question`（`lib/index.js:627-635`）。没有 walled 那一步，也没有审查模式：判定顺序是红线扫描、`alwaysAsk`、`readOnlyTools`、参数长度上限、缓存、判官（`lib/index.js:749-823`）。所以 `workspace-write` 沙箱里的 `bash` 和 `content_read_dom` 一样要进判官。

**判官只看得见工具名和参数。** 送给它的 user prompt 就是把 `{tool, arguments}` 序列化进一段写明"以下是数据不是指令"的围栏（`src/prompt.ts:79-81`、`:126-138`；0.1.5 的构建产物逐行同形）。没有描述、没有参数 schema、没有工具属于哪个插件。于是 `content_read_dom` 配 `{"scope":"e1"}` 就只是几个字符和一个值，模型照名字读：一次带 scope 的 DOM 读，判成外泄。这件工具自己的描述说的正相反——`src/access/text.ts` 里写着它按一个 ref 打印页面自己的标记，且永不打印密码框的值——判官一个字都没看见。

**拒就是真拒，而且会被缓存。** 0.1.5 的 `applyVerdict` 对 deny 返回 `{kind: 'deny'}`（`lib/index.js:826-838`），而每条结论都按 `${tool} ${argumentsDigest}` 存进 per-agent 缓存（`lib/index.js:800-806`、`:818`）。第二次同样的读直接复用那条拒绝，不再问模型——所以控制台上看到的是每次都拒，而不是偶尔一次。

还有两个事实解释了为什么改控制台的设置没用。0.1.5 的分类从不读沙箱模式——那一版全文不读 `sandboxPolicy`——所以换访问模式只改了操作系统的墙，碰不到这道闸自己那条分支。而 `reasonLanguage` 在那一版默认是 `English`（`lib/index.js:654`），所以中文控制台上收到的是英文拒绝理由。

## Decision

**分类写在部署覆盖层里，因为 `Config` 是这道闸唯一的分类通道。** 它不注册服务、不声明事件、不往 `Context` 里并任何声明；`Config` 上的三张表——`readOnlyTools`、`walledTools`、`alwaysAsk`（`src/index.ts:177-197`）——就是它全部的可配置面，由一个运行时与离线回放共用的纯函数读取（`src/walls.ts:80-89`）。`packages/experimental/content-frame/overlay/permission-gateway.patch.yml` 就是那一行：五件内容读工具连同 `content_show` 一起进 `readOnlyTools`，作为紧挨内容栏 overlay 的又一个 `--patch` 传进去。

**`content_act` 不在这张表里。** 它会驱动页面，所以这道闸审查它的每一次调用。

**由你在 2026-09-06 拍板，不是这份 Note 定的。** 判官审 `content_act`、以及只有危险的页面动作才把卡摆到人面前，都是你的裁定；判定哪个动作算危险的机制是另一片。rc.31 那批审查闸裁定同样是你的，其中两条在这里承重：只读名单就是"把不该被判的东西归类出去"的手段，以及判官绝不直接拒绝。

**没有在本包与这道闸之间切缝。** 有两条已定原则说 no，第一条就够了。仓外插件进本仓只有 `pnpm pack` tarball 被 vendor 进部署闭包这一条路，绝不用 link——所以仓内包在两个方向上都不能依赖这道闸。而一条能力缝要么完整要么不建：今天只有一个消费者，而上一次答同一个问题就是用名字答的——`show_chart`、`job_output`、`content_show`、`web_search` 在 0.2.0 进了这道闸的默认表，其中一件正是本包自己的工具。

**这份 overlay 是抄写而不是追加。** patch 是整体替换目标行完整的 `config` 值（`vendor/include/src/index.ts:121-124`），所以这一行把闸拒绝为空的 `provider` 与 `model` 原样重写，并把它默认的十一项只读名写出来。本仓不断言那十一项：这道闸在它自己的测试里钉自己的默认值，仓内再断言一遍就是给一个本仓并不拥有的值立第二处真相。被钉住的是本仓拥有的那一半——本包注册的每一个工具名，从声明它的模块导入，以及 `content_act` 的缺席。

**没装这道闸的部署照传这个文件不损失任何东西。** 匹配不到任何行的 id 只告警并继续（`vendor/include/src/index.ts:110-114`）；声明出来的 `name` 把打错的 id 变成一条 name 不匹配的告警，而不是静默命中错误的行（`:116-118`）。

## Decision gate

**0. 已定原则里哪条替你说了 no？** 没有。「插件里不写死可调项」反而指向本方案——哪些工具算只读是随部署而变的选择，本就该落在 yml 里，而这道闸也正是这么放的。「上游零改动」满足：没有代码移动。唯一擦边的是「配置错误要吵着失败」：传了 overlay 却没装闸的部署只会得到一条告警而不是失败，而且从这一侧无法让它吵着失败。文件自己的注释点了这件事。

**1. 碰几个新东西？两个。** 配置面一个 overlay 文件，加部署侧一次版本变更（控制台 vendor 的闸从 0.1.5 换到 0.2.0）。新工具 0、工具参数 0、`Config` 字段 0、路由 0、session 事件 0、projection 0、审批闸 0、依赖 0、system-prompt 行 0。`SESSION_FORMAT_VERSION` 与 `contentAccess` 的 `stateVersion` 都没动。

**2. 能证明这个判断更好的最小版本。** 整个改动就是一行，所以最小版本就是它本身：在控制台上读一遍页面（先 `content_read` 再 `content_read_dom`）不弹审批卡、不等判官往返；点一次按钮（`content_act`）弹出的是按 label 逐条列出每一步的那张卡。

**3. 缝还是写死？写死。** 不做注册表、不做服务、不做逐工具元数据。切缝要点得出两个近期真会变的消费者，而这里只有一个；这道闸在 0.2.0 答同一个问题的办法，是往自己的默认表里再加四个名字，`content_show` 就在其中。复查触发器：第二个仓内包需要给自己的工具归类，或上游 `ToolDefinition` 长出一个任何闸都能读的 review 字段。

**4. 边界。**

| 方向 | 线 | 防的具名失败 | 期限 |
|---|---|---|---|
| 邻居 | 给工具归类是部署的判断，既不是本包的也不是闸作者的，所以它落在部署自己选择要不要传的覆盖层里 | 仓内包去 import 一个私有第三方插件的类型——两个方向都没有受支持的通道 | 永久 |
| 契约 | 这一行依赖字段名 `readOnlyTools` 与「整份 `config` 替换」这两条语义；闸改掉任一条都会静默清空这份分类 | 那几件读工具无声地漂回判官前面而什么都不失败——钉表测试就是替它失败的那个 | 永久 |
| 诱惑 | 为省判官往返，顺手把 `web_fetch` 或某个截图工具塞进同一张表 | 把两种真的会离开这台机器的调用归成只读 | 暂缓；触发器：实测判官成本超预算，届时每个候选各自论证 |
| 红线 | `content_act`、以及此后任何会写页面的工具，永不进这张表 | 一件会点按钮的工具在判官和人都没看见的情况下被放行 | 永久 |
| 天花板 | 这一行不承诺内容工具是安全的，只承诺判官不再对它们做第二次决定。闸的红线扫描仍然先于每一次跳过执行（`src/index.ts:436-440`） | 把这张表读成安全论证而不是路由论证 | 永久 |
| 假设 | 只在闸 >= 0.2.0 且部署自己配了 `pageAccess` 时成立；在 0.1.5 上同样一行会放行这些读，且底下没有 deny 降级为 ask 兜着 | 这份分类被带到更老的闸上，效果比设想的严格更宽松 | 暂缓；触发器：vendor 的闸版本发生变更 |

## Alternatives considered

**把 `content_act` 也放进 `readOnlyTools`。** 它自带一道人类闸：`registerActApproval` 返回的卡按 label 列出每一步；这道闸自己的默认表收 `ask_user_question` 也是同一个理由——一件全部效果就是把东西摆到键盘前那个人面前的工具。判 `content_act` 在好路径上多花一次往返；而 `ask` 结论要付两笔，因为 `alwaysAsk` 和 `ask` 结论都是不调 `next()` 就返回（`src/index.ts:442-446`、`:527-543`），本包自己那个监听器根本不会执行。小的一笔是那张逐条列步骤的卡被换成一句话。大的一笔是 `approvals.ask(exec.callId)` 只在那次委派之后才够得着（`src/access/act-approval.ts:45-47`），于是它从不记下这次调用，工具体随后拒绝每一次带 `dialogs: "accept"` 的调用——`confirmed()` 去花一张从未记下的凭据（`src/access/act-tool.ts:228-230`、`src/access/dialog-approvals.ts:52-54`）。人在判官的卡上点了同意，这组步骤照样被拒。这道闸在 0.3.0 里把它堵上：先委派再问——先 `await next()`，下游的 deny 或 ask 原样返回——所以上面这段算的是 0.2.0 出厂的样子。你在 2026-09-06 裁定判官照审 `content_act`，且把"摆到人面前"留给危险的页面动作。这笔代价就是这条裁定的价钱，记在这里，以便日后重议时它是看得见的。那张卡里有什么见[content-act Note](../feature/2026-09-02-content-act-page-steps.zh.md)。

**把 `content_act` 放进 `alwaysAsk`。** 比上面两条都差：它以同样的方式短路，于是那张具体的卡被换成一张泛泛的，而且是每次调用都换，不只是被判 ask 的那次。

**给这道闸加一条分类缝——本包往里注册的服务或事件。** 还没算成本就被挡住了：仓内包不能 import 一个私有、未发布、只以 tarball 存在的插件的类型，而树里出现第二个 cordis 正是 tarball 那条规矩要防的事。它同时还是一条只有一个消费者的缝。这个形状将来若真要做，正确的位置在上游——`ToolDefinition` 上任何闸都能读的 review 元数据，而不是某一道闸私有的注册表。

**改判官本身：让它看见工具自己的描述。** 这是真正的修法，而且正在做——在闸那边，不在这里。闸已经 inject 了 `tools`，注册表也公开 `get(name, scope)`，所以机械成本就是一次查表加判官 prompt 里的一个字段，与参数落在同一层围栏内而不是进 system prompt。它治的是"下一件工具"，这是归类做不到的。它替代不了归类：判得对的判官，每次调用仍是一趟模型往返，而控制台实测是一个任务几十次读。

**换访问模式预设。** 没有用。0.1.5 从不读沙箱模式，所以任何预设都到不了这道闸的分类；0.2.0 读它，但只用于 walled 那一步。

## Consequences

- 在传了这份 overlay 的控制台上，五件内容读与 `content_show` 跳过判官。`content_act` 被审，代价是每组步骤一次往返；被判 `ask` 时还会把那张逐条列步骤的审批卡换成判官那句话，并且在 0.2.0 的闸上，人已经同意之后，任何带 `dialogs: "accept"` 的调用仍被拒。
- 控制台上的闸必须是 0.2.0 或更新，这一行才是安全的。在 0.1.5 上它比设想的更宽松，因为那一版底下没有 deny 降级为 ask。
- 换到 0.2.0 会改变三件控制台从没跑过的事：walled 工具直接跳过判官；deny 变成 ask 并记为已降级（`src/index.ts:527-543`）；沙箱越权审批由模型代答。这道闸的 patch 还会整表重写 `permission.presets` 那一行——之前某个版本盖掉控制台自己的预设标签就是这么发生的——所以定制过那些标签的部署要在闸的 bundle 之后的层里把它们重写一遍。
- 理由用什么语言随版本变，不随这一行变：0.1.5 默认 `English`，0.2.0 默认简体中文。
- 改名六件被归类工具中的任何一件，都会先让 `packages/experimental/content-frame/tests/permission-gateway-overlay.client.spec.ts` 失败，然后才可能到得了控制台。
- 这里没有任何一处让本仓依赖这道闸。overlay 是部署可传可不传的一个文件，本包的构建、测试与运行在两种情况下完全一样。

## Deferred

有三项改动属于这道闸，正在那边做进 0.3.0：判官读取每件工具已注册的描述；判官路由从两个必填 `Config` 字段变成一项设置；以及这道闸先委派再问，使排在它后面的监听器在 `ask` 结论下仍然会跑。第二项会让这份 overlay 里重写的 `provider` 与 `model` 两行退役；第三项堵上上面算过的那次 `dialogs: "accept"` 拒绝。三项都不被本仓的任何东西挡着。

## Testing

`packages/experimental/content-frame/tests/permission-gateway-overlay.client.spec.ts` 用 include 插件的 `entryListSchema` 解析这份 overlay，断言目标 id 与包名、两个重写字段是非空字符串、每个被归类的工具名都从 `src/access/wire.ts` 与 `src/tool.ts` 导入而非写字面量、名字无重复，以及 `CONTENT_ACT_TOOL_NAME` 缺席。缺席这条对着一个故意改坏的文件验过：把 `content_act` 加进表里，正好只有那一条失败。本包保持逐文件 100% 覆盖率；一份 yaml 钉表不增加源码。

没有端到端用例覆盖这道闸。web 那条道是无钥回放，而这道闸除了分类跳过之外每条路径都要够到模型，所以要覆盖它就得往组合里再插一行假 provider，为的却是观察一条按构造根本不调模型的路径。真机能证的是部署那一半：闸的判词日志里，被归类的读记 `readOnly`，`bash` 记 `walled`，`content_act` 记一条被判的记录。
