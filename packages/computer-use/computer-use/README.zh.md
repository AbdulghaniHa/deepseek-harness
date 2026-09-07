---
description: "电脑操控服务（ctx.computer）：部署和插件作者如何通过可替换提供方驱动 GUI 应用，并带有授权、拒绝列表和命中测试。"
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use

[English](README.md) | 中文

## 概述

任何插件或工具都可以通过 `dsh-computer-use`（`ctx.computer`）列出应用、快照窗口并注入输入，而无需绑定原生 GUI 库。提供方作为后端接入，服务选出一个可用提供方，因此调用方不必跟踪背后运行的 helper。在构建桌面工具或另一个后端时选择它；已发布的面向模型工具（`dsh-tool-computer-use`）会自动挂载它。服务本身不做操作系统 GUI 调用，也不注册面向模型的工具：必须先挂载提供方，应用或输入调用才能运行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

需要桌面 GUI 访问的组合加载 `dsh-computer-use` 服务并至少挂载一个后端，然后插件或工具作者通过 `Agent` owner 调用 `ctx.computer.listApps()`、`snapshot()` 和 `click()`。服务为每次调用解析后端，因此除非配置了提供方 id，调用方看不到它。

### 何时选择它

当插件或工具必须驱动 GUI 应用且不能硬编码原生库时选择该服务。只使用已发布 `computer_*` 工具的部署会通过 `dsh-tool-computer-use` 免费获得它。组合从不触及桌面时不需要它。服务自身不提供桌面访问：没有至少一个可用提供方时，每次调用都以结构化 `ComputerError` 失败。

### 最小配置

加载服务并让单个已挂载后端自动选择，或用 `provider` 钉住提供方 id。`$DSH_COMPUTER_PROVIDER` 填入同一字段，不是单独的优先级链。

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- name: '@deepseek-ai/dsh-computer-use-local'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `provider` | （未设置） | 钉住的提供方 id；未设置时在恰好一个可用时自动选择 |
| `deniedApps` | `[]` | 固定终端列表之外的额外拒绝标记 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-computer-use)是每个已接受字段及其 JSDoc 的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`ComputerRuntime` 是 `ctx.computer` 上的 Cordis `Service`。选择语义与 `BrowserRuntime` 相同：配置的 id，否则恰好一个可用提供方。授权是以 `Agent` 对象身份为键的 `WeakMap`。拒绝检查和 `windowAtPoint` 命中测试在运行时执行，因此直接调用方无法跳过工具。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 注册表、授权、拒绝、命中测试 |
| `src/types.ts` | 提供方词汇和 `ComputerError` |
| `src/deny.ts` | 终端标记和 harness pid |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [电脑操控子系统](../../../docs/subsystems/computer-use.zh.md)
- [电脑操控包地图](../README.zh.md)
- [dsh-tool-computer-use](../tool-computer-use/README.zh.md)
- [电脑操控能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-09-06-computer-use-capability-seam.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-computer-use`，它向模型渲染快照和截图，而本服务不贡献提示或 schema。

#### KV Cache effect

无直接失效；具名消费者拥有任何请求前缀变化。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **没有观察面** — 可用性只能通过运行一次调用并路由抛出的代码来观察。
- **启动不要求授权** — 启动后的身份直到提供方返回才知道；消费者随后运行授权流程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

授权按精确 `Agent` 对象身份隔离，而不是 session-id 字符串相等。

</details>
