# Agent Note: The desktop's model catalog follows upstream

Status: implemented

[English](2026-10-01-desktop-model-catalog-follows-upstream.md) | 中文

## 问题

从 0.1.0-rc.32 到 rc.36,桌面端选择器只列出一个 DeepSeek 模型,而上游列出两个。[桌面组合层](../feature/2026-09-06-desktop-composition-layer-content-search.zh.md)的 `llm-deepseek` 行重述了一张只有一行的 `models` 表——`deepseek-flash`,名为 `DeepSeek-V4.1-Flash`,下面一句中文 `V4.1 Flash · 文本与图片`——而 `models` 会整表替换适配器的 `DEFAULT_MODELS`。上游在 0.2.0-rc.2 基座上的目录是 `deepseek-flash`(`DeepSeek-V41-Flash`,文本与图片)和 `deepseek-v4-pro`(`DeepSeek-V4-Pro`,只收文本)。那张表删掉 V4 Pro,依据的是 DeepSeek 关于 2026-09-14 起 V4 Pro 请求转给 V4.1 Flash 的公告;DeepSeek 在 2026-09-10 的更新日志里撤回了这一安排,它的定价页仍以 V4 Pro 自己的价格列出 `deepseek-v4-pro`。所有者在 2026-10-01 定下:模型清单以上游为准。

差异来自本 fork 的两处。组合层的那张表是一处。[`@haoran/dsh-default-model`](../feature/2026-08-23-desktop-builtin-default-model.zh.md) 是另一处:它设的 `agent-default-model` 与 dsh-base 出厂的是同一对,它设的 `models` 表又总被组合层整块替换,而插件页仍把它描述为一个只有一个模型的选择器的来源。

把两者从载荷里拿掉,到不了每一台机器。从 0.1.0-rc.34 起,在模型页保存一次会把这一行组合后的整份 `config` 写进 `$DSH_HOME/profiles/desktop-shell/cordis.patch.yml`,服务端一次性导入 `settings.yaml` 的某一节也走同一条写入路径,所以凡是保存过 DeepSeek 设置、或导入过这样一节的机器,都存着当时 bundle 层带的那张表。这一层在每一个 bundle 层之后生效。rc.33 及更早的客户端把设置存在 `settings.yaml` 里,用户动过模型页的模型列表而没有改出差异时,那里也存着一张表。

## 决策

**`apps/desktop-app/cordis.patch.yml` 的 `llm-deepseek` 行只设 `retryPolicy`**,于是 `resolveModels` 回落到 `DEFAULT_MODELS`,两个选择器都按上游的名字列出上游的两行。

**撤下 `@haoran/dsh-default-model`。**它的名字从 [`profile-seed.ts`](../../../../apps/desktop-shell/src/profile-seed.ts) 的 `BUILTIN_WEB_BUNDLES` 移到 `WITHDRAWN_WEB_BUNDLES`:之前的构建播种过它的 profile 会删掉这个名字,并移除壳自己建的扁平兜底链接,而装进 profile 的副本保留它的条目。它的 tarball、`file:` 标识符、锁文件条目与署名 override 一并删除。新会话从 dsh-base 自己的 `agent-default-model` 起步,即 `deepseek-official` / `deepseek-flash`,也就是那个包设的那一对。

**[`model-catalog-migration.ts`](../../../../apps/desktop-shell/src/model-catalog-migration.ts) 只删本 fork 某个版本分发过的表。**它只运行一次,在设置迁移之后、服务端启动之前。profile 层 `llm-deepseek` 行的 `models`,以及服务端即将导入的 `settings.yaml` 里 `llm-deepseek` 一节的 `models`,只要等于三张表之一就被删掉:组合层 rc.34 到 rc.36 的那张;它在 rc.32 与 rc.33 的前身,多写了图片预算、没有 `toolUpdate`;以及 `@haoran/dsh-default-model` 0.1.2 在 rc.20 到 rc.30 带的三行表。相等按解析后的值判断,不计键的顺序,计行的顺序。这一行的其余键都保留。用户改过的表保留并记录下来;模型页把它显示为已自定义的目录,旁边是恢复默认的按钮。

**用户存下的东西,上游怎么处理就怎么处理。**上游 0.2.0-rc.2 不改写任何已存的模型 id,也不做别名:[它的 pi-ai 目录恢复](../bug-fix/2026-09-07-pi-ai-settings-catalog-recovery.zh.md)在加载时不改写任何用户配置,LLM 运行时写明不做夹紧、不做别名([`packages/llm/llm/src/index.ts`](../../../../packages/llm/llm/src/index.ts)),[模型选择 README](../../../../packages/client/ui-model-selection/README.zh.md) 保留目录已不再列出的已存选择。所以这次迁移不读任何已存的模型选择、思考档位、pi-ai 路由、子智能体允许列表、审查模型或看图切换目标,也不弹任何提示。选着 `deepseek-v4-flash` 的照常能用于文本,因为 DeepSeek 用 V4.1 Flash 为这个名字提供服务,选择器把它显示为原始 id;选着 pi-ai 0.87.1 删掉的模型的,每一轮都失败,直到用户重新选一次,与上游相同。

**`settings.yaml` 等设置迁移完成。**`settings-migration.json` 读到 `done` 之前,那次迁移可能在之后某次启动从 `settings.yaml.pre-rc34` 把迁移后的副本写回来,所以这一步先清 profile、记下 `settingsDeferred`,等到某次启动发现设置迁移已完成,再在那次启动的服务端导入之前清这个文件。

