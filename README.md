<p align="center">
  <img src="resources/icon.png" width="96" height="96" alt="Plume">
</p>

<h1 align="center">Plume</h1>

<p align="center">
  <b>A feather-light Markdown viewer for Windows.</b><br>
  Double-click any <code>.md</code> file and it opens instantly — no vault, no project, no editor chrome. Just the document, beautifully set.
</p>

<p align="center">
  <a href="https://github.com/Ishan-Nim/plume/releases/latest"><b>Download for Windows</b></a> ·
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#keyboard">Keyboard</a> ·
  <a href="#build-from-source">Build</a>
</p>

![Plume showing a note with its folder tree, a callout and a table](docs/screenshots/light.png)

## Screenshots

| Dark mode | Code, diagrams & outline |
|---|---|
| ![Plume in dark mode](docs/screenshots/dark.png) | ![Highlighted code, a Mermaid diagram and the outline sidebar](docs/screenshots/diagram.png) |
| **Reading settings** | **Welcome screen** |
| ![Theme, text size, width, font and line-break settings](docs/screenshots/reading.png) | ![Welcome screen with recent files](docs/screenshots/welcome.png) |

## Features

- **Opens with one double-click.** The installer registers Plume for `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.mdtxt`, `.mdtext`. A second file opens in a new window of the already-running app — no cold start.
- **Reads Obsidian notes properly.** `[[wiki links]]`, `[[Note#Heading|alias]]`, `![[image.png|300]]`, `![[Note#Section]]` transclusion, callouts (`> [!tip]`, foldable `> [!warning]-`), `==highlights==`, `#tags`, `%%comments%%`, `^block` ids, front-matter Properties, and Obsidian-style line breaks (toggleable).
- **Full GitHub-flavoured Markdown.** Tables, task lists, footnotes, definition lists, emoji shortcodes, syntax highlighting (incl. PowerShell, Dockerfile, nginx…), KaTeX math, Mermaid diagrams.
- **Sidebar** with the folder tree around the file (the whole vault when the file is inside one) and an outline of headings with reading time.
- **Live reload** — save the file in any editor and Plume updates in place, keeping your scroll position.
- **Find in page**, back/forward between linked notes, image lightbox, copy buttons on code blocks.
- **Light / dark / auto theme**, text size, reading width, sans/serif.
- **Print** and **Export to PDF** (with a PDF outline from your headings).
- **Open in editor** (VS Code if installed, otherwise Notepad), **Open in Obsidian** for vault files, **Open with…**, **Show in folder**.
- Safe by default: documents are sanitised, scripts never run, links to programs are never executed.

## Install

1. Download `Plume-Setup-<version>.exe` from [Releases](https://github.com/Ishan-Nim/plume/releases/latest) (or build it yourself, below).
2. Run it. Plume installs for all users in `C:\Program Files\Plume` — Windows asks for administrator approval once — and adds Start-menu and desktop shortcuts.

Requires Windows 10 or 11, 64-bit. Uninstall from **Settings → Apps → Installed apps**.

### Make Plume the default for .md

Windows only lets *you* choose default apps, so this is one click on your side. Any of these works:

- Right-click any `.md` file → **Open with** → **Choose another app** → **Plume** → **Always**.
- **Settings → Apps → Default apps**, type `.md` in *Set a default for a file type*, and pick **Plume**.
- In Plume, open **⋯ → Make Plume the default for .md** — it jumps straight to Plume's page in Settings.

After that, a double-click opens Markdown files straight into Plume. Plume also appears in the right-click **Open with** menu for every Markdown extension.

## Keyboard

| Action | Keys |
|---|---|
| Open file | `Ctrl+O` |
| New window | `Ctrl+N` |
| Close window | `Ctrl+W` |
| Find / next / previous | `Ctrl+F`, `Enter` / `F3`, `Shift+Enter` / `Shift+F3` |
| Back / forward | `Alt+←` / `Alt+→`, mouse side buttons |
| Toggle sidebar | `Ctrl+\` |
| Text size | `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, `Ctrl`+wheel |
| Reload | `F5` / `Ctrl+R` |
| Open in editor | `Ctrl+E` |
| Print | `Ctrl+P` |
| Full screen | `F11` |
| Open link in new window | `Ctrl`+click or middle-click |

## Build from source

```bash
npm install
npm start        # run in development
npm test         # unit tests
npm run icons    # re-render icons from resources/*.svg
npm run dist     # build release/Plume-Setup-<version>.exe (per-machine installer)
```

Visual smoke test (renders a document in the real app and saves a screenshot):

```bash
PLUME_OUT=shot.png npx electron test/e2e/capture.js test/fixtures/vault/kitchen-sink.md
```

The screenshots above come from the sample notes in [`docs/demo-notebook`](docs/demo-notebook), rendered by that harness.

## Project layout

```
src/main/       main process — windows, file access, settings, IPC, preload bridge
src/renderer/   UI — markdown pipeline, DOM enhancements, find, sidebar, styles
resources/      icons (SVG sources + generated ICO/PNG), NSIS installer additions
scripts/        build + icon generation
test/           unit tests, e2e capture harness, fixture vault
docs/           screenshots and the demo notebook they are taken from
```

## Security

Markdown files are untrusted input. Plume renders them in a sandboxed, context-isolated window with a strict Content-Security-Policy; HTML is sanitised with DOMPurify, scripts never run, external links open in your browser, and links to local files only open documents, images and media — programs, scripts and shortcuts are only ever revealed in File Explorer.
