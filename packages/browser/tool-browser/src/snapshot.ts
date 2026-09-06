/**
 * Host-side accessibility snapshot: ref-annotated outline from a CDP AX tree.
 * Refs carry a per-navigation epoch and never write into the page DOM.
 * @module @deepseek-ai/dsh-tool-browser/snapshot
 */

/** One AX node as CDP `Accessibility.getFullAXTree` returns it. */
export interface AxNode {
  readonly nodeId?: string
  readonly backendDOMNodeId?: number
  readonly role?: { readonly value?: string }
  readonly name?: { readonly value?: string }
  readonly value?: { readonly value?: string }
  readonly properties?: readonly { readonly name?: string; readonly value?: { readonly value?: unknown } }[]
  readonly childIds?: readonly string[]
  readonly ignored?: boolean
}

/** One outline row the model sees. */
export interface SnapshotNode {
  readonly ref: string
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly backendNodeId?: number
}

/** Built snapshot plus the epoch used to mint refs. */
export interface BrowserSnapshot {
  readonly epoch: number
  readonly url: string
  readonly title: string
  readonly truncated: boolean
  readonly nodes: readonly SnapshotNode[]
  readonly text: string
}

const SECRET_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
const SECRET_NAME = /password|one[- ]?time|otp|verification code|credit card|card number|cvv|ssn|social security|phone|email|pin/i

/** Snapshot refs are `epoch-eN` and fail loudly when the epoch does not match. */
export const SNAPSHOT_REF = /^([0-9]+)-e(\d+)$/

/**
 * Build a ref-annotated outline from an AX tree.
 * @param nodes - CDP AX nodes.
 * @param options - page url/title, epoch, and max node count.
 * @returns the snapshot the model sees.
 */
export function buildSnapshot(nodes: readonly AxNode[], options: {
  readonly url: string
  readonly title: string
  readonly epoch: number
  readonly maxNodes: number
}): BrowserSnapshot {
  const byId = new Map(nodes.map(node => [node.nodeId ?? '', node]))
  const collected: SnapshotNode[] = []
  const seen = new Set<string>()
  const roots = nodes.filter((node) => {
    const id = node.nodeId
    if (id === undefined) return false
    return ![...byId.values()].some(parent => parent.childIds?.includes(id))
  })
  const walk = (node: AxNode): void => {
    if (collected.length >= options.maxNodes) return
    if (node.nodeId !== undefined) {
      if (seen.has(node.nodeId)) return
      seen.add(node.nodeId)
    }
    if (node.ignored !== true) {
      const role = node.role?.value ?? 'generic'
      const name = node.name?.value ?? ''
      const rawValue = node.value?.value
      const secret = isSecret(role, name, node)
      if (role !== 'generic' || name.length > 0) {
        collected.push({
          ref: `${options.epoch}-e${collected.length}`,
          role,
          name,
          ...rawValue !== undefined ? { value: secret ? '<redacted>' : String(rawValue) } : {},
          ...node.backendDOMNodeId !== undefined ? { backendNodeId: node.backendDOMNodeId } : {},
        })
      }
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child !== undefined) walk(child)
    }
  }
  for (const root of roots.length > 0 ? roots : nodes) walk(root)
  const truncated = collected.length >= options.maxNodes
  const lines = collected.map(node => `- ${node.role}${node.name.length > 0 ? ` "${node.name}"` : ''}${node.value !== undefined ? ` = ${node.value}` : ''} [${node.ref}]`)
  return {
    epoch: options.epoch,
    url: options.url,
    title: options.title,
    truncated,
    nodes: collected,
    text: lines.length > 0 ? lines.join('\n') : '(empty page)',
  }
}

/**
 * Resolve a snapshot ref against the last snapshot, failing on a stale epoch.
 * @param ref - model-supplied ref.
 * @param snapshot - last snapshot for the tab.
 * @returns the matching node.
 */
export function resolveRef(ref: string, snapshot: BrowserSnapshot): SnapshotNode {
  const match = SNAPSHOT_REF.exec(ref)
  if (match === null) throw new Error(`invalid snapshot ref "${ref}"`)
  const epoch = Number(match[1])
  if (epoch !== snapshot.epoch) throw new Error(`stale snapshot ref "${ref}" (page epoch is ${snapshot.epoch})`)
  const node = snapshot.nodes.find(item => item.ref === ref)
  if (node === undefined) throw new Error(`unknown snapshot ref "${ref}"`)
  return node
}

function isSecret(role: string, name: string, node: AxNode): boolean {
  if (SECRET_NAME.test(name)) return true
  const described = node.properties?.some(property =>
    (property.name === 'sensitive' || property.name === 'autocomplete')
    && String(property.value?.value ?? '').match(/password|one-time|cc-|tel|email|pin/i) !== null,
  )
  return described === true && SECRET_ROLES.has(role)
}
