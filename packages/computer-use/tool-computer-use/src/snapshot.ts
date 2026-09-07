/**
 * Host-side accessibility snapshot: epoch-scoped refs over provider nodes.
 * @module @deepseek-ai/dsh-tool-computer-use/snapshot
 */

import { ComputerError, type ComputerSnapshot, type ComputerSnapshotNode } from '@deepseek-ai/dsh-computer-use'

/** One outline row the model sees. */
export interface ComputerSnapshotRow {
  readonly ref: string
  readonly handle: string
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly bounds: ComputerSnapshotNode['bounds']
  readonly supportsPress: boolean
  readonly supportsSetValue: boolean
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
 * @param snapshot - provider snapshot.
 * @param options - epoch, node cap, and optional role/name query.
 * @returns the snapshot the model sees.
 */
export function buildComputerSnapshot(snapshot: ComputerSnapshot, options: {
  readonly epoch: number
  readonly maxNodes: number
  readonly query?: string
}): ComputerToolSnapshot {
  const collected: ComputerSnapshotRow[] = []
  const query = options.query?.trim().toLowerCase()
  const walk = (node: ComputerSnapshotNode): void => {
    if (collected.length >= options.maxNodes) return
    const name = node.name
    const role = node.role
    const matches = query === undefined
      || role.toLowerCase().includes(query)
      || name.toLowerCase().includes(query)
    if (matches) {
      collected.push({
        ref: `${options.epoch}-e${collected.length}`,
        handle: node.handle,
        role,
        name,
        ...node.value !== undefined ? { value: node.secure ? '<redacted>' : node.value } : {},
        bounds: node.bounds,
        supportsPress: node.supportsPress,
        supportsSetValue: node.supportsSetValue,
      })
    }
    for (const child of node.children ?? []) walk(child)
  }
  for (const node of snapshot.nodes) walk(node)
  const truncated = snapshot.truncated || collected.length >= options.maxNodes
  const lines = collected.map(node => `- ${node.role}${node.name.length > 0 ? ` "${node.name}"` : ''}${node.value !== undefined ? ` = ${node.value}` : ''} [${node.ref}]`)
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
