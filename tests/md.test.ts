import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  changedLines,
  draftLines,
  partialString,
  rangesOfQuote,
  reanchor,
  replaceRange,
  spansOf,
  textBetween,
  wrapSegments,
} from '../hooks/doc'
import type { Comment } from '../types'

const FILE = '/repo/notes.md'
const TEXT = '# Title\n\nfirst para\nsecond para\n\n- item\n'

// The editor's gutter for a 6-line file: a mark, one digit, the caret arrow, a bar
const GUTTER = 4

const PANE_PROPS = {
  title: 'notes.md',
  isFocused: true,
  bodyColumns: 80,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

const runMd = (args: string) => ({
  command: 'md',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
})

function world(on: On, file: { text: string; writes?: string[] }, submitted: string[] = []) {
  mock.env(on, { HOME: '/home' })
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.read', () => ({ value: file.text }))
  on('fs.write', (_$, e) => {
    file.text = e.text
    file.writes?.push(e.path)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: e.path === FILE }))
  on('fs.stat', () => ({ value: { kind: 'file', size: file.text.length, mtimeMs: 1, isLink: false } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.selection', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
}

type View = { caret: { line: number; col: number }; selection: { text: string } | null; comments: Comment[] }

test('a click places the caret at the exact character', async ($, on) => {
  const file = { text: TEXT }
  world(on, file)
  await $.command.run(runMd('notes.md'))
  const ui = await $.ui.mount({ plugin: 'md', surface: 'terminal', component: 'Pane', requestId: 'md', props: PANE_PROPS })
  // Row 2 is line 3, 'first para'; three cells into the text is column 3
  await ui.pointer({ type: 'down', x: GUTTER + 3, y: 2, button: 'left', in: 'editor' })
  const said = await $.tool.call({ tool: 'mcp__md__view' } as never)
  expect((JSON.parse((said as { result: string }).result) as View).caret).toEqual({ line: 3, col: 3 })
  await ui.unmount()
})

test('a drag selects exact text and ask sends it to Claude', async ($, on) => {
  const file = { text: TEXT }
  const submitted: string[] = []
  world(on, file, submitted)
  await $.command.run(runMd('notes.md'))
  for (const surface of ['terminal', 'desktop'] as const) {
    submitted.length = 0
    const ui = await $.ui.mount({ plugin: 'md', surface, component: 'Pane', requestId: 'md', props: PANE_PROPS })
    // From 'para' on line 3 to the end of 'second' on line 4
    await ui.pointer({ type: 'down', x: GUTTER + 6, y: 2, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'move', x: GUTTER + 6, y: 3, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: GUTTER + 6, y: 3, button: 'left', in: 'editor' })
    await ui.press({ key: 'k-a' })
    await ui.input({ key: 'input-ask', text: 'tighten this' })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain(`In ${FILE}, lines 3-4:`)
    expect(submitted[0]).toContain('Specifically this text: "para\nsecond"')
    expect(submitted[0]).toContain('tighten this')
    await ui.press({ key: 'k-s' })
    await ui.unmount()
  }
})

test('ctrl+j in the editor asks about the selection without typing over it', async ($, on) => {
  const file = { text: TEXT }
  const submitted: string[] = []
  world(on, file, submitted)
  await $.command.run(runMd('notes.md'))
  const ui = await $.ui.mount({ plugin: 'md', surface: 'terminal', component: 'Pane', requestId: 'md', props: PANE_PROPS })
  await ui.pointer({ type: 'down', x: GUTTER + 6, y: 2, button: 'left', in: 'editor' })
  await ui.pointer({ type: 'move', x: GUTTER + 6, y: 3, button: 'left', in: 'editor' })
  await ui.pointer({ type: 'up', x: GUTTER + 6, y: 3, button: 'left', in: 'editor' })
  const type = (key: string, ctrl = false) => ui.post({ type: 'key', key, shift: false, ctrl, meta: false }, { in: 'editor' })
  await type('j', true)
  for (const key of ['t', 'i', 'g', 'h', 't', 'space', 'x', 'backspace', 'e', 'n']) await type(key)
  expect(await ui.find({ type: 'Text', text: /tight en/ })).toBeDefined()
  await type('return')
  expect(file.text).toBe(TEXT)
  expect(submitted[0]).toContain('Specifically this text: "para\nsecond"')
  expect(submitted[0]).toContain('tight en')
  await ui.unmount()
})

test('typing in the editor edits the file, and undo puts it back', async ($, on) => {
  const file = { text: TEXT }
  world(on, file)
  await $.command.run(runMd('notes.md'))
  const ui = await $.ui.mount({ plugin: 'md', surface: 'terminal', component: 'Pane', requestId: 'md', props: PANE_PROPS })
  // After '# ' on line 1
  await ui.pointer({ type: 'down', x: GUTTER + 2, y: 0, button: 'left', in: 'editor' })
  for (const key of ['N', 'e', 'w', 'x']) await ui.post({ type: 'key', key, shift: false, ctrl: false, meta: false }, { in: 'editor' })
  await ui.post({ type: 'key', key: 'backspace', shift: false, ctrl: false, meta: false }, { in: 'editor' })
  await ui.post({ type: 'key', key: 'space', shift: false, ctrl: false, meta: false }, { in: 'editor' })
  expect(file.text.split('\n')[0]).toBe('# New Title')
  await ui.post({ type: 'key', key: 'return', shift: false, ctrl: false, meta: false }, { in: 'editor' })
  expect(file.text.split('\n').slice(0, 2)).toEqual(['# New ', 'Title'])
  await ui.press({ key: 'k-u' })
  expect(file.text.split('\n')[0]).toBe('# New Title')
  await ui.unmount()
})

test('comments follow their lines after an edit above them', () => {
  const c: Comment = { id: 'c1', start: 3, end: 3, quote: 'first para', text: 'x', kind: 'note', status: 'open' }
  const moved = reanchor([c], ['# Title', 'new', '', 'first para'])
  expect(moved[0]?.start).toBe(4)
  expect(reanchor([c], ['# Title'])[0]?.status).toBe('stale')
  expect(changedLines(['a', 'b'], ['a', 'c', 'b'])).toEqual([2])
})

test('wrapping keeps every column, and edits splice text across lines', () => {
  const pieces = wrapSegments('the quick brown fox', 10)
  expect(pieces).toEqual([
    { start: 0, end: 10 },
    { start: 10, end: 19 },
  ])
  expect(wrapSegments('abcdefghijkl', 5)).toEqual([
    { start: 0, end: 5 },
    { start: 5, end: 10 },
    { start: 10, end: 12 },
  ])
  const lines = ['one two', 'three', 'four']
  expect(textBetween(lines, { line: 1, col: 4 }, { line: 3, col: 2 })).toBe('two\nthree\nfo')
  expect(replaceRange(lines, { line: 1, col: 4 }, { line: 3, col: 2 }, 'X\nY')).toEqual({
    lines: ['one X', 'Yur'],
    caret: { line: 2, col: 1 },
  })
})

test('Claude can comment on a range and the pane shows it', async ($, on) => {
  const file = { text: TEXT }
  world(on, file)
  await $.command.run(runMd('notes.md'))
  const said = await $.tool.call({ tool: 'mcp__md__comment', line: 3, endLine: 4, text: 'merge these' } as never)
  expect(JSON.stringify(said)).toContain('lines 3-4')
  const ui = await $.ui.mount({ plugin: 'md', surface: 'terminal', component: 'Pane', requestId: 'md', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /◆ Claude.*merge these/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◆3/ })).toBeDefined()
  await ui.unmount()
})

test('a quote finds its lines across whitespace and line breaks, nearest first', () => {
  const lines = ['para one', '', 'the same  words', 'here', '', 'the same words here']
  expect(rangesOfQuote(lines, 'same words here')).toEqual([
    [3, 4],
    [6, 6],
  ])
  expect(rangesOfQuote(lines, 'same words here', 6)[0]).toEqual([6, 6])
  expect(rangesOfQuote(lines, 'not there')).toEqual([])
  expect(rangesOfQuote(['a (b)'], '(b)')).toEqual([[1, 1]])
})

test('exact text is found by caret positions, across lines, nearest first', () => {
  const lines = ['one two', 'three two', 'four']
  expect(spansOf(lines, 'two')).toEqual([
    [{ line: 1, col: 4 }, { line: 1, col: 7 }],
    [{ line: 2, col: 6 }, { line: 2, col: 9 }],
  ])
  expect(spansOf(lines, 'two', 2)[0]).toEqual([{ line: 2, col: 6 }, { line: 2, col: 9 }])
  expect(spansOf(lines, 'two\nthree')).toEqual([[{ line: 1, col: 4 }, { line: 2, col: 5 }]])
  expect(spansOf(lines, 'five')).toEqual([])
})

test('Claude edits through the pane: marked changed, undone with u, refused when ambiguous', async ($, on) => {
  const file = { text: TEXT }
  world(on, file)
  await $.command.run(runMd('notes.md'))
  const ok = await $.tool.call({ tool: 'mcp__md__edit', find: 'second para', replace: 'second paragraph' } as never)
  expect(JSON.stringify(ok)).toContain('Edited line 4')
  expect(file.text.split('\n')[3]).toBe('second paragraph')
  const twice = await $.tool.call({ tool: 'mcp__md__edit', find: 'para', replace: 'x' } as never)
  expect(JSON.stringify(twice)).toContain('appears 2 times')
  const missing = await $.tool.call({ tool: 'mcp__md__edit', find: 'nope', replace: 'x' } as never)
  expect(JSON.stringify(missing)).toContain('nothing changed')
  const ui = await $.ui.mount({ plugin: 'md', surface: 'terminal', component: 'Pane', requestId: 'md', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /^\+4/ })).toBeDefined()
  await ui.press({ key: 'k-u' })
  expect(file.text).toBe(TEXT)
  await ui.unmount()
})

test('Claude selects exact text by quote, as a drag would', async ($, on) => {
  const file = { text: TEXT }
  world(on, file)
  await $.command.run(runMd('notes.md'))
  await $.tool.call({ tool: 'mcp__md__open', quote: 'para\nsecond' } as never)
  const view = JSON.parse(String(((await $.tool.call({ tool: 'mcp__md__view' } as never)) as { result: string }).result)) as View
  expect(view.selection?.text).toBe('para\nsecond')
})

test('a draft streams in: partial JSON yields the text so far, never a broken escape', () => {
  const json = JSON.stringify({ append: true, text: '# Hi\n\nSay "yo" é' })
  const seen = Array.from({ length: json.length + 1 }, (_, i) => partialString(json.slice(0, i), 'text'))
  expect(seen[0]).toBeNull()
  expect(seen[seen.length - 1]).toBe('# Hi\n\nSay "yo" é')
  for (const s of seen) if (s !== null) expect('# Hi\n\nSay "yo" é'.startsWith(s)).toBe(true)
  expect(draftLines(null, 'a\nb\n')).toEqual(['a', 'b'])
  expect(draftLines(['x'], 'y')).toEqual(['x', '', 'y'])
})

test('Claude drafts into the pane without a file, then saves it, never over another file', async ($, on) => {
  const written: string[] = []
  const file = { text: TEXT, writes: written }
  world(on, file)
  await $.tool.call({ tool: 'mcp__md__draft', text: '# Draft\n\nfirst' } as never)
  await $.tool.call({ tool: 'mcp__md__draft', append: true, text: 'second' } as never)
  await $.tool.call({ tool: 'mcp__md__edit', find: 'first', replace: 'one' } as never)
  const view = JSON.parse(String(((await $.tool.call({ tool: 'mcp__md__view' } as never)) as { result: string }).result))
  expect(view.path).toBeNull()
  expect(view.lineCount).toBe(5)
  expect(written).toEqual([])
  const ui = await $.ui.mount({ plugin: 'md', surface: 'terminal', component: 'Pane', requestId: 'md', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /Untitled draft/ })).toBeDefined()
  await ui.unmount()
  const refused = await $.tool.call({ tool: 'mcp__md__save', path: 'notes.md' } as never)
  expect(JSON.stringify(refused)).toContain('already exists')
  expect(JSON.stringify(await $.command.run(runMd('notes.md')))).toContain('unsaved draft')
  const saved = await $.tool.call({ tool: 'mcp__md__save', path: 'draft.md' } as never)
  expect(JSON.stringify(saved)).toContain('/repo/draft.md')
  expect(written).toEqual(['/repo/draft.md'])
})

