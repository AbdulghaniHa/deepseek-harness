# Drive GUI apps from DeepSeek Harness

English | [中文](computer-use.zh.md)

The `computer_*` tools drive GUI applications through the OS accessibility tree, with screenshots as an additive sense on image-capable model routes. They are mounted in `dsh-base` with `enabled: false` until you turn them on after granting OS permissions.

## Check permissions

```sh
dsh computer doctor
```

On macOS, grant **Accessibility** and **Screen Recording** to the terminal (or app) that launches `dsh`. Re-run with `--request` to trigger the system prompt:

```sh
dsh computer doctor --request
```

On Linux, X11 sessions can synthesize input; Wayland input injection is unsupported. Windows computer-use is foreground-only.

## Enable the tools

Add a profile overlay (`$DSH_HOME/profiles/<name>/cordis.patch.yml`):

```yaml
- id: tool-computer-use
  name: '@deepseek-ai/dsh-tool-computer-use'
  config:
    enabled: true
    approval: apps
```

First use of an app asks **Allow once** / **Allow for this session** / **Deny**. Terminal apps and the harness process itself are always refused.

Prefer `computer_snapshot` and refs. Use `computer_screenshot` only when the accessibility tree is insufficient and the current model accepts images.
