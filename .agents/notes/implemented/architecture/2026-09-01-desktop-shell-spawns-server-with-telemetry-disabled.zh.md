# Agent Note: 桌面壳以关闭遥测的环境启动服务器

Status: implemented

[English](2026-09-01-desktop-shell-spawns-server-with-telemetry-disabled.md) | 中文

## Problem

[本 fork 出厂即关闭会话遥测与插件清单上报](../process/2026-09-01-fork-kills-session-telemetry-and-plugin-inventory.zh.md) 在每个 profile 都会组合的 bundle 里关掉了通往 DeepSeek 的各行。这些行是补丁条目，叠在它们之上的补丁层——profile 补丁、home 级补丁、调用时的 `--patch`——可以替换其中一行，把 `session-telemetry-otel` 重新打开。桌面是本 fork 直接掌控服务器启动的那一个产品，因此它可以再加一重保证，不依赖底下叠的是哪些补丁层。

## Decision

[`apps/desktop-shell/src/server.ts`](../../../../apps/desktop-shell/src/server.ts) 的 `startServer` 在内置服务器的启动环境上设置 `DSH_TELEMETRY_DISABLED: '1'`。这个值在壳自身的环境之后、`spec.env` 之前展开，所以自行设置了该值的调用方（测试）仍能覆盖它。

`DSH_TELEMETRY_DISABLED` 是上游自己的硬性关闭开关。[`packages/boot/app-boot/src/profile-context.ts`](../../../../packages/boot/app-boot/src/profile-context.ts) 的 `resolveTelemetryPatch` 把任何非空值变成一条针对 `session-telemetry-otel` 行的 `disabled: true` 补丁，`readProfilePatches` 把这条补丁追加在所有 bundle、profile、home 与 overlay 层之后。因此无论下面各层怎么写，桌面服务器运行时遥测行都是关闭的。

这个开关只作用于这一行。`plugin-package-inventory-deepseek` 与 `session-log-deepseek` 没有环境变量开关；共享 Note 描述的 bundle 行就是它们唯一的关闭开关。

## Alternatives considered

**只依赖 bundle 行。** 对桌面否决：用户或将来的某个 bundle 层只要重述 `session-telemetry-otel` 行，上传就会重新打开，而桌面侧什么都不会察觉。环境变量开关施加在所有补丁层之后，所以无论如何都成立。

**另造一个覆盖另外两行的 fork 环境变量开关。** 否决：那是本 fork 要写文档、要维护的新配置面，而 bundle 行已经在桌面出厂的每一种组合里关掉了这两个插件。

## Consequences

即使某个补丁层重新启用该行，桌面服务器也无法上传会话遥测；要重新打开，只能改壳的启动环境。[`apps/desktop-shell/tests/server.spec.ts`](../../../../apps/desktop-shell/tests/server.spec.ts) 启动一个脚本化子进程，检查它默认能看到 `DSH_TELEMETRY_DISABLED=1`，且显式的 `spec.env` 条目能覆盖它。[`apps/desktop-shell/tests/desktop-composition-layer.spec.ts`](../../../../apps/desktop-shell/tests/desktop-composition-layer.spec.ts) 覆盖各 bundle 层组合出的行。
