# Agent Note: 登录页照读，只扣住密码的值

Status: implemented

[English](2026-09-04-sign-in-pages-are-read.md) | 中文

## Problem

读取器对整个页面下过一道判定：一个可见的密码框旁边有一个可见的账号框，就判此页是登录页，五件内容工具一律拒绝。`content_read` 用一句话顶掉清单，三件原文读取用同一句话顶掉页面自己的写法，`content_act` 在第一步之前拒一次、收尾读取时再拒一次。[通用工具那篇记录](../simplification/2026-09-03-content-reader-general-tools-only.zh.md)把这道判定作为 fail-closed 的凭据保护留了下来，直到座位能读到页面确实有的那两处声明——伙伴框上的 `autocomplete="username"` 与密码框上的 `current-password`。

它拒掉的正是用户自己的活。当你要 agent 帮忙看一个控制台的登录页——那页上画着二维码和验证码，你要的是 agent 把页面上显示的东西读出来，与任何凭据无关——五件工具每一件都只回一句拒绝。那个页面最后还是到了模型手里：模型用 `bash screencapture` 截了整块屏幕，再用 `read_image` 把 PNG 读回来，于是那张凭据表单以像素的形式、经由一件对它没有任何规矩的工具到达，连同当时屏幕上的其他一切。一道架在某条通道上的闸，把同一个页面赶去了一条没有闸的通道，还让用户没拿到他要的那次读取。

这道判定判的也不是该判的东西。一条凭据规矩要保护的是框里那个值，而页面的形状只是在猜这个值将来可能被填在哪里。读取器本来就在每一条路径上扣住这个值；页面判定连它周围的整个页面一起扣了。

## Decision

显示着登录表单的页面，读与动手都和别的页面一样。这道页面级判定是整条删掉，不是收窄。

只留一条凭据规矩，而且它点名的是凭据本身、不是页面：**密码框装着的值，在任何一条路径上都不到模型手里。** 一个控件算不算密码控件，看的是它的 `type`，或者它的 `autocomplete` 里带 `password` 词，在 HTML 给了自动填充字段名的那三种标签上都算——[`isPassword`](../../../../packages/experimental/content-frame/src/client/access/dom.ts)，每条路径都问它。框本身是可读的：它在不在、它的 ref、它的名字、它的 mark 和它的状态都照印，所以模型看得见这张表单在要密码，也说得出来。

| 路径 | 值的位置上写着什么 |
|---|---|
| `content_read` 清单 | `= (hidden)`；值在 `controlState` 里根本不被取出 |
| `content_read_attrs` | `value=(password withheld)` |
| `content_read_dom` 树形行 | 元素自己的文字被换成 `(password withheld)` |
| `content_read_dom_content` | 整个答案就是 `(password withheld)` |
| `content_act` 步骤回报 | `fill "密码" ← (hidden)` |
| `content_act` 收尾读取 | 清单自己的 `= (hidden)` |

### 删掉了什么

[`snapshot.ts`](../../../../packages/experimental/content-frame/src/client/access/snapshot.ts) 里的 `asksToSignIn` 及其 `SIGN_IN_PARTNER`、`SIGN_IN_SCOPE` 选择器；`SnapshotHeader.signIn`；wire 字段 `ReadSnapshot.signIn` 及其解析检查，连同 `ReadErrorCode` 的 `'sign-in'` 成员、它在 `failureRefusal` 里的那一支和它在 `ERROR_CODES` 里的那一项；`text.ts` 的 `SIGN_IN_REFUSAL` 与 `act-text.ts` 的 `SIGN_IN_ACT_REFUSAL`；`read-tool.ts` 与 `markup-tool.ts` 两处宿主检查；以及座位 executor 里的三处——读取回报的那个头部字段、第一步之前的预检、收尾读取的扣留。

去掉这个 wire 字段，每份回报少 15 字节 JSON。`REPORT_SYNTAX_BYTES` 仍是 512——它本就是对实测信封的上取整，而被上取整的那次实测从 257/301/318 字节变为 242/286/303——因此 `REPORT_ENVELOPE_BYTES` 以及由它算出的每一道路由上限都没变，只是字节测试所校准的那些回报小了 15 字节。

