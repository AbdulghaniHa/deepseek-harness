/**
 * Host-side accessibility snapshot: observation-scoped refs from a CDP AX tree.
 * Refs bind to one observation and never write into the page DOM.
 * @module @deepseek-ai/dsh-tool-browser/snapshot
 */

import { boundChars } from './text.ts'

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
  readonly frameId?: string
  readonly depth: number
  readonly states: readonly string[]
}

/** Built snapshot plus the observation used to mint refs. */
export interface BrowserSnapshot {
  readonly observationId: string
  readonly url: string
  readonly title: string
  readonly truncated: boolean
  /** Complete capture; refs resolve against this list even when `nodes` is a page. */
  readonly allNodes: readonly SnapshotNode[]
  readonly nodes: readonly SnapshotNode[]
  readonly text: string
  readonly frameId?: string
}

const SECRET_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
const SECRET_NAME = /password|one[- ]?time|otp|verification code|credit card|card number|cvv|ssn|social security|phone|email|pin/i

/** Snapshot refs are `observationId-eN` and fail when the observation does not match. */
export const SNAPSHOT_REF = /^([0-9]+)-e(\d+)$/

/**
 * Build a ref-annotated outline from an AX tree.
 * @param nodes - CDP AX nodes.
 * @param options - page identity, observation, caps, and optional view filters.
 * @returns the snapshot the model sees.
 */
export function buildSnapshot(nodes: readonly AxNode[], options: {
  readonly url: string
  readonly title: string
  readonly observationId: string
  readonly maxNodes: number
  readonly maxFieldChars: number
  readonly frameId?: string
  readonly query?: string
  readonly maxDepth?: number
  readonly offset?: number
  readonly limit?: number
}): BrowserSnapshot {
  const byId = new Map(nodes.map(node => [node.nodeId ?? '', node]))
  const childIds = new Set<string>()
  for (const node of nodes) {
    for (const childId of node.childIds ?? []) childIds.add(childId)
  }
  const collected: SnapshotNode[] = []
  const seen = new Set<string>()
  const roots = nodes.filter((node) => {
    const id = node.nodeId
    if (id === undefined) return false
    return !childIds.has(id)
  })
  const walk = (node: AxNode, depth: number): void => {
    if (collected.length >= options.maxNodes) return
    if (node.nodeId !== undefined) {
      if (seen.has(node.nodeId)) return
      seen.add(node.nodeId)
    }
    const overDepth = options.maxDepth !== undefined && depth > options.maxDepth
    if (node.ignored !== true && !overDepth) {
      const role = node.role?.value ?? 'generic'
      const rawName = node.name?.value ?? ''
      const rawValue = node.value?.value
      const secret = isSecret(role, rawName, node)
      const name = boundChars(rawName, options.maxFieldChars).text
      if (role !== 'generic' || name.length > 0) {
        const valueText = rawValue === undefined
          ? undefined
          : secret
            ? '<redacted>'
            : boundChars(rawValue, options.maxFieldChars).text
        collected.push({
          ref: `${options.observationId}-e${collected.length}`,
          role,
          name,
          ...valueText !== undefined ? { value: valueText } : {},
          ...node.backendDOMNodeId !== undefined ? { backendNodeId: node.backendDOMNodeId } : {},
          ...options.frameId !== undefined ? { frameId: options.frameId } : {},
          depth,
          states: axStates(node),
        })
      }
    }
    if (overDepth) return
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child !== undefined) walk(child, depth + 1)
    }
  }
  for (const root of roots.length > 0 ? roots : nodes) walk(root, 0)
  const viewed = viewSnapshot({
    observationId: options.observationId,
    url: options.url,
    title: options.title,
    truncated: collected.length >= options.maxNodes,
    allNodes: collected,
    nodes: collected,
    text: formatNodes(collected),
    ...options.frameId !== undefined ? { frameId: options.frameId } : {},
  }, {
    ...options.query !== undefined ? { query: options.query } : {},
    ...options.offset !== undefined ? { offset: options.offset } : {},
    ...options.limit !== undefined ? { limit: options.limit } : {},
  })
  return viewed
}

/**
 * Filter or paginate an existing capture without minting new refs.
 * @param snapshot - last snapshot for the tab.
 * @param options - optional role/name query and page window.
 * @returns a view of the same observation.
 */