test('/md alone lists recent files first, then markdown under the cwd; typing filters, Enter opens', async ($, on) => {
  const file = { text: TEXT }
  world(on, file)
  const dirs: Record<string, { name: string; kind: 'file' | 'dir'; mtimeMs: number }[]> = {
    '/repo': [
      { name: 'notes.md', kind: 'file', mtimeMs: 1 },
      { name: 'docs', kind: 'dir', mtimeMs: 1 },
      { name: 'node_modules', kind: 'dir', mtimeMs: 1 },
      { name: 'code.ts', kind: 'file', mtimeMs: 1 },
    ],
    '/repo/docs': [{ name: 'guide.md', kind: 'file', mtimeMs: 5 }],
    '/repo/node_modules': [{ name: 'readme.md', kind: 'file', mtimeMs: 9 }],
  }
  on('fs.list', (_$, e) => ({ value: (dirs[e.path ?? ''] ?? []).map(d => ({ ...d, size: 1, isLink: false })) }))
  on('fs.exists', () => ({ value: true }))
  await $.command.run(runMd('notes.md'))
  await $.tool.call({ tool: 'mcp__md__draft', text: 'x' } as never)
  await $.tool.call({ tool: 'mcp__md__save', path: 'later.md' } as never)
  await $.command.run(runMd(''))
  const ui = await $.ui.mount({ plugin: 'md', surface: 'terminal', component: 'Pane', requestId: 'md', props: PANE_PROPS })
  const labels = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))
  expect(labels.slice(0, 3)).toEqual(['later.md  · recent', 'notes.md  · recent', 'docs/guide.md'])
  expect(labels.some(l => l.includes('node_modules'))).toBe(false)
  await ui.input({ key: 'pick-filter', text: 'gde', kind: 'change' })
  expect((await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))).toEqual(['docs/guide.md', 'cancel'])
  await ui.input({ key: 'pick-filter', text: 'gde', kind: 'submit' })
  const view = JSON.parse(String(((await $.tool.call({ tool: 'mcp__md__view' } as never)) as { result: string }).result))
  expect(view.path).toBe('/repo/docs/guide.md')
  await ui.unmount()
})

