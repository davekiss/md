import type { Comment, Pos } from '../types'

export type { Pos }

export function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function quoteOf(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join('\n')
}

// Moves each comment to where its quoted lines went after an edit, nearest the
// old spot first; a comment whose lines are gone is marked stale.
export function reanchor(comments: Comment[], lines: string[]): Comment[] {
  return comments.map(c => {
    if (c.status === 'resolved') return c
    if (quoteOf(lines, c.start, c.end) === c.quote) return { ...c, status: c.status === 'stale' ? 'open' : c.status }
    const span = c.end - c.start
    let best = -1
    for (let i = 1; i + span <= lines.length; i++) {
      if (quoteOf(lines, i, i + span) !== c.quote) continue
      if (best === -1 || Math.abs(i - c.start) < Math.abs(best - c.start)) best = i
    }
    if (best === -1) return { ...c, status: 'stale' }
    return { ...c, start: best, end: best + span, status: 'open' }
  })
}

// Lines of `next` (1-based) that the old text did not have.
export function changedLines(prev: string[], next: string[]): number[] {
  const pool = new Map<string, number>()
  for (const line of prev) pool.set(line, (pool.get(line) ?? 0) + 1)
  const changed: number[] = []
  next.forEach((line, i) => {
    const left = pool.get(line) ?? 0
    if (left > 0) pool.set(line, left - 1)
    else if (line.trim() !== '') changed.push(i + 1)
  })
  return changed
}

// Finds the line range a mouse selection covers, by its first and last lines.
export function rangeOfText(lines: string[], text: string): [number, number] | null {
  const picked = splitLines(text).map(l => l.trim()).filter(Boolean)
  const firstText = picked[0]
  const lastText = picked[picked.length - 1]
  if (firstText === undefined || lastText === undefined) return null
  const first = lines.findIndex(l => l.includes(firstText))
  if (first === -1) return null
  let last = first
  for (let i = first; i < lines.length && i < first + picked.length * 3; i++) {
    if (lines[i]?.includes(lastText)) last = i
  }
  return [first + 1, last + 1]
}

// Every line range where `quote` appears, ignoring differences in whitespace and
// line breaks, nearest `near` first.
export function rangesOfQuote(lines: string[], quote: string, near = 1): [number, number][] {
  const words = quote.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const pattern = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g')
  const text = lines.join('\n')
  const lineAt = (offset: number) => text.slice(0, offset).split('\n').length
  const found: [number, number][] = []
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0
    found.push([lineAt(at), lineAt(at + m[0].length)])
  }
  return found.sort((a, b) => Math.abs(a[0] - near) - Math.abs(b[0] - near))
}

// Every place `text` appears exactly, as the caret positions around it,
// nearest `near` first.
export function spansOf(lines: string[], text: string, near = 1): [Pos, Pos][] {
  if (!text) return []
  const all = lines.join('\n')
  const posAt = (offset: number): Pos => {
    const before = all.slice(0, offset).split('\n')
    return { line: before.length, col: (before[before.length - 1] ?? '').length }
  }
  const found: [Pos, Pos][] = []
  for (let i = all.indexOf(text); i !== -1; i = all.indexOf(text, i + 1)) found.push([posAt(i), posAt(i + text.length)])
  return found.sort((a, b) => Math.abs(a[0].line - near) - Math.abs(b[0].line - near))
}

export function fence(lines: string[], start: number, end: number): string {
  return '```markdown\n' + quoteOf(lines, start, end) + '\n```'
}

export function rangeLabel(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`
}

// How a prompt names the open document: its path, or the unsaved draft
export function docLabel(path: string | null): string {
  return path ?? 'the unsaved draft in the md pane (edit it with mcp__md__edit)'
}

// Whether every character of `query` appears in `text` in order, ignoring case
export function fuzzy(query: string, text: string): boolean {
  const t = text.toLowerCase()
  let at = 0
  for (const ch of query.toLowerCase().replace(/\s+/g, '')) {
    at = t.indexOf(ch, at)
    if (at === -1) return false
    at++
  }
  return true
}

// A draft's lines: Claude's text alone, or after `base` with a blank line between
export function draftLines(base: string[] | null, text: string): string[] {
  const added = splitLines(text.replace(/\n+$/, ''))
  return base && base.some(l => l.trim()) ? [...base, '', ...added] : added
}

// The value of string `field` in JSON that is still arriving, as far as it
// has come; null until the field starts
export function partialString(json: string, field: string): string | null {
  const start = new RegExp(`"${field}"\\s*:\\s*"`).exec(json)
  if (!start) return null
  let raw = ''
  for (let i = start.index + start[0].length; i < json.length; i++) {
    const ch = json[i]
    if (ch === '"') break
    if (ch === '\\') {
      const len = json[i + 1] === 'u' ? 6 : 2
      if (i + len > json.length) break
      raw += json.slice(i, i + len)
      i += len - 1
      continue
    }
    raw += ch
  }
  try {
    return JSON.parse('"' + raw + '"') as string
  } catch {
    return raw
  }
}

