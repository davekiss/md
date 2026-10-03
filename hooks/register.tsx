import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Comment, Doc, Mode, Pos, StoredDraft, Suggestion } from '../types'
import {
  askPrompt,
  blockAt,
  blocksOf,
  changedLines,
  clampPos,
  ordered,
  quoteOf,
  rangeLabel,
  rangesOfQuote,
  fuzzy,
  draftLines,
  partialString,
  readMinutes,
  spansOf,
  reanchor,
  replaceRange,
  reviewPrompt,
  rowsOfBlock,
  splitLines,
  stepCol,
  textBetween,
  wrapSegments,
} from './doc'
import type { EditorRow } from './editor'
import { blockBody } from './blocks'

const PANE = 'md'

const docAtom = atom({ plugin: 'md', key: 'doc' } as const, null)
const commentsAtom = atom({ plugin: 'md', key: 'comments' } as const, [])
const cursorAtom = atom({ plugin: 'md', key: 'cursor' } as const, 1)
const colAtom = atom({ plugin: 'md', key: 'col' } as const, 0)
const markAtom = atom({ plugin: 'md', key: 'mark' } as const, null)
const viewTopAtom = atom({ plugin: 'md', key: 'viewTop' } as const, 1)
const modeAtom = atom({ plugin: 'md', key: 'mode' } as const, 'review')
const draftAtom = atom({ plugin: 'md', key: 'draft' } as const, null)
const writingAtom = atom({ plugin: 'md', key: 'writing' } as const, false)
const pickerAtom = atom({ plugin: 'md', key: 'picker' } as const, null)
const suggestionsAtom = atom({ plugin: 'md', key: 'suggestions' } as const, [])
const changedAtom = atom({ plugin: 'md', key: 'changed' } as const, [])
const readerAtom = atom({ plugin: 'md', key: 'reader' } as const, false)
const tocAtom = atom({ plugin: 'md', key: 'toc' } as const, false)
const readTopAtom = atom({ plugin: 'md', key: 'readTop' } as const, 1)

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// Wheel rows per paragraph step in the reader; ticks below it add up
const ROWS_PER_BLOCK = 5
let wheelRows = 0

// The review view's text area as last drawn, so moving the caret can keep
// it on screen
let layout = { textWidth: 60, room: 20 }

// Where a drag started, so the selection runs from there
let dragFrom: Pos | null = null

// Earlier states of the file, newest last, for undo
const undoStack: { lines: string[]; caret: Pos }[] = []

// Editor messages run one at a time, so fast typing applies in order
let queue: Promise<unknown> = Promise.resolve()

function newId(): string {
  return 'c' + crypto.randomUUID().slice(0, 6)
}

async function absolute($: EngineInterface, path: string): Promise<string> {
  const home = $.env.get('HOME') ?? ''
  if (path.startsWith('~/')) return home + path.slice(1)
  if (path.startsWith('/')) return path
  const cwd = await $.session.cwd()
  return cwd.replace(/\/$/, '') + '/' + path.replace(/^\.\//, '')
}

// Keeps the open document's comments and suggestions in the store: under its
// path, or with the unsaved draft, which survives the session that way
async function persist($: EngineInterface) {
  const doc = await read($, docAtom)
  if (!doc) return
  const comments = await read($, commentsAtom)
  const suggestions = await read($, suggestionsAtom)
  if (!doc.path) return $.store.set('draft', { lines: doc.lines, comments, suggestions } satisfies StoredDraft)
  await $.store.set('comments:' + doc.path, comments)
  await $.store.set('suggestions:' + doc.path, suggestions)
}

async function saveComments($: EngineInterface, comments: Comment[]) {
  await update($, commentsAtom, () => comments)
  await persist($)
}

async function saveSuggestions($: EngineInterface, suggestions: Suggestion[]) {
  await update($, suggestionsAtom, () => suggestions)
  await persist($)
}

async function storedDraft($: EngineInterface): Promise<StoredDraft | null> {
  return ((await $.store.get('draft')) ?? null) as StoredDraft | null
}

// The draft's lines, open or kept in the store
async function draftSoFar($: EngineInterface): Promise<string[] | null> {
  const doc = await read($, docAtom)
  return doc && doc.path === null ? doc.lines : ((await storedDraft($))?.lines ?? null)
}

// Files opened or saved here, newest first
async function remember($: EngineInterface, path: string) {
  const recent = ((await $.store.get('recent')) ?? []) as string[]
  await $.store.set('recent', [path, ...recent.filter(p => p !== path)].slice(0, 10))
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'coverage'])

