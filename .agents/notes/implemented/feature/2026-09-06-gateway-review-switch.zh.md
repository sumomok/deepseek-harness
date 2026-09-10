# Agent Note: The review switch leaves the preset table

Status: implemented

[English](2026-09-06-gateway-review-switch.md) | 中文

## Problem

`@haoran/dsh-llm-permission-gateway` 0.1.5 把模型审查绑在一个权限预设上。它带来的那一行叫自动审查,选中它同时做两件事:把操作系统沙箱关掉,以及让审查模型的判断从此才有意义。在桌面端,这样的绑定有三处不对。

审查与沙箱不是二选一。在 `workspace-write` 下,沙箱已经围住了 `bash`、`pwsh`、`write`、`edit`、`str_replace_editor`、`terminal_open` 与 `terminal_send`,却完全够不着 `run_code` 的程序体——它跑在 harness 进程内的一个 worker 线程上,`node:fs`、`node:child_process` 与 `fetch` 都在手边——也够不着 `web_fetch`、`screenshot` 这类能力工具。没有围墙的那些调用,恰恰是没有任何东西审查的那些,因为要审它们就得放弃其余一切的围墙。

那一行自己的措辞承诺了它给不出的东西。审查模型能回 `allow` 或 `ask`,它执行不了拒绝;0.2.0 把这件事做成了结构性的:每个 `deny` 判决都降级成一个问题。于是一个叫「自动审查」的预设读起来像是模型会逐步把关,而它实际买到的,是一个模型在背后沙箱已关的情况下弹出的审批提示。

而且预设表本来就不是放开关的地方。`PermissionPresetService` 靠把一个预设的 `(sandbox, approval)` 组合在表里查一遍来解析它,所以第二行只要与谁共用一个组合,两行就都解析成 `custom`,谁都选不中;唯一空着的组合 `approval: never`,又会把这道门自己的 `alwaysAsk` 条目所需要的通道拿掉。放不下第五行来表示「审查开着」。

## Decision

桌面端换到 `@haoran/dsh-llm-permission-gateway` 0.3.1(sha256 `9846923006f8dff42c2f0177de7ab78bbb359d275c4a326875a4f8ce33da3091`),替换掉 0.1.5 的 tarball。

**审查是插件自己的一项设置,在任何预设下都生效。**出厂为 `auto`。设置页的**自动审查**小节是这个开关,输入框里的 `/review auto` 与 `/review manual` 是同一个,这个选择存在插件自己的 `llm-permission-gateway` 设置命名空间里。`manual` 保留两条红线与 `alwaysAsk` 条目,其余一概跳过。

**有沙箱时,这道门只审沙箱管不到的东西。**哪些调用属于此列,是逐次调用地从运行中的安装读出来的:`ctx.sandboxPolicy.resolve({ session })` 加上所挂载的 shell 执行器报告的 `sandboxMode`;两边都报告有围墙时,`walledTools` 名单直接放行,围墙不在的地方则照审。用一份录下来的 97 次调用的会话按新规则重放,`workspace-write` 下 81 次模型审查变成 52 次,`danger-full-access` 下是 80 次。

**这道门代你回答沙箱自己弹出的越权申请。**某次被围住的 `bash`、`pwsh`、`write` 或 `edit` 调用因为伸到墙外而被拒、agent 请求解除这次拒绝时,由同一个模型对着这道门记住的那次被拒调用来审这个请求:判 `allow` 就授予 `allowed-once`;判 `ask`、`onFailure: ask` 下审查失败、那次调用没被记住、以及请求点的工具与记录里的不是同一个,都交还给人。

**这道门从不凭模型的话拒绝。**`deny` 判决变成 `ask`,记录里带 `downgraded: true`;而且这道门产出的每一个 ask 都会先走完 `tools/pre-execute` 这条 waterfall 的其余部分:链上更靠后的 `deny`,或者更具体的 `ask`,原样返回;只有链上放行时,这道门自己的问题才立得住。

**理由用简体中文写。**`reasonLanguage` 默认 `简体中文`,而插件自己写的每一句话——红线、超长调用、没拿到判决的审查、`/review` 的回声、`browser_auth` 的代价句——无论这项设置是什么都是编译进去的中文。

**同一个设置小节还决定用哪个模型来审查**,可选范围是这次安装能读到模型目录的那些供应商。`config.provider` 与 `config.model` 仍然必填,并成为兜底:全新安装按它审查,存下的供应商没有适配器时也按它审查。改动在下一次调用生效,并清空两个判决缓存。

**那一行预设保留 id、换掉名字。**`yolo-access` 现在叫关闭沙箱（不推荐）,描述如实写明:操作系统的围墙没了,审查照跑,而审查最多只能弹一个提示。于是访问方式控件读作 仅可查看 / 工作区内修改 / 完全权限 / 关闭沙箱（不推荐）。

