# Agent Note: 桌面安装包自带出厂默认模型

Status: implemented

[English](2026-08-23-desktop-builtin-default-model.md) | 中文

## Problem

全新桌面安装的第一个会话开在 `deepseek-v4-flash` 上,因为那是 `@deepseek-ai/dsh-base` 携带的 `agent-default-model` 组合配置项,而 `@deepseek-ai/dsh-base` 是 harness 编排的每一个 profile 的基础层。旁边的模型选择器列出 `@deepseek-ai/dsh-llm-deepseek` 出厂目录里的三条建议行,其中唯一带视觉的那个模型被标为 `DeepSeek-V4-Flash-Vision-Exp`。这两件事都是部署选择,却穿着上游默认值的外衣:桌面客户端要的是首次启动就开在视觉模型上、而且选择器那一行读起来就是默认值,这两样都不该写进一个每个 CLI 安装都会编排的包里。

`@haoran/dsh-default-model` 正是为回答这件事而写的,它的 README 也写明了它期待的交付方式:vendor 进内嵌服务端闭包,首次启动时播种进 web profile 的 `dsh.profile.bundles`。本仓库没有它的任何版本。桌面载荷里有四个内置插件,它不在其中,这个包存在的意义——那个部署默认值——在哪台机器上都没有生效。

## Decision

把 `@haoran/dsh-default-model` 0.1.1 与另外两个 `@haoran/` tarball 一起 vendor 到 `apps/desktop-server/vendor/` 下,并在 `BUILTIN_WEB_BUNDLES` 里写上它的名字,于是 `apps/desktop/src/profile-seed.ts` 会在内嵌服务端读取 profile 之前把它放进 `desktop` profile。它是第五个内置插件,也是最后一个 bundle 层,正因为在最后,它才定得下前四个都不去碰的那些条目。

**这个包只是一个 patch 层,别的什么都不是。**它没有 `src/`、没有 `lib/`、也没有入口点,全部实质就是 `cordis.patch.yml`。这行得通是因为 harness 从不 import 一个 bundle:`loadProfile` 读 bundle 包的清单,取 `dsh.bundle.patch` 里的路径,再解析那份 YAML。同一条声明也是它留在载荷里的原因——`scripts/bundle-closure.ts` 会删掉每一个没有可达代码 import 的第三方包,而把声明了 `dsh.bundle` 的清单当作要完整保留的 profile bundle。它没有声明 `dsh.client`,所以打包构建的 client 模块检查会跳过它:默认模型属于编排,不是页面要加载的东西。

**两条 id 定向覆盖,两条都是完整值。**`agent-default-model` 变成 `{provider: deepseek-official, model: deepseek-v4-flash-vision-exp}`,于是没有会话级选择就创建出来的 Agent 从视觉模型起步。`llm-deepseek` 拿到一份 `models` 目录,它逐字重述那两条未改动的出厂行,并把第三条重标为 `default`。同一个弹层里还有一档同样叫 `Default` 的推理强度,而选择器的触发按钮把一次选择拼作 `<model> · <effort>`,所以钉在这一行上的会话读作 `default · Default`。这一行的 `id` 没有变,所以重标从不上到线上。

**两个块都写成完整的 config 值,因为 patch 机制不给别的选择。**`applyEntryPatches`(`vendor/include/src/index.ts`)按 `id` 把 patch 匹配到条目,然后把 patch 的每个顶层 key 赋上去——`target[key] = value`——所以 `config` 是整块替换条目原有的 config,前一层设过而这一层没写的任何 key 都退回插件的 schema 默认值。在这一层这不花什么代价:`dsh-base` 根本没给 `llm-deepseek` 任何 config,给 `agent-default-model` 的也正是这个包要设的那两个 key。但这是之后每一层都继承的规则,包括用户自己的 `cordis.patch.yml`。

**播种按名字来,所以这里不需要任何与版本相关的处理。**`seedBuiltinBundles` 会把缺的名字追加进已有 profile 的 `dsh.profile.bundles`,并把包链接进 `$DSH_HOME/profiles/node_modules`,两件事都是追加式且幂等的;patch 层本身则在每次启动时从随包的那份副本读取。已经在跑某个桌面构建的机器,会把这个名字追加在它已列出的四个之后,而这正是这一层需要的位置。

## 已有安装看到的是什么

