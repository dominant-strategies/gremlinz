/**
 * Avatar pictures (uploads and NFT images): whatever arrives is sniffed by its bytes, decoded by libvips (sharp) and
 * drawn again as a fresh 256×256 and 64×64 WebP. Nothing of the original file survives: no EXIF (so no GPS), no ICC
 * profile, no XMP, no comments, no extra frames. SVG is never accepted (it is a document, not a picture).
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'

// Nothing a person uploads is kept in libvips' operation cache.
sharp.cache(false)

export const AVATAR_LARGE = 256
export const AVATAR_SMALL = 64
/** Largest upload, in bytes, before decoding. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
/** Decoding bombs: refuse anything larger than this many pixels. */
const MAX_INPUT_PIXELS = 40_000_000

export type RasterKind = 'png' | 'jpeg' | 'webp' | 'gif'

export class AvatarError extends Error {
  readonly status: 400 | 413 | 415
  constructor(status: 400 | 413 | 415, message: string) {
    super(message)
    this.status = status
  }
}

/** What the bytes are, by their signature (never by a declared content type). */
export function sniffImage(b: Uint8Array): RasterKind | 'svg' | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  // SVG / XML / HTML: text starting with '<' (after a BOM or whitespace)
  const head = Buffer.from(b.subarray(0, 512)).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase()
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!doctype') || head.includes('<svg')) return 'svg'
  return null
}

export interface ReencodedAvatar {
  large: Buffer
  small: Buffer
  /** First 16 hex of sha256(large): changes whenever the picture does. */
  hash: string
  mime: 'image/webp'
}

/**
 * Decodes `bytes` (one of `allow`) and draws it again as square WebP avatars, centre-cropped, EXIF orientation applied
 * and every piece of metadata dropped. Throws AvatarError for anything that isn't one of the allowed raster formats or
 * doesn't decode.
 */
export async function reencodeAvatar(bytes: Uint8Array, allow: readonly RasterKind[] = ['png', 'jpeg', 'webp']): Promise<ReencodedAvatar> {
  if (bytes.byteLength === 0) throw new AvatarError(400, 'empty image')
  const kind = sniffImage(bytes)
  if (kind === 'svg') throw new AvatarError(415, 'SVG images are not accepted: use PNG, JPEG or WebP')
  if (!kind || !allow.includes(kind)) throw new AvatarError(415, `the image must be ${allow.map((k) => k.toUpperCase()).join(', ')}`)
  const open = () => sharp(bytes, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: false })
  let format: string | undefined
  try {
    format = (await open().metadata()).format
  } catch {
    throw new AvatarError(400, "that file doesn't decode as an image")
  }
  // libvips agrees with the signature (a PNG header on a JPEG body, or anything else odd, is refused).
  if (format !== kind) throw new AvatarError(415, "the file's contents don't match an allowed image format")
  const draw = (px: number) =>
    open()
      .rotate() // apply the EXIF orientation before it is dropped
      .resize(px, px, { fit: 'cover', position: 'centre' })
      .flatten({ background: '#e9e3d8' }) // transparent pixels sit on the site's paper colour
      .webp({ quality: px > 100 ? 86 : 80, effort: 4 })
      .toBuffer()
  let large: Buffer, small: Buffer
  try {
    ;[large, small] = await Promise.all([draw(AVATAR_LARGE), draw(AVATAR_SMALL)])
  } catch {
    throw new AvatarError(400, "that file doesn't decode as an image")
  }
  return { large, small, hash: createHash('sha256').update(large).digest('hex').slice(0, 16), mime: 'image/webp' }
}

/** Parses a `data:image/(png|jpeg|webp);base64,…` upload into bytes, enforcing the size cap. */
export function decodeUpload(dataUrl: unknown): Uint8Array {
  if (typeof dataUrl !== 'string') throw new AvatarError(400, 'image must be a data: URL')
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!m) throw new AvatarError(415, 'image must be a PNG, JPEG or WebP data: URL (base64)')
  if ((m[2]!.length * 3) / 4 > MAX_UPLOAD_BYTES + 3) throw new AvatarError(413, 'image is larger than 2 MB')
  const bytes = Buffer.from(m[2]!, 'base64')
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new AvatarError(413, 'image is larger than 2 MB')
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
