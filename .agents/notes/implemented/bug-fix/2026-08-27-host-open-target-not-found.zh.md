# Agent Note: 让路径打开器给出可区分的“未找到”错误

Status: implemented

[English](2026-08-27-host-open-target-not-found.md) | 中文

## 问题

`dsh-host-apiproxy` 中的 `openTarget`（`host.openPath` 与设置文档文本编辑器移交共用的实现）把 opener 的所有失败——路径不存在、没有注册的应用程序、权限被拒、平台命令缺失——统统折叠成一个 `internal` RPC 错误，只带一条自由文本消息。调用方若不解析消息文本就无法区分“这个路径不存在”与其他任何失败，而消息文本从未承诺过这样的约定。

## 决策

`openTarget` 在调用原生 opener 之前先用 `stat` 检查已解析的路径。`ENOENT` 会应答封闭的 RPC 错误码 `not-found`，`details` 中带 `{ path }`；其余 `stat` 失败（权限、路径某一段不是目录、Windows 上瞬时的共享冲突）原样下沉，opener 自身的失败仍折叠进既有的 `internal`/`cancelled` 处理。该检查之所以放在调用 opener 之前，是因为 opener 是一条 shell 出去的平台命令（`open`、`xdg-open`、PowerShell 的 `Invoke-Item`），从来不是一次 Node fs 调用——它绝不会抛出本进程能读到可靠错误码的 `NodeJS.ErrnoException`，各平台自己的“找不到文件”文本也是非结构化、无法解析的。预检查是唯一能在所有平台上给出一致答案的办法。

由于 `stat` 本身是一次 await，若调用方的 abort 恰好在它进行期间落地，这个 abort 原本会在 opener 已经触发过之后才抵达它：一个只监听存活的 `abort` DOM 事件（而不额外在一开始轮询 `signal.aborted`）的 opener 将永远观察不到它，请求便会挂起。`openTarget` 在 `stat` 预检查之后、调用 opener 之前立刻重新检查一次 `signal.aborted`，因此在存在性检查期间发生的 abort 仍会应答 `cancelled`。

`not-found` 是 `RpcErrorDetailsMap` 与 `rpcErrorSchema`（`packages/host/apiproxy/src/api/rpc.ts`、`rpc.schema.ts`）中新增的一行，因此它会流经与其他任何 RPC 错误码相同的封闭联合类型校验。`WorkspaceRuntime.openPath`（`packages/client/runtime/src/client/workspaces/service.ts`）现在抛出 `PathOpenError`——以 `readonly rpcError` 携带 Host 的 `RpcError`——而不是裸 `Error`，与既有的 `WorkspaceCreateError`/`DirectoryBrowseError` 模式一致。`PathOpenError` 的消息文本与它所取代的 `Error` 保持不变（`path open failed: ${rpcError.message}`，不插入错误码），因此这是一次纯增量的变更：只读取 `.message` 的调用方——包括文件打开失败的 Host 拒绝弹窗，其确切文本被一份快照 fixture 固定——看到的字符串与此前完全相同，而读取 `.rpcError.code` 是新增能力。

## 备选方案

**按平台解析原生 opener 自身的“未找到”文本。** 不予采纳：`open`、`xdg-open` 与 PowerShell 的 `Invoke-Item` 各自用非结构化文本报告目标缺失，解析它会很脆弱，且会随操作系统语言环境或平台版本漂移；预检查在所有平台上给出一致的答案。

**完全对齐 `WorkspaceCreateError`/`DirectoryBrowseError`，把错误码并入 `PathOpenError` 的消息。** 不予采纳：Host 拒绝弹窗已经原样渲染 `PathOpenError.message`，一份快照 fixture 固定了其确切文本；插入错误码会是一次可见的、未被要求的 UI 文案改动，而任务要求以不破坏兼容的方式新增该能力。以字段形式携带 `rpcError` 才是调用方需要的、不破坏兼容的扩展。

**跳过预检查，依赖 opener 自身的拒绝。** 不予采纳：opener 是一条 shell 出去的平台命令，没有本进程能读取的结构化“未找到”信号；调用方仍将无法把 `not-found` 与其他任何 opener 失败区分开。

## 后果

调用方可以据 `PathOpenError.rpcError.code === 'not-found'` 分支处理，提供比通用失败更贴切的操作——例如提示重新选择文件，而不是展示一条原生平台错误。此后每次打开尝试都要多付出一次 `stat` 调用；在存在性检查失败的路径上，原生 opener 根本不会被调用，从而避免为一个注定无法解析的路径去起一个必败的子进程。`dsh-host-apiproxy` 与 `dsh-client-runtime` 中此前用裸字面路径驱动 opener 的若干测试 fixture，现在改为暂存一个真实文件或目录，因为该存在性检查是无条件生效的。

**退役条件。** 本补丁是针对上游尚未具备能力的临时 overlay：若上游自行区分出“路径不存在”这一 opener 失败，即退役该补丁，并让 fork 适配上游形式。
