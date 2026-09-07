# 用 DeepSeek Harness 驱动 GUI 应用

[English](computer-use.md) | 中文

`computer_*` 工具通过操作系统无障碍树驱动 GUI 应用，并在支持图像的模型路由上把截图作为附加感官。它们挂在 `dsh-base` 中且 `enabled: false`，直到你授予操作系统权限后再打开。

## 检查权限

```sh
dsh computer doctor
```

在 macOS 上，向启动 `dsh` 的终端（或应用）授予**辅助功能**和**屏幕录制**。带 `--request` 再运行以触发系统提示：

```sh
dsh computer doctor --request
```

在 Linux 上，X11 会话可以合成输入；Wayland 输入注入不受支持。Windows 电脑操控仅限前台窗口。

## 启用工具

在 profile overlay（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）中加入：

```yaml
- id: tool-computer-use
  name: '@deepseek-ai/dsh-tool-computer-use'
  config:
    enabled: true
    approval: apps
```

首次使用某个应用时会询问**允许一次** / **允许本次会话** / **拒绝**。终端应用和 harness 进程本身始终被拒绝。

优先使用 `computer_snapshot` 与 refs。仅当无障碍树不够、且当前模型接受图像时，才使用 `computer_screenshot`。
