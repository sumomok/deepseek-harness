# Agent Note：桌面载荷的裁剪允许删掉什么

Status: implemented

[English](2026-08-20-desktop-payload-prune-gate.md) | 中文

## 问题

桌面载荷由两条彼此独立的裁剪把一棵 35000 个文件的暂存闭包切到 3858 个文件，其中较大的一条是[收敛第三方树](../architecture/2026-08-19-self-contained-desktop-closure.zh.md)。`apps/desktop/scripts/package.ts` 里的 `PLATFORM_DIR_RULES` 在拷贝阶段丢掉另一个平台的产物目录；`apps/desktop/scripts/bundle-closure.ts` 里的可达性遍历把每个 `@deepseek-ai/*` 包的依赖内联进去，然后删掉所有已经没人 import 的第三方目录。两条都靠静态证据判断——一个作用在目录名上的谓词，或者跟在 `from`、`require`、`import` 后面的说明符——而且都不会报告自己解释不了的删除。

名字在运行期才产生的包没有静态证据。有三个在同一天被删掉：

| 被删的 | 为什么没人看见它 | 本来会怎么暴露 | 实际怎么暴露的 |
|---|---|---|---|
| `@vscode/ripgrep-<platform>-<arch>` | `lib/index.js` 用 `process.platform` 和 `process.arch` 拼出名字 | 搜索找不到二进制 | 有人恰好去查了 |
| `@img/sharp-libvips-darwin-*`、`@vscode/ripgrep-darwin-*`、`node-addon-require-builtin-darwin-*` | 只被 `require.resolve` 或 `.node` 自己的动态库搜索引用 | 启动在 `sharp.mjs` 里挂；另两个要等到搜索、等到后续插件 | 启动闸恰好加载 sharp |
| `open` | `import.meta.resolve('open')` 把名字放在 `from`、`require`、`import` 三者之后都不是的位置 | 载荷 import 期 `ERR_MODULE_NOT_FOUND` | 打包直接失败 |

三个里有两个是靠运气抓到的。中间那行里 ripgrep 和 `node-addon-require-builtin` 的删除只在用户搜索、或加载需要它的插件时才失败，本来会一路发到用户手上；[那一次的记录](../bug-fix/2026-08-19-darwin-native-variants-dropped-by-closure.zh.md)正是最早提出要为载荷包名加一道门禁的地方。

ripgrep 那次说明了为什么光靠包名差集不够。`PLATFORM_DIR_RULES` 里写着 `{ parent: '@vscode/ripgrep', keep: name => name !== 'bin' }`，而 `@vscode/ripgrep@1.18.0` 根本不发布 `bin/`：这条规则匹配零个目录，而且从来没匹配到过。它看上去像是管住了 ripgrep，实际上装二进制的那些兄弟包一条规则都没有，还害人多绕了一轮诊断。它的症状也在没人动它的情况下变过——闭包收敛之前，两个载荷各自带着对方平台的 `rg`；收敛之后，darwin 变体被当作不可达删掉，只剩 mac 载荷带着一个用不了的 `rg`。两种状态下这条规则同样是死的。

## 决定

`apps/desktop/scripts/payload-gate.ts` 跑四条检查，全部致命，由 `package.ts` 调用：`verifyPruneRules` 在暂存树验证之后跑一次，`verifyPrunedPayload` 在每份派生载荷的冒烟测试和启动闸之前跑。

**一条什么都不丢的裁剪规则直接判构建失败。** 这是主判据。每条 `PLATFORM_DIR_RULES` 都拿全量暂存树评估，而且评估**所有** target，不只是本次构建的那个——因为一条规则匹不匹配是规则表和暂存树的性质，本次派生哪份载荷不进入这个判断。失败信息会打印该 parent 下的实际条目，于是一条指向 `LICENSE, README.md, lib, package.json` 的规则一眼就看得出没指着平台分包。

另外三条读流水线各阶段之间的集合差，是补充判据：差集会随上游发布内容变化而漂移，而上游两天能推一百个提交。

**拷贝阶段消失的包必须有一条规则的拒绝记录。** 那个阶段除了平台规则以外，不允许任何东西删掉整个包。

**平台分包目录必须与它所在的载荷相符。** 判定单位是目录名按 `-`/`_`/`.` 切出的段里同时含平台（`darwin`、`win32`、`linux`……）和体系结构（`arm64`、`x64`……）的目录，取 `node_modules` 下任意深度最靠上的那一层，兄弟包和 `node-pty/prebuilds/*` 一并覆盖。名字指向本 target 的必须活到最终载荷里；名字指向别处的不许出现在里面。失败信息会对照两条裁剪之间拍下的快照，说清是拷贝过滤器还是闭包遍历删的。

**活下来的代码不得按名解析已被裁掉的包。** 最终载荷会被扫描 `import.meta.resolve`、`require.resolve` 和 `createRequire(…).resolve` 以字符串字面量为参数的调用点；字面量指向一个被裁掉的包就是一条 finding，连同解析它的文件一起打印。

### 遍历自己认解析调用，不为此留名单

`bundle-closure.ts` 里的 `specifierFor` 现在除了 `from`/`require`/`import` 后面的说明符，也匹配解析调用里的字面量。这覆盖的是一整类——`import.meta.resolve('open')` 和 `require.resolve('@img/sharp-libvips-darwin-arm64/binary')` 都要求那个包以目录形态留下，而且两者都不内联任何东西。它取代了一份 `RUNTIME_RESOLVED` 保留名单，那份名单每出现一次就得加一条。