test('Claude comments by quote land on the right lines even with stale line numbers', async ($, on) => {
  const file = { text: TEXT }
  world(on, file)
  await $.command.run(runMd('notes.md'))
  const said = await $.tool.call({ tool: 'mcp__md__comment', quote: 'second para', line: 1, text: 'tighten' } as never)
  expect(JSON.stringify(said)).toContain('line 4')
  const missing = await $.tool.call({ tool: 'mcp__md__comment', quote: 'gone text', text: 'x' } as never)
  expect(JSON.stringify(missing)).toContain('Could not find')
})

test('a click in the reader margin selects that paragraph without scrolling', async ($, on) => {
  const file = { text: TEXT }
  world(on, file)
  await $.command.run(runMd('notes.md'))
  await $.tool.call({ tool: 'mcp__md__open', line: 1, view: 'read' } as never)
  const ui = await $.ui.mount({ plugin: 'md', surface: 'terminal', component: 'Pane', requestId: 'md', props: PANE_PROPS })
  await ui.press({ key: 'bm-3' })
  const said = await $.tool.call({ tool: 'mcp__md__view' } as never)
  expect((JSON.parse((said as { result: string }).result) as View).caret.line).toBe(3)
  expect(await ui.find({ type: 'Text', text: /Title/ })).toBeDefined()
  await ui.unmount()
})