已经选过模型的用户保留他自己的选择。`$DSH_HOME/settings.yaml` 是一份实时读取的设置文档,它的 `agent-default-model:` 分节——正是有人在 web UI 里选模型时写下的东西([默认模型跟随选择器](2026-08-07-default-model-follows-the-picker.zh.md))——位于每一个 bundle patch 层之上。这个包设定的是你还没选之前拿到的东西,绝不是压在你的选择之上。

对这样的用户确实变了的是选择器那一行:无论他存着什么选择,视觉模型都会列作 `default`,因为这份目录是组合配置项,不是逐用户的。他自己的 `cordis.patch.yml` 不受影响,播种从不编辑用户 patch 层。

## Alternatives considered

**把默认值挪进 `@deepseek-ai/dsh-base` 或 `PROFILE_TEMPLATES`。**改一处、不添新包,而且能覆盖全新 profile。否决,因为两者都是每个 CLI 安装都会编排的已发布面:`dsh-base` 是每个 profile 的基础层,而模板是 harness 为它自己创建的 profile 给出的答案。一个部署偏好的模型不是 harness 的默认值,视觉模型的选择器标签也是某一个客户端的产品决定。

**交给逐用户的 profile patch。**`$DSH_HOME/profiles/desktop/cordis.patch.yml` 能为一台机器设定这两个条目,机器本地的覆盖本就该写在那里。作为交付机制被否决,因为 profile 是用户数据:`initProfile` 只写一次,播种也刻意从不回头改它,所以这个文件在现有的每一个安装上都已经存在,只能一台台手工去编辑。对想要另一个默认值的人,它仍然是对的位置,并且仍然在这一层之上。

**在 `@deepseek-ai/dsh-llm-deepseek` 上游重标那一行。**目录本来就是那个适配器的,在那里把 `DeepSeek-V4-Flash-Vision-Exp` 改个名字,就不需要重述整张表。以与 `dsh-base` 相同的理由否决:那个标签之所以读作 `default`,只因为这个部署把它当默认值,而在任何不这么做的安装里它都是假话。

## Consequences

全新桌面安装的第一个会话开在 `deepseek-v4-flash-vision-exp` 上,于是无需任何人去选模型,图像输入就是通的,选择器也把那一行称作它本来就是的默认值。版本和其他每个内置插件一样属于安装包:换版本意味着发一个桌面构建。

重述出来的 `models` 表是整表替换——`resolveModels` 读的是 `config.models ?? DEFAULT_MODELS`,从不把两者合并——所以上游给 `@deepseek-ai/dsh-llm-deepseek` 新增的模型,在被加进这张表之前不会出现在选择器里。把两者拴在一起的是插件自己的 `tests/patch.spec.ts`:它从适配器的 `Config` schema 里读出已安装的目录逐行比对,又读 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 断言两个被 patch 的 id 仍在其中。这些检查活在插件自己的仓库里,按它 devDependencies 钉住的版本运行,所以本仓库目录的改动是在插件下一次构建时被抓住,而不是被这里的任何闸抓住。

视觉行上有三个字段是刻意不写的——`contextWindow`、`imagePixelBudget` 与 `imageMaxBytes`——因为每一个都退回出厂行自己携带的那个适配器值。继承让这张表不去钉死上游可能会挪的数字;漂移测试会拿每一个被继承的值与已安装的适配器比对。

一条 id 定向 patch,若目标 id 已经不在,就什么都不作用:`applyEntryPatches` 往 loader 日志写一行 `patch: entry <id> not found` 然后继续。那一行进的是服务端日志而不是任何用户眼前,所以 `dsh-base` 里对 `agent-default-model` 或 `llm-deepseek` 的一次重命名,会在这里悄悄把出厂默认值恢复回去。今天这两个 id 在本仓库的 `dsh-base` 里都在,而插件对它们的断言正是其中之一被挪动时会失败的那道检查。

这是第一个全部作用都落在编排上、而不落在某个工具或某个页面上的内置插件,所以打包构建对它的证明比对其余几个要少。`verifyStagedBoot` 要求 `BUILTIN_WEB_BUNDLES` 里的每个名字都被播种、载荷都能启动,这覆盖了这个包确实随包走且能被解析;`verifyClientModules` 因为它没有 `dsh.client` 而跳过它。两条覆盖是否如期落地,由 `dsh --profile desktop --dump-config` 作答,不由某道闸作答。
