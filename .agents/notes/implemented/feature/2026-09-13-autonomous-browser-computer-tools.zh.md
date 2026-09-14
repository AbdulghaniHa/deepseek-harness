# Agent Note: Autonomous browser and computer tools

Status: implemented

[English](2026-09-13-autonomous-browser-computer-tools.md) | 中文

本决策在审批默认值与基于 native-id 的窗口身份上部分取代[电脑与浏览器自动化扩展](2026-09-11-computer-browser-automation-expansion.zh.md)。该笔记中的发现、frame、下载和呈现仍然有效。[电脑操控能力 seam](../architecture/2026-09-06-computer-use-capability-seam.zh.md) 与[浏览器能力 seam](../architecture/2026-09-06-browser-capability-seam.zh.md) 仍拥有提供方选择、授权、附加围栏和 CDP 中继。

## 问题

默认的 `apps` / `user-tabs` 审批会挡住无人值守工作流，即使主机已经授权了 Chrome 标签页或操作系统 helper。快照 ref 使用按标签页的 epoch，因此过滤或分页可能把旧的「保存」ref 绑到新的「删除」节点上。截图空间点击会回退到无关几何。桌面输入不验证前台窗口。无障碍 press 会用于每一次点击，包括右键和带修饰键的点击。Linux X11 把缺失的命中测试当成成功。Console 捕获在 `Runtime.enable` 之后才武装，因此最早的错误会丢失。

## 决策

两个工具插件和 `dsh-base` 行默认 `approval: never`。`dsh-base` 仍以 `enabled: false` 交付。`user-tabs`、`apps`、`always` 以及显式 overlay 仍可选择。在 `never` 模式下，提示词不让模型去询问，电脑工具在内部授予会话级应用访问，包括先写剪贴板的流程。

每次新的快照或截图铸造唯一的数字观察 id。Ref 为 `${observationId}-eN`，并绑定到该观察、owner、目标和浏览器 frame。过滤或分页是对 `allNodes` 的视图，并保留相同 ref。导航、frame 脱离、窗口销毁、重连和释放会清除已存储的观察。过期 ref 绝不会对更新的捕获解析。

浏览器输入按标签页串行；桌面输入在共享键盘和指针上串行。无障碍 press 只用于普通的未修改单击左键。无法建立目标时在分发前失败。分发之后，后续观察失败返回 `observationError`，不重放该动作。

浏览器点击、输入、填充、悬停、选择和拖拽会等待已附加、可见、启用或可编辑、稳定且未被遮挡的几何。CDP 视口坐标包含同进程 frame 的偏移和变换；命中测试也会拒绝祖先文档中的遮挡层。子 frame 执行上下文用于文本、evaluate、选择和等待。`browser_fill` 替换字段；`browser_type` 插入。点击接受按钮、次数和具名修饰键。滚动使用 ref、坐标或视口中心。等待返回 `matched` 和 `timedOut`。截图是附件，并且只在支持图像的路由上发出图片块。Console 监听器在 `Runtime.enable` 之前安装。文本默认值为 100 KB、每个快照字段 2,000 个字符，以及 200 条 console 记录。

桌面截图空间输入要求精确的观察 id 以及该捕获存储的几何。附件存储拥有截图尺寸；报告的缩放是已交付像素相对逻辑边界。注册 `computer_focus_element`、`computer_set_window_bounds` 和 `computer_displays`。按键支持 `press` / `down` / `up`；按住的键按 owner 跟踪，并在轮次停止、释放、取消和 helper 失败时松开。输入会验证前台焦点。simulang 的 Linux 路径通过祖先关系将原生无障碍命中节点解析为窗口；未定义命中是 `COMPUTER_TARGET_MISMATCH`。新的文本观察绝不继承截图几何。快照与截图文本携带观察 id，浏览器等待文本携带匹配和超时结果。

当 simulang 报告 `nativeId` 时，提供方窗口 id 是受 helper 生命周期围栏的不透明 `wN` 值。标题变化保持该 id；销毁后再创建的原生句柄铸造新 id。没有 `nativeId` 的构建保持 `<pid>:<title>`。可选的 `setBounds`、`screens()`、`windowByNativeId` 和树 `focus` 在存在时使用。已发布的 v13 缺少原生窗口 id、调整窗口尺寸和树 focus；调整尺寸以 `COMPUTER_UNSUPPORTED` 失败，元素聚焦则回退为指针点击。原生快照遍历仍无界限；映射限制在捕获后应用。本次变更不钉住分叉的 simulang 二进制。

`SESSION_FORMAT_VERSION` 不变。

## 考虑过的替代方案

**把 `apps` / `user-tabs` 保持为已交付默认。** 否决：无人值守运行随后会要求部署常常省略的审批或用户提问服务，并且模型提示词仍会让它在已授权动作前询问。

**钉住带必需原生窗口 API 的已打补丁 simulang 二进制。** 这仍是必需工作，但受阻于上游私有 `simulang-rs-internal` 依赖的访问权限。适配器中的可选方法不代表完成了这项工作；可复现的原生构建以及 macOS、Windows 和 Linux 验证仍待完成。

**把截图空间点击回退到屏幕坐标或最新缓存截图。** 否决：窗口移动、缩放或显示器布局变化后会静默改目标。

**后续观察失败时自动重试动作。** 否决：该动作可能已经完成。

## 后果

默认组合在未挂载审批服务时也能完成有副作用的浏览器和电脑调用。仍想要确认 overlay 的运营商显式设置 `approval`。窗口 id 仅在 addon 报告 `nativeId` 时对标题稳定。Wayland 输入仍不受支持。截图字节仍不进入 `presentationMeta`。

## 测试

`packages/browser/tool-browser/tests` 覆盖观察范围 ref、fill 与 type、具名点击修饰键、等待的 `matched`/`timedOut`、console 武装、可操作性失败，以及在默认 `never` 且无审批服务时打开标签页的 Loader 启动。`packages/computer-use/*/tests` 覆盖按住的键、`COMPUTER_INPUT_BUSY`、未聚焦输入、未定义命中测试不匹配、nativeId 稳定 id、Linux X11 列表、已交付截图缩放、截图空间要求精确观察 id，以及无审批或用户提问服务的 Loader 启动。会话行注册 `browser_fill`、`computer_displays`、`computer_focus_element` 和 `computer_set_window_bounds`。头钉住的会话快照 `browser-tabs`、`computer-apps` 和 `computer-screenshot-text-only` 刷新工具 schema 和提示词段落。
