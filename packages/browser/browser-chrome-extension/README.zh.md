---
description: "ctx.browser 的 Chrome Native Messaging 提供方：MV3 扩展、native host、套接字客户端和安装库。"
kind: "package-reference"
---

# @deepseek-ai/dsh-browser-chrome-extension

[English](README.md) | 中文

## 概述

本包是 `ctx.browser` 随附的 Chrome 后端。瘦 MV3 扩展通过 Chrome Native Messaging 与 Node native host 通信；host 在 `$DSH_HOME/browser/host.sock`（或 Windows named pipe）上监听并复用多个 dsh 客户端。插件注册提供方 id `chrome-extension`，惰性连接并在 socket 断开后的下一次调用重连；缺失的 host 是 `BROWSER_NOT_CONNECTED`。当模型应驱动用户真实、已登录的 Chrome 时选择它。`dsh browser install` 写入 native-host 清单，并在出现 Web Store id 之前打印 Load unpacked 路径。

Agent 标签页在后台打开。同一 Agent 的分组打开操作在前一个 Agent 创建的标签页仍存在时复用其分组和窗口；前一个标签页关闭后创建新分组。创建或分组标签页不会使 Chrome 获得焦点。明确的显示操作会激活标签页并聚焦其窗口。Chrome 的调试横幅保持可见。

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

加载浏览器服务和本提供方，然后运行 `dsh browser install --browser chrome` 并加载未打包扩展。

```yaml
- name: '@deepseek-ai/dsh-browser'
- name: '@deepseek-ai/dsh-browser-chrome-extension'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `socketPath` | `$DSH_HOME/browser/host.sock`（win32 上为 named pipe） | dsh 客户端连接的套接字 |
| `connectTimeoutMs` | `2000` | 连接超时 |
| `requestTimeoutMs` | `30000` | 每次 RPC 超时 |
| `tabGroupTitle` | `DeepSeek` | 智能体打开的标签页所在 Chrome 标签组标题 |
| `extensionId` | 未打包占位 | 钉在安装清单中 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-browser-chrome-extension)是每个已接受字段及其 JSDoc 的穷尽来源。

### 失败与恢复

首次使用时惰性连接。缺失或已关闭的套接字抛出 `BROWSER_NOT_CONNECTED`。已消失的标签页映射为 `BROWSER_TAB_GONE`。协议版本不匹配在握手时大声失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 函数插件：注册 `ChromeExtensionProvider` |
| [`src/provider.ts`](src/provider.ts) | 映射到 `BrowserProvider` 的惰性套接字客户端 |
| [`src/host/`](src/host/) | Native host：监听、复用客户端、中继 CDP |
| [`src/protocol/`](src/protocol/) | 长度前缀帧、JSON-RPC、1 MiB 分块 |
| [`src/install/`](src/install/) | 按操作系统的 native-host 清单路径与安装/状态 |
| [`extension/`](extension/) | MV3 service worker、弹窗和权限集 |
| — | 不发布运行时不变式配套插件；host 进程和套接字只通过提供方的连接/请求路径观察。 |

Native host 监听；dsh 连接。该角色拆分避免了 Codex 那种应用与 host 各自在不同套接字上监听的失败模式。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [浏览器子系统](../../../docs/subsystems/browser.zh.md)
- [安装 Chrome 浏览器工具](../../../docs/user/guide/browser.zh.md)
- [浏览器能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-09-06-browser-capability-seam.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-browser`。本提供方不贡献提示词或 schema。

#### KV Cache 影响

无直接失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **未打包安装** — 尚无 Web Store id；用户在 `dsh browser install` 之后手动加载 `extension/`。
- **无编译后的 host 二进制** — Chrome 启动 POSIX/`cmd` 包装器，再 exec Node。
- **修改 `extension/` 后需重新加载** — Chrome 保留已加载的 Service Worker 源码，因此改动后的 `extension/` 文件只有在 `chrome://extensions` 重新加载该未打包扩展后才生效。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

从不抑制 Chrome 的“正在调试此浏览器”横幅。智能体标签页会被分组并加上徽章。

</details>