遍历仍然看不到的是不以字面量出现的名字：带替换的模板（`@img/sharp-${platform}-${arch}`、`@vscode/ripgrep-${process.platform}-${arch}`），以及 `.node` 自己发起的动态库搜索。`NATIVE` 就留给这些，两个平台的变体都在里面写全。

## 验证

在未经改动的分支上跑完整 `pnpm --filter @deepseek-ai/dsh-desktop run package --mac` 静默通过：先是 `10 platform prune rules live against the staged tree`，然后是 `94 packages dropped, 15 platform dirs accounted for, 7 runtime-resolved names checked`。没有任何豁免生效，所以门禁一行豁免信息都不打印。

每个案例都通过还原造成它的缺陷再跑流水线来复现；每一次都在门禁处非零退出，早于它原本会造成的那个故障。

| 还原的缺陷 | 门禁说了什么 |
|---|---|
| 那条 `{ parent: '@vscode/ripgrep', … }` 规则 | `[dead-rule] win: … matched 0 of 4 entries`，在派生任何载荷之前 |
| darwin 列表里没有 `@vscode` 规则 | `[platform-variant] @vscode/ripgrep-win32-x64 … rode into the darwin payload` |
| `NATIVE` 缺 darwin 侧变体 | `@vscode/ripgrep-darwin-arm64` 和 `node-addon-require-builtin-darwin-arm64` 各一条 `[platform-variant]` |
| `specifierFor` 不认解析调用 | `[runtime-resolved] open … node_modules/@deepseek-ai/dsh-web-app/lib/index.js` |

整个修复前的状态一次跑下来只产出那条死规则失败，因为它先触发；只把那条规则修好、其余保持原状，同一个状态产出全部六条载荷层 finding，其中两条都指向 `@img/sharp-libvips-darwin-arm64`——一条来自平台分包检查，一条来自解析扫描。

解析调用这条扩展保留的东西与被取消的名单完全一致：有它时闭包移除 90 个第三方包，没有它时移除 102 个，差的 12 个就是 `open` 和它的传递依赖。

## 备选方案

**只做包名差集，要求每个消失项都有一条规则解释。** 最初的提案，而它恰好漏掉引发这项工作的那个案例：ripgrep 的兄弟包压根不在任何规则的射程里，而看上去管着 ripgrep 的那条规则又对不上它们。死规则本身就是缺陷，而且是这个 bug 出现过的两个基线上唯一都成立的信号。

**扫描活下来的载荷里所有提到被删包名的字符串字面量。** 它能抓住 `open` 那次，而 `open`、`diff`、`debug`、`once`、`send`、`which` 都是普通英文词，在一棵 node_modules 里到处作为事件名、CSS 类名和选项键出现。在载荷的 2927 个模块上实测，把扫描限制在解析调用点得到 14 个不同字面量、零误报；不加限制的形态不可用。

**保留 `RUNTIME_RESOLVED` 名单。** 每出现一次加一条，每次事故之后补一条。扩展遍历覆盖的是整类，而且只留一份名单而不是两份。

**把载荷启动得更彻底——跑一次搜索、加载每个插件。** 启动闸抓到 sharp 那次是因为开机就加载 sharp，同批的另外两个它没抓到。沿这条路走下去就是要把每个功能都跑一遍，而且删除暴露出来的样子仍然是缺包所导致的任意现象，而不是它自己的名字。

**从 `optionalDependencies` 元数据推导平台家族。** 对包很精确，但对 `node-pty/prebuilds/*` 完全看不见，那是一处没有任何 manifest 声明的平台分包。读目录名的分段两者都覆盖，而且在这棵树上正好选出 15 个平台分包目录、不多不少。

## 影响

一次载荷裁剪失误变成一条构建失败，点名是哪个包、证据在哪、该往哪份名单里加，而不是一次启动崩溃、一个悄悄失灵的功能，或者一份用户报告。

代价是一次暂存树的目录遍历、每份载荷一次目录遍历，以及把最终载荷里每个模块文件读一遍；相对一次本来就要拷 35000 个文件、打包 456 个入口的运行，它看不出来。

有四类运行期解析仍在覆盖范围之外。由片段拼出来、又不是平台分包目录的名字——比如从配置里按算出来的第三方名解析的插件——这里没有任何一条检查看得见。从来就不在闭包里的包是不可见的，因为每条检查都以暂存树为基准。只带两段中一段的平台目录（`prebuilds/darwin`）不会被认作平台分包。而通过别名或辅助函数拿到的解析器（`const r = import.meta.resolve`）躲得过字面量扫描，运行期从数据文件里读出来的名字同样如此。

读差集的那几条也随上游漂移，这正是它们不作主判据的原因。`@img/sharp-darwin-arm64` 在今天这棵树上是静态可达的，因为 `sharp/dist/sharp.cjs` 在一个平台分支里 require 了它；在发现第二行那批删除的那棵树上并非如此。死规则检查不随之移动。

`payload-gate.ts` 里的 `EXEMPTIONS` 按检查逐项收豁免，每项配一句写下来的理由，理由为空在加载时就失败。四张表现在都是空的。每条生效的豁免都会在每次构建开始时打印，于是理由已经过期的那条会一直显眼，而不会变成门禁的常态。

有一处宿主差异是已知且未豁免的。`stageWindowsVariants` 在任何宿主上都会取来平台分包家族的 win32 成员，所以 macOS 上的暂存树两个平台都有；Windows 宿主的树里没有 darwin 成员，那时 Windows 那侧的规则会什么都不丢、读起来像死规则。失败信息会列出该 parent 的实际条目，这正是它与"规则写错地址"的区别所在，而 `EXEMPTIONS['dead-rule']` 就是 Windows 宿主构建记录这件事的地方。
