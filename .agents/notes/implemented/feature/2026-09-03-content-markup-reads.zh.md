# Agent Note: 三件按页面原样读取

Status: implemented

[English](2026-09-03-content-markup-reads.md) | 中文

## 问题

[阅读器只提供通用工具](../simplification/2026-09-03-content-reader-general-tools-only.zh.md) 退役了每一条按某个组件库怎么写页面来配的规则，并实测了代价：那台真实控制台图层列表的 操作 列，二十行读出来每格都是空的。那些命令没有 role、没有名字、没有 title、也没有指针光标，规范定义的东西它们一样都没写，而一个只陈述文档所陈述之事的读法，对它们就无话可说。

用户看见那一列里有两个图标。模型看见一列空的，也没有任何可以指的 ref。退役记录接受了这一点，理由是那些图标是什么意思该由技能来说——可技能要能说出一个元素是什么，前提是有什么东西到达它、并且能指认那个元素，而 `content_read` 到达它的是一无所有：没有行、没有 ref、没有词元。知识没有可以挂靠的地方。

`content_read` 还会把它打印的每一段文字裁到 200 字符，于是一条超过这个长度的提示、消息或单元格到达模型时结尾是个省略号，而没有任何办法索要其余部分。

## 决策

再加三件读取，全部只读，全部走 `content_read` 已经在用的那条通道。

- **`content_read_dom`** —— `scope` 必填（任一次先前读取给出的 ref），`after` 可选。打印该元素及其内部每一个元素，一行一个、按嵌套缩进：ref、标签名、`#id`、以 `{class: …}` 形式给出的 class 词元，以及该元素直接持有的文字的开头。按 `outlineChars` 渲染并带游标裁断，与清单完全一致。
- **`content_read_attrs`** —— `ref` 必填。打印该元素的全部属性，名与值按页面写的原样给出，别的什么都不打。
- **`content_read_dom_content`** —— `ref` 必填。打印该元素的全部可见文字，页面在哪里换行就在哪里换行，页面隐藏的一概不含，且从不截断。

`content_read` 不退役，而是重新定位：它是页面按 HTML 与 ARIA 所描述的样子，仍是一页从那里起手的读法。它的描述曾经把这句话说出来，并点名另外两件在 class 词元不够用时打印某一行原文与属性的读取；[只写自身文案那篇记录](2026-09-04-self-contained-tool-copy.zh.md) 把两者都删掉了，因为一段替同伴摆位的描述在真机上把模型带错了路。它仍保留的两条推断——指针光标标记可点目标、字段前方绘制的 `label` 为其命名——沿用 [退役记录](../simplification/2026-09-03-content-reader-general-tools-only.zh.md) 给它们的退役条件。

这四件答的都是页面写成什么样。页面**画**出来的东西——二维码、验证码、`canvas` 里的图表——由同一条通道上的第五件读取来答：[一张图，作为模型直接看的像素](2026-09-04-content-read-image.zh.md)。

### 决策闸

