---
description: "在交给操作系统之前解析一个外部 URL，只允许调用方声明的协议，并以稳定原因拒绝危险或歧义目标。"
kind: "package-library"
---

# @deepseek-ai/dsh-external-url

[English](README.md) | 中文

## Summary

`dsh-external-url` 把链接、导航或配置的目标转换为规范的 `URL.href` 或稳定的拒绝原因，之后才由应用交给操作系统。调用方声明接受的协议；该库比较完整的 `URL.protocol` 值，要求 HTTP(S) 为绝对地址且不含凭证，并保留 `mailto:` 的编码字段而不预先解码。它不注册任何内容，也没有运行时依赖。

## Table of Contents

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

在可能把 URL 交给操作系统协议处理器的每个进程边界使用本包。`apps/desktop-shell` 和 `apps/desktop` 用它包装各自的 Electron `shell.openExternal` 调用；每个调用方声明自己的协议子集，因此发行下载只允许 HTTPS，而普通渲染链接也可以使用 `http:` 和 `mailto:`。

### 入口

```text
import { resolveExternalUrl } from '@deepseek-ai/dsh-external-url'

const result = resolveExternalUrl(target, ['https:'])
if (result.kind === 'allowed') {
  // Hand result.url to the OS.
} else {
  // result.reason is a stable refusal category.
}
```

`allowedProtocols` 必传。允许的结果携带 `url` 与 `protocol`；拒绝的结果只携带稳定的 `reason`，调用方无需重复记录原始目标。调用方不得从拒绝结果重建目标，也不得在拒绝时回退到 `target`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

解析按以下顺序进行：拒绝首尾空白、ASCII 控制字符和反斜杠；拒绝没有绝对 scheme 的目标；使用不带 base 的 `new URL(target)` 解析；要求解析出的协议在调用方列表中；最后要求 HTTP(S) 具有主机名且不含凭证。`mailto:` 保留解析器给出的编码路径和查询，不预先解码，也不当作完整邮箱地址解析。

顺序是契约的一部分。URL 解析器会清除制表符和换行符，因此这些字符先在原始目标上检查。反斜杠在解析前拒绝，因为 Chromium 和 WHATWG URL 解析会把它当作路径分隔符。协议不能靠前缀匹配判断：`httpsfoo:` 和 `httpx:` 是不同 scheme，在只允许 `https:` 或 `http:` 时会被拒绝。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security) — 为什么主进程在委托操作系统前必须校验 URL。
- [桌面 shell 导航](../../../apps/desktop-shell/src/navigation.ts) — 建立在本解析器上的 popup、导航和重定向策略。
- [util 组地图](../README.zh.md) — 本包所属的零依赖工具族。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **白名单不等于可信。** 被允许的 HTTPS 站点仍可能有恶意；本解析器不做声誉、用户手势或内容检查。
- **不做 SSRF 或目的地策略。** 它不解析主机名，也不拒绝私有地址；抓取而非外开的调用方需要自己的目的地规则。
- **不做邮箱地址校验。** `mailto:` 目标按解析结果保留，不校验地址是否有效，也不解释多个收件人或邮件头。
- **交接由调用方负责。** 只有调用方在调用 opener 前检查 `kind`，拒绝结果才能阻止操作系统调用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
