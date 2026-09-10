# Agent Note: 浏览器网络捕获

Status: implemented

[English](2026-09-10-browser-network-capture.md) | 中文

本决策为[浏览器能力 seam](../architecture/2026-09-06-browser-capability-seam.zh.md)所定义的中继增加了一个消费方。该记录继续拥有提供方选择、附加围栏和 CDP 中继；没有活跃 Agent Note 被取代。

## 问题

浏览器工具可以驱动标签页，并读取页面渲染、记录的内容或 `Runtime.evaluate` 得到的应答，但没有任何工具暴露其 HTTP 流量。调试失败登录流程的 agent 能看到最终页面状态和控制台输出，却看不到哪个请求返回了 `401`、点击触发了哪个端点，或者 API 返回了什么。

传输层其实已经承载了这些数据。对于已附加调试器的标签页，Chrome 会发出 `Network.*` 事件；扩展转发每一个 `chrome.debugger` 事件；native host 将其广播给已连接的客户端；`ctx.browser.onCdpEvent` 再把它们分发出去。唯一的消费方是读取 `Runtime.consoleAPICalled` 的 `browser_console`，因此网络事件到达 seam 后被丢弃。

## 决策

`dsh-tool-browser` 注册 `browser_network` 和 `browser_network_body`。捕获状态位于工具消费方（`src/network.ts`），而非 `dsh-browser` seam。

**启用捕获。** 捕获从某个标签页的首次 `browser_network` 调用开始。工具通过 `ctx.browser.cdp` 发送 `Network.enable`，该调用会强制校验附加所有权，并且只有在 Chrome 接受该命令之后才武装该标签页。因此被拒绝的 enable 会让标签页保持未武装状态，下次调用会重试，而不会报告一个静默的空捕获。

**缓冲区。** 每个标签页一个按已配置标签页 id 索引的受限缓冲区，最新的 `networkMaxRequests` 条条目（默认 200）保留。重定向会复用其 request id，因此最新一跳会就地替换该条目，而不是新增一条。`browser_close` 和插件 fiber 释放会随标签页一起丢弃该缓冲区。

**限界。** `browser_network` 返回可选的大小写不敏感 URL 过滤器的最新 `limit` 个匹配项（默认 50），并在丢弃了更早匹配项时报告 `truncated`。`networkMaxBodyBytes`（默认 100000）为响应体封顶，在字节边界上截断且不切断多字节字符；`base64Encoded` 响应体只按字节大小报告，绝不内联，因为 base64 既消耗 token 又不携带可读内容。 `resourceType` 采用 Chrome 自身资源类型枚举的大小写（`Document`、`Fetch`、`Script`），而不是小写化的归一形式，因此模型读到的取值与 DevTools 网络面板显示的一致；事件未报告类型时回退到该枚举自身的 `Other`。

**授权。** 两个工具都不请求 `ctx.approval`。附加本身就是授权：`Network.enable` 和 `Network.getResponseBody` 都经由 `ctx.browser.cdp` 运行，而后者会拒绝调用 agent 未附加的标签页。`browser_console` 为读取标签页输出确立了同样的先例。

**事件访问。** 工具原样复用 `ctx.browser.onCdpEvent`。事件会不分所有者地针对每个已附加标签页到达，因此捕获只按已武装的标签页记录：从未对某标签页调用 `browser_network` 的所有者不会向该标签页的缓冲区贡献任何内容，其他标签页的事件也完全不会被缓冲。

## 考虑过的替代方案

**为 `BrowserProvider` 和 `BrowserCapability` 增加 `network` 分面。** 否决，因为没有提供方为它实现独立传输：捕获用的就是 `cdp` 分面已经提供的 `Network.enable`、`Network.getResponseBody` 和 `Network.*` 流量，因此该分面会宣告一个并不存在的提供方差异。

**为 agent 打开的每个标签页启用 `Network.enable`。** 否决，因为这会为无人查看的标签页保留并流式传输响应体，而且发生在每次打开时。首次工具调用时武装只需一个明确的、模型可见的步骤，并把成本放在需求旁边。

**把缓冲区放进 `dsh-browser` seam。** 否决，因为 seam 对这些数据只有一个消费方，自身也没有观察面；`browser_console` 已经确立了消费方侧的事件订阅，而 seam 中的第二个进程内缓冲区会比每个读取它的插件活得更久。

**把二进制响应体以 base64 返回。** 否决，因为模型无法使用编码后的字节，而大小说明已经回答了负载是什么、有多大。

**读取请求或响应负载前要求审批。** 否决，因为用户通过附加标签页已经授权了该标签页及其会话；每次读取都确认会让用户形成反射式批准负载读取的习惯，而这正是审批要防止的行为。

## 后果

模型无需离开工具面即可诊断标签页的请求级失败——状态码、加载失败、重定向目标、响应负载——代价是浏览器提示词段落中多出两个 schema 和一句引导语。

在某个标签页启用捕获期间，Chrome 拥有响应体缓冲区，因此响应体可能在 `browser_network_body` 请求之前被丢弃；这表现为该 `requestId` 的 CDP 错误，而不是空响应体。

捕获只覆盖 HTTP 请求。WebSocket 帧、服务器发送事件和 `data:` URL 不被观察；标签页在首次 `browser_network` 调用之前产生的流量不可获得，因此首次页面加载只有重新加载后才能观察。

本包无法同时观察用户的 DevTools 网络面板并驱动同一标签页：Chrome 每个标签页只允许一个调试器，因此当该标签页打开了 DevTools 时，`chrome.debugger.attach` 会失败。

## 测试

`packages/browser/tool-browser/tests/tool-browser.spec.ts` 覆盖了缓冲区（武装、不可读事件、重定向替换、淘汰、丢弃）、响应体限界（含多字节截断）、两个格式化器的文本，以及经由假提供方的工具路径：每个标签页只武装一次、过滤器、limit、失败原因、二进制响应体，以及被拒绝的 enable 之后的重试。`packages/browser/tool-browser/tests/loader-composition.spec.ts` 固定了 `browser_network` 经真实 Loader 启动的注册。`packages/browser/tool-browser/tests/browser-network.e2e.ts` 在 `DSH_BROWSER_E2E=1` 选中它时运行：它把已交付的扩展载入真实 Chromium，并用已交付的存储归约真实 `Network.enable` 之后产生的 Chrome 事件，固定了大写的资源类型、重定向折叠到最终一跳、每个请求 id 只有一条条目，以及由 `networkMaxBodyBytes` 限界的真实 `Network.getResponseBody`。`browser-tabs` 会话快照携带刷新后的工具 schema 和提示词段落。