- **新面。** 三件工具、三种 wire 请求种类、一个被放宽的 `ReadSnapshot.kind`、三种输出格式、三段描述。零 `Config` 字段：预算、超时与认领窗口都是 `content_read` 的，原样共用。
- **边界。** 机制归本包：遍历子树、打印属性、切分文字的行、给元素编号、预算与游标。知识归技能：`el-icon-edit` 是什么、页面画的哪几张表在用户眼里是一张、`data-op="edit"` 会做什么。三件读取把原料送到技能能够挂靠的地方，自己一个字都不解读。
- **契约。** 一个 ref 在页面还持有该元素期间始终指同一个元素，无论哪一次读取铸出它；树形行打印的 class 词元，与清单为无名行打印、座位为步骤 `mark` 重算的是同一个 [`elementMark`](../../../../packages/experimental/content-frame/src/client/access/dom.ts)，因此树里找到的行就是 `content_act` 能操作的行。各有一处归属：[`markup.ts`](../../../../packages/experimental/content-frame/src/client/access/markup.ts) 负责打印，[`read-value.ts`](../../../../packages/experimental/content-frame/src/access/read-value.ts) 持有四件读取共用的等待与四种结局，`snapshot.ts` 持有四者共用的页首、ref 查找与组装。
- **诱惑。** 拿 `content_read_dom` 当默认读法。整页原文比它的清单大一个数量级，而一个刚被告知有办法看见真东西的模型会先伸手去拿。一样东西拒绝它：`scope` 必填，因此必须先有一次清单。描述里曾直说不要，`content_read` 自己的描述也曾说它才是起手那一读，直到[只写自身文案那篇记录](2026-09-04-self-contained-tool-copy.zh.md)把每段描述都约束在它自己那件工具上。
- **红线。** 代码永不解读 class 名或属性，只打印。没有 mode、没有属性白名单、没有过滤、没有 depth 参数——v0 就是把页面自己的写法送到技能手里的最小形态。密码控件所装的东西被三件读取一律扣留，打印为 `(password withheld)`：属性读取扣留 `value`，树形与整文读取则扣留一个在 `autocomplete` 里声明了密码的 `textarea` 把值存在其中的那段文本。一个控件算不算密码控件，看的是它的 `type` 或那个属性，在 HTML 给了自动填充字段名的那三种标签上都算；这条规则住在 [`isPassword`](../../../../packages/experimental/content-frame/src/client/access/dom.ts) 里，清单自己的控件状态也读它。清单在别处怎么处理 `textarea` 的值，是那条读取自己的路径，此处不动。整文读取所指名的那个元素，与它的后代受同一套规则约束——页面隐藏的、带 `aria-hidden` 的、以及浏览器自己绘制的，一律读作没有文字——因此这条读取不会回答出它自己的遍历本会略过的东西。
- **天花板。** 树按 `outlineChars` 设限并从游标续读。另外两件要么整份给出、要么拒绝：元素的属性与元素的文字都不截断，超出报告路由所能承载者——`outlineChars × 4` 个字符，或信封所留的字节上限——一律拒绝，并在拒绝语里报出字符数与它越过的那个预算；[只写自身文案那篇记录](2026-09-04-self-contained-tool-copy.zh.md)把这些拒绝原本点名的补救办法拿掉了。文字读取在哪里断行也以同一方式设限：断行遵循本包的行内元素集合——短语内容减去浏览器自己绘制的那些，再减去用户可操作的那些——因此 `del`、`ins`、`button`、`input`、`output`、`select` 与 `slot` 会断行，而浏览器本会把它们留在同一行里。这个集合同时也是清单的，不为这条读取另行裁剪。
- **假设。** 存在一份技能，或模型能写出一份技能，把 `{class: el-tooltip operation-modify el-icon-edit}` 变成「这是这一行的编辑命令」。没有它，三件读取就只是原料。这正是 [代码与技能的边界](../simplification/2026-09-03-content-reader-general-tools-only.zh.md) 所依托的假设，也是这一片不自带任何页面知识的原因。

### 答案长什么样

树形行是 `<缩进><ref> <标签>[#id][ {class: …}][ "文字"]`，文字超出该行自有的 80 字符额度时补上 `(text cut)`——在[只写自身文案那篇记录](2026-09-04-self-contained-tool-copy.zh.md)之前这个标记点名了整文读取，而这一行开头本来就写着 ref。属性行是 `<名>=<值>`，值按 JSON 引号规则加引号，因此一个含引号或换行的属性仍然只占一行，且仍然说出页面写的是什么。两者都以更短的页首 `Page: <title> — the app is at <path>` 开头：文档怎么称呼自己、它开着哪个对话框、它标记了什么还在加载，都是关于页面的问题，而回答它们的读取是 `content_read`。

## 备选方案

**在 `content_read` 上加一个 `mode`。** 郝然的拍板，也是对的：一个 mode 会把原文读取变成语义读取的一个变体，于是每一条拒绝语、每一行参数说明、每一个页首字段都得同时替两者作答，而选择 `mode` 的模型仍然需要被告知描述里现在无论如何都要写的那套定位。三件工具的代价是三段描述，买到的是三份各自只说自己收什么的参数表。

**把过长文字截断而不是拒绝。** 一件承诺给出全文却悄悄只给一部分的工具，比一件说自己给不了的更糟：模型无从分辨完整答案与被裁答案，据此写出的技能错得毫无声响。拒绝语报出字数。

**属性白名单，或树上的过滤器。** 两者都是由本包来判定页面原文里什么值得读，而这正是退役记录从它手里拿走的判断。嫌答案太大的部署去调 `outlineChars`，那是它本来就拥有的数字。

**把 `content_read` 的记录行也注册给这三件工具。** 那一行写的是「看了一眼「X」」，对四件都成立。这里保持原样：该行是在一份生成的客户端槽位目录里按工具名建索引的，而三件工具自己的 `presentCall`/`presentResult` 已经给了通用卡片一个标题——模型被告知内容的第一行，其中就有页面名。一次原文读取的答案不是页面清单，把它说成清单的行比一张如实说明的卡片更糟。

## 影响

**模型现在能够到一行规范没有任何东西描述的行。** `content_read` 把那一列打成空的，对该行 ref 调 `content_read_dom` 打出 `i {class: op op-a}`，对该元素调 `content_read_attrs` 打出 `data-op="edit"`。本包里没有任何东西把 `op-a` 变成「编辑」；做这件事的是模型写出的答案，以及它随后写下的技能。

