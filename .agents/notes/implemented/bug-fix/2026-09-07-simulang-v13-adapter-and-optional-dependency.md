# Agent Note: Bind the local computer-use helper to simulang-js v13 and install it as an optional dependency

Status: implemented

English | [中文](2026-09-07-simulang-v13-adapter-and-optional-dependency.zh.md)

Related: [Computer-use capability seam](../architecture/2026-09-06-computer-use-capability-seam.md) (owns the seam; this note fixes its shipped provider).

## Problem

`computer_snapshot` on macOS failed with `snapshot is not supported by the platform backend on darwin` for every window, so the model could only work from screenshots, which default text-only routes refuse. Two defects combined. `@simular-ai/simulang-js` was never declared as a dependency, so no install ever placed the native addon next to the helper and `loadSimulang` always returned `undefined`. The adapter in `src/simulang.ts` was also written against a guessed flat function API (`module.listWindows()`, `module.snapshot(windowId)`, `module.click(x, y)`) that the published package does not have: simulang-js v13 exposes classes (`Machine`, `Window`, `AccessibilityTree`, `AccessibilityNodeJs`) and enums (`Button`, `Direction`, `Key`). Installing the package by hand would have produced a backend whose every method threw `simulang <x> is unavailable`.

Two smaller facts surfaced while probing the real library on macOS: it writes `[info] …` lines to stdout unless `initLogger` is installed, which would corrupt the helper's JSON-RPC stream, and `Machine.foregroundApp()` panics (`not yet implemented`) and aborts the process.

## Decision

`@deepseek-ai/dsh-computer-use-local` declares `@simular-ai/simulang-js@^13` under `optionalDependencies`. pnpm resolves the platform binary (`darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`, `win32-x64-msvc`, `win32-arm64-msvc`); on any other platform the install skips it and the helper keeps the OS fallback. `pnpm-workspace.yaml` denies the package's postinstall under `allowBuilds` because it only prints a Claude Code hint.

`src/simulang.ts` is rewritten against the v13 class API through a structural `SimulangModule` interface; `loadSimulang` accepts a module only when every required export is present, so an unexpected API falls back rather than producing a backend of throwing methods. The adapter binds `Machine.local()` once per helper, mints window ids as `<pid>:<title>` (`#n` on duplicate titles) and app ids as `pid:<pid>`, and names apps from `ps -o comm=` / `tasklist` so the fixed deny list matches real process names and pids. `snapshot` uses `AccessibilityTree.fromWindow(window).snapshot()`, keeps the tree per window, records a press action per `refId` by ARIA role, and returns `<refId>@<windowId>` handles; `press` and `setValue` resolve those handles against the kept tree. Pointer, keyboard, scroll, drag, and clipboard input go through `Machine`, with modifiers pressed before and released after the action and a small key alias table (`ArrowDown` → `Down`, `' '` → `Space`, `Cmd` → `Meta`, `Ctrl` → `Control`). The adapter installs `initLogger` so native log lines go to stderr, and never calls `foregroundApp()`.

`Machine.windows()` walks every process and measured 10–12 seconds per call on a desktop with an unresponsive accessibility client, while `ctx.computer` lists windows and apps before every action. The plugin gains a `windowCacheMs` Config field (default `2000`, `0` disables) forwarded to the helper as `--window-cache-ms=<n>`; the adapter reuses one enumeration within that window for `listWindows`, `listApps`, and `permissions`, and re-enumerates immediately when a requested window id is not cached.

## Alternatives considered

**Implement macOS accessibility snapshots in the OS fallback through `osascript` / System Events.** Rejected because the seam decision already chose simulang for its window-bound tree with stable `refId`s, and a JXA walk would add a second, macOS-only tree format with its own action mapping while still leaving Linux and Windows without snapshots.

**Keep simulang undeclared and document a manual install.** Rejected because an undeclared native dependency is invisible to `pnpm install`, lockfile review, and third-party notices, and the default install would keep shipping a provider whose primary observation primitive throws.

**Make simulang a required dependency.** Rejected because the package has no binary for Linux musl or 32-bit targets; `optionalDependencies` lets those installs succeed and the documented OS fallback remain reachable.

**Encode the press action in the handle string instead of a per-tree map.** Rejected because the handle is model-invisible either way and the map keeps the handle format to two fields; the map dies with the tree it belongs to.

**Pass `windowCacheMs` over a new RPC method.** Rejected because argv reaches the helper before its first request without extending the JSON-RPC protocol version; the flag parser fails loud on a malformed value.

## Consequences

`computer_snapshot`, `computer_press`, and `computer_set_value` work on macOS, Linux glibc, and Windows after a plain `pnpm install`; the Simulator window that produced the original error returns a 17-node tree with pressable device buttons. App names and pids in `computer_apps` are real, so the terminal deny list and the harness-pid check apply to the native backend. `pnpm install` now downloads one platform binary (~10 MB) and the lockfile carries the six platform packages.

Window ids follow titles: a window whose title changes between listing and action reads as `COMPUTER_WINDOW_GONE`. Within `windowCacheMs`, a window closed after the last enumeration still lists; the next snapshot on it fails from the native tree. The adapter's structural module interface is a maintenance obligation against simulang's major versions; `loadSimulang` rejecting an unknown API degrades to the OS fallback rather than crashing.

Unit tests drive the adapter through a fake v13 module and pin ids, action dispatch, secure redaction, the node budget, screenshot scale, the input call sequence, logger routing, cache reuse, process naming on POSIX and Windows, and the argv flag round trip. The real addon runs only in `local.e2e.ts` and on a maintainer desktop.
