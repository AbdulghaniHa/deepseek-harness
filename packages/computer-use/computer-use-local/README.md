---
description: "Local desktop provider for ctx.computer: crash-isolated helper over stdio JSON-RPC, OS fallback, and dsh computer doctor."
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use-local

English | [中文](README.zh.md)

## Summary

This package is the shipped local backend for `ctx.computer`. It spawns `lib/host.js` through `ctx.subprocess` and speaks newline-delimited JSON-RPC over stdio. The helper loads `@simular-ai/simulang-js` when present and otherwise uses an OS fallback. The plugin registers provider id `local` and starts the helper lazily; a crash is `COMPUTER_HOST_CRASHED`. Choose it when the model should drive GUI apps on the same machine as `dsh`. `dsh computer doctor` prints permission state without booting Cordis.

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

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-computer-use-local) is the exhaustive source for every accepted field and its JSDoc.

### Failures and recovery

The first use starts the helper lazily. A helper exit fails in-flight calls with `COMPUTER_HOST_CRASHED`; the next call starts a new helper. Missing OS permissions surface as `COMPUTER_PERMISSION_DENIED` or `COMPUTER_UNSUPPORTED`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers `LocalComputerProvider` on `ctx.computer` and disposes the helper with the fiber. `ComputerHostClient` frames JSON-RPC lines on the subprocess pipes. `handleComputerMethod` in the helper dispatches onto a `DesktopBackend` (simulang or platform).

| File | Owns |
|---|---|
| `src/index.ts` | plugin apply |
| `src/provider.ts` | `ComputerProvider` implementation |
| `src/client.ts` | stdio JSON-RPC client |
| `src/host.ts` | helper entry |
| `src/platform.ts` | OS fallback |
| `src/doctor.ts` | CLI probe |

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

- **Windows is foreground-only** — synthesized input cannot target background windows.
- **Wayland input is unsupported** — doctor reports `inputInjection: denied` when `WAYLAND_DISPLAY` is set.
- **Native library is optional** — without simulang, accessibility snapshots throw `COMPUTER_UNSUPPORTED` except for the small macOS System Events path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The helper uses stdio only; no listening TCP port. TCC attaches to the same responsible process as `dsh`.

</details>
