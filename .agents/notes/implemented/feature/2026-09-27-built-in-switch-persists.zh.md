# Agent Note: 关掉的内置插件保持关闭

Status: implemented

[English](2026-09-27-built-in-switch-persists.md) | 中文

## 问题

桌面壳把十三个内置插件链接进 `$DSH_HOME/profiles/node_modules`，并列进 `desktop-shell` profile 的 `dsh.profile.bundles`。插件页关掉一个组合包的做法是把它的名字从这份清单里删掉。下一次启动时，[`seedExistingManifest`](../../../../apps/desktop-shell/src/profile-seed.ts) 发现名字不在，把它当作新构建新增的插件，又插了回去。用户的开关只维持到下一次启动。

名字缺席有两个原因，单看组合包清单分不出来：构建新增了这个插件，或者用户把它关掉了。启动需要一份记录，写明它已经把哪些内置插件放进过 profile。

## 决定

这份记录是 profile 清单里的 `dsh.profile.shipped`：载荷里的内置插件，不含组合层 `@deepseek-ai/dsh-desktop-app`。每次启动都把它改写成本次载荷的名单。`dsh.profile.bundles` 里缺席的内置插件，只有在本次启动开始时读到的记录里没有它时才加回；记录里有的就保持关闭，并在 `dsh-server.log` 里记 `left switched off built-in <name>`。关掉的内置插件的平铺回退链接保留，所以关着的时候新的载荷版本也会到达它，插件页也经这条链接读它的版本与组件行。组合层不在记录里，总会被加回。

核心补丁 `launcher-shipped-bundles` 读的正是同一个字段，所以插件页会列出每一个内置插件，开着或关着都带「内置」标签，没有卸载。

迁移：之前的构建播种的 profile 没有这份记录。它缺的内置插件照以前每次启动那样加回，并写入记录。之前没有任何构建能让内置插件保持关闭，所以不会丢掉任何用户的选择。

## 考虑过的方案

**把选择记在 `web-migration.json` 里。** 否决。那个文件记录的是 `web` profile 同步做了什么，Host 不读它，插件页仍然没有关着的内置插件的来源。第二份名单还要与清单保持一致。

**记录关掉的名字，而不是随附的名字。** 否决。插件页只写 `dsh.profile.bundles`；壳无论如何都得从名字缺席推断开关，而 Host 仍然需要随附名单才能显示关着的组合包。

**在 profile 的 patch 层里禁用组合包的行。** 否决。插件页的整包开关不写行，而禁用行会让组合包层仍然挂载着。

## 测试

| 证据 | 行为 |
|---|---|
| [profile-seed.spec.ts](../../../../apps/desktop-shell/tests/profile-seed.spec.ts) | 关掉的内置插件连续两次启动都不出现，仍在记录里、仍有链接；新的载荷版本改指它的链接，仍保持关闭；重新打开后保持打开，组合层挪到它之后；记录里没有的名字仍会加回；组合层总会被加回；没有记录的 profile 得到记录而组合包清单不变；格式不对的记录被替换。改成总是加回缺席的名字，或者不写记录，这些用例失败。 |

## 后果

- 重新打开的内置插件在下一次启动重排清单之前，排在组合层之后运行。
- 某个构建没带的内置插件会从记录里掉出去，之后重新带上它的构建会把它以打开状态加回来。
- `launcher-shipped-bundles` 并入 `develop` 之前，这份记录没有读者，插件页不显示内置插件的卡片。