// Markdown files under `dir`, a few levels down, newest first
async function markdownUnder($: EngineInterface, dir: string): Promise<string[]> {
  const found: { path: string; mtimeMs: number }[] = []
  const walk = async (at: string, depth: number) => {
    const entries = await $.fs.list(at).catch(() => [])
    for (const e of entries) {
      if (found.length >= 200) return
      const path = at.replace(/\/$/, '') + '/' + e.name
      if (e.kind === 'file' && /\.(md|markdown|mdx)$/i.test(e.name)) found.push({ path, mtimeMs: e.mtimeMs })
      else if (e.kind === 'dir' && depth < 3 && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await walk(path, depth + 1)
    }
  }
  await walk(dir, 0)
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map(f => f.path)
}

async function showPicker($: EngineInterface) {
  const recent: string[] = []
  // Before the recent list there was only the last file opened
  const stored = ((await $.store.get('recent')) ?? [await $.store.get('last')].filter(Boolean)) as string[]
  for (const p of stored) if (await $.fs.exists(p)) recent.push(p)
  const here = await markdownUnder($, await $.session.cwd())
  const files = [...recent, ...here.filter(p => !recent.includes(p))]
  const doc = await read($, docAtom)
  const hasDraft = (doc !== null && doc.path === null) || (await storedDraft($)) !== null
  await update($, pickerAtom, () => ({ files, recent: recent.length, filter: '', hasDraft }))
  await $.ui.open({ id: PANE, title: 'Open markdown', focus: true })
}

// Opens a file from the picker, or tells the person why not; null goes back
// to the unsaved draft
async function openPicked($: EngineInterface, path: string | null) {
  if (path === null) {
    const doc = await read($, docAtom)
    const stored = await storedDraft($)
    if (doc?.path !== null && stored) await showDoc($, { path: null, lines: stored.lines, mtimeMs: 0 }, stored.comments, stored.suggestions)
    await update($, pickerAtom, () => null)
    return $.ui.open({ id: PANE, title: docName(null), focus: true })
  }
  try {
    await openDoc($, path)
    await update($, pickerAtom, () => null)
    await $.ui.open({ id: PANE, title: docName(path), focus: true })
  } catch (err) {
    $.ui.toast(`Could not open ${docName(path)}: ${String(err)}`)
  }
}

function docName(path: string | null): string {
  return path?.split('/').pop() ?? 'Untitled draft'
}

async function openDoc($: EngineInterface, given: string): Promise<string> {
  const path = await absolute($, given)
  const text = await $.fs.read(path)
  const { mtimeMs } = await $.fs.stat(path)
  const lines = splitLines(text)
  const comments = ((await $.store.get('comments:' + path)) ?? []) as Comment[]
  const suggestions = ((await $.store.get('suggestions:' + path)) ?? []) as Suggestion[]
  await showDoc($, { path, lines, mtimeMs }, comments, suggestions)
  await remember($, path)
  return path
}

// Puts a document in the pane from the top, with nothing selected or pending
async function showDoc($: EngineInterface, doc: Doc, comments: Comment[], suggestions: Suggestion[]) {
  await update($, docAtom, () => doc)
  await update($, cursorAtom, () => 1)
  await update($, colAtom, () => 0)
  await update($, markAtom, () => null)
  await update($, viewTopAtom, () => 1)
  await update($, readTopAtom, () => 1)
  undoStack.length = 0
  await update($, changedAtom, () => [])
  await update($, modeAtom, () => 'review')
  await update($, draftAtom, () => null)
  await update($, suggestionsAtom, () => suggestions)
  await saveComments($, reanchor(comments, doc.lines))
}

// The draft as Claude's text sets it: the text alone, or added after the
// draft so far with a blank line between
async function setDraft($: EngineInterface, lines: string[]) {
  const doc = await read($, docAtom)
  if (doc && doc.path === null) {
    await update($, docAtom, () => ({ ...doc, lines }))
    await saveComments($, reanchor(await read($, commentsAtom), lines))
  } else {
    const stored = await storedDraft($)
    await showDoc($, { path: null, lines, mtimeMs: 0 }, stored?.comments ?? [], stored?.suggestions ?? [])
  }
}

// Writes the open document, draft or file, to a new path and keeps it open
// from there; refuses to overwrite another file
async function saveAs($: EngineInterface, given: string): Promise<string> {
  const doc = await read($, docAtom)
  if (!doc) throw new Error('nothing is open in the pane')
  const path = await absolute($, given)
  if (path !== doc.path && (await $.fs.exists(path))) throw new Error(`${path} already exists`)
  await $.fs.write(path, doc.lines.join('\n') + '\n')
  const { mtimeMs } = await $.fs.stat(path)
  await update($, docAtom, () => ({ path, lines: doc.lines, mtimeMs }))
  await persist($)
  if (doc.path === null) await $.store.delete('draft')
  await remember($, path)
  return path
}

const DRAFT_TOOL = 'mcp__md__draft'

// The draft's lines before the draft call now streaming, so the call's end
// can add to them and u can bring them back
let draftBefore: string[] | null = null

// Shows a draft call's text as far as it has streamed, following its end
async function previewDraft($: EngineInterface, json: string) {
  const text = partialString(json, 'text')
  if (text === null) return
  const append = /"append"\s*:\s*true/.test(json)
  const lines = draftLines(append ? draftBefore : null, text)
  await setDraft($, lines)
  await update($, cursorAtom, () => lines.length)
  await update($, colAtom, () => 0)
  await keepVisible($)
}

// Re-reads the open file when it changed on disk, marking the new lines and
// moving comments along with the text they were made on.
async function refresh($: EngineInterface) {
  const doc = await read($, docAtom)
  if (!doc?.path) return
  const stat = await $.fs.stat(doc.path).catch(() => undefined)
  if (!stat || stat.mtimeMs === doc.mtimeMs) return
  const lines = splitLines(await $.fs.read(doc.path))
  await update($, docAtom, () => ({ ...doc, lines, mtimeMs: stat.mtimeMs }))
  await update($, changedAtom, () => changedLines(doc.lines, lines))
  await update($, cursorAtom, n => Math.min(n, Math.max(1, lines.length)))
  const cursor = await read($, cursorAtom)
  await update($, colAtom, c => Math.min(c, (lines[cursor - 1] ?? '').length))
  await saveComments($, reanchor(await read($, commentsAtom), lines))
}

async function caretOf($: EngineInterface): Promise<Pos> {
  return { line: await read($, cursorAtom), col: await read($, colAtom) }
}

// Moves the view so the caret's line is on screen
async function keepVisible($: EngineInterface) {
  const doc = await read($, docAtom)
  if (!doc) return
  const cursor = await read($, cursorAtom)
  const rowsOf = (n: number) => wrapSegments(doc.lines[n - 1] ?? '', layout.textWidth).length
  let top = await read($, viewTopAtom)
  if (cursor < top) top = cursor
  let used = 0
  for (let n = top; n <= cursor; n++) used += rowsOf(n)
  while (used > layout.room && top < cursor) {
    used -= rowsOf(top)
    top++
  }
  await update($, viewTopAtom, () => top)
}

// Puts the caret at a position; `extend` keeps (or starts) the selection
async function placeCaret($: EngineInterface, to: Pos, extend: boolean) {
  const doc = await read($, docAtom)
  if (!doc) return
  const caret = await caretOf($)
  const p = clampPos(doc.lines, to)
  if (extend) await update($, markAtom, m => m ?? caret)
  else await update($, markAtom, () => null)
  await update($, cursorAtom, () => p.line)
  await update($, colAtom, () => p.col)
  await keepVisible($)
}

// Replaces the selection (or the range given) with text, saving the file
async function edit($: EngineInterface, from: Pos, to: Pos, text: string) {
  const doc = await read($, docAtom)
  if (!doc) return
  undoStack.push({ lines: doc.lines, caret: await caretOf($) })
  if (undoStack.length > 200) undoStack.shift()
  const next = replaceRange(doc.lines, from, to, text)
  await writeLines($, next.lines)
  await update($, markAtom, () => null)
  await update($, cursorAtom, () => next.caret.line)
  await update($, colAtom, () => next.caret.col)
  await keepVisible($)
}

async function undo($: EngineInterface) {
  const last = undoStack.pop()
  if (!last) return
  await writeLines($, last.lines)
  await update($, markAtom, () => null)
  await update($, cursorAtom, () => last.caret.line)
  await update($, colAtom, () => last.caret.col)
  await keepVisible($)
}

// Where a suggestion's old text is now, nearest the line it was made on
function locate(lines: string[], s: Suggestion): [Pos, Pos] | null {
  return spansOf(lines, s.old, s.line)[0] ?? null
}

async function suggestionAtCaret($: EngineInterface): Promise<Suggestion | null> {
  const doc = await read($, docAtom)
  if (!doc) return null
  const cursor = await read($, cursorAtom)
  for (const s of await read($, suggestionsAtom)) {
    const span = locate(doc.lines, s)
    if (span && span[0].line <= cursor && cursor <= span[1].line) return s
  }
  return null
}

// Accepts the suggestion on the caret's line, as an edit u undoes, or drops it
async function settle($: EngineInterface, accept: boolean) {
  const s = await suggestionAtCaret($)
  const doc = await read($, docAtom)
  if (!s || !doc) return $.ui.toast('No suggested change on this line.')
  await saveSuggestions($, (await read($, suggestionsAtom)).filter(x => x.id !== s.id))
  const span = locate(doc.lines, s)
  if (!accept || !span) return
  await edit($, span[0], span[1], s.text)
  const after = (await read($, docAtom))?.lines ?? []
  await update($, changedAtom, () => changedLines(doc.lines, after))
}

// One key typed into the editor: caret moves, selection with shift, edits
async function editorKey($: EngineInterface, k: { key: string; shift: boolean; ctrl: boolean; meta: boolean }) {
  const doc = await read($, docAtom)
  if (!doc || (await read($, writingAtom))) return
  // Letters type into the file, so comment and ask need a chord. The pane's
  // Input can't take the keys from the editor, so the text is typed here, into
  // a draft, until Enter
  const chord = k.ctrl ? ({ k: 'comment', j: 'ask' } as const)[k.key as 'k' | 'j'] : undefined
  const draft = await read($, draftAtom)
  if (chord) {
    const same = draft !== null && (await read($, modeAtom)) === chord
    await update($, modeAtom, () => (same ? 'review' : chord))
    await update($, draftAtom, () => (same ? null : draft ?? ''))
    return
  }
  if (draft !== null) {
    if (k.key === 'return') {
      const mode = await read($, modeAtom)
      await update($, draftAtom, () => null)
      await update($, modeAtom, () => 'review')
      if (mode !== 'review') await submitPrompt($, mode, draft)
    } else if (k.key === 'backspace') await update($, draftAtom, () => [...draft].slice(0, -1).join(''))
    else if (k.key === 'space') await update($, draftAtom, () => draft + ' ')
    else if (!k.ctrl && !k.meta && [...k.key].length === 1) await update($, draftAtom, () => draft + k.key)
    return
  }
  const lines = doc.lines
  const caret = await caretOf($)
  const sel = ordered(await read($, markAtom), caret)
  const go = (p: Pos) => placeCaret($, p, k.shift)
  switch (k.key) {
    case 'left':
      return sel && !k.shift ? placeCaret($, sel[0], false) : go(stepCol(lines, caret, -1))
    case 'right':
      return sel && !k.shift ? placeCaret($, sel[1], false) : go(stepCol(lines, caret, 1))
    case 'up':
      return go({ line: caret.line - 1, col: caret.col })
    case 'down':
      return go({ line: caret.line + 1, col: caret.col })
    case 'home':
      return go({ line: caret.line, col: 0 })
    case 'end':
      return go({ line: caret.line, col: Number.MAX_SAFE_INTEGER })
    case 'pageup':
      return go({ line: caret.line - layout.room, col: caret.col })
    case 'pagedown':
      return go({ line: caret.line + layout.room, col: caret.col })
    case 'backspace':
      return sel ? edit($, sel[0], sel[1], '') : edit($, stepCol(lines, caret, -1), caret, '')
    case 'delete':
      return sel ? edit($, sel[0], sel[1], '') : edit($, caret, stepCol(lines, caret, 1), '')
    case 'return':
      return edit($, sel?.[0] ?? caret, sel?.[1] ?? caret, '\n')
    case 'tab':
      return edit($, sel?.[0] ?? caret, sel?.[1] ?? caret, '  ')
    case 'space':
      return edit($, sel?.[0] ?? caret, sel?.[1] ?? caret, ' ')
  }
  if ((k.ctrl || k.meta) && k.key === 'z') return undo($)
  if (k.ctrl || k.meta) return
  // A printable character
  if ([...k.key].length === 1) return edit($, sel?.[0] ?? caret, sel?.[1] ?? caret, k.key)
}

async function writeLines($: EngineInterface, lines: string[]) {
  const doc = await read($, docAtom)
  if (!doc) return
  let mtimeMs = doc.mtimeMs
  if (doc.path) {
    await $.fs.write(doc.path, lines.join('\n') + '\n')
    mtimeMs = (await $.fs.stat(doc.path)).mtimeMs
  }
  await update($, docAtom, () => ({ ...doc, lines, mtimeMs }))
  await saveComments($, reanchor(await read($, commentsAtom), lines))
}

async function currentRange($: EngineInterface): Promise<[number, number]> {
  return (await currentPick($)).range
}

// What the person means: the selected text (exact, with the lines it spans),
// else the caret's line
async function currentPick($: EngineInterface): Promise<{ range: [number, number]; excerpt?: string }> {
  const doc = await read($, docAtom)
  const caret = await caretOf($)
  const sel = ordered(await read($, markAtom), caret)
  if (doc && sel) {
    // A selection ending at column 0 doesn't reach into that line
    const endLine = sel[1].col === 0 && sel[1].line > sel[0].line ? sel[1].line - 1 : sel[1].line
    return { range: [sel[0].line, endLine], excerpt: textBetween(doc.lines, sel[0], sel[1]) }
  }
  return { range: [caret.line, caret.line] }
}

async function addComment(
  $: EngineInterface,
  text: string,
  kind: Comment['kind'],
  author: 'you' | 'claude' = 'you',
  at?: [number, number],
): Promise<Comment | null> {
  const doc = await read($, docAtom)
  if (!doc || !text.trim()) return null
  const pick = at ? { range: at, excerpt: undefined } : await currentPick($)
  const [start, end] = pick.range
  const comment: Comment = {
    id: newId(),
    start,
    end,
    quote: quoteOf(doc.lines, start, end),
    text: text.trim(),
    kind,
    author,
    status: 'open',
    ...(pick.excerpt ? { excerpt: pick.excerpt } : {}),
  }
  await saveComments($, [...(await read($, commentsAtom)), comment])
  await update($, markAtom, () => null)
  return comment
}

// Saves a comment, or saves a question and sends it to Claude
async function submitPrompt($: EngineInterface, mode: 'comment' | 'ask', text: string) {
  if (mode === 'comment') return void (await addComment($, text, 'note'))
  const c = await addComment($, text, 'ask')
  const doc = await read($, docAtom)
  if (c && doc) void $.prompt.submit({ text: askPrompt(doc.path, doc.lines, c), asUser: true })
}

function relative(path: string, cwd: string): string {
  return path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

function lineStyle(line: string, inFence: boolean): { color?: string; bold?: boolean; dimColor?: boolean; italic?: boolean } {
  if (line.trimStart().startsWith('```')) return { dimColor: true }
  if (inFence) return { color: 'cyan' }
  if (/^#{1,6}\s/.test(line)) return { bold: true, color: 'magenta' }
  if (/^\s*>/.test(line)) return { italic: true, dimColor: true }
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) return { color: 'blue' }
  return {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(1500, () => void refresh($))
    await $.tool.register({
      name: 'view',
      description:
        'What the person has open in the md markdown pane: the file, the caret (line and column), the exact text they selected, and every open review comment with its line range and quoted text.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'reply',
      description:
        'Reply to a review comment in the md pane after working on it. Use resolve: true when the comment is fully addressed.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, reply: { type: 'string' }, resolve: { type: 'boolean' } },
        required: ['id', 'reply'],
      },
    })
    await $.tool.register({
      name: 'open',
      description:
        "Open a markdown file in the person's md pane at a line or range (selected for them), to show them something or to start reviewing together. Give quote to select exact text instead, as the person would by dragging; line then picks among repeats. Leave out path to move within the file already open.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          quote: { type: 'string', description: 'Exact text in the file to select' },
          line: { type: 'number' },
          endLine: { type: 'number' },
          view: { type: 'string', enum: ['read', 'review'], description: 'read: the formatted reader; review: numbered lines' },
        },
      },
    })
    await $.tool.register({
      name: 'comment',
      description:
        "Leave a review comment on the file open in the md pane, as the person can. Use it to flag something for them, propose a change before making it, or ask them a question about specific lines. Prefer quote (a few words copied from the file) over line numbers: it lands on the right lines even after edits. With both, line picks among repeated quotes. The pane moves to the range.",
      inputSchema: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'Text from the file to comment on; whitespace and line breaks need not match' },
          line: { type: 'number' },
          endLine: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'edit',
      description:
        "Edit the file open in the md pane the way the person types in it: replaces the exact text find with replace, saves the file, moves the caret there and marks the lines changed. The person can undo it with u. find must appear once, or give line to pick the nearest. Prefer this over Edit for the open file.",
      inputSchema: {
        type: 'object',
        properties: {
          find: { type: 'string', description: 'Exact text in the file, line breaks included' },
          replace: { type: 'string' },
          line: { type: 'number', description: 'Picks the match nearest this line when find repeats' },
        },
        required: ['find', 'replace'],
      },
    })
    await $.tool.register({
      name: 'suggest',
      description:
        "Propose a change to the text open in the md pane without making it: find is struck through in place and replace shows beneath with accept and reject buttons. Prefer this over edit for the person's own prose; use edit when they asked for the change. find must appear once, or give line to pick the nearest. mcp__md__view lists what is still pending.",
      inputSchema: {
        type: 'object',
        properties: {
          find: { type: 'string', description: 'Exact text in the file, line breaks included' },
          replace: { type: 'string' },
          note: { type: 'string', description: 'Why, in a few words' },
          line: { type: 'number', description: 'Picks the match nearest this line when find repeats' },
        },
        required: ['find', 'replace'],
      },
    })
    await $.tool.register({
      name: 'draft',
      description:
        "Write markdown into the md pane as an unsaved draft, streamed onto the person's screen as you write it. Use it for first drafts instead of answering in chat or writing a file: the person reads, selects and comments on it in the pane. Replaces the draft, or with append: true adds after it (put append before text). Revise parts with mcp__md__edit; mcp__md__save writes it to a file.",
      inputSchema: {
        type: 'object',
        properties: {
          append: { type: 'boolean', description: 'Add after the draft so far instead of replacing it' },
          text: { type: 'string', description: 'The markdown' },
        },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'save',
      description: 'Save what the md pane shows (a draft, or the open file under a new name) to path. Refuses to overwrite another file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    })
    await $.tool.register({
      name: 'close',
      description: "Close the md pane on the person's screen.",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.command.register({
      name: 'md',
      description: 'Open a markdown file in the review pane, or save the draft there with /md save <path>',
      argumentHint: '[path | save <path>]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'md' }, async ($, e) => {
    const args = e.args.trim()
    const saving = /^save\s+(.+)$/.exec(args)
    if (saving?.[1]) {
      try {
        const path = await saveAs($, saving[1])
        await $.ui.open({ id: PANE, title: docName(path) })
        return { text: `Saved to ${path}` }
      } catch (err) {
        return { text: `Could not save: ${String(err)}` }
      }
    }
    if (!args) {
      await showPicker($)
      return {}
    }
    try {
      const path = await openDoc($, args)
      await update($, pickerAtom, () => null)
      await $.ui.open({ id: PANE, title: docName(path), focus: true })
      return {}
    } catch (err) {
      return { text: `Could not open ${args}: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__md__view' }, async $ => {
    const doc = await read($, docAtom)
    if (!doc) return { result: 'No file is open in the md pane.' }
    await refresh($)
    const lines = (await read($, docAtom))?.lines ?? doc.lines
    const suggestions = await read($, suggestionsAtom)
    const pick = await currentPick($)
    const [start, end] = pick.range
    const open = (await read($, commentsAtom)).filter(c => c.status !== 'resolved')
    return {
      result: JSON.stringify(
        {
          path: doc.path,
          lineCount: lines.length,
          showing: (await read($, readerAtom)) ? 'read' : 'review',
          changedLines: await read($, changedAtom),
          suggestions: suggestions.map(s => {
            const span = locate(lines, s)
            return { ...s, ...(span ? { line: span[0].line } : { stale: true }) }
          }),
          caret: await caretOf($),
          selection: pick.excerpt !== undefined ? { start, end, text: pick.excerpt } : null,
          caretLine: quoteOf(doc.lines, start, end),
          comments: open.map(({ id, start, end, text, kind, author, status, reply, quote, excerpt }) => ({
            id, start, end, text, kind, author: author ?? 'you', status, reply, quote, excerpt,
          })),
        },
        null,
        2,
      ),
    }
  })

  on('tool.call', { tool: 'mcp__md__reply' }, async ($, e) => {
    const args = e as unknown as { id: string; reply: string; resolve?: boolean }
    const doc = await read($, docAtom)
    const comments = await read($, commentsAtom)
    if (!doc || !comments.some(c => c.id === args.id)) return { result: `No comment ${args.id} in the open file.` }
    await refresh($)
    const latest = await read($, commentsAtom)
    await saveComments(
      $,
      latest.map(c =>
        c.id === args.id ? { ...c, reply: args.reply, status: args.resolve ? 'resolved' : c.status } : c,
      ),
    )
    return { result: 'Reply shown in the pane.' }
  })

  on('tool.call', { tool: 'mcp__md__open' }, async ($, e) => {
    const args = e as unknown as { path?: string; quote?: string; line?: number; endLine?: number; view?: 'read' | 'review' }
    try {
      const current = await read($, docAtom)
      const path = args.path || !current ? await openDoc($, args.path ?? '') : current.path
      const total = (await read($, docAtom))?.lines.length ?? 1
      let where = args.line ? ` at ${rangeLabel(args.line, args.endLine ?? args.line)}` : ''
      if (args.quote) {
        const span = spansOf((await read($, docAtom))?.lines ?? [], args.quote, args.line)[0]
        if (!span) return { result: `"${args.quote}" is not in ${path}; nothing selected.` }
        await placeCaret($, span[0], false)
        await placeCaret($, span[1], true)
        await update($, readTopAtom, () => span[0].line)
        where = ` with "${args.quote}" selected (${rangeLabel(span[0].line, span[1].line)})`
      } else if (args.line) {
        const line = Math.max(1, Math.min(total, args.line))
        const end = args.endLine ? Math.max(line, Math.min(total, args.endLine)) : line
        const lines = (await read($, docAtom))?.lines ?? []
        await update($, markAtom, () => (end > line ? { line, col: 0 } : null))
        await update($, cursorAtom, () => end)
        await update($, colAtom, () => (end > line ? (lines[end - 1] ?? '').length : 0))
        await update($, viewTopAtom, () => line)
        await update($, readTopAtom, () => line)
      }
      if (args.view) await update($, readerAtom, () => args.view === 'read')
      const placed = await $.ui.open({ id: PANE, title: docName(path) })
      if (placed.isPlaced) return { result: `Showing ${path ?? 'the draft'}${where} in the pane.` }
      $.ui.toast(`Claude opened ${docName(path)}${where} — run /md to see it`)
      return { result: `The pane is ready but not on screen (${placed.reason}); the person was told to run /md.` }
    } catch (err) {
      return { result: `Could not open ${args.path}: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__md__close' }, async $ => {
    await $.ui.close({ id: PANE })
    return { result: 'Closed the pane.' }
  })

  on('tool.call', { tool: 'mcp__md__comment' }, async ($, e) => {
    const args = e as unknown as { quote?: string; line?: number; endLine?: number; text: string }
    const doc = await read($, docAtom)
    if (!doc) return { result: 'No file is open in the md pane; call mcp__md__open first.' }
    await refresh($)
    const total = (await read($, docAtom))?.lines.length ?? 1
    const lines = (await read($, docAtom))?.lines ?? []
    let start: number
    let end: number
    if (args.quote?.trim()) {
      const found = rangesOfQuote(lines, args.quote, args.line)[0]
      if (!found) return { result: `Could not find "${args.quote}" in ${doc.path}; no comment added. Call mcp__md__view or re-read the file.` }
      ;[start, end] = found
    } else if (args.line) {
      start = Math.max(1, Math.min(total, args.line))
      while (start > 1 && (lines[start - 1] ?? '').trim() === '') start--
      end = Math.max(start, Math.min(total, args.endLine ?? start))
    } else {
      return { result: 'Give quote (preferred) or line; no comment added.' }
    }
    const c = await addComment($, args.text, 'note', 'claude', [start, end])
    if (!c) return { result: 'Comment text was empty.' }
    await update($, cursorAtom, () => start)
    await update($, colAtom, () => 0)
    $.ui.toast(`Claude commented on ${rangeLabel(start, end)}`)
    return { result: `Comment ${c.id} added on ${rangeLabel(start, end)}.` }
  })

  on('tool.call', { tool: 'mcp__md__edit' }, async ($, e) => {
    const args = e as unknown as { find: string; replace: string; line?: number }
    const doc = await read($, docAtom)
    if (!doc) return { result: 'No file is open in the md pane; call mcp__md__open first.' }
    await refresh($)
    const before = (await read($, docAtom))?.lines ?? []
    const spans = spansOf(before, args.find, args.line)
    const span = spans[0]
    if (!span) return { result: `The text to find is not in ${doc.path}; nothing changed. Call mcp__md__view or re-read the file.` }
    if (spans.length > 1 && !args.line) {
      const at = spans.map(s => s[0].line).sort((a, b) => a - b).join(', ')
      return { result: `That text appears ${spans.length} times (lines ${at}); give line to pick one. Nothing changed.` }
    }
    await edit($, span[0], span[1], args.replace)
    const after = (await read($, docAtom))?.lines ?? []
    await update($, changedAtom, () => changedLines(before, after))
    const end = span[0].line + splitLines(args.replace).length - 1
    $.ui.toast(`Claude edited ${rangeLabel(span[0].line, end)} — u to undo`)
    return { result: `Edited ${rangeLabel(span[0].line, end)}; the person can undo it with u.` }
  })

  on('tool.call', { tool: 'mcp__md__suggest' }, async ($, e) => {
    const args = e as unknown as { find: string; replace: string; note?: string; line?: number }
    const doc = await read($, docAtom)
    if (!doc) return { result: 'Nothing is open in the md pane; call mcp__md__open first.' }
    await refresh($)
    const lines = (await read($, docAtom))?.lines ?? []
    const spans = spansOf(lines, args.find, args.line)
    const span = spans[0]
    if (!span) return { result: 'The text to find is not in the open document; nothing suggested. Call mcp__md__view or re-read it.' }
    if (spans.length > 1 && !args.line) {
      const at = spans.map(s => s[0].line).sort((a, b) => a - b).join(', ')
      return { result: `That text appears ${spans.length} times (lines ${at}); give line to pick one. Nothing suggested.` }
    }
    const s: Suggestion = { id: 's' + newId().slice(1), line: span[0].line, old: args.find, text: args.replace, ...(args.note ? { note: args.note } : {}) }
    await saveSuggestions($, [...(await read($, suggestionsAtom)), s])
    await placeCaret($, span[0], false)
    $.ui.toast(`Claude suggested a change on ${rangeLabel(span[0].line, span[1].line)} — accept or reject it under the text`)
    return { result: `Suggestion ${s.id} shown on ${rangeLabel(span[0].line, span[1].line)}; the person will accept or reject it.` }
  })

  // A draft call's text shows in the pane while the model is still writing it
  on('turn.step', async function* ($, e, next) {
    const calls = new Map<number, string>()
    let shownAt = 0
    for await (const chunk of next(e)) {
      yield chunk
      if (chunk.kind === 'tool' && chunk.name === DRAFT_TOOL) {
        calls.set(chunk.index, '')
        draftBefore = await draftSoFar($)
        await update($, writingAtom, () => true)
        await $.ui.open({ id: PANE, title: docName(null) })
      } else if (chunk.kind === 'input' && calls.has(chunk.index)) {
        const json = (calls.get(chunk.index) ?? '') + chunk.json
        calls.set(chunk.index, json)
        if (Date.now() - shownAt < 80) continue
        shownAt = Date.now()
        await previewDraft($, json)
      }
    }
    if (calls.size === 0) return
    for (const json of calls.values()) await previewDraft($, json)
    await update($, writingAtom, () => false)
  })

  on('tool.call', { tool: DRAFT_TOOL }, async ($, e) => {
    const args = e as unknown as { text: string; append?: boolean }
    const before = draftBefore ?? (await draftSoFar($))
    draftBefore = null
    await update($, writingAtom, () => false)
    const lines = draftLines(args.append ? before : null, args.text)
    await setDraft($, lines)
    if (before) undoStack.push({ lines: before, caret: await caretOf($) })
    const first = args.append && before ? Math.min(lines.length, before.length + 2) : 1
    await placeCaret($, { line: first, col: 0 }, false)
    await update($, viewTopAtom, () => first)
    const placed = await $.ui.open({ id: PANE, title: docName(null) })
    const where = placed.isPlaced ? 'in the pane' : 'ready, but the pane is not on screen; the person was told to run /md'
    if (!placed.isPlaced) $.ui.toast('Claude wrote a draft — run /md to see it')
    return { result: `Draft ${args.append ? 'extended' : 'written'} (${lines.length} lines) ${where}. Not saved to a file yet.` }
  })

  on('tool.call', { tool: 'mcp__md__save' }, async ($, e) => {
    const args = e as unknown as { path: string }
    try {
      const path = await saveAs($, args.path)
      await $.ui.open({ id: PANE, title: docName(path) })
      return { result: `Saved to ${path}; the pane now edits that file.` }
    } catch (err) {
      return { result: `Not saved: ${String(err)}` }
    }
  })

  // Claude's edits to the open file show up right away, marked as changed,
  // and u undoes them like the person's own
  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.includes(String(e.tool))) return next(e)
    const before = await read($, docAtom)
    const caret = await caretOf($)
    const ran = await next(e)
    await refresh($)
    const after = await read($, docAtom)
    if (before && after && before.path === after.path && after.mtimeMs !== before.mtimeMs) {
      undoStack.push({ lines: before.lines, caret })
    }
    return ran
  })

  // The pane draws its own window over the file, so the wheel moves the
  // position the views draw from: a line in review, a paragraph in the reader
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const doc = await read($, docAtom)
    if (!doc) return {}
    const total = doc.lines.length
    if (!(await read($, readerAtom))) {
      await update($, viewTopAtom, n => Math.max(1, Math.min(total, n + e.by)))
      return {}
    }
    wheelRows += e.by
    const steps = Math.trunc(wheelRows / ROWS_PER_BLOCK)
    if (steps === 0) return {}
    wheelRows -= steps * ROWS_PER_BLOCK
    const blocks = blocksOf(doc.lines)
    const at = blockAt(blocks, await read($, readTopAtom))
    const target = blocks[Math.max(0, Math.min(blocks.length - 1, at + steps))]
    if (target) {
      await update($, readTopAtom, () => target.start)
      await update($, cursorAtom, () => target.start)
    }
    return {}
  })

  // Clicks, drags and keys from the editor, applied one at a time
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const m = e.data as
      | { type: 'down'; line: number; col: number; shift: boolean }
      | { type: 'drag'; line: number; col: number }
      | { type: 'key'; key: string; shift: boolean; ctrl: boolean; meta: boolean }
    const run = async () => {
      if (m.type === 'down') {
        dragFrom = m.shift ? null : { line: m.line, col: m.col }
        await placeCaret($, { line: m.line, col: m.col }, m.shift)
      } else if (m.type === 'drag') {
        if (dragFrom && (await read($, markAtom)) === null) await update($, markAtom, () => dragFrom)
        const p = { line: m.line, col: m.col }
        await update($, cursorAtom, () => p.line)
        await update($, colAtom, () => p.col)
      } else if (m.type === 'key') {
        await editorKey($, m)
      }
    }
    queue = queue.then(run, run)
    await queue
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    if (e.surface === 'vscode') return next(e)
    const E = $.ui.resolve(e)
    const { Box, Text, Button, Input, Client } = E
    const doc = await read($, docAtom)
    const picker = await read($, pickerAtom)
    if (picker) {
      const cwd = await $.session.cwd()
      const label = (f: string | null) =>
        f === null ? 'Untitled draft  · unsaved' : relative(f, cwd) + (picker.files.indexOf(f) < picker.recent ? '  · recent' : '')
      const entries = [...(picker.hasDraft ? [null] : []), ...picker.files]
      const matches = entries.filter(f => fuzzy(picker.filter, label(f))).slice(0, 15)
      return (
        <Box flexDirection="column">
          <Input
            key="pick-filter"
            label="Open"
            value={picker.filter}
            placeholder="type to filter, or a path"
            submitLabel="open"
            autoFocus
            onInput={v => void update($, pickerAtom, p => p && { ...p, filter: v })}
            onSubmit={v => void openPicked($, matches.length ? (matches[0] ?? null) : v.trim())}
          />
          {matches.map((f, i) => (
            <Button
              key={'pick-' + i}
              label={label(f)}
              plain
              onPress={() => void openPicked($, f)}
            />
          ))}
          {matches.length === 0 && <Text dimColor>No markdown files match. Enter opens what you typed as a path.</Text>}
          <Button
            key="pick-cancel"
            label="cancel"
            plain
            dimColor
            onPress={() => void (async () => {
              await update($, pickerAtom, () => null)
              if (!(await read($, docAtom))) await $.ui.close({ id: PANE })
            })()}
          />
        </Box>
      )
    }
    if (!doc) return <Text dimColor>No file open. Run /md to pick one.</Text>

    const comments = await read($, commentsAtom)
    const cursor = await read($, cursorAtom)
    const col = await read($, colAtom)
    const mark = await read($, markAtom)
    const mode = await read($, modeAtom)
    const draft = await read($, draftAtom)
    const writing = await read($, writingAtom)
    const reader = await read($, readerAtom)
    const changed = new Set(await read($, changedAtom))
    const cwd = await $.session.cwd()
    const total = doc.lines.length
    const sel = ordered(mark, { line: cursor, col })
    const excerpt = sel ? textBetween(doc.lines, sel[0], sel[1]) : null
    const short = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1).replace(/\s+/g, ' ') + '…' : t.replace(/\s+/g, ' '))
    const open = comments.filter(c => c.status !== 'resolved')
    const here = comments.filter(c => c.status !== 'resolved' && c.start <= cursor && cursor <= c.end)
    const suggested = (await read($, suggestionsAtom)).flatMap(s => {
      const span = locate(doc.lines, s)
      return span ? [{ s, span }] : []
    })
    const suggestedHere = suggested.filter(({ span }) => span[0].line <= cursor && cursor <= span[1].line)
    const bodyRows = e.props.scroll.bodyRows || 20
    const page = Math.max(5, bodyRows - 8)

    const move = (to: number) => placeCaret($, { line: Math.max(1, Math.min(total, to)), col: 0 }, false)
    // The toolbar's prompts type into the pane's Input, never a draft
    const setMode = async (m: Mode) => {
      await update($, draftAtom, () => null)
      await update($, modeAtom, () => m)
    }
    const nextComment = () => {
      const after = open.map(c => c.start).filter(s => s > cursor).sort((a, b) => a - b)
      const first = open.map(c => c.start).sort((a, b) => a - b)
      return move(after[0] ?? first[0] ?? cursor)
    }

    const key = (k: string, label: string, onPress: () => unknown) => (
      <Button key={'k-' + k} hotkey={k} label={label} plain dimColor onPress={() => void onPress()} />
    )

    const header = (
      <Box flexDirection="row" columnGap={2}>
        <Text bold wrap="truncate-start">{doc.path ? relative(doc.path, cwd) : docName(null)}</Text>
        <Text dimColor>
          {excerpt ? `“${short(excerpt, 24)}”` : `${cursor}:${col + 1}`} · {open.length} open
          {changed.size > 0 ? ` · ${changed.size} changed` : ''}
          {suggested.length > 0 ? ` · ${suggested.length} suggested` : ''}
          {doc.path === null ? (writing ? ' · ✎ Claude is writing…' : ' · unsaved, /md save <path>') : ''}
        </Text>
      </Box>
    )

    const toolbar = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          {key('j', '↓', () => move(cursor + 1))}
          {key('k', '↑', () => move(cursor - 1))}
          {key('f', 'pg↓', () => move(cursor + page))}
          {key('b', 'pg↑', () => move(cursor - page))}
          {key('v', mark ? 'clear' : 'select', () => update($, markAtom, m => (m ? null : { line: cursor, col })))}
          {key('n', 'next', nextComment)}
          {key('r', 'read', async () => {
            const blocks = blocksOf(doc.lines)
            await update($, readTopAtom, () => blocks[blockAt(blocks, cursor)]?.start ?? 1)
            await update($, readerAtom, () => true)
          })}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          {key('c', 'comment', () => setMode('comment'))}
          {key('a', 'ask', () => setMode('ask'))}
          {key('x', 'send all', async () => {
            if (open.length === 0) return $.ui.toast('No open comments to send.')
            void $.prompt.submit({ text: reviewPrompt(doc.path, doc.lines, open), asUser: true })
            $.ui.toast(`Sent ${open.length} comment(s) to Claude.`)
          })}
          {key('s', 'resolve', () =>
            saveComments($, comments.map(c => (here.some(h => h.id === c.id) ? { ...c, status: 'resolved' } : c))),
          )}
          {key('u', 'undo', () => undo($))}
          {key('q', 'close', () => $.ui.close({ id: PANE }))}
        </Box>
      </Box>
    )

    const prompts = {
      comment: { label: excerpt ? `Note on “${short(excerpt, 22)}”` : `Comment on line ${cursor}`, submit: 'save' },
      ask: { label: excerpt ? `Ask about “${short(excerpt, 22)}”` : `Ask Claude about line ${cursor}`, submit: 'send' },
    }
    const active = mode === 'review' ? null : prompts[mode]
    const input =
      active &&
      (draft !== null ? (
        <Text key={'draft-' + mode} wrap="truncate-start">
          <Text bold>{active.label}: </Text>
          {draft}
          <Text inverse> </Text>
          <Text dimColor>  Enter to {active.submit}, empty to cancel</Text>
        </Text>
      ) : (
        <Input
          key={'input-' + mode}
          label={active.label}
          value=""
          submitLabel={active.submit}
          placeholder="Enter to submit, empty to cancel"
          autoFocus
          onSubmit={async (v: string) => {
            if (mode !== 'review' && v.trim()) await submitPrompt($, mode, v)
            await setMode('review')
          }}
        />
      ))

    // Notes wrap in full; the file view above gives up the rows they take
    const cols = Math.max(20, e.props.bodyColumns)
    const rowsOf = (text: string) => text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cols)), 0)
    const shown = here.slice(0, 2).map(c => ({
      c,
      head: `${c.author === 'claude' ? '◆ Claude' : c.kind === 'ask' ? '→ Claude' : '● you'} (${rangeLabel(c.start, c.end)}): ${c.text}`,
      reply: c.reply ? `  ↳ Claude: ${c.reply}` : undefined,
    }))
    const proposals = suggestedHere.slice(0, 1).map(({ s, span }) => ({
      s,
      head: `✎ Claude suggests (${rangeLabel(span[0].line, span[1].line)}): ${s.text || '(delete it)'}`,
      note: s.note ? `  ${s.note}` : '',
    }))
    const threadRows = Math.min(
      Math.floor(bodyRows / 2),
      proposals.reduce((n, t) => n + rowsOf(t.head) + 1, 0) +
        shown.reduce((n, t) => n + rowsOf(t.head) + (t.reply ? rowsOf(t.reply) : 0), 0),
    )
    const thread = [
      ...proposals.map(({ s, head, note }) => (
        <Box key={'s-' + s.id} flexDirection="column">
          <Text color="magenta" wrap="wrap">{head}</Text>
          <Box flexDirection="row" columnGap={2}>
            {note && <Text dimColor wrap="truncate-end">{note}</Text>}
            <Button key="k-y" hotkey="y" label="accept" onPress={() => void settle($, true)} />
            <Button key="k-d" hotkey="d" label="reject" plain dimColor onPress={() => void settle($, false)} />
            <Text dimColor>tab, then y / d</Text>
          </Box>
        </Box>
      )),
      ...shown.map(({ c, head, reply }) => (
        <Box key={'t-' + c.id} flexDirection="column">
          <Text color="yellow" wrap="wrap">{head}</Text>
          {reply && <Text color="green" wrap="wrap">{reply}</Text>}
        </Box>
      )),
    ]
    const stale = comments.filter(c => c.status === 'stale').length

    if (reader) {
      const toc = await read($, tocAtom)
      const blocks = blocksOf(doc.lines)
      const at = blockAt(blocks, await read($, readTopAtom))
      const selected = blockAt(blocks, cursor)
      const current = blocks[selected]
      const headings = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.kind === 'heading')
      const section = [...headings].reverse().find(({ i }) => i <= at)?.b

      const measure = Math.min(72, Math.max(20, cols - 6))
      const pad = Math.max(1, Math.floor((cols - measure - 2) / 2))
      const goBlock = async (i: number) => {
        const b = blocks[Math.max(0, Math.min(blocks.length - 1, i))]
        if (!b) return
        await update($, readTopAtom, () => b.start)
        await move(b.start)
      }
      const goHeading = (dir: 1 | -1) => {
        const target = dir === 1 ? headings.find(({ i }) => i > at) : [...headings].reverse().find(({ i }) => i < at)
        return target ? goBlock(target.i) : undefined
      }
      // A note belongs to the block its first line falls in, or the block above
      // a blank line, so none goes missing between paragraphs
      const notesOn = (start: number, _end: number) =>
        open.filter(c => blocks[blockAt(blocks, c.start)]?.start === start)
      const pick = (m: Mode) => async () => {
        if (current) {
          await placeCaret($, { line: current.start, col: 0 }, false)
          await placeCaret($, { line: current.end, col: (doc.lines[current.end - 1] ?? '').length }, true)
        }
        await setMode(m)
      }

      // Chrome: header, progress, footer keys, input
      const chromeRows = 3 + 3 + (input ? 1 : 0)
      const budget = Math.max(4, bodyRows - chromeRows)
      const visible: number[] = []
      const drawn: number[] = []
      let used = 0
      for (let i = at; i < blocks.length; i++) {
        const b = blocks[i]
        if (!b) break
        const noteRows = notesOn(b.start, b.end).reduce((n, c) => n + Math.ceil((c.text.length + 12) / measure), 0)
        const need = rowsOfBlock(b, measure - 2) + noteRows
        if (used > budget * 2) break
        if (drawn.length === 0 || used + need <= budget) visible.push(i)
        drawn.push(i)
        used += need
      }
      const lastLine = blocks[visible[visible.length - 1] ?? at]?.end ?? cursor
      const progress = lastLine >= total ? 100 : Math.round((((current?.start ?? 1) - 1) / Math.max(1, total)) * 100)
      const filled = Math.round((progress / 100) * (cols - 2))

      const drawBlock = (i: number) => {
        const b = blocks[i]
        if (!b) return null
        const notes = notesOn(b.start, b.end)
        const isChanged = Array.from({ length: b.end - b.start + 1 }, (_, k) => b.start + k).some(n => changed.has(n))
        return (
          <Box
            key={'b-' + b.start}
            flexDirection="column"
            marginBottom={1}
            marginTop={b.kind === 'heading' && b.level === 2 && i !== at ? 1 : 0}
            flexShrink={0}
          >
            <Box flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Button
                  key={'bm-' + b.start}
                  label={i === selected ? '▌' : notes.length > 0 ? '◆' : isChanged ? '┃' : '·'}
                  plain
                  dimColor={i !== selected && notes.length === 0}
                  onPress={() => {
                    void move(b.start)
                  }}
                />
              </Box>
              <Box width={measure - 2} flexDirection="column">{blockBody(E, b, measure - 2)}</Box>
            </Box>
            {notes.map(c => (
              <Box key={'n-' + c.id} flexDirection="column" paddingLeft={4} width={measure}>
                <Text color="yellow" italic wrap="wrap">
                  {c.author === 'claude' ? 'Claude' : c.kind === 'ask' ? 'You asked' : 'You'}: {c.text}
                </Text>
                {c.reply && <Text color="green" italic wrap="wrap">↳ Claude: {c.reply}</Text>}
              </Box>
            ))}
          </Box>
        )
      }

      const contents = (
        <Box flexDirection="column" paddingLeft={pad} width={measure + pad}>
          <Text bold>Contents</Text>
          <Text> </Text>
          {headings.map(({ b, i }, n) => (
            <Box key={'toc-' + i} paddingLeft={((b.level ?? 1) - 1) * 2}>
              <Button
                key={'toc-' + i}
                label={(n < 9 ? '' : '   ') + (b.label ?? '')}
                hotkey={n < 9 ? String(n + 1) : undefined}
                plain
                dimColor={section !== b}
                onPress={async () => {
                  await goBlock(i)
                  await update($, tocAtom, () => false)
                }}
              />
            </Box>
          ))}
          {headings.length === 0 && <Text dimColor>No headings in this file.</Text>}
        </Box>
      )

      return (
        <Box flexDirection="column" height={bodyRows}>
          <Box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={3} flexShrink={0}>
            <Text dimColor wrap="truncate-end">{docName(doc.path)}</Text>
            <Text dimColor wrap="truncate-start">
              {section && section.level !== 1 ? `§ ${section.label} · ` : ''}
              {progress}% · {readMinutes(doc.lines)} min
              {open.length ? ` · ${open.length} note${open.length === 1 ? '' : 's'}` : ''}
            </Text>
          </Box>
          <Box paddingX={1} flexShrink={0}>
            <Text color="magenta">{'━'.repeat(filled)}</Text>
            <Text dimColor>{'─'.repeat(Math.max(0, cols - 2 - filled))}</Text>
          </Box>
          <Text> </Text>
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {toc ? (
              contents
            ) : (
              <Box flexDirection="column" paddingLeft={pad} flexShrink={0}>
                {drawn.map(drawBlock)}
                {drawn[drawn.length - 1] === blocks.length - 1 && (
                  <Box width={measure} justifyContent="center">
                    <Text dimColor>· · ·</Text>
                  </Box>
                )}
              </Box>
            )}
          </Box>
          <Box paddingX={1} flexShrink={0}>
            <Text dimColor>{'─'.repeat(Math.max(0, cols - 2))}</Text>
          </Box>
          {input && <Box paddingLeft={pad} flexShrink={0}>{input}</Box>}
          <Box flexDirection="row" columnGap={2} paddingX={1} flexWrap="wrap" flexShrink={0}>
            {key('j', '↓', () => goBlock(at + 1))}
            {key('k', '↑', () => goBlock(at - 1))}
            {key('f', 'pg↓', () => goBlock((visible[visible.length - 1] ?? at) + 1))}
            {key('b', 'pg↑', () => goBlock(at - Math.max(1, visible.length)))}
            {key('n', '§↓', () => goHeading(1))}
            {key('p', '§↑', () => goHeading(-1))}
            {key('t', toc ? 'text' : 'contents', () => update($, tocAtom, v => !v))}
            {key('c', 'note', pick('comment'))}
            {key('a', 'ask', pick('ask'))}
            {key('r', 'review', () => update($, readerAtom, () => false))}
            {key('q', 'close', () => $.ui.close({ id: PANE }))}
          </Box>
        </Box>
      )
    }

    const width = String(total).length
    const gutterWidth = width + 3
    const textWidth = Math.max(10, cols - gutterWidth - 1)
    const room = Math.max(3, bodyRows - 6 - (threadRows ? threadRows + 1 : 0) - (input ? 1 : 0) - (stale ? 1 : 0))
    layout = { textWidth, room }
    const viewTop = Math.max(1, Math.min(total, await read($, viewTopAtom)))
    let inFence = false
    for (let i = 0; i < viewTop - 1; i++) if (doc.lines[i]?.trimStart().startsWith('```')) inFence = !inFence

    // The text as screen rows: each line's wrapped pieces, with the part of the
    // selection and the caret that fall in each
    const editorRows: EditorRow[] = []
    for (let n = viewTop; n <= total && editorRows.length < room; n++) {
      const line = doc.lines[n - 1] ?? ''
      const isFence = line.trimStart().startsWith('```')
      const style = lineStyle(line, inFence && !isFence)
      if (isFence) inFence = !inFence
      const notes = comments.filter(c => c.status !== 'resolved' && c.start <= n && n <= c.end)
      const noted = notes.length > 0
      // The person's own notes win the mark; ◆ means only Claude has spoken here
      const byClaude = noted && notes.every(c => c.author === 'claude')
      const isChanged = changed.has(n)
      // Columns of this line that a suggested change would replace
      const struckCols = suggested
        .filter(({ span }) => span[0].line <= n && n <= span[1].line)
        .map(({ span }): [number, number] => [n === span[0].line ? span[0].col : 0, n === span[1].line ? span[1].col : line.length])
      const isSuggested = struckCols.length > 0
      const lineSel: [number, number] | null =
        sel && sel[0].line <= n && n <= sel[1].line
          ? [n === sel[0].line ? sel[0].col : 0, n === sel[1].line ? sel[1].col : line.length]
          : null
      const pieces = wrapSegments(line, textWidth)
      pieces.forEach((piece, k) => {
        if (editorRows.length >= room) return
        const isLast = k === pieces.length - 1
        const a = lineSel ? Math.max(lineSel[0], piece.start) : 0
        const b = lineSel ? Math.min(lineSel[1], piece.end) : 0
        const caretHere = n === cursor && col >= piece.start && (col < piece.end || (isLast && col === line.length))
        editorRows.push({
          line: n,
          start: piece.start,
          text: line.slice(piece.start, piece.end),
          isLast,
          gutter:
            k === 0
              ? (isSuggested ? '✎' : byClaude ? '◆' : noted ? '●' : isChanged ? '+' : ' ') +
                String(n).padStart(width) +
                (n === cursor ? '▸' : ' ') +
                '│'
              : ' '.repeat(width + 2) + '│',
          gutterColor:
            k === 0 ? (isSuggested ? 'magenta' : byClaude ? 'cyan' : noted ? 'yellow' : isChanged ? 'green' : null) : null,
          style,
          isCaretLine: n === cursor,
          sel: lineSel && a < b ? [a - piece.start, b - piece.start] : null,
          struck: struckCols.flatMap(([from, to]): [number, number][] => {
            const x = Math.max(from, piece.start)
            const y = Math.min(to, piece.end)
            return x < y ? [[x - piece.start, y - piece.start]] : []
          }),
          caret: caretHere ? col - piece.start : null,
        })
      })
    }
    const rows = <Client key="editor" module="./editor.tsx" width={cols} props={{ rows: editorRows, gutterWidth }} />

    return (
      <Box flexDirection="column">
        {header}
        {toolbar}
        <Text dimColor>Click to place the caret, drag to select, type to edit · ctrl+k comment, ctrl+j ask</Text>
        {rows}
        {stale > 0 && <Text dimColor>{stale} comment(s) lost their lines after an edit.</Text>}
        {thread.length > 0 && <Text dimColor>{'─'.repeat(cols)}</Text>}
        {thread}
        {input}
      </Box>
    )
  })
}