export function askPrompt(path: string | null, lines: string[], c: Comment): string {
  return [
    `In ${docLabel(path)}, ${rangeLabel(c.start, c.end)}:`,
    '',
    fence(lines, c.start, c.end),
    '',
    ...(c.excerpt ? [`Specifically this text: "${c.excerpt}"`, ''] : []),
    c.text,
    '',
    `(From the md pane, comment ${c.id}. Edit the file as needed, then call mcp__md__reply with id "${c.id}" and a one-line summary.)`,
  ].join('\n')
}

export function reviewPrompt(path: string | null, lines: string[], open: Comment[]): string {
  const parts = open.map(c =>
    [`### ${c.id}: ${rangeLabel(c.start, c.end)}`, fence(lines, c.start, c.end), c.text].join('\n'),
  )
  return [
    `Address my review comments on ${docLabel(path)}. Edit the file for each one, then call mcp__md__reply for each id with a one-line summary (resolve: true when done).`,
    '',
    ...parts,
  ].join('\n\n')
}

export type Block = {
  /** 1-based, inclusive */
  start: number
  end: number
  kind: 'heading' | 'code' | 'text'
  /** Heading level, 1-6 */
  level?: number
  /** The heading's words, or a code fence's language */
  label?: string
  text: string
}

// Splits markdown into the units a reader steps through: headings, fenced
// code, and runs of text separated by blank lines.
export function blocksOf(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i++
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ start: i + 1, end: i + 1, kind: 'heading', level: heading[1]?.length, label: heading[2]?.trim(), text: line })
      i++
      continue
    }
    const fence = /^\s*(```|~~~)\s*(\S*)/.exec(line)
    if (fence) {
      let j = i + 1
      while (j < lines.length && !(lines[j] ?? '').trimStart().startsWith(fence[1] ?? '```')) j++
      const end = Math.min(j, lines.length - 1)
      blocks.push({ start: i + 1, end: end + 1, kind: 'code', label: fence[2] || undefined, text: lines.slice(i + 1, j).join('\n') })
      i = end + 1
      continue
    }
    let j = i
    while (j + 1 < lines.length && (lines[j + 1] ?? '').trim() !== '' && !/^(#{1,6}\s|\s*(```|~~~))/.test(lines[j + 1] ?? '')) j++
    blocks.push({ start: i + 1, end: j + 1, kind: 'text', text: lines.slice(i, j + 1).join('\n') })
    i = j + 1
  }
  return blocks
}

// The block a line falls in, or the last one starting before it.
export function blockAt(blocks: Block[], line: number): number {
  let at = 0
  blocks.forEach((b, i) => {
    if (b.start <= line) at = i
  })
  return at
}

// Rows a block takes at a width, roughly: wrapped lines plus its gap.
export function rowsOfBlock(b: Block, width: number): number {
  const lines = b.kind === 'heading' && b.level === 1 ? 1 : b.kind === 'code' ? 3 : 0
  if (isTable(b.text)) return tableRows(tableOf(b.text, width)) + 1
  return lines + b.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(10, width))), 0) + 1
}

export function readMinutes(lines: string[]): number {
  const words = lines.join(' ').split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round(words / 230))
}

export type TableCell = { text: string; isCode: boolean; isBold: boolean }
export type Table = { header: TableCell[]; rows: TableCell[][]; widths: number[] }

export function isTable(text: string): boolean {
  const rows = text.split('\n')
  return rows.length > 1 && rows.every(r => r.trimStart().startsWith('|')) && /^\s*\|?\s*:?-{2,}/.test(rows[1] ?? '')
}

function cellOf(raw: string): TableCell {
  const t = raw.trim()
  const isCode = /^`[^`]+`$/.test(t)
  const isBold = /^\*\*[^*]+\*\*$/.test(t)
  return { text: t.replace(/`/g, '').replace(/\*\*/g, ''), isCode, isBold }
}

