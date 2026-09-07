# Agent Note: 将本地电脑操控 helper 绑定到 simulang-js v13 并作为可选依赖安装

Status: implemented

[English](2026-09-07-simulang-v13-adapter-and-optional-dependency.md) | 中文

相关：[电脑操控能力 seam](../architecture/2026-09-06-computer-use-capability-seam.zh.md)（拥有该 seam；本笔记修复其已发布的提供方）。

## Problem

macOS 上的 `computer_snapshot` 对每个窗口都以 `snapshot is not supported by the platform backend on darwin` 失败，模型只能依赖截图，而默认的纯文本路由拒绝截图。两个缺陷叠加。`@simular-ai/simulang-js` 从未被声明为依赖，因此没有任何安装会把原生 addon 放到 helper 旁边，`loadSimulang` 始终返回 `undefined`。`src/simulang.ts` 中的适配器还是按猜测的扁平函数 API（`module.listWindows()`、`module.snapshot(windowId)`、`module.click(x, y)`）编写的，而已发布的包并没有这套 API：simulang-js v13 暴露的是类（`Machine`、`Window`、`AccessibilityTree`、`AccessibilityNodeJs`）和枚举（`Button`、`Direction`、`Key`）。即便手工安装该包，得到的后端也会让每个方法抛出 `simulang <x> is unavailable`。

在 macOS 上探测真实库时又浮现两个较小的事实：除非安装 `initLogger`，它会把 `[info] …` 行写到 stdout，这会破坏 helper 的 JSON-RPC 流；`Machine.foregroundApp()` 会 panic（`not yet implemented`）并中止进程。

## Decision

`@deepseek-ai/dsh-computer-use-local` 在 `optionalDependencies` 下声明 `@simular-ai/simulang-js@^13`。pnpm 解析对应平台的二进制（`darwin-arm64`、`darwin-x64`、`linux-x64-gnu`、`linux-arm64-gnu`、`win32-x64-msvc`、`win32-arm64-msvc`）；在其他平台上安装会跳过它，helper 保留操作系统回退。`pnpm-workspace.yaml` 在 `allowBuilds` 下拒绝该包的 postinstall，因为它只打印一条 Claude Code 提示。

`src/simulang.ts` 按 v13 类 API 通过结构化的 `SimulangModule` 接口重写；`loadSimulang` 仅在每个必需导出都存在时才接受模块，因此意外的 API 会回退，而不是产生一个全部抛出的后端。适配器每个 helper 绑定一次 `Machine.local()`，把窗口 id 铸造为 `<pid>:<title>`（标题重复时加 `#n`），应用 id 为 `pid:<pid>`，并用 `ps -o comm=` / `tasklist` 命名应用，使固定拒绝列表匹配真实进程名与 pid。`snapshot` 使用 `AccessibilityTree.fromWindow(window).snapshot()`，按窗口保留该树，按 ARIA 角色为每个 `refId` 记录一个 press 动作，并返回 `<refId>@<windowId>` 句柄；`press` 与 `setValue` 针对保留的树解析这些句柄。指针、键盘、滚动、拖拽和剪贴板输入经由 `Machine`，修饰键在动作前按下、动作后释放，并带一张小的按键别名表（`ArrowDown` → `Down`、`' '` → `Space`、`Cmd` → `Meta`、`Ctrl` → `Control`）。适配器安装 `initLogger` 使原生日志行进入 stderr，并且从不调用 `foregroundApp()`。

`Machine.windows()` 遍历每个进程，在一台存在无响应无障碍客户端的桌面上每次调用实测 10–12 秒，而 `ctx.computer` 在每次动作前都会列出窗口和应用。插件新增 `windowCacheMs` Config 字段（默认 `2000`，`0` 表示禁用），作为 `--window-cache-ms=<n>` 转发给 helper；适配器在该窗口内为 `listWindows`、`listApps` 与 `permissions` 复用一次枚举，并在请求的窗口 id 未缓存时立即重新枚举。

## Alternatives considered

**在操作系统回退中通过 `osascript` / System Events 实现 macOS 无障碍快照。** 被否决，因为 seam 决策已经因其带稳定 `refId` 的窗口绑定树而选择了 simulang，而 JXA 遍历会增加第二种仅限 macOS 的树格式及其动作映射，同时 Linux 与 Windows 仍然没有快照。

**保持 simulang 不声明并记录手工安装。** 被否决，因为未声明的原生依赖对 `pnpm install`、lockfile 审查和第三方声明不可见，默认安装会继续发布一个主观察原语会抛出的提供方。

**把 simulang 设为必需依赖。** 被否决，因为该包没有 Linux musl 或 32 位目标的二进制；`optionalDependencies` 让这些安装成功，并保持文档中的操作系统回退可达。

**把 press 动作编码进句柄字符串而不是每棵树一张映射表。** 被否决，因为句柄无论如何对模型不可见，映射表让句柄格式保持两个字段；映射表随其所属的树一起消亡。

**通过新的 RPC 方法传递 `windowCacheMs`。** 被否决，因为 argv 在 helper 的第一个请求之前就能到达，无需扩展 JSON-RPC 协议版本；标志解析器对畸形值大声失败。

## Consequences

在普通 `pnpm install` 之后，`computer_snapshot`、`computer_press` 与 `computer_set_value` 在 macOS、Linux glibc 和 Windows 上可用；产生原始错误的 Simulator 窗口返回一棵 17 节点的树，其中设备按钮可按下。`computer_apps` 中的应用名与 pid 是真实的，因此终端拒绝列表和 harness pid 检查对原生后端生效。`pnpm install` 现在会下载一个平台二进制（约 10 MB），lockfile 携带六个平台包。

窗口 id 跟随标题：在列出与动作之间标题发生变化的窗口读作 `COMPUTER_WINDOW_GONE`。在 `windowCacheMs` 内，上次枚举之后关闭的窗口仍会被列出；对它的下一次快照会由原生树报错。适配器的结构化模块接口是针对 simulang 大版本的维护义务；`loadSimulang` 拒绝未知 API 时降级到操作系统回退而不是崩溃。

单元测试通过一个伪造的 v13 模块驱动适配器，并固定 id、动作分发、secure 脱敏、节点预算、截图缩放、输入调用序列、logger 路由、缓存复用、POSIX 与 Windows 上的进程命名，以及 argv 标志的往返。真实 addon 仅在 `local.e2e.ts` 和维护者桌面上运行。
