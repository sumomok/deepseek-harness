# Agent Note: Explorer 以可见窗口启动

Status: implemented

[English](2026-09-27-explorer-visible-window.md) | 中文

## 问题

在 Windows 桌面客户端上，**打开**和**在文件夹中显示**没有任何可见反应，日志里也没有记录。两者都走 [`runExplorer`](../../../../packages/util/native-command/src/path-opener.ts)，它通过 `runNativeCommand` 运行 `explorer.exe`。该运行器以 `execFile(command, args, { encoding: 'utf8', signal, windowsHide: true })` 启动每一条命令。Windows 把启动信息里的隐藏显示状态应用到程序显示的第一个窗口上，而对 Explorer 来说，这个窗口正是这次调用要打开的文件夹或选中窗口。两种情况下 Explorer 都以 0 或 1 退出，[Windows 打开交接](2026-09-22-windows-open-through-shell-resolution.zh.md)把两者都当作成功，因此没有失败进入日志。

根因在 Windows 11 25H2 build 26200.9457 上、用桌面客户端自带的 Node 可执行文件隔离出来。同一个调用 `execFile('explorer.exe', ['/select,', fileURL], { windowsHide: X })`，`X = true` 时不出现窗口，`X = false` 时打开 Explorer 并选中该文件。涉及的两种路径编码在命令行里手动输入都能用，因此目标编码不是原因。macOS 与 Linux 忽略 `windowsHide`；Windows Host 上每一次经过 Explorer 的打开和显示都受影响。WSL Host 从 Linux 进程启动 `explorer.exe`，Node 在那里忽略该选项。

## 决策

`NativeCommandRunner` 接受可选的第四个参数 `NativeCommandOptions { windowsHide: boolean }`。`runNativeCommand` 在签名里把它默认为 `{ windowsHide: true }`，现有调用全部保持隐藏窗口。`runExplorer` 传 `{ windowsHide: false }`，且是唯一这样传的调用方；`wslpath`、`open`、`xdg-open`、`defaults`、PowerShell 与目录选择器的命令仍以隐藏方式启动，不弹控制台窗口。

该选项与命令走同一个注入的运行器，因此唯一的 `PathOpenerInternals.run` 注入点，以及转发它的 open-in-app 路由，照旧能看到 Explorer 调用及其选项。

## 考虑过的替代方案

**给 Explorer 单独一个运行器。** 否决。`runExplorer` 将不再使用注入的 `run`，注入运行器的测试和调用方（包括 open-in-app 路由）就看不到 Explorer 调用，否则内部参数得再加一个运行器字段。

**在运行器内按命令名选择显示状态。** 否决。运行器要维护一份没有任何调用方声明的 GUI 程序名单，改名或带路径的 Explorer 会悄悄退回隐藏。

**所有命令都以可见窗口启动。** 否决。`wslpath`、`powershell.exe` 这类控制台工具每次调用都会闪出控制台窗口。

## 验证

| 证据 | 行为 |
|---|---|
| [runner.spec.ts](../../../../packages/util/native-command/tests/runner.spec.ts) | 调用不传选项或要求隐藏窗口时，`execFile` 收到 `windowsHide: true`；要求可见窗口时收到 `false`。 |
| [path-opener.spec.ts](../../../../packages/util/native-command/tests/path-opener.spec.ts) | Windows 上和 WSL 中每一次 Explorer 打开与显示都传 `{ windowsHide: false }`；`wslpath`、`open`、`xdg-open` 不传选项。经默认运行器时，`execFile` 以可见方式启动 Explorer、以隐藏方式启动 `wslpath`。把 Explorer 改回隐藏启动，这些用例失败。 |

## 后果

- Windows 上经过 Explorer 的打开和显示重新出现窗口，设置面板、产物、工作区和 open-in-app 的打开共用这一行为。
- Explorer 的退出码仍不能证明窗口已出现；交接照旧接受 0 和 1。
- 其余原生命令保持隐藏启动。新增的调用方若通过运行器启动 GUI 程序，需要自己传 `{ windowsHide: false }`。
- Windows 上的 `openNativeFileApplication` 仍以隐藏方式启动 `powershell.exe`，并从该进程调用所选处理器；处理器窗口是否受影响尚未实测。
