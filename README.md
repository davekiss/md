<h1 align="center">md</h1>

<p align="center"><b>Write markdown with Claude in the margin.</b></p>

<p align="center">
  A Claude Code mod for markdown files.<br>
  Claude drafts into a pane beside the chat. You read, select, comment and edit there, and so does Claude.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.0-000" alt="Version 0.2.0">
  <img src="https://img.shields.io/badge/Claude%20Code-2.1.288%2B-000" alt="Claude Code 2.1.288+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-000" alt="MIT"></a>
</p>

---

Chat is a poor place to edit prose. Each revision is a fresh wall of text, and the sentence you reacted to scrolls away.

md gives the text a place to stay. Claude writes the draft into a pane, and you see it stream in. You select a phrase and ask about it. Claude answers on that phrase, or proposes a rewrite you accept or reject. Every comment stays on its words, even after the paragraph above it changes.

```
╭─ essay.md ─────────────────────────── 22:1 · 2 open · 1 suggested ─╮
│ 20 │ For most of history the margin was a dead end.                │
│ 21 │                                                               │
│✎22▸│ That is no longer quite true. A bracketed paragraph can come  │
│    │ back rewritten.                                               │
│ 23 │                                                               │
│◆24 │ The page stops being a finished object.                       │
├────────────────────────────────────────────────────────────────────┤
│ ✎ Claude suggests (line 22): flagged                               │
│   fits the conversation idea   [ accept ]  d: reject               │
╰────────────────────────────────────────────────────────────────────╯
```

## Get started

```
/plugin marketplace add davekiss/cc-plugins
/plugin install md@davekiss
```

Then ask Claude to draft something in the pane, or type `/md` to pick a file.

## What it does

### Drafts stream into the pane

Ask for a first draft and Claude writes it into the pane instead of the chat. The text appears as Claude writes it, so you can start on the first section while the last is still coming. The draft isn't a file yet. It keeps its comments between sessions, and `/md save drafts/post.md` writes it out when it's worth keeping.

### Point at exact words

Drag across a phrase, then press **ctrl+j** to ask Claude about it or **ctrl+k** to leave a note. Claude gets the exact text you selected, not just a line number. Press **x** to send every open note at once.

### Claude suggests, you decide

For your prose, Claude proposes changes instead of making them. The old text is struck through in place and the new text waits underneath. Accept or reject it with a click, or press **Tab** to land on accept, then **y** or **d**. When you ask for a change outright, Claude makes it directly. Either way it's marked in the gutter and **u** undoes it.

### Made for reading what you wrote

The text sits in a centered column about 72 characters wide, the line length prose reads best at, however wide the pane is. Markdown stays real and editable, but it steps back. `**` and `#` are faint, so **bold** reads bold and *italic* reads italic. Code and links get their own color. The header keeps a live word count, of the whole document or of what you've selected.

Press **z** for focus mode. Every paragraph but the one you're in fades, and your line stays near the middle of the pane as you write.

### Images in the text

An image on its own line shows as a picture in the reader view, and under your line when the caret is on it. Ghostty, kitty and WezTerm draw real pixels. Other terminals with full color, iTerm2 included, get a half-block thumbnail. Previews need macOS, which reads the image with `sips`.

### Comments stay on their words

Notes are anchored to the text they quote. Edit above them and they move with it. Delete their text and they're marked stale instead of pointing at the wrong line.

### The gutter tells you who said what

| Mark | Meaning |
|---|---|
| `●` | You commented on this line |
| `◆` | Only Claude commented on this line |
| `✎` | Claude suggested a change here |
| `+` | Changed since you opened the file |
| `▸` | Your caret |

## Keys

In the text, type to edit. Click to place the caret and drag to select.

| Key | Does |
|---|---|
| ctrl+j | Ask Claude about the selection |
| ctrl+k | Comment on the selection |
| ctrl+u | Undo (ctrl+z suspends Claude Code) |
| cmd+v | Paste text. A dragged-in image file becomes an image link. |
| ctrl+v | Paste the image on the clipboard: saved to `assets/` and linked (macOS) |
| Tab | Move to the pane's buttons |

With the pane's buttons focused:

| Key | Does |
|---|---|
| j / k | Next / previous line |
| f / b | Page down / up |
| v | Start or clear a selection |
| o | Copy the selection, or the whole document, to the clipboard |
| i | Paste the image on the clipboard |
| z | Focus mode: fade all but this paragraph, keep your line centered |
| n | Next comment |
| c / a | Comment / ask |
| x | Send all open comments to Claude |
| s | Resolve the comment on this line |
| y / d | Accept / reject the suggestion on this line |
| u | Undo |
| r | Switch to the reader view (and back) |
| q | Close the pane |

## Commands

| Command | Does |
|---|---|
| `/md` | Pick a file: recent ones first, then markdown under the current directory. Type to filter, or choose **+ New file**. |
| `/md <path>` | Open a file |
| `/md new [name]` | Create an empty markdown file and open it. Without a name, `untitled.md`. Never overwrites. |
| `/md save <path>` | Save the draft, or the open file under a new name. Never overwrites another file. |

## Claude's tools

Claude works the pane through the same moves you have.

| Tool | Does |
|---|---|
| `draft` | Write or extend the draft, streamed into the pane |
| `suggest` | Propose a change for you to accept or reject |
| `edit` | Change exact text, marked in the gutter and undoable |
| `comment` | Leave a note on quoted text |
| `reply` | Answer a note, and resolve it when done |
| `open` | Show a file, a line range, or select exact text |
| `view` | See your caret, selection, comments, suggestions and changes |
| `save` | Write the draft to a file |
| `close` | Close the pane |

## License

MIT
