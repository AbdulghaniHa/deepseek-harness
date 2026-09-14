/**
 * Physically fit a PNG to a max width before attachment storage.
 * @module @deepseek-ai/dsh-tool-computer-use/image
 */

import sharp from 'sharp'

/** Resized PNG plus the per-axis mapping from the source image. */
export interface FittedPng {
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly scaleX: number
  readonly scaleY: number
}

/**
 * Downscale a PNG so its width does not exceed `maxWidth`. Invalid or empty
 * images are returned unchanged with a 1:1 mapping.
 * @param png - source PNG bytes.
 * @param maxWidth - maximum stored width in pixels.
 * @returns stored bytes, stored pixel size, and per-axis scale from the source.
 */
export async function fitPng(png: Uint8Array, maxWidth: number): Promise<FittedPng> {
  try {
    const image = sharp(png, { failOn: 'error', limitInputPixels: false })
    const meta = await image.metadata()
    /* v8 ignore start -- sharp supplies width and height for a decoded PNG; the zeros satisfy the optional type. */
    const sourceWidth = meta.width ?? 0
    const sourceHeight = meta.height ?? 0
    /* v8 ignore stop */
    if (sourceWidth <= maxWidth) {
      return {
        png,
        width: sourceWidth,
        height: sourceHeight,
        sourceWidth,
        sourceHeight,
        scaleX: 1,
        scaleY: 1,
      }
    }
    const width = maxWidth
    const height = Math.max(1, Math.round(sourceHeight * (maxWidth / sourceWidth)))
    const out = new Uint8Array(await image.resize(width, height).png().toBuffer())
    return {
      png: out,
      width,
      height,
      sourceWidth,
      sourceHeight,
      scaleX: width / sourceWidth,
      scaleY: height / sourceHeight,
    }
  } catch {
    // Test bytes and corrupt captures skip transcoding; callers keep provider dimensions.
    return { png, width: 0, height: 0, sourceWidth: 0, sourceHeight: 0, scaleX: 1, scaleY: 1 }
  }
}
