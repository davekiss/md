export type Comment = {
  id: string
  /** 1-based, inclusive */
  start: number
  end: number
  /** The lines the comment was made on, to re-anchor after edits */
  quote: string
  /** The exact text the person selected, when they selected some */
  excerpt?: string
  text: string
  kind: 'note' | 'ask'
  /** Who wrote it; absent on comments saved before this field existed */
  author?: 'you' | 'claude'
  status: 'open' | 'resolved' | 'stale'
  reply?: string
}

/** A change Claude proposes; the person accepts or rejects it. Found by its exact old text, nearest `line` */
export type Suggestion = {
  id: string
  line: number
  old: string
  text: string
  note?: string
}

/** An unsaved draft as the store keeps it between sessions */
export type StoredDraft = { lines: string[]; comments: Comment[]; suggestions: Suggestion[] }

/** A caret position: 1-based line, 0-based column */
export type Pos = { line: number; col: number }

/** `path` is null for a draft Claude wrote that no file holds yet; the store keeps it until it is saved */
export type Doc = { path: string | null; lines: string[]; mtimeMs: number }

export type Mode = 'review' | 'comment' | 'ask'

declare module 'claude-code' {
  interface PluginState {
    'md': {
      doc: Doc | null
      comments: Comment[]
      suggestions: Suggestion[]
      /** The caret's line */
      cursor: number
      /** The caret's column in its line */
      col: number
      /** The other end of the selection; the caret is one end */
      mark: Pos | null
      /** The first line the review view shows */
      viewTop: number
      mode: Mode
      /** The comment or question typed in the editor after ctrl+k / ctrl+j; null when the Input takes it */
      draft: string | null
      /** Claude's draft tool call is streaming into the pane */
      writing: boolean
      /** The file picker /md shows without a path: absolute paths, recent first, and the filter typed */
      picker: { files: string[]; recent: number; filter: string; hasDraft: boolean } | null
      changed: number[]
      reader: boolean
      /** The line the reader's window starts at; the cursor marks the selected block */
      readTop: number
      toc: boolean
      /** Focus mode: only the caret's paragraph at full strength, its line kept mid-pane */
      focus: boolean
    }
  }
}