**记录是一个单独的文件**,即桌面 profile 里的 `model-catalog-migration.json`,在它所描述的文件写完之后才写。`done` 让之后的每次启动都跳过这次运行,所以用户之后再建的表会留着。运行中的故障只是一行日志,记录保持上一次写完时的样子;启动照常继续。

## 目录变化让 V4 Pro 会话付出什么

上游的 `deepseek-v4-pro` 一行既没有声明 `systemPromptUpdate: in-history`,也没有声明 `toolUpdate: addition-only`,而它的 `deepseek-flash` 一行两者都声明了。因此在 V4 Pro 会话里,会话中途系统提示词变化时,循环改写系统节点 0,而不是追加在缓存的历史之后;每次请求都声明完整的工具列表,会话中途加入的工具会改动缓存历史之前的声明;两者都让供应商的前缀缓存从第一个 token 起失效。这是上游出厂目录的样子,本部署不为补这两个字段去重述那一行。

V4 Pro 会话里发送的图片会经过 `@haoran/dsh-vision-switch`,它在发送前通过 `session.selectModel` 把会话切到 `deepseek-flash`。这次调用同时把 Flash 存为默认模型,所以之后新建的会话也从 Flash 起步,而这个会话会停在 Flash,直到用户再选回 Pro。

壳没有定义 `dshDesktop` 全局变量,所以上游的页面像在 `dsh web` 下那样组合:0.2 的「预览版说明」会注册,并在第一次进入空白新对话页时显示一次;账号登录那一节不注册,所以这个应用不提供 DeepSeek 账号登录。

## 备选方案

**继续重述那张表,加上 V4 Pro,保留带点的名字。**这样能保住 fork 的标签,也留下了一张需要手工追上游每次目录变化的表,而所有者的决定排除了这一点。它还会让冻结在 profile 里的那些副本原样留着。

**把已下线的 id 映射到现有的 id。**有一种设计把每条路由上的 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 映射成 `deepseek-flash`,把 pi-ai 删掉的 id 回落到默认模型,清掉收窄后不再提供的思考档位,改写 `modelOverrides` 与允许列表,并弹出一条提示。上游对自己的用户一样都不做,而这里的决定是让 fork 用户的状态等于同版本上游用户的状态;只撤回本 fork 自己放进 profile 的东西。

**清掉这一行上任何一个 `models` 值。**更简单,但会丢掉用户自己编辑过的表。与某张分发过的表相等,正是区分冻结副本与用户编辑的依据。

**把这次运行记在 `settings-migration.json` 里。**那个标记一旦是 `done` 就提前返回,而没完成的运行会从一个新对象改写它,丢掉它不认识的字段,所以加在那里的字段恰恰会在需要它的那几次启动里丢失。

**在服务端清这些表。**只有壳运行在服务端导入 `settings.yaml` 之前,而服务端的一步需要为一次 fork 专属的迁移改动核心。

**把 `@haoran/dsh-default-model` 当作空操作留着。**它的两行都早已不起作用,插件页却一直列着它,描述的是一个已不存在的选择器。

## 后果

全新安装,以及 profile 里存着分发过的表的机器上,选择器的 DeepSeek 组列出 DeepSeek-V41-Flash 与 DeepSeek-V4-Pro;V4 Pro 的请求按 V4 Pro 自己的价格计费,DeepSeek 定价页上它高于 Flash。插件页列出十三个内置插件。

存着编辑过的表的机器会一直保留它,直到用户在模型页恢复默认。rc.30 或 rc.33 的编辑器写下的表,只要有任何一个字段的规范化与分发的值不同,就被当作编辑过而保留;完全相等这条规则宁可多留。会话日志不被改写,所以记在 pi-ai 删掉的模型上的对话,需要在那个对话里重新选一次。

只要还有 0.1.0-rc.36 或更早的安装可能升级到之后的构建,`WITHDRAWN_WEB_BUNDLES` 就必须保留 `@haoran/dsh-default-model`;只要这样的机器还可能第一次运行这一步,这三张表就必须留在 `SHIPPED_MODEL_TABLES` 里。

[`desktop-composition-layer.spec.ts`](../../../../apps/desktop-shell/tests/desktop-composition-layer.spec.ts) 检查组合出的 `llm-deepseek` 行只带 `retryPolicy`、适配器自己的 `Config` 把它解析为适配器的出厂目录、会话从 dsh-base 自己的默认值起步、目录里列着这个默认值;把旧表加回这一行会让它失败。[`model-catalog-migration.spec.ts`](../../../../apps/desktop-shell/tests/model-catalog-migration.spec.ts) 覆盖每一张分发过的表、键顺序不同的表、编辑过的表、它不写的行、其余各行与 `!!js` 表达式逐字节不变的 profile、设置迁移完成前后的 `settings.yaml`、之后的启动,以及失败的运行;去掉标记检查,或把判定放宽到任何 `models` 值,都会让它失败。没有任何无 key 的录制会话快照运行桌面 profile,所以没有录制会话覆盖桌面目录;上游的 Web 金样,例如 `apps/web/tests/expected/onboarding-deepseek-config/default-models.expected.md`,已经显示它现在列出的这两行。

## 相关

[桌面安装包自带出厂默认模型](../feature/2026-08-23-desktop-builtin-default-model.zh.md)记录这个被撤下的包为什么加入、在 rc.36 之前做了什么。[桌面组合层](../feature/2026-09-06-desktop-composition-layer-content-search.zh.md)负责 `llm-deepseek` 行的重试策略。[撤下贩售进来的右侧栏](2026-09-14-desktop-withdraw-better-sidebar.zh.md)是 `WITHDRAWN_WEB_BUNDLES` 的先例。
