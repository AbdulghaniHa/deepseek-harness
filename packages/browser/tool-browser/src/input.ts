/**
 * Named keyboard modifiers and platform-correct shortcut bits for CDP input.
 * @module @deepseek-ai/dsh-tool-browser/input
 */

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
const BITS: Readonly<Record<string, number>> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
}

/**
 * Fold named modifiers into a CDP bitmask.
 * @param modifiers - alt, ctrl/control, meta/cmd/command, and/or shift.
 * @returns the bitmask, or 0 when omitted.
 */
export function modifierMask(modifiers?: readonly string[]): number {
  let mask = 0
  for (const name of modifiers ?? []) {
    const bit = BITS[name.toLowerCase()]
    if (bit === undefined) throw new Error(`unknown modifier "${name}"`)
    mask |= bit
  }
  return mask
}

/**
 * Modifier bit for select-all / copy / paste shortcuts on this host.
 * @param platform - host OS; defaults to `process.platform`.
 * @returns Meta on macOS, Control elsewhere.
 */
export function shortcutModifier(platform: NodeJS.Platform = process.platform): number {
  return platform === 'darwin' ? 4 : 2
}

/**
 * Whether a click is an ordinary unmodified single left-click.
 * @param button - requested button.
 * @param count - requested click count.
 * @param modifiers - named modifiers.
 * @returns true when accessibility press may substitute for pointer input.
 */
export function isOrdinaryLeftClick(
  button?: string,
  count?: number,
  modifiers?: readonly string[],
): boolean {
  const left = button === undefined || button === 'left'
  const single = count === undefined || count === 1
  return left && single && (modifiers === undefined || modifiers.length === 0)
}
