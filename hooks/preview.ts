// The runtime has these (ES2025); the TypeScript lib in use doesn't declare them yet
declare global {
  interface Uint8Array {
    toBase64(): string
  }
  interface Uint8ArrayConstructor {
    fromBase64(base64: string): Uint8Array
  }
}

// How an image is drawn: real pixels where the terminal speaks a graphics
// protocol, else half-block cells (two pixels a cell) in any truecolor terminal
export type Preview =
  | { kind: 'pixels'; file: string; generation: number; columns: number; rows: number }
  | { kind: 'cells'; cells: string; columns: number; rows: number }

// A line that is only an image: ![alt](src), src optionally in <angle brackets>
export function imageOfLine(line: string): { alt: string; src: string } | null {
  const m = /^\s*!\[([^\]]*)\]\(\s*<?([^)>]+?)>?(?:\s+"[^"]*")?\s*\)\s*$/.exec(line)
  return m ? { alt: m[1] ?? '', src: m[2] ?? '' } : null
}


// Cells for an image at most `columns` wide and `maxRows` tall, keeping its
// shape: a cell is about twice as tall as it is wide
export function fitRows(width: number, height: number, columns: number, maxRows: number): { columns: number; rows: number } {
  const rows = Math.max(1, Math.round((columns * height) / width / 2))
  if (rows <= maxRows) return { columns, rows }
  return { columns: Math.max(1, Math.round((maxRows * 2 * width) / height)), rows: maxRows }
}

// RGBA pixels of a BMP as sips writes it (32-bit with masks), or plain 24/32-bit
export function decodeBmp(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = v.getUint32(10, true)
  const width = v.getInt32(18, true)
  const rawHeight = v.getInt32(22, true)
  const height = Math.abs(rawHeight)
  const bpp = v.getUint16(28, true)
  const bitfields = v.getUint32(30, true) === 3
  const mask = (at: number, fallback: number) => (bitfields ? v.getUint32(at, true) : fallback)
  const masks = [mask(54, 0xff0000), mask(58, 0xff00), mask(62, 0xff), bpp === 32 ? mask(66, 0xff000000) : 0]
  const channel = (px: number, m: number) => {
    if (!m) return 255
    let shift = 0
    while (((m >>> shift) & 1) === 0) shift++
    return Math.round((((px & m) >>> shift) * 255) / (m >>> shift))
  }
  const stride = Math.floor((bpp * width + 31) / 32) * 4
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = offset + (rawHeight < 0 ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const at = row + x * (bpp / 8)
      const px = bpp === 32 ? v.getUint32(at, true) : v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getUint8(at + 2) << 16)
      masks.forEach((m, c) => (rgba[(y * width + x) * 4 + c] = channel(px, m)))
    }
  }
  return { width, height, rgba }
}

// Half-block cells: each cell's upper pixel as ▀ in the foreground, the lower
// as the background; mostly transparent pixels show the terminal's own color
export function halfBlocks(rgba: Uint8Array, width: number, height: number): string {
  const rows = Math.ceil(height / 2)
  const words = new Uint32Array(width * rows * 3)
  const clear = 0x01000000
  const color = (x: number, y: number) => {
    if (y >= height) return clear
    const at = (y * width + x) * 4
    if ((rgba[at + 3] ?? 255) < 128) return clear
    return ((rgba[at] ?? 0) << 16) | ((rgba[at + 1] ?? 0) << 8) | (rgba[at + 2] ?? 0)
  }
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < width; x++) {
      const i = (r * width + x) * 3
      const top = color(x, r * 2)
      const bottom = color(x, r * 2 + 1)
      // A half block's glyph half takes the text color, so an empty half is
      // drawn as the cell's background instead: ▀ or ▄ by which half has color
      const [glyph, fg, bg] = top !== clear ? [0x2580, top, bottom] : bottom !== clear ? [0x2584, bottom, clear] : [0x20, clear, clear]
      words[i] = glyph
      words[i + 1] = fg
      words[i + 2] = bg
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}

export function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(36)
}
