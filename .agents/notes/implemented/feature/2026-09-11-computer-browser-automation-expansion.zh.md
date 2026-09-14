# Agent Note: 电脑与浏览器自动化扩展

Status: implemented

[English](2026-09-11-computer-browser-automation-expansion.md) | 中文

本决策扩展[电脑操控能力 seam](../architecture/2026-09-06-computer-use-capability-seam.zh.md)和[浏览器能力 seam](../architecture/2026-09-06-browser-capability-seam.zh.md)所定义的 seam。那些记录继续拥有提供方选择、授权、附加围栏和 CDP 中继。[自主浏览器与电脑工具](2026-09-13-autonomous-browser-computer-tools.zh.md)后来取代本笔记的审批默认值和与标题无关的 id 事实；此处的发现、frame、下载和呈现仍然有效。

## 问题

已交付的桌面和浏览器工具可以列出应用和标签页、拍摄快照、点击、输入并检查网络流量，但无法告诉调用方后端是已配置还是真正活着，无法带着绑定几何观察窗口，无法调用原生 helper 已支持的无障碍操作，无法驱动 iframe，也无法等待下载完成。后续观察失败时调用方会重试已经成功的输入，回放元数据里存了截图字节，并且在原窗口消失时按标题猜测替代窗口。

## 决策

工作留在现有能力服务、提供方和工具消费方中。不改 agent loop、默认启用策略或审批策略。

**发现。** `computer_status` 和 `browser_status` 只读。它们区分 `available()` 与有界活探测（`permissions()` / `listTabs()`），列出支持的操作，并为缺失提供方、未连接的 Chrome、被拒绝的权限和不支持的分面返回恢复文案。所选提供方宕机时工具仍保持注册。

**桌面观察与操作。** `computer_snapshot.maxDepth` 和当前快照 ref 选择子树。节点声明状态和动作。`computer_observe` 返回树以及可选的截图附件，带像素尺寸、逻辑边界和缩放。截图空间坐标绑定到 observation id，并按照结果所声明的同一像素尺寸进行映射，边界或标题变化时以 `COMPUTER_GEOMETRY_CHANGED` 失败。`computer_action` 运行已声明的 `activate` / `toggle` / `select` / `expandCollapse` / `setValue`。拖拽端点接受 ref 或坐标；点击、滚动和拖拽共用修饰键。`computer_wait_for` 等待文本消失和节点状态。输入之后尝试一次新观察；若失败，工具返回 `observationError`，而不是让调用方重复输入。原生适配器未报告 `nativeId` 时，窗口身份是 `pid:title`；消失或歧义的目标会失败。

**Frame、拖拽和下载。** `browser_frames` 列出文档。快照、文本、evaluate 和 wait 接受可选 `frameId`（默认主 frame）。存储的 ref 携带 frame 身份；点击、输入、选择、上传和悬停经该 frame 的 CDP 会话路由，包括 `Target.setAutoAttach` 得到的展平 OOPIF 会话。多个附加 iframe 共用同一 URL 时，会询问每个候选会话其自身树以哪个 frame 为根来解析，因此输入绝不会路由到同 URL 的兄弟 frame。导航和脱离会清除已存储的 observation。`browser_drag` 使用可信指针事件，并要求两个端点在同一 frame；原始视口坐标视为主 frame 坐标。下载 id 是带品牌的字符串。`browser_wait_for_download` 轮询显式 id，并返回本地路径而不读取文件；中断为 `BROWSER_DOWNLOAD_INTERRUPTED`。

**呈现。** 回放卡片持久化目标身份和观察错误；工具名即操作，因此元数据不再单列该字段。截图字节绝不进入 `presentationMeta`，浏览器预览保持为实时捕获而非存储的附件。新的会话行通过现有 locale 词典注册。

## 考虑过的替代方案

**与标题无关的窗口 id。** 否决：原生适配器没有稳定窗口标识符，猜测替代窗口会静默改目标。

**不提升标签页 epoch 的按 frame 快照代数。** 在第一刀否决：在 `Page.frameNavigated` / `Target.detachedFromTarget` 上提升标签页 epoch，会让过期 ref 失败，而不是提供混合世代的树。

**跨 frame 拖拽。** 否决：可信指针坐标是 frame 局部的；跨 frame 拖拽需要后续的命中测试设计。

**把截图字节放进 `presentationMeta` 供预览坞使用。** 否决：会话日志会保留无界图像。坞已经捕获实时预览；仍存储 base64 的旧日志保持可读。

**增加 `network` 或 `frames` 提供方分面。** 否决：frame 和下载复用 CDP 与现有 downloads 分面；没有提供方实现独立传输。

## 后果

macOS 是第一个完整验证的桌面平台。`dsh-base` 仍以 `enabled: false` 交付两套工具。OCR、持久 always-allow 授权、工作流录制、其他浏览器引擎和原生窗口管理继续延后。addon 未报告 `nativeId` 时，与标题无关的窗口 id 继续延后。

调用方可以完成桌面表单交互、iframe 工作流以及下载到上传的交接，结果可观察且不会静默改目标。代价是额外的 schema、发现时的状态探测，以及子目标的 CDP 自动附加。

## 测试

`packages/computer-use/*/tests` 覆盖状态（已配置 vs 活 vs 探测失败）、观察几何、已声明动作、拖拽 ref、等待消失和节点状态、按所声明像素尺寸进行的截图空间映射、准确的节点预算截断，以及部分 `observationError`。`packages/browser/*/tests` 覆盖状态、展平子会话、同 URL iframe 绑定、`downloads.get`、frame 列表和子快照、同一 frame 拖拽（包括子 frame ref 搭配主 frame 坐标）、导航后的过期 ref、中断和超时下载，以及不含截图字节的呈现元数据。会话行测试注册新工具名。嵌入工具 schema 的录制会话快照在本次交付时需要刷新。
