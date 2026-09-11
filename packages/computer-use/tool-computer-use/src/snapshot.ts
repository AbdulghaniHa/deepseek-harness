/**
 * Host-side accessibility snapshot: epoch-scoped refs over provider nodes.
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

/** Built snapshot plus the epoch used to mint refs. */
export interface ComputerToolSnapshot {
  readonly epoch: number
  readonly windowId: string
  readonly appId: string
  readonly title: string
  readonly truncated: boolean
  readonly nodes: readonly ComputerSnapshotRow[]
  readonly text: string
}

/** Snapshot refs are `epoch-eN` and fail loudly when the epoch does not match. */
export const SNAPSHOT_REF = /^([0-9]+)-e(\d+)$/

/**
 * Flatten provider nodes depth-first, mint refs, and redact secure values.
 * Depth, query, and node caps apply here; they do not bound native traversal.
 * @param snapshot - provider snapshot.
 * @param options - epoch, node cap, optional depth, query, and subtree handle.
 * @returns the snapshot the model sees.
 */
export function buildComputerSnapshot(snapshot: ComputerSnapshot, options: {
  readonly epoch: number
  readonly maxNodes: number
  readonly maxDepth?: number
  readonly query?: string
  readonly rootHandle?: string
}): ComputerToolSnapshot {
  const collected: ComputerSnapshotRow[] = []
  const query = options.query?.trim().toLowerCase()
  let truncated = snapshot.truncated
  const start = options.rootHandle === undefined
    ? snapshot.nodes
    : findSubtree(snapshot.nodes, options.rootHandle)
  if (options.rootHandle !== undefined && start.length === 0) {
    throw new ComputerError(`unknown snapshot handle "${options.rootHandle}"`, 'COMPUTER_STALE_REF')
  }
  const walk = (node: ComputerSnapshotNode, depth: number): void => {
    const name = node.name
    const role = node.role
    const matches = query === undefined
      || role.toLowerCase().includes(query)
      || name.toLowerCase().includes(query)
    const actions = node.actions
    if (matches) {
      // Only a node the outline would have carried makes the result truncated;
      // a node the query filters out costs the caller nothing.
      if (collected.length >= options.maxNodes) {
        truncated = true
        return
      }
      collected.push({
        ref: `${options.epoch}-e${collected.length}`,
        handle: node.handle,
        role,
        name,
        ...node.value !== undefined ? { value: node.secure ? '<redacted>' : node.value } : {},
        bounds: node.bounds,
        states: node.states,
        actions,
        supportsPress: node.supportsPress || actions.some(action => action !== 'setValue'),
        supportsSetValue: node.supportsSetValue || actions.includes('setValue'),
        depth,
      })
    }
    if (options.maxDepth !== undefined && depth >= options.maxDepth) {
      if ((node.children ?? []).length > 0) truncated = true
      return
    }
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  for (const node of start) walk(node, 0)
  const lines = collected.map((node) => {
    const state = node.states.length > 0 ? ` (${node.states.join(', ')})` : ''
    const acts = node.actions.length > 0 ? ` actions=${node.actions.join(',')}` : ''
    return `- ${node.role}${node.name.length > 0 ? ` "${node.name}"` : ''}${node.value !== undefined ? ` = ${node.value}` : ''}${state}${acts} [${node.ref}]`
  })
  return {
    epoch: options.epoch,
    windowId: snapshot.windowId,
    appId: snapshot.appId,
    title: snapshot.title,
    truncated,
    nodes: collected,
    text: lines.length > 0 ? lines.join('\n') : '(empty window)',
  }
}

/**
 * Resolve a snapshot ref against the last snapshot, failing on a stale epoch.
 * @param ref - model-supplied ref.
 * @param snapshot - last snapshot for the window.
 * @returns the matching node.
 */
export function resolveRef(ref: string, snapshot: ComputerToolSnapshot): ComputerSnapshotRow {
  const match = SNAPSHOT_REF.exec(ref)
  if (match === null) throw new ComputerError(`invalid snapshot ref "${ref}"`, 'COMPUTER_STALE_REF')
  const epoch = Number(match[1])
  if (epoch !== snapshot.epoch) {
    throw new ComputerError(`stale snapshot ref "${ref}" (window epoch is ${snapshot.epoch})`, 'COMPUTER_STALE_REF')
  }
  const node = snapshot.nodes.find(item => item.ref === ref)
  if (node === undefined) throw new ComputerError(`unknown snapshot ref "${ref}"`, 'COMPUTER_STALE_REF')
  return node
}

function findSubtree(nodes: readonly ComputerSnapshotNode[], handle: string): ComputerSnapshotNode[] {
  for (const node of nodes) {
    if (node.handle === handle) return [node]
    const nested = findSubtree(node.children ?? [], handle)
    if (nested.length > 0) return nested
  }
  return []
}