**网关长出了浏览器那一半。**0.3.1 声明了 `dsh.client`,正是它让服务端为这个插件组合出 `/plugins/<name>/client.js` 那一行,也正是它让打包的启动闸要求这个模块出现在所服务的 index 所列的客户端模块里。

### 既有安装的升级兼容性

预设的 **id** 没变,而这正是已安装的机器所依赖的东西。`permission.defaultPreset` 存在设置文档里,其 schema 是对预设表里那些名字的闭合联合,而 `SettingsProvider.register` 面对 schema 不再接纳的已存小节是拒绝而不是回退——`permission` 小节会因此装不上,存下的默认值被丢掉,设置页连权限那一节都没有了。改这一行的 `name` 与 `description` 动不到其中任何一样。

壳写出的东西里没有任何预设名或网关的配置键。`apps/desktop-shell/src/profile-seed.ts` 写的是 profile 清单、空白的用户 patch 模板与 pnpm 设置,并且从不回头改已存在的文件;设置这个插件的 config 的,只有它自己的 `cordis.patch.yml` 这一层。

`Config` 的键是 0.1.5 的超集:新增 `mode`、`walledTools` 与 `reasoningBudgetTokens`,一个都没删,所以一份手写的、重述过旧键的 profile 层照样能加载。有两项默认值移动了——`reasonLanguage` 从 `English` 变成 `简体中文`,`readOnlyTools` 增加了 `show_chart`、`job_output`、`content_show` 与 `web_search`——而重述过其中任一项的层保留它自己写的值,因为以 id 为目标的 patch 替换的是整个 `config` 块。

`llm-permission-gateway` 这个设置命名空间是新的,所以没有哪台机器存着可供它拒绝的小节。

## Alternatives considered

**保留自动审查这个名字。**唯一用过这个功能的那台机器就是这么认它的。但它命名的是一个已经不存在的模式:审查现在在任何预设下都跑,所以这一行会承诺一个选中它并买不到的检查,同时把选中它真正做的那件事——关掉沙箱——藏起来。

**既然 `yolo-access` 只剩「关掉沙箱」这一层意思,就把它删掉。**`danger-full-access` 本来就在,这一行加的只有 `{danger-full-access, ask}` 这个组合。否决的理由是:删掉它会按上面兼容性一节所述,弄坏那些存下的 `defaultPreset` 指向它的用户的设置页;留着它只占一个表项,却修好一台已安装的机器。

**把 `mode` 默认成 `manual`,让升级在有人主动要求之前什么都不改。**挂载这个 bundle 本来就是一次刻意的动作,而 `manual` 会让升级在每台机器上都变成空操作。在 `auto` 下,这道门审的东西严格少于 0.1.5——沙箱已经覆盖的部分它一概不碰——所以这个默认值付出的只是沙箱做不了的那些审查。

**在预设表里加第五行表示「审查开着」。**这是用户会去找它的地方。但权限服务按 `(sandbox, approval)` 组合解析预设,与别人共用组合的一行会让两行都解析成 `custom`,谁都选不中;而唯一空着的组合 `approval: never`,又会把这道门的 `alwaysAsk` 条目与它自己的 ask 所需要的审批通道拿掉。

**越权申请照旧交给人。**这是不增加任何授权的那个答案。但它意味着 agent 一次普通的工作区外读取,会以一个人毫无上下文的提示收场,而本产品的用户不是在读 argv 的人;何况替他回答的那个模型,面前摆着那次被拒调用自己的参数,而且只能把一次调用放宽一次。

## Consequences

选哪种访问方式与要不要开审查,现在是两个互不相干的选择,桌面 README 的两种语言都这么写。想要围墙又想要审查的人——旧表表达不出的那个状态——出厂即是。

有沙箱时审查更便宜,没编排沙箱的地方一如从前。省下来的是被围住的那些工具,加上 `run_code` 外壳分派出去的嵌套子调用——它们过去要被审两遍。

越权应答器是这个插件唯一「给予」而非「发问」的地方。桌面端总有审批应答器在编排里,所以模型拿不准时人依然够得着;`/review manual` 会把这个应答器连同其余部分一起关掉。

`apps/desktop-shell/tests/builtin-permission-gateway.spec.ts` 从提交进来的那个 tarball 里读出预设表,所以这次改名是被钉住的而不是被描述的:它断言那一行的名字、断言描述里写了操作系统的围墙没了、并断言描述没有把审查说成顶替围墙的那个东西。

## Related

[桌面端分发权限网关,预设随插件一起走](2026-08-22-desktop-builtin-permission-gateway.zh.md) 拥有插件与它那一行预设为何一起进载荷、以及那一行为何是被提供而不是被强加的。
