---
description: "ctx.computer 的本地桌面提供方：stdio JSON-RPC 上的崩溃隔离 helper、操作系统回退，以及 dsh computer doctor。"
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use-local

[English](README.md) | 中文

## 概述

本包是 `ctx.computer` 已发布的本地后端。它通过 `ctx.subprocess` 启动 `lib/host.js`，并在 stdio 上使用换行分隔的 JSON-RPC。helper 通过 `@simular-ai/simulang-js` v13 原生 addon 驱动桌面，该依赖声明为 `optionalDependencies`，因此 `pnpm install` 会为 macOS、Linux glibc 和 Windows 拉取预编译二进制；二进制缺失时 helper 使用不带无障碍树的操作系统回退。插件注册提供方 id `local` 并惰性启动 helper；崩溃对应 `COMPUTER_HOST_CRASHED`。当模型应驱动与 `dsh` 同一台机器上的 GUI 应用时选择它。`dsh computer doctor` 在不启动 Cordis 的情况下打印权限状态。

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
| `windowCacheMs` | `2000` | 原生后端复用一次窗口枚举来服务窗口与应用读取的时长；`0` 表示禁用 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-computer-use-local)是每个已接受字段及其 JSDoc 的详尽来源。

### 失败与恢复

首次使用会惰性启动 helper。helper 退出会使进行中的调用以 `COMPUTER_HOST_CRASHED` 失败；下一次调用会启动新 helper。缺失的操作系统权限表现为 `COMPUTER_PERMISSION_DENIED` 或 `COMPUTER_UNSUPPORTED`。无法再解析的窗口 id 以 `COMPUTER_WINDOW_GONE` 失败；所属窗口没有已加载快照的 press 或 set-value 句柄以 `COMPUTER_STALE_REF` 失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

插件在 `ctx.computer` 上注册 `LocalComputerProvider`，并随 fiber 释放 helper。`ComputerHostClient` 在子进程管道上成帧 JSON-RPC 行。helper 中的 `handleComputerMethod` 分发到 `DesktopBackend`（simulang 或平台）。插件把 `windowCacheMs` 作为 argv 上的 `--window-cache-ms=<n>` 转发给 helper。

simulang 适配器每个 helper 绑定一次 `Machine.local()`。窗口 id 为 `<pid>:<title>`（标题重复时加 `#n` 后缀），应用 id 为 `pid:<pid>`，应用名来自 `ps` / `tasklist`，以便固定拒绝列表匹配真实进程名。`snapshot` 构建 `AccessibilityTree.fromWindow(window).snapshot()`，按窗口保留该树，并返回 `<refId>@<windowId>` 句柄；`press` 按快照时记录的角色分发（`activate`、`toggle`、`select` 或 `expandCollapse`），`setValue` 直接调用该树。`password` 节点为 `secure` 且不携带值。指针与按键输入通过 `Machine` 合成，修饰键在动作前后按住与释放；按键名接受 simulang 的 `keyFromString` 词汇，另加 `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`、空格、`Esc`、`Cmd` 与 `Ctrl`。适配器安装 simulang 的 logger，使原生日志行进入 stderr，而不是 JSON-RPC 的 stdout。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件 apply |
| `src/provider.ts` | `ComputerProvider` 实现 |
| `src/client.ts` | stdio JSON-RPC 客户端 |
| `src/host.ts` | helper 入口 |
| `src/flags.ts` | helper argv 标志 |
| `src/simulang.ts` | simulang-js v13 适配器 |
| `src/platform.ts` | 操作系统回退 |
| `src/doctor.ts` | CLI 探测 |
| — | 不发布运行时不变式伴生入口；helper 状态位于单个子进程并在每次启动时重建，进程内不存在可能分歧的两个观察点。 |

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
- **原生二进制是可选的** — `@simular-ai/simulang-js` 仅为 macOS、Linux glibc 和 Windows x64/arm64 提供预编译二进制；其他平台上操作系统回退提供截图与剪贴板，而无障碍快照、`press` 与 `setValue` 抛出 `COMPUTER_UNSUPPORTED`。
- **窗口枚举很慢** — simulang 的 `Machine.windows()` 遍历每个进程，当某个应用不及时响应无障碍请求时可能耗时约十秒；`windowCacheMs` 限制一次动作为此付出代价的频率。
- **窗口 id 跟随标题** — 在 `computer_apps` 与下一次动作之间标题发生变化的窗口会被视为消失（`COMPUTER_WINDOW_GONE`）；请重新列出窗口。
- **不从 simulang 读取前台应用** — v13 的 `Machine.foregroundApp()` 在 macOS 上会 panic，因此适配器从不调用它；`focused` 由 `focusedWindow()` 推导。
- **快照遍历整棵原生树** — `AccessibilityTree.snapshot()` 没有深度或节点数上限，`maxNodes` 只裁剪映射后的结果；拥有数千个无障碍节点的窗口（Finder 文件夹列表、长网页）可能超过 `requestTimeoutMs`。把内容绘制为单一表面的窗口（iOS 模拟器、游戏、远程桌面）只返回一个 `window` 节点；此时请配合坐标使用 `computer_screenshot`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

helper 仅使用 stdio；无监听 TCP 端口。TCC 附着到与 `dsh` 相同的责任进程。

</details>
