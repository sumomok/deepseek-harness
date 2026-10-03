# Agent Note：控制台的模型请求不带面向开发者的提示词段落

Status: implemented

[English](2026-10-03-console-prompt-without-developer-sections.md) | 中文

## Problem

每个控制台部署都会把三段写给 DeepSeek Harness 开发者的内容发给模型。Web bundle 的 `web-runtime` 行出厂带 `surfaceContext: true`，它注册 `harness:source`（DeepSeek Harness 检出目录的路径，用来查看或扩展 DSH）与 `app:web-surface`（页面的本地 URL、`pnpm run dev:web`，以及如何重新构建 Web 产物）。`ui-deliverables` 注册 `ui:deliverable-file-references`，告诉模型何时调用 `present`，而两个控制台预设都不提供这个工具。控制台 persona 要求模型不描述工作目录与内部实现，同一次请求却交给它一个检出路径和开发服务器的说明。提示词还以 base `system-prompt` 行的固定句子 `You are an AI agent powered by DeepSeek Harness.` 开头；2026-10-03 问控制台助手它基于什么系统或框架运行，它答由 DeepSeek Harness 驱动。

## Decision

**控制台 bundle 给 `web-runtime` 配置 `surfaceContext: false`。** 这个开关只控制三处注册：两个提示词段落，以及这一行加进 shell 命令环境的 `DSH_WEB_URL` 变量。只有 `tool-bash` 与 `tool-pwsh` 通过 `shellEnv.collect` 读这个变量，两个控制台预设都不提供它们。补丁会替换一行的整个 config，所以控制台这一行照抄 Web bundle 的 `openBrowser`、`printUrl` 与 `trustedHosts` 的值；`tests/profile.spec.ts` 检查它的 config 等于出厂 config 且只改了 `surfaceContext`，Web bundle 以后新增的字段会让这项测试失败，而不是悄悄落回默认值。

**控制台 bundle 禁用 `ui-deliverables`。** 这个包没有 Config，它的段落无条件注册，它的 README 写明去掉这一行就是关掉这块界面的方式。这一行带的其余内容随之去掉：改动文件卡片（只在开启代码工作工具时绘制）、`present` 产出的交付卡片、收尾回答里可点击的文件路径，以及它们打开的审阅标签页。`ui-open-in-app` 把它的动作放在这些卡片里，所以它的注册不会触发。

**控制台 bundle 给 `system-prompt` 配置 `includeHarnessIdentity: false`。** `dsh-system-prompt` 的 README 写的是「仅当兼容性部署拥有完整系统提示词时设为 false」；控制台不是兼容性部署，也不拥有完整提示词，内容栏和文件、技能工具都会加自己的段落。同一份 README 说明这个开关只去掉那句固定开头，`dsh-system-prompt` 之外也没有任何源码读取 `harness:identity` 段落，所以这项改动只删一句话，之后提示词由各控制台预设的 persona 前缀开头。补丁会替换整个 config，所以这一行照抄 Web bundle 的 `personaPrefix` 与 `personaSuffix`，两者都被各控制台预设的 persona 遮蔽；`tests/profile.spec.ts` 检查这一行等于出厂那一行，只多了 `includeHarnessIdentity`。

**控制台的 Web 快照看到的是 bundle 的选择。** Web e2e 脚手架在全部 profile 层之上重新应用 `web-runtime`，以关掉 URL 行与浏览器交接，并沿用组合出的 `surfaceContext`。现在它把启用的 profile 包也组合进这个值，所以 `console-auto-compact` 钉住的是控制台自己的系统提示词。

## Alternatives considered

**给 persona 设 `complete: true`。** 它让 persona 成为整个系统提示词，内容栏的「已在展示的内容」规则和每个工具的指引段落也会一起被去掉。

**在每个名字下注册一个空的 scoped 段落。** scoped 段落会遮蔽同名的全局段落，空段落渲染为空，但出厂的行都不按配置的名字注册段落，所以这需要在控制台包里写新代码，而一行组合就能得到同样的结果。

**打一个核心补丁，让 `ui-deliverables` 的段落取决于 `present` 是否存在。** 控制台这条线在有受支持开关的地方用组合行取得行为，禁用这一行就是这样的开关。

## Consequences

控制台的模型请求里有 persona、内容栏的规则、文件与技能工具的指引，系统提示词里没有任何一句提到 DeepSeek Harness、它的检出目录、开发服务器或 `present`。第一轮的运行时上下文消息仍写着「DSH file policy」和「DSH file sandbox」；这段文字来自沙箱策略，不来自本 bundle 组合的行。控制台页面在收尾回答里不画改动文件卡片、交付卡片或文件链接。内容读取场景组合的是 Web bundle、内容栏、控制台预设的一份副本，以及重述这三行的 `apps/web/tests/console-prompt.overlay.yml`；它们的 `web-content-console` 钉子与 `console-auto-compact` 钉子里的系统提示词相同，`apps/web/tests/console-preset.spec.ts` 拿两份副本与本 bundle 逐一核对。
