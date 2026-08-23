# Agent Note: 由 host 配置的预设自行指定选择器 glyph

Status: implemented

[English](2026-08-23-permission-preset-glyph.md) | 中文

## 问题

Web composer 的权限选择器为每一行绘制一个来自封闭设计集的盾形 glyph：`read-only` 用对勾，`workspace-write` 用铅笔，`danger-full-access` 用感叹号。它按选项自身的 value 选择 glyph，因此只有三个内置预设 id 能命中。

自行配置预设的部署——例如保留审批提示的完全权限组合——因此在两个带图标的行之间渲染成纯文本行；当这类预设或派生的 `custom` 状态成为当前值时，触发按钮也会失去图标。选项投影没有给客户端更好的办法：`PresetOption` 只携带 `value`、`name` 与 `description`，客户端无法为从未见过的名称猜出合适的 glyph。

## 决策

`PresetSpec` 与 `PresetOption` 携带可选的 `glyph`，取值为 `read-only`、`workspace-write` 或 `danger-full-access`——设计集已有的三个 glyph 的名称。`PermissionPresetService.optionOf` 原样传出已配置的 glyph，`permissions` 投影的 wire schema 也携带它，因此所有展示层读到的都是 host 配置的同一个选择。

该字段在 schemastery `Config` schema 与投影的 zod wire schema 中都是封闭枚举，因此集合之外的名称会在插件加载时失败并指出出错路径（`$.presets.<name>.glyph`），而不是等到渲染时。

`PermissionSelect` 按 `permissionGlyph(option.glyph ?? option.value)` 解析每一行；设计集之外的任何键现在绘制裸盾形轮廓——对勾与感叹号 glyph 本就构建在该轮廓之上。触发按钮采用同一套解析。因此每一行与触发按钮都带有尺寸一致的图标，包括不指定 glyph 的派生 `custom` 状态。

## 备选方案

**从预设的沙箱级别推导 glyph。** 不予采纳：选项投影刻意不携带任何 knob 取值——客户端渲染 label 与 description，沙箱模式经由自身事件抵达模型与工具。从 knob 推导展示会给 `sandbox/mode` 增加第二个消费方，而且对那些「knob 无法描述自身要点」的预设仍然是错的，例如以审批提示兜底的完全权限。

**允许预设指定任意图标名。** 不予采纳：这些 glyph 是以内联 SVG 绘制的设计集，而不是图标库。自由格式的名称要么解析失败，要么诱使 host 通过配置投送美术资源。

**只加裸轮廓兜底，不加 `glyph` 字段。** 不予采纳：这只修复了对齐，没有修复语义。「带审查的完全权限」这类预设应当能显示完全权限盾形，而不是中性轮廓，而只有 host 知道这一点。

**把映射留在客户端，并补上 fork 的预设名称。** 不予采纳：客户端无法枚举 host 配置，把特定部署的 id 写死进随产品发布的组件正是本次变更要消除的缺陷。

## 后果

host 现在无需改动客户端即可决定自有预设的展示，选择器也不再存在无图标状态。glyph 集合保持封闭，因此新增第四个 glyph 需要同时改动设计集、枚举与两处 schema。不指定 glyph 的预设行为不变：它仍按自身 id 解析，三个内置 id 的表现与此前完全一致。

**退役条件。** 本次变更在 fork 中以临时 overlay 形式承载。若上游获得等价能力——让 host 配置的预设选择自己的选择器美术资源，无论采用何种形式——即退役该 overlay，并让 fork 的插件适配上游形式；绝不与之并行维护同一行为的 fork 实现。

客户端的 aria 树没有变化——这些 glyph 带 `aria-hidden`，任何浏览器快照都观察不到它们。覆盖来自 `permission-presets` 的 schema 与投影测试，以及 `PermissionSelect` 组件测试：后者固定了具名 glyph、兜底轮廓，以及触发按钮与行采用同一解析。