function cellsOf(row: string): TableCell[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cellOf)
}

// Column widths that fit `width`: natural widths when they fit, otherwise the
// widest columns give up room first, none narrower than 6.
export function tableOf(text: string, width: number): Table {
  const [head = '', , ...body] = text.split('\n')
  const header = cellsOf(head)
  const rows = body.map(cellsOf)
  const cols = header.length
  const natural = header.map((h, i) => Math.max(h.text.length, ...rows.map(r => r[i]?.text.length ?? 0)))
  const room = Math.max(cols * 6, width - (cols - 1) * 3)
  const widths = [...natural]
  while (widths.reduce((a, b) => a + b, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths))
    if ((widths[widest] ?? 0) <= 6) break
    widths[widest] = (widths[widest] ?? 0) - 1
  }
  return { header, rows, widths }
}

export function tableRows(t: Table): number {
  const tall = (cells: TableCell[]) => Math.max(1, ...cells.map((c, i) => Math.ceil(c.text.length / Math.max(1, t.widths[i] ?? 1))))
  const wraps = t.rows.some(r => r.some((c, i) => c.text.length > (t.widths[i] ?? 0)))
  return tall(t.header) + 1 + t.rows.reduce((n, r) => n + tall(r), 0) + (wraps ? t.rows.length - 1 : 0)
}

/** One wrapped row of a line: columns [start, end) of the line's text */
export type Piece = { start: number; end: number }

// Splits a line into rows of at most `width` columns, breaking after a space
// where one falls in the row, else mid-word. The pieces cover the whole line
// in order, so a column on screen maps back to one column of the line.
export function wrapSegments(text: string, width: number): Piece[] {
  const w = Math.max(1, width)
  const pieces: Piece[] = []
  let start = 0
  while (text.length - start > w) {
    const space = text.lastIndexOf(' ', start + w - 1)
    const end = space >= start ? space + 1 : start + w
    pieces.push({ start, end })
    start = end
  }
  pieces.push({ start, end: text.length })
  return pieces
}


export function before(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col)
}

// The selection between the mark and the caret, start first; null when empty
export function ordered(mark: Pos | null, caret: Pos): [Pos, Pos] | null {
  if (!mark || (mark.line === caret.line && mark.col === caret.col)) return null
  return before(mark, caret) ? [mark, caret] : [caret, mark]
}

export function textBetween(lines: string[], from: Pos, to: Pos): string {
  if (from.line === to.line) return (lines[from.line - 1] ?? '').slice(from.col, to.col)
  const first = (lines[from.line - 1] ?? '').slice(from.col)
  const middle = lines.slice(from.line, to.line - 1)
  const last = (lines[to.line - 1] ?? '').slice(0, to.col)
  return [first, ...middle, last].join('\n')
}

export function clampPos(lines: string[], p: Pos): Pos {
  const line = Math.max(1, Math.min(Math.max(1, lines.length), p.line))
  return { line, col: Math.max(0, Math.min((lines[line - 1] ?? '').length, p.col)) }
}

// Replaces the text between two positions with `text` (which may hold line
// breaks) and returns the new lines and the caret after the inserted text
export function replaceRange(lines: string[], from: Pos, to: Pos, text: string): { lines: string[]; caret: Pos } {
  const head = (lines[from.line - 1] ?? '').slice(0, from.col)
  const tail = (lines[to.line - 1] ?? '').slice(to.col)
  const parts = text.split('\n')
  const middle = parts.map((p, i) => (i === 0 ? head + p : p))
  const lastIndex = middle.length - 1
  const caret = { line: from.line + lastIndex, col: (middle[lastIndex] ?? '').length }
  middle[lastIndex] = (middle[lastIndex] ?? '') + tail
  const next = [...lines.slice(0, from.line - 1), ...middle, ...lines.slice(to.line)]
  return { lines: next.length ? next : [''], caret }
}

// The caret one step left or right, across line ends
export function stepCol(lines: string[], p: Pos, dir: 1 | -1): Pos {
  const len = (lines[p.line - 1] ?? '').length
  if (dir === -1) return p.col > 0 ? { line: p.line, col: p.col - 1 } : p.line > 1 ? { line: p.line - 1, col: (lines[p.line - 2] ?? '').length } : p
  return p.col < len ? { line: p.line, col: p.col + 1 } : p.line < lines.length ? { line: p.line + 1, col: 0 } : p
}
