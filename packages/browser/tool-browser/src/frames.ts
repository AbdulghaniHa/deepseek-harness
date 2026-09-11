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
 * Drag endpoints must resolve to the same document frame. The caller passes
 * each endpoint's frame, using the main frame for raw viewport coordinates.
 * @param fromFrame - frame id of the press point.
 * @param toFrame - frame id of the release point.
 * @returns nothing; throws when the two frame ids differ.
 */
export function assertSameFrame(fromFrame?: string, toFrame?: string): void {
  if (fromFrame !== toFrame) {
    throw new BrowserError('browser_drag requires both endpoints in the same frame', 'BROWSER_UNSUPPORTED_DRAG')
  }
}
