---
description: "ctx.computer 的本地桌面提供方：stdio JSON-RPC 上的崩溃隔离 helper、操作系统回退，以及 dsh computer doctor。"
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use-local

[English](README.md) | 中文

## 概述

本包是 `ctx.computer` 已发布的本地后端。它通过 `ctx.subprocess` 启动 `lib/host.js`，并在 stdio 上使用换行分隔的 JSON-RPC。helper 在可用时加载 `@simular-ai/simulang-js`，否则使用操作系统回退。插件注册提供方 id `local` 并惰性启动 helper；崩溃对应 `COMPUTER_HOST_CRASHED`。当模型应驱动与 `dsh` 同一台机器上的 GUI 应用时选择它。`dsh computer doctor` 在不启动 Cordis 的情况下打印权限状态。

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

加载电脑操控服务和本提供方，然后运行 `dsh computer doctor` 并授予操作系统权限。

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- name: '@deepseek-ai/dsh-computer-use-local'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `requestTimeoutMs` | `30000` | 每次 RPC 超时 |
| `graceMs` | `5000` | helper 进程树的 SIGTERM 到 SIGKILL 宽限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-computer-use-local)是每个已接受字段及其 JSDoc 的详尽来源。

### 失败与恢复

首次使用会惰性启动 helper。helper 退出会使进行中的调用以 `COMPUTER_HOST_CRASHED` 失败；下一次调用会启动新 helper。缺失的操作系统权限表现为 `COMPUTER_PERMISSION_DENIED` 或 `COMPUTER_UNSUPPORTED`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

插件在 `ctx.computer` 上注册 `LocalComputerProvider`，并随 fiber 释放 helper。`ComputerHostClient` 在子进程管道上成帧 JSON-RPC 行。helper 中的 `handleComputerMethod` 分发到 `DesktopBackend`（simulang 或平台）。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件 apply |
| `src/provider.ts` | `ComputerProvider` 实现 |
| `src/client.ts` | stdio JSON-RPC 客户端 |
| `src/host.ts` | helper 入口 |
| `src/platform.ts` | 操作系统回退 |
| `src/doctor.ts` | CLI 探测 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [电脑操控子系统](../../../docs/subsystems/computer-use.zh.md)
- [驱动 GUI 应用](../../../docs/user/guide/computer-use.zh.md)
- [电脑操控能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-09-06-computer-use-capability-seam.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-computer-use`，它向模型渲染快照和截图，而本提供方不贡献提示或 schema。

#### KV Cache effect

无直接失效；具名消费者拥有任何请求前缀变化。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **Windows 仅限前台** — 合成输入无法瞄准后台窗口。
- **Wayland 输入不受支持** — 设置 `WAYLAND_DISPLAY` 时 doctor 报告 `inputInjection: denied`。
- **原生库是可选的** — 没有 simulang 时，无障碍快照抛出 `COMPUTER_UNSUPPORTED`，macOS System Events 的小路径除外。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

helper 仅使用 stdio；无监听 TCP 端口。TCC 附着到与 `dsh` 相同的责任进程。

</details>
