/**
 * Host-side accessibility snapshot: observation-scoped refs over provider nodes.
 * @module @deepseek-ai/dsh-tool-computer-use/snapshot
 */

import {
  ComputerError,
  type ComputerA11yAction,
  type ComputerRect,
  type ComputerSnapshot,
  type ComputerSnapshotNode,
} from '@deepseek-ai/dsh-computer-use'

/** One outline row the model sees. */
export interface ComputerSnapshotRow {
  readonly ref: string
  readonly handle: string
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly bounds: ComputerRect
  readonly states: readonly string[]
  readonly actions: readonly ComputerA11yAction[]
  readonly supportsPress: boolean
  readonly supportsSetValue: boolean
  readonly depth: number
}

/** Built snapshot plus the observation used to mint refs. */
export interface ComputerToolSnapshot {
  readonly observationId: string
  readonly windowId: string
  readonly appId: string
  readonly title: string
  readonly truncated: boolean
  /** Complete capture; refs resolve against this list even when `nodes` is a filtered view. */
  readonly allNodes: readonly ComputerSnapshotRow[]
  readonly nodes: readonly ComputerSnapshotRow[]
  readonly text: string
}

/** Snapshot refs are `observationId-eN` and fail when the observation does not match. */
export const SNAPSHOT_REF = /^([0-9]+)-e(\d+)$/

const DEFAULT_FIELD_CHARS = 2000

/**
 * Flatten provider nodes depth-first, mint refs, and redact secure values.
 * Depth, query, and node caps apply here; they do not bound native traversal.
 * @param snapshot - provider snapshot.
 * @param options - observation, node cap, optional depth, query, and subtree handle.
 * @returns the snapshot the model sees.
 */
export function buildComputerSnapshot(snapshot: ComputerSnapshot, options: {
  readonly observationId: string
  readonly maxNodes: number
  readonly maxFieldChars?: number
  readonly maxDepth?: number
  readonly query?: string
  readonly rootHandle?: string
}): ComputerToolSnapshot {
  const collected: ComputerSnapshotRow[] = []
  const maxFieldChars = options.maxFieldChars ?? DEFAULT_FIELD_CHARS
  let truncated = snapshot.truncated
  const start = options.rootHandle === undefined
    ? snapshot.nodes
    : findSubtree(snapshot.nodes, options.rootHandle)
  if (options.rootHandle !== undefined && start.length === 0) {
    throw new ComputerError(`unknown snapshot handle "${options.rootHandle}"`, 'COMPUTER_STALE_REF')
  }
  const walk = (node: ComputerSnapshotNode, depth: number): void => {
    const name = boundChars(node.name, maxFieldChars)
    const role = node.role
    const actions = node.actions
    if (collected.length >= options.maxNodes) {
      truncated = true
      return
    }
    collected.push({
      ref: `${options.observationId}-e${collected.length}`,
      handle: node.handle,
      role,
      name,
      ...node.value !== undefined
        ? { value: node.secure ? '<redacted>' : boundChars(node.value, maxFieldChars) }
        : {},
      bounds: node.bounds,
      states: node.states,
      actions,
      supportsPress: node.supportsPress || actions.some(action => action !== 'setValue'),
      supportsSetValue: node.supportsSetValue || actions.includes('setValue'),
      depth,
    })
    if (options.maxDepth !== undefined && depth >= options.maxDepth) {
      if ((node.children ?? []).length > 0) truncated = true
      return
    }
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  for (const node of start) walk(node, 0)
  const full: ComputerToolSnapshot = {
    observationId: options.observationId,
    windowId: snapshot.windowId,
    appId: snapshot.appId,
    title: snapshot.title,
    truncated,
    allNodes: collected,
    nodes: collected,
    text: formatRows(collected),
  }
  return viewComputerSnapshot(full, options.query)
}

/**
 * Filter an existing capture without minting new refs.
 * @param snapshot - last snapshot for the window.
 * @param query - optional role or name substring.
 * @returns a view of the same observation.
 */
export function viewComputerSnapshot(snapshot: ComputerToolSnapshot, query?: string): ComputerToolSnapshot {
  const needle = query?.trim().toLowerCase()
  if (needle === undefined || needle.length === 0) return snapshot
  const nodes = snapshot.allNodes.filter(node =>
    node.role.toLowerCase().includes(needle) || node.name.toLowerCase().includes(needle))
  return { ...snapshot, nodes, text: formatRows(nodes) }
}

/**
 * Resolve a snapshot ref against the last snapshot, failing on a stale observation.
 * @param ref - model-supplied ref.
 * @param snapshot - last snapshot for the window.
 * @returns the matching node.
 */
export function resolveRef(ref: string, snapshot: ComputerToolSnapshot): ComputerSnapshotRow {
  const match = SNAPSHOT_REF.exec(ref)
  if (match === null) throw new ComputerError(`invalid snapshot ref "${ref}"`, 'COMPUTER_STALE_REF')
  if (match[1] !== snapshot.observationId) {
    throw new ComputerError(`stale snapshot ref "${ref}" (observation is ${snapshot.observationId})`, 'COMPUTER_STALE_REF')
  }
  const node = snapshot.allNodes.find(item => item.ref === ref)
  if (node === undefined) throw new ComputerError(`unknown snapshot ref "${ref}"`, 'COMPUTER_STALE_REF')
  return node
}

function formatRows(nodes: readonly ComputerSnapshotRow[]): string {
  if (nodes.length === 0) return '(empty window)'
  return nodes.map((node) => {
    const indent = '  '.repeat(node.depth)
    const state = node.states.length > 0 ? ` (${node.states.join(', ')})` : ''
    const acts = node.actions.length > 0 ? ` actions=${node.actions.join(',')}` : ''
    return `${indent}- ${node.role}${node.name.length > 0 ? ` "${node.name}"` : ''}${node.value !== undefined ? ` = ${node.value}` : ''}${state}${acts} [${node.ref}]`
  }).join('\n')
}

function boundChars(value: string, maxChars: number): string {
  if ([...value].length <= maxChars) return value
  return [...value].slice(0, maxChars).join('')
}

function findSubtree(nodes: readonly ComputerSnapshotNode[], handle: string): ComputerSnapshotNode[] {
  for (const node of nodes) {
    if (node.handle === handle) return [node]
    const nested = findSubtree(node.children ?? [], handle)
    if (nested.length > 0) return nested
  }
  return []
}
