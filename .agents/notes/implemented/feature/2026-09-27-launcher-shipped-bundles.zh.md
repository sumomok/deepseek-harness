# Agent Note: 插件管理器列出启动器随附的组合包

Status: implemented

[English](2026-09-27-launcher-shipped-bundles.md) | 中文

## 问题

启动 profile 的应用可以从自身载荷提供组合包：它把每个包链接进平铺回退目录 `$DSH_HOME/profiles/node_modules`，并在 `dsh.profile.bundles` 里点名，不写 profile 依赖。[`listBundles`](../../../../packages/boot/plugin-manager/src/index.ts) 从 `dsh.profile.bundles`、profile 的 `dependencies` 与安装的 `dependencies` 读取名字，把这样的组合包报为 `installed: false, optional: false`。插件页只收已安装、可选或出错的组合包，所以这些组合包没有卡片、没有开关，也没有组件行开关。经 `setBundleEnabled` 关掉其中一个会把它的名字从 `dsh.profile.bundles` 删掉，此后三个来源都不再点名它，Host 不再列出它，任何页面都无法再把它打开。

启动器链接进来的 `web` profile 迁移插件，以及启动器自己的组合层，也是 `installed: false, optional: false`。因此页面无法从这两个字段认出启动器提供的插件。

## 决定

由启动器在 profile 清单里写明这个事实。`DshProfileManifest.shipped` 是启动该 profile 的应用从自身载荷提供的组合包名单；由启动器写入，DSH 内没有任何代码写它。`listBundles` 把这些名字并入它读取的名字，并对每一个报 `BundleInfo.shipped: true`。随附组合包无论 `dsh.profile.bundles` 是否选中都会列出；包缺失或没有组合包 patch 的随附名字带着问题列出。`setBundleEnabled` 展开保留 `dsh.profile`，关掉组合包不改动这份名单。`dsh.profile.shipped` 不是字符串数组时按没有名字处理，每个不同的值记一次警告；否则字符串会按字符列出多条，对象会让整次读取失败。`removable` 不变：只有 profile 自己的依赖也持有一份副本时，随附组合包才可卸载。

插件页把 `shipped` 组合包收进**已安装**，卡片和详情页都带**内置**标签。分组和没有卸载沿用现有规则：它不是 `optional`，而卸载只对 `installed` 提供。启动器不把组合层与迁移来的用户插件写进 `shipped`，所以它们和以前一样不出现在页面上。

## 考虑过的方案

**页面过滤条件收下所有已启用、未安装、非可选的组合包。** 否决。它会把迁移来的用户插件和组合层标成内置，而且组合包一关就从页面上消失。

**列出平铺回退目录里能解析到的所有组合包。** 否决。该目录还放着 CLI 应用的依赖闭包，列表会取决于安装的链接方式，而不是启动器随附了什么。

**把随附名单放在清单之外、由启动器自管的存储里。** 否决。Host 要多读一个输入，名单与 `dsh.profile.bundles` 也可能不同步。

## 测试

| 证据 | 行为 |
|---|---|
| [manager.spec.ts](../../../../packages/boot/plugin-manager/tests/manager.spec.ts) | 随附组合包关闭时带版本与组件行列出，没有 patch 与缺失的随附包带着问题列出，开启再关闭后 `dsh.profile.shipped` 不变，卸载被拒绝。把随附名字从名字集合或任一处带条件的写入中去掉，该用例失败。字符串、对象、混合数组各自按没有名字处理，两次读取只警告一次；接受它们、每次读取都警告或不警告，这些用例失败。 |
| [components.client.spec.tsx](../../../../packages/client/ui-plugin-manager/tests/components.client.spec.tsx) | 随附组合包开着或关着都出现在**已安装**下，各带**内置**标签；未随附的选中层不出现在页面上；详情页带标签与版本、没有卸载。从页面过滤条件去掉 `shipped`，该用例失败。 |

## 后果

- 随附组合包的启动器必须写入 `dsh.profile.shipped` 并保持更新，包括删掉不再随附的名字。
- 每次启动都把缺失的名字补回 `dsh.profile.bundles` 的启动器会覆盖用户的开关；尊重开关是启动器的责任。
- `setBundleEnabled(name, true)` 把名字追加到 `dsh.profile.bundles` 末尾。对组合层顺序有要求的启动器要在下次启动时恢复顺序。
- `list_bundles` 的结果现在带 `shipped`。