**整页原文读取是可用的，也是唯一一种把预算花坏的方式。** 上面那三重拒绝就是拦它的全部，而它们没有一样是机制：把 `scope` 指到 `body` 的模型会按部署预算拿到整页的树，其余部分给游标。真正兜底的是这只花掉一次读取并返回游标，而不是无声地只给半页。

**树会打印清单藏起来的东西。** 可见性是清单的过滤器，并且刻意不是树的，因此一个带大片隐藏子树的页面会把预算花在上面。这正是要点——清单因不可见而丢掉的那一行，恰恰是读者到树里来找的东西——而游标是唯一约束它的东西。

**`content_read_dom_content` 按原文的读法换行，而不是按页面被画出来的样子。** 座位要为一个没有布局的 DOM 实现里的文档作答，因此行在元素不是行内元素处以及 `<br>` 处结束。一个把 `span` 改成块级、或把 `div` 改成行内的页面，是按它的原文而不是按它的样式表被断行的。

**wire 现在承载五种 kind。** `ReadSnapshot.kind` 是 `outline | map | dom | attrs | content`，五件工具共走一条路由、一次认领、一份文档；每件工具都会用误报早已挣得的那句话，拒绝以另一种读取的 kind 回来的答案。`contentAccess` 投影的 `stateVersion` 升到 3，因此由不认识这些调用的构建写下的检查点会被重折而不是被信任。

**一次原文读取的代价就是它索要的东西。** 在这条线所对着的控制台上，一张表体的树是每个 `tr`、`td`、`i` 各一行；一次属性读取是一个元素。两者都不是每请求的固定开销——固定的是三段描述与四行参数说明。

## 测试

`tests/markup.client.spec.ts` 钉住三件读取产出的每一个字符串——树形行、裁断标记、属性行及其 JSON 引号、被扣留的密码值、文字的分行、以及两种空答案——外加预算裁断、游标、续读，以及对一个并非该树某一行的游标的拒绝。`tests/content-markup-tool.client.spec.ts` 对着真实的工具运行时逐字钉住三段描述与参数表，并驱动每件工具能到达的每一种结局。`tests/content-read-executor.client.spec.tsx` 让三件读取都在真实 iframe 里的真实文档上过一遍座位，包含三种「宽到 wire 装不下」的拒绝。`src/` 按文件 100% 覆盖；耦合审计——没有任何代码路径读取厂商 class 前缀——只命中一处点名说明「刻意不识别什么」的注释。

四份 Web 场景为它作证，全部位于 `snapshots/web/` 下：`content-read` 与 `content-act` 自 `apps/web/tests/snapshots/` 迁入，`content-read-dom` 与 `content-read-attrs` 新增，对着新的 fixture 应用 `tests/fixtures/markup-app`——它的 Operations 列画成只带一个 class 与一个 `data-op`、别无他物的裸元素，正是那种在真实浏览器里读出来一列全空的形状，而这是任何 jsdom fixture 都造不出来的。四者共用语料库组合 `web-content` 及其唯一的 header class，由 `content-read` 钉住。带密钥录制：

```sh
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read.e2e.ts
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-act.e2e.ts
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-dom.e2e.ts
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-attrs.e2e.ts
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read.e2e.ts \
  apps/web/tests/content-act.e2e.ts apps/web/tests/content-read-dom.e2e.ts apps/web/tests/content-read-attrs.e2e.ts
```

最后一条不需要密钥，而且四份都少不了它：一次录制带着实时供应商解析出来的东西——请求的 `maxTokens` 与推理力度，以及一条 `request/context` 事件——而重放跑不会产生这些，因此这一遍刷新把每份 fixture 归一到「重放所落盘的样子」，并写出被钉住的 header 所拥有的那两份边车文件。模型说过的话不受它影响：提示词、工具调用、结果与回答，仍是那次录制的。

把这四份收进语料库，动了 Web scaffold 一处。清单一旦与 `session.jsonl` 并排，落盘日志比对就被打开；而四者都会先把一轮种进它们随后要驱动的那个会话——`recordFixture` 的 `afterSeed` 修剪正是把这一轮从录制里去掉的，因为一份带着已种轮次的重放 fixture，会拿一次它从未发生过的回合的答复去应答实跑的第一次模型调用。`assertReplaySession` 现在在把 fixture 对上会话、与之比对、或读取 header 钉子之前，先在同一个 `session/end-seed` 边界上裁剪实时日志，刷新写回也走同一处修剪。什么都没种的场景没有可裁的边界，整份比对，一如既往。

这就是 [fixture 留在语料库之外那份记录](../testing/2026-09-03-content-access-fixtures-outside-the-corpus.zh.md) 所记的那处偏离的终点。
