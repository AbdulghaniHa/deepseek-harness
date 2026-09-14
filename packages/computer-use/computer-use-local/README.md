---
description: "Local desktop provider for ctx.computer: crash-isolated helper over stdio JSON-RPC, OS fallback, and dsh computer doctor."
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use-local

English | [中文](README.zh.md)

## Summary

This package is the shipped local backend for `ctx.computer`. It spawns `lib/host.js` through `ctx.subprocess` and speaks newline-delimited JSON-RPC over stdio. The helper drives the desktop through the `@simular-ai/simulang-js` v13 native addon, declared as an `optionalDependencies` entry so `pnpm install` fetches the prebuilt binary for macOS, Linux glibc, and Windows; when the binary is absent the helper uses an OS fallback without accessibility trees. Provider id `local` starts the helper lazily; a crash is `COMPUTER_HOST_CRASHED`. Choose it when the model should drive GUI apps on the same machine as `dsh`. `dsh computer doctor` prints permission state without booting Cordis.

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

Load the computer-use service and this provider, then run `dsh computer doctor` and grant OS permissions.

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- name: '@deepseek-ai/dsh-computer-use-local'
```

| Field | Default | Meaning |
|---|---|---|
| `requestTimeoutMs` | `30000` | Per-RPC timeout |
| `graceMs` | `5000` | SIGTERM-to-SIGKILL grace for the helper tree |
| `windowCacheMs` | `2000` | How long the native backend reuses one window enumeration for window and app reads; `0` disables |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-computer-use-local) is the exhaustive source for every accepted field and its JSDoc.

### Failures and recovery

The first use starts the helper lazily. A helper exit fails in-flight calls with `COMPUTER_HOST_CRASHED`; the next call starts a new helper. Missing OS permissions surface as `COMPUTER_PERMISSION_DENIED` or `COMPUTER_UNSUPPORTED`. A window id that no longer resolves fails with `COMPUTER_WINDOW_GONE`; a press or set-value handle whose window has no loaded snapshot fails with `COMPUTER_STALE_REF`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers `LocalComputerProvider` on `ctx.computer` and disposes the helper with the fiber. `ComputerHostClient` frames JSON-RPC lines on the subprocess pipes. `handleComputerMethod` in the helper dispatches onto a `DesktopBackend` (simulang or platform). The plugin forwards `windowCacheMs` to the helper as `--window-cache-ms=<n>` on argv.

Provider disposal awaits key-up calls before terminating the helper, including key-down calls whose response failed. When simulang returns no window hit, its live accessibility hit node and native ancestor identity determine the window; coordinates alone do not establish a match.

The simulang adapter binds `Machine.local()` once per helper. When the addon reports `nativeId`, window ids are opaque `wN` values fenced by helper lifetime and survive title changes; a destroyed then recreated native handle mints a new id. When `nativeId` is absent, ids remain `<pid>:<title>` (`#n` suffix on duplicate titles). App ids are `pid:<pid>`, and app names come from `ps` / `tasklist` so the fixed deny list matches real process names. `snapshot` builds `AccessibilityTree.fromWindow(window).snapshot()`, keeps that tree per window, and returns handles `<refId>@<windowId>`; `press` dispatches by the role recorded at snapshot time (`activate`, `toggle`, `select`, or `expandCollapse`) and `setValue` calls the tree directly. `password` nodes are `secure` and carry no value. Pointer and key input synthesize through `Machine` with modifiers held around the action; key names accept simulang's `keyFromString` vocabulary plus `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`, a space, `Esc`, `Cmd`, and `Ctrl`. The adapter installs simulang's logger so native log lines reach stderr, never the JSON-RPC stdout.

| File | Owns |
|---|---|
| `src/index.ts` | plugin apply |
| `src/provider.ts` | `ComputerProvider` implementation |
| `src/client.ts` | stdio JSON-RPC client |
| `src/host.ts` | helper entry |
| `src/flags.ts` | helper argv flags |
| `src/simulang.ts` | simulang-js v13 adapter |
| `src/platform.ts` | OS fallback |
| `src/doctor.ts` | CLI probe |
| — | No runtime invariant companion is published; helper state lives in one subprocess and is rebuilt on every spawn, so no two in-process observations can diverge. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Computer-use subsystem](../../../docs/subsystems/computer-use.md)
- [Drive GUI apps](../../../docs/user/guide/computer-use.md)
- [Computer-use capability seam decision](../../../.agents/notes/implemented/architecture/2026-09-06-computer-use-capability-seam.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-computer-use`, which renders snapshots and screenshots to the model while this provider contributes no prompt or schema.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Native extension is incomplete** — published v13 lacks stable native window ids and window resizing; the optional adapter methods do not provide those features. A patched binary requires access to upstream’s private Rust dependency. Element focus falls back to a pointer click when tree focus is absent.
- **Windows is foreground-only** — synthesized input cannot target background windows.
- **Wayland input is unsupported** — doctor reports `inputInjection: denied` when `WAYLAND_DISPLAY` is set.
- **Native binary is optional** — `@simular-ai/simulang-js` ships prebuilt binaries for macOS, Linux glibc, and Windows x64/arm64 only; elsewhere the OS fallback serves screenshots and clipboard, and accessibility snapshots, `press`, and `setValue` throw `COMPUTER_UNSUPPORTED`.
- **Window enumeration is slow** — simulang's `Machine.windows()` walks every process and can take about ten seconds when an application does not answer accessibility requests promptly; `windowCacheMs` bounds how often one action pays that cost.
- **Window ids follow titles** — a window whose title changes between `computer_apps` and the next action reads as gone (`COMPUTER_WINDOW_GONE`); list windows again.
- **Foreground app is not read from simulang** — `Machine.foregroundApp()` panics on macOS in v13, so the adapter never calls it; `focused` derives from `focusedWindow()`.
- **Snapshots walk the whole native tree** — `AccessibilityTree.snapshot()` has no depth or node cap, so `maxNodes` trims only the mapped result; a window with thousands of accessibility nodes (a Finder folder listing, a long web page) can exceed `requestTimeoutMs`. Windows that draw their content as one surface (iOS Simulator, games, remote desktops) return a single `window` node; use `computer_screenshot` with coordinates there.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The helper uses stdio only; no listening TCP port. TCC attaches to the same responsible process as `dsh`.

</details>
