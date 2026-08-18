# @deepseek-ai/dsh-pwa

[English](README.md) | 中文

`dsh web` 之上的组合层 PWA 插件:以命名 webserver 路由注册 `/manifest.webmanifest`(用完整的 standalone 清单遮蔽前端自带的最小静态清单)、`/sw.js`(导航请求网络优先、断网回退缓存壳)和 `/pwa/*` PNG 图标组,再通过 webserver 的 index tap 注入缺失的 head 引用(主题色、apple-touch 图标、service worker 注册)。前端构建零改动;挂上本插件后,桌面与 Android 的 Chrome/Edge 出现"安装应用",iOS Safari 获得正式的主屏图标。

## 挂载

包声明了 `dsh.bundle` 补丁,加进 profile 即自动激活为一个层,之后无需任何旗标:

```sh
pnpm --filter @deepseek-ai/dsh-pwa run build
pnpm dsh plugin --profile web add link:$(pwd)/apps/pwa
pnpm dsh web
```

移除:`pnpm dsh plugin --profile web remove @deepseek-ai/dsh-pwa`。

## 手机需要一条到服务器的路

后端跑不了在手机上,手机客户端就是这张经网络送达的可安装页面。`dsh web` 有意拒绝 `--host 0.0.0.0`(能连上端口就能以你的身份执行代码);[overlay/lan.patch.yml](overlay/lan.patch.yml) 是显式的选择性开关,在确认每台设备都属于你的网络里绑定全部接口。Service worker 安装还要求安全上下文:`http://127.0.0.1` 算,裸局域网 `http://<ip>` 不算——优先走 tailnet HTTPS 或带证书的反向代理;纯局域网 HTTP 下页面仍可用,Android 退化为普通快捷方式。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `appName` | `DeepSeek Harness` | 安装提示与系统应用列表名称 |
| `shortName` | `dsh` | 启动器图标下的短名 |
| `themeColor` | `#10131a` | 安装后窗口工具栏颜色 |
| `backgroundColor` | `#10131a` | 启动闪屏背景 |

图标是 `scripts/gen-icons.mjs` 生成的随包资产(确定性、零依赖);改设计后重跑脚本并提交 PNG。

## Known Limitations and Deferred Work

- Service worker 只缓存 index 壳:断网能打开应用框架,但所有 API 调用都依赖服务器。更深的离线能力属于刻意不做的范围。
- 图标画稿在构建期固定;`Config` 只覆盖清单身份信息。
