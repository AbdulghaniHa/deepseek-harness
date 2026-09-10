# 用 DeepSeek Harness 驱动 Chrome

[English](browser.md) | 中文

`browser_*` 工具通过瘦未打包扩展和 native-messaging host 驱动用户真实、已登录的 Chrome——已有标签页、cookie 和会话。它们在 `dsh-base` 中以 `enabled: false` 挂载，直到你在安装后打开它们。

## 安装

1. 为 Chrome（或 Chromium、Edge、Brave）注册 native host：

```sh
dsh browser install --browser chrome
```

2. 打开 `chrome://extensions`，启用开发者模式，然后 **加载已解压的扩展程序**。指向命令打印的路径（`…/dsh-browser-chrome-extension/extension`）。
3. 复制该页上的 32 位扩展 **ID**，并把它钉到 Native Messaging（在 `allowed_origins` 匹配此 id 之前，Chrome 会拒绝 host）：

```sh
dsh browser install --browser chrome --extension-id <id-from-chrome-extensions>
```

4. 重新加载扩展，然后确认弹窗显示 Connected。
5. 在 profile overlay（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）中启用工具：

```yaml
- id: tool-browser
  name: '@deepseek-ai/dsh-tool-browser'
  config:
    enabled: true
    approval: user-tabs
    allowRawCdp: false
```

## 检查状态

```sh
dsh browser status --browser chrome
```

`uninstall` 移除 native-host 注册。未打包扩展必须在 `chrome://extensions` 中移除。

## 模型能做什么

启用后，模型可以列出标签页、附加到已有标签页（需审批）、打开 URL、快照无障碍树、点击、输入、截图、执行 JavaScript，以及读取该标签页的 HTTP 请求和响应体。对于不需要登录会话的公开页面，优先使用 `web_fetch`。把每份快照和响应体当作不可信数据。

Chrome 保持“正在调试此浏览器”横幅可见。智能体打开的标签页落在 DeepSeek 标签组中。

## 进一步阅读

- [浏览器子系统](../../subsystems/browser.zh.md)
- [dsh-tool-browser](../../../packages/browser/tool-browser/README.zh.md)
