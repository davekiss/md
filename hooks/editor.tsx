import type { ClientModule } from 'claude-code'

type Style = { color?: string; bold?: boolean; dimColor?: boolean; italic?: boolean }

// One screen row: a wrapped piece of a line, with what to highlight in it
export type EditorRow = {
  line: number
  /** Column of the line where this piece starts */
  start: number
  text: string
  /** The last piece of its line: a click past its end lands at the line's end */
  isLast: boolean
  gutter: string
  gutterColor: string | null
  style: Style
  isCaretLine: boolean
  /** Piece columns [from, to) inside the selection */
  sel: [number, number] | null
  /** Piece columns [from, to) a suggested change would replace */
  struck: [number, number][]
  /** Piece column the caret sits on */
  caret: number | null
}

export type EditorProps = { rows: EditorRow[]; gutterWidth: number }

// The review view's text. It draws the caret and the selection the hooks module
// holds, and reports where each click, drag and key lands as a line and column.
const Editor: ClientModule<EditorProps> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { rows, gutterWidth } = props

  const at = (x: number, y: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, y))]
    if (!row) return null
    // Above or below the text clamps to its first or last row
    if (y < 0) return { line: row.line, col: row.start }
    const offset = Math.max(0, x - gutterWidth)
    const end = row.isLast ? row.text.length : Math.max(0, row.text.length - 1)
    return { line: row.line, col: row.start + Math.min(offset, end) }
  }

  // Set on every draw (each call replaces the last) so positions match the rows drawn now
  surface.onPointer(ev => {
    if (ev.button !== 'left' && ev.type !== 'move') return
    const pos = at(ev.x, ev.y)
    if (!pos) return
    if (ev.type === 'down') surface.post({ type: 'down', ...pos, shift: ev.shift === true })
    else if (ev.type === 'move' && ev.button === 'left') surface.post({ type: 'drag', ...pos })
  })
  surface.onKey(ev => surface.post({ type: 'key', key: ev.key, shift: ev.shift === true, ctrl: ev.ctrl === true, meta: ev.meta === true }))

  return (
    <Box flexDirection="column">
      {rows.map((r, i) => {
        const parts: { text: string; selected: boolean; caret: boolean; struck: boolean }[] = []
        const text = r.text
        // Split the piece where the selection and the caret begin and end
        const cuts = new Set([0, text.length])
        if (r.sel) {
          cuts.add(r.sel[0])
          cuts.add(r.sel[1])
        }
        // Absent while a reload has the hooks one version behind this module
        const struck = r.struck ?? []
        for (const [a, b] of struck) {
          cuts.add(a)
          cuts.add(b)
        }
        if (r.caret !== null) {
          cuts.add(r.caret)
          cuts.add(r.caret + 1)
        }
        const points = [...cuts].filter(c => c >= 0 && c <= text.length).sort((a, b) => a - b)
        for (let k = 0; k < points.length - 1; k++) {
          const from = points[k] ?? 0
          const to = points[k + 1] ?? 0
          parts.push({
            text: text.slice(from, to),
            selected: r.sel !== null && from >= r.sel[0] && to <= r.sel[1],
            caret: r.caret === from,
            struck: struck.some(([a, b]) => from >= a && to <= b),
          })
        }
        // A caret at the end of the line sits on a space after it
        const caretAtEnd = r.caret !== null && r.caret >= text.length
        return (
          <Box key={'r' + i} flexDirection="row" backgroundColor={r.isCaretLine ? '#2a2a40' : undefined}>
            <Text color={r.gutterColor ?? undefined} dimColor={!r.gutterColor && !r.isCaretLine}>
              {r.gutter}
            </Text>
            <Text {...r.style} wrap="truncate-end">
              {parts.map((p, k) =>
                p.caret ? (
                  <Text key={'p' + k} inverse>{p.text}</Text>
                ) : p.selected ? (
                  <Text key={'p' + k} backgroundColor="#6d4fd8" color="white">{p.text}</Text>
                ) : p.struck ? (
                  <Text key={'p' + k} strikethrough color="magenta">{p.text}</Text>
                ) : (
                  p.text
                ),
              )}
              {caretAtEnd ? <Text inverse> </Text> : ''}
              {text === '' && !caretAtEnd ? ' ' : ''}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export default Editor