### 这条规矩管不到的地方

`content_act` 在动手之前组成、要用户回答的那个审批请求，仍会把一步 `fill` 的文本原样写出：`填「密码」为「hunter2」`。那是用户要回答的那句话，由调用的参数组成，展示给做决定的人。密码框的值该不该出现在里面，是未决的，本记录不作定论。

用户在对话里打出来的凭据，本包一律不扣。被扣的是页面装着的东西；用户自己说出口的，是一次模型可见输入，按「模型可见即入日志」那条规矩留在会话日志里。

## Alternatives considered

**把这道闸收窄到页面自己作出的声明**，也就是通用工具那篇给它写的退役条件：只认 `autocomplete="username"` 与 `current-password`，不再认「密码框旁边有个文本框」。按你的裁决否决。那是同一种拒绝，只是页面集合小一点；而用户要读的那个控制台两个属性一个都没写，所以收窄后的闸会和宽的那道一模一样地拒掉它。

**`content_act` 保留这道闸，四件读取取消。** 否决。动手这条通道本来就在任何东西跑起来之前，逐步点名地问过用户，这比一条关于页面形状的规矩更硬；而一个只许读、不许动的页面，只会让模型描述一张它帮不上忙的表单——那正是用户这次任务被拒的处境。

**扣住密码框本身——它的行、它的 ref、它的状态——而不只是它的值。** 否决。模型看不见的表单就是它描述不了的表单，而「有一个密码框」不是凭据。正是这一行让模型说得出这页在要密码。

**闸留着，改去回应截屏那条路**，给模型另一条不经清单也能看见页面画面的路。否决：绕闸是拒绝造成的后果，不是缺了什么能力。两条通道按不同规矩读同一个页面，正是把整块屏幕塞进 transcript 的那种安排。

## Consequences

**模型会读也会动登录表单。** 它能列出这些框、印出它们的原文、读验证码的 `alt` 文字或二维码那个元素，也能在这页上填和点，走的是每一次 `content_act` 调用都要走的同一道审批。

**少一种拒绝要解释。** 读取工具的失败集合就是座位对任何一次读取都能到达的那四种；动手工具的是那四种加上「前面的页面换了」。`failureRefusal` 少一支，它 switch 的那个封闭 union 仍以同一个 `assertNever` 兜底收尾。

**凭据规矩是一条规矩、一处归属。** `isPassword` 定它，每条读取路径问它，README 说它一次。页面的形状什么都不定。

**用户在对话里打出来的密码会到模型手里、也会进会话日志**，出于用户自己的选择，也出于「模型可见输入即已入日志」这条规矩。本包的规矩只管页面装着的东西。

**审批窗仍会显示往密码框里填的那个值。** 上文已记为未决。

## Testing

`pnpm exec vitest run packages/experimental/content-frame`——696 项。这道闸自己的用例已删；顶上来的用例钉住的是「照读」：`snapshot.client.spec.ts` 列出一整张登录表单，账号框的值照印、密码框的值扣住；`content-act-executor.client.spec.tsx` 把登录表单两个框都填掉，再把回报与收尾清单读回来；同一套用例还驱动一次「退出登录」，让一张凭据表单留在用户面前，然后把它读出来。`markup.client.spec.ts`、`content-act-text.client.spec.ts` 与 `snapshot.client.spec.ts` 里的密码用例未动，它们正是守住这唯一一条规矩的东西。

本包 `src` 按文件 100% 覆盖不变：

```sh
pnpm exec vitest run --coverage --coverage.include='packages/experimental/content-frame/src/**/*.{ts,tsx}' \
  packages/experimental/content-frame
```

`snapshots/web/` 下的四个 Web fixture 原样回放通过——没有任何描述、参数或输出 schema 动过，四个之中也没有一个驱动过登录页：

```sh
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read.e2e.ts \
  apps/web/tests/content-act.e2e.ts apps/web/tests/content-read-dom.e2e.ts apps/web/tests/content-read-attrs.e2e.ts
```
