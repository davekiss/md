import type { ClientElements, Elements } from 'claude-code'

import type { Block } from './doc'
import { isTable, tableOf } from './doc'

type El = Elements['terminal'] | Elements['desktop'] | ClientElements

// The body of one reader block, drawn with the surface's elements
export function blockBody(E: El, b: Block, width: number) {
  const { Box, Text, Markdown, Code } = E
  if (b.kind === 'heading') {
    const label = b.label ?? ''
    if (b.level === 1) {
      return (
        <Box flexDirection="column">
          <Text bold color="magenta" wrap="wrap">{label}</Text>
          <Text color="magenta" dimColor>{'━'.repeat(Math.min(width, label.length + 2))}</Text>
        </Box>
      )
    }
    return b.level === 2 ? <Text bold color="magenta" wrap="wrap">{label}</Text> : <Text bold wrap="wrap">{label}</Text>
  }
  if (b.kind === 'code') {
    const label = b.label && !['text', 'plain', 'txt'].includes(b.label) ? b.label : null
    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {label && <Text dimColor>{label}</Text>}
        <Code source={b.text || ' '} language={b.label} />
      </Box>
    )
  }
  if (isTable(b.text)) {
    const t = tableOf(b.text, width)
    const full = t.widths.reduce((n, w) => n + w, 0) + (t.widths.length - 1) * 3
    const wraps = t.rows.some(r => r.some((c, i) => c.text.length > (t.widths[i] ?? 0)))
    const line = (cells: typeof t.header, isHead: boolean, k: string) => (
      <Box key={k} flexDirection="row">
        {t.widths.map((w, i) => {
          const c = cells[i] ?? { text: '', isCode: false, isBold: false }
          return (
            <Box key={k + '-' + i} flexDirection="row" flexShrink={0}>
              {i > 0 && <Text>{'   '}</Text>}
              <Box width={w} flexShrink={0}>
                <Text bold={isHead || c.isBold} color={c.isCode ? 'blue' : undefined} wrap="wrap">
                  {c.text || ' '}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {line(t.header, true, 'h')}
        <Text dimColor>{'─'.repeat(full)}</Text>
        {t.rows.map((r, i) => (
          <Box key={'row' + i} flexDirection="column">
            {i > 0 && wraps && <Text dimColor>{'┄'.repeat(full)}</Text>}
            {line(r, false, 'r' + i)}
          </Box>
        ))}
      </Box>
    )
  }
  return <Markdown text={b.text.slice(0, 9900) || ' '} />
}
