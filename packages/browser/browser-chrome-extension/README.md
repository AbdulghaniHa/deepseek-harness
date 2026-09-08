---
description: "Chrome Native Messaging provider for ctx.browser: the MV3 extension, native host, socket client, and install library."
kind: "package-reference"
---

# @deepseek-ai/dsh-browser-chrome-extension

English | [中文](README.zh.md)

## Summary

This package is the shipped Chrome backend for `ctx.browser`. A thin MV3 extension talks to a Node native host over Chrome Native Messaging; the host listens on `$DSH_HOME/browser/host.sock` (or a Windows named pipe) and multiplexes dsh clients. The plugin registers provider id `chrome-extension` and connects lazily, reconnecting on the next call after the socket drops; a missing host is `BROWSER_NOT_CONNECTED`. Choose it when the model should drive the user's real, logged-in Chrome. `dsh browser install` writes the native-host manifest and prints the Load-unpacked path until a Web Store id exists.

Agent tabs open inactive. Grouped opens for one Agent reuse the preceding agent-created tab’s group and window while that tab exists; a closed predecessor starts a new group. Creating or grouping tabs does not focus Chrome. Explicit reveal activates the tab and focuses its window. Chrome’s debugging banner remains visible.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load the browser service and this provider, then run `dsh browser install --browser chrome` and load the unpacked extension.

```yaml
- name: '@deepseek-ai/dsh-browser'
- name: '@deepseek-ai/dsh-browser-chrome-extension'
```

| Field | Default | Meaning |
|---|---|---|
| `socketPath` | `$DSH_HOME/browser/host.sock` (Windows named pipe on win32) | Socket the dsh client connects to |
| `connectTimeoutMs` | `2000` | Connect timeout |
| `requestTimeoutMs` | `30000` | Per-RPC timeout |
| `tabGroupTitle` | `DeepSeek` | Chrome tab-group title for agent-opened tabs |
| `extensionId` | unpacked placeholder | Pinned in install manifests |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-browser-chrome-extension) is the exhaustive source for every accepted field and its JSDoc.

### Failures and recovery

The first use connects lazily. A missing or closed socket throws `BROWSER_NOT_CONNECTED`. A vanished tab maps to `BROWSER_TAB_GONE`. Protocol version mismatch fails loud at handshake.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Function plugin: registers `ChromeExtensionProvider` |
| [`src/provider.ts`](src/provider.ts) | Lazy socket client mapped onto `BrowserProvider` |
| [`src/host/`](src/host/) | Native host: listens, multiplexes clients, relays CDP |
| [`src/protocol/`](src/protocol/) | Length-prefixed frames, JSON-RPC, 1 MiB chunking |
| [`src/install/`](src/install/) | Per-OS native-host manifest paths and install/status |
| [`extension/`](extension/) | MV3 service worker, popup, and permission set |
| — | No runtime invariant companion is published; the host process and socket are observed only through the provider's connect/request path. |

The native host listens; dsh connects. That role split avoids the Codex failure mode where app and host each listen on different sockets.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser subsystem](../../../docs/subsystems/browser.md)
- [Install Chrome browser tools](../../../docs/user/guide/browser.md)
- [Browser capability seam decision](../../../.agents/notes/implemented/architecture/2026-09-06-browser-capability-seam.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-browser`. This provider contributes no prompt or schema.

#### KV Cache effect

No direct invalidation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Unpacked install** — there is no Web Store id yet; users load `extension/` manually after `dsh browser install`.
- **No compiled host binary** — Chrome launches the POSIX/`cmd` wrapper, which execs Node.
- **Reload after editing `extension/`** — Chrome keeps the service worker source it loaded, so an edited `extension/` file takes effect only after reloading the unpacked extension in `chrome://extensions`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Chrome's "is debugging this browser" banner is never suppressed. Agent tabs are grouped and badged.

</details>
