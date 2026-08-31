# Agent Note: 让路径打开器给出可区分的“未找到”错误

Status: implemented

[English](2026-08-27-host-open-target-not-found.md) | 中文

## 问题

`dsh-api-session-controller` 中的 `openWorkspacePath`（浏览器会话界面打开工作区路径所走的 Remote 方法）把 opener 的所有失败——路径不存在、没有注册的应用程序、权限被拒、平台命令缺失——统统折叠成一个 `gateway/internal` 错误，只带一条自由文本消息。调用方若不解析消息文本就无法区分“这个路径不存在”与其他任何失败，而消息文本从未承诺过这样的约定。设置文档文本编辑器那条路径用的是 `settings-controller` 自己独立的一份实现，不在本决策范围内。

## 决策

`openWorkspacePath` 在调用原生 opener 之前先用 `stat` 检查已解析的路径。`ENOENT` 会应答封闭的 `RemoteError` 错误码 `session/path-not-found`，`details` 中带 `{ path }`；其余 `stat` 失败（权限、路径某一段不是目录、Windows 上瞬时的共享冲突）原样下沉，opener 自身的失败仍折叠进既有的 `gateway/internal`/`gateway/cancelled` 处理。该检查之所以放在调用 opener 之前，是因为 opener 是一条 shell 出去的平台命令（`open`、`xdg-open`、PowerShell 的 `Invoke-Item`），从来不是一次 Node fs 调用——它绝不会抛出本进程能读到可靠错误码的 `NodeJS.ErrnoException`，各平台自己的“找不到文件”文本也是非结构化、无法解析的。预检查是唯一能在所有平台上给出一致答案的办法。

由于 `stat` 本身是一次 await，若调用方的 abort 恰好在它进行期间落地，这个 abort 原本会在 opener 已经触发过之后才抵达它：一个只监听存活的 `abort` DOM 事件（而不额外在一开始轮询 `signal.aborted`）的 opener 将永远观察不到它，请求便会挂起。`openWorkspacePath` 在 `stat` 预检查之后、调用 opener 之前立刻重新检查一次 `signal.aborted`，因此在存在性检查期间发生的 abort 仍会应答 `gateway/cancelled`。

`session/path-not-found` 是 `RemoteErrorDetailsMap`（`packages/api/session-controller/src/types.ts`）中新增的一行，因此它会流经与其他任何 Remote 错误码相同的封闭联合类型 `RemoteError<'domain/code'>` 校验。`openWorkspacePath` 直接抛出这个 `RemoteError`——RPC 层在客户端把它解析成 `{ok: false, error: RemoteError}`，调用方读取 `.error.code === 'session/path-not-found'` 即可，中间不再经过任何包装异常类。

## 备选方案

**按平台解析原生 opener 自身的“未找到”文本。** 不予采纳：`open`、`xdg-open` 与 PowerShell 的 `Invoke-Item` 各自用非结构化文本报告目标缺失，解析它会很脆弱，且会随操作系统语言环境或平台版本漂移；预检查在所有平台上给出一致的答案。

**跳过预检查，依赖 opener 自身的拒绝。** 不予采纳：opener 是一条 shell 出去的平台命令，没有本进程能读取的结构化“未找到”信号；调用方仍将无法把 `session/path-not-found` 与其他任何 opener 失败区分开。

## 后果

调用方可以据 `error.code === 'session/path-not-found'` 分支处理，提供比通用失败更贴切的操作——例如提示重新选择文件，而不是展示一条原生平台错误。此后每次打开尝试都要多付出一次 `stat` 调用；在存在性检查失败的路径上，原生 opener 根本不会被调用，从而避免为一个注定无法解析的路径去起一个必败的子进程。`session-open-workspace-path.host.spec.ts` 覆盖了未命中/非 ENOENT 落空/`stat` 期间 abort 竞态三种场景，其既有场景也已改为暂存一个真实 `mkdtemp`+`writeFile` 文件或目录而非裸字面路径，因为该存在性检查是无条件生效的。

**退役条件。** 本补丁是针对上游尚未具备能力的临时 overlay：若上游自行区分出“路径不存在”这一 opener 失败，即退役该补丁，并让 fork 适配上游形式。
