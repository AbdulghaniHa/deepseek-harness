/**
 * Flatten a CDP `Page.getFrameTree` result into seam {@link BrowserFrame} rows.
 * @module @deepseek-ai/dsh-tool-browser/frames
 */

import { BrowserError, BrowserFrameId, type BrowserFrame } from '@deepseek-ai/dsh-browser'

/** One node as CDP `Page.getFrameTree` returns it. */
export interface FrameTreeNode {
  readonly frame: {
    readonly id: string
    readonly parentId?: string
    readonly name?: string
    readonly url?: string
    readonly securityOrigin?: string
  }
  readonly childFrames?: readonly FrameTreeNode[]
}

/**
 * Walk a frame tree depth-first, parent before children.
 * @param root - CDP frame tree root.
 * @returns ordered frames with branded ids.
 */
export function flattenFrameTree(root: FrameTreeNode): BrowserFrame[] {
  const frames: BrowserFrame[] = []
  const walk = (node: FrameTreeNode, parentId?: string): void => {
    frames.push({
      frameId: BrowserFrameId(node.frame.id),
      ...parentId !== undefined ? { parentFrameId: BrowserFrameId(parentId) } : {},
      url: node.frame.url ?? '',
      ...node.frame.name ? { name: node.frame.name } : {},
      ...node.frame.securityOrigin !== undefined ? { securityOrigin: node.frame.securityOrigin } : {},
    })
    for (const child of node.childFrames ?? []) walk(child, node.frame.id)
  }
  walk(root)
  return frames
}

/**
 * Drag endpoints must share a frame when both are snapshot refs.
 * @param fromFrame - frame id of the press ref, if any.
 * @param toFrame - frame id of the release ref, if any.
 * @returns nothing; throws when both ids are present and differ.
 */
export function assertSameFrame(fromFrame?: string, toFrame?: string): void {
  if (fromFrame !== undefined && toFrame !== undefined && fromFrame !== toFrame) {
    throw new BrowserError('browser_drag requires both endpoints in the same frame', 'BROWSER_UNSUPPORTED_DRAG')
  }
}