export function viewSnapshot(snapshot: BrowserSnapshot, options: {
  readonly query?: string
  readonly offset?: number
  readonly limit?: number
} = {}): BrowserSnapshot {
  const query = options.query?.trim().toLowerCase()
  const matched = snapshot.allNodes.filter(node =>
    query === undefined
    || node.role.toLowerCase().includes(query)
    || node.name.toLowerCase().includes(query))
  const offset = options.offset ?? 0
  const visible = options.limit === undefined ? matched.slice(offset) : matched.slice(offset, offset + options.limit)
  const truncated = snapshot.truncated
    || (options.limit !== undefined && offset + visible.length < matched.length)
  return {
    ...snapshot,
    truncated,
    allNodes: snapshot.allNodes,
    nodes: visible,
    text: formatNodes(visible),
  }
}

/**
 * Resolve a snapshot ref against the last snapshot, failing on a stale observation.
 * @param ref - model-supplied ref.
 * @param snapshot - last snapshot for the tab.
 * @returns the matching node.
 */
export function resolveRef(ref: string, snapshot: BrowserSnapshot): SnapshotNode {
  const match = SNAPSHOT_REF.exec(ref)
  if (match === null) throw new Error(`invalid snapshot ref "${ref}"`)
  const observationId = match[1]
  if (observationId !== snapshot.observationId) {
    throw new Error(`stale snapshot ref "${ref}" (observation is ${snapshot.observationId})`)
  }
  const node = snapshot.allNodes.find(item => item.ref === ref)
  if (node === undefined) throw new Error(`unknown snapshot ref "${ref}"`)
  return node
}

/**
 * Resolve a ref against the full capture even when the current view is paginated.
 * @param ref - model-supplied ref.
 * @param nodes - complete node list from the observation.
 * @param observationId - observation the refs bind to.
 * @returns the matching node.
 */
export function resolveRefFrom(ref: string, nodes: readonly SnapshotNode[], observationId: string): SnapshotNode {
  const match = SNAPSHOT_REF.exec(ref)
  if (match === null) throw new Error(`invalid snapshot ref "${ref}"`)
  if (match[1] !== observationId) {
    throw new Error(`stale snapshot ref "${ref}" (observation is ${observationId})`)
  }
  const node = nodes.find(item => item.ref === ref)
  if (node === undefined) throw new Error(`unknown snapshot ref "${ref}"`)
  return node
}

function formatNodes(nodes: readonly SnapshotNode[]): string {
  if (nodes.length === 0) return '(empty page)'
  return nodes.map((node) => {
    const indent = '  '.repeat(node.depth)
    const state = node.states.length > 0 ? ` (${node.states.join(', ')})` : ''
    return `${indent}- ${node.role}${node.name.length > 0 ? ` "${node.name}"` : ''}${node.value !== undefined ? ` = ${node.value}` : ''}${state} [${node.ref}]`
  }).join('\n')
}

function axStates(node: AxNode): string[] {
  const states: string[] = []
  let disabled = false
  let editable = false
  for (const property of node.properties ?? []) {
    const name = property.name
    const value = property.value?.value
    if (name === 'disabled' && value === true) disabled = true
    if (name === 'checked' && (value === true || value === 'mixed')) {
      states.push(value === 'mixed' ? 'mixed' : 'checked')
    }
    if (name === 'selected' && value === true) states.push('selected')
    if (name === 'expanded' && value === true) states.push('expanded')
    if (name === 'expanded' && value === false) states.push('collapsed')
    if (name === 'readonly' && value === false) editable = true
    if (name === 'editable' && value === true) editable = true
  }
  if (disabled) states.push('disabled')
  if (editable) states.push('editable')
  return states
}

function isSecret(role: string, name: string, node: AxNode): boolean {
  if (SECRET_NAME.test(name)) return true
  const described = node.properties?.some((property) => {
    const value: unknown = property.value?.value
    return (property.name === 'sensitive' || property.name === 'autocomplete')
      && typeof value === 'string'
      && /password|one-time|cc-|tel|email|pin/i.test(value)
  })
  return described === true && SECRET_ROLES.has(role)
}
