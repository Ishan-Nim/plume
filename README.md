<p align="center">
  <img src="resources/icon.png" width="96" height="96" alt="Plume">
</p>

<h1 align="center">Plume</h1>

<p align="center">
  <b>A feather-light Markdown viewer and editor for Windows, macOS and Linux.</b><br>
  Double-click any <code>.md</code> file and it opens instantly — no workspace to import, no project to set up. Just the document, beautifully set.
</p>

<p align="center">
  <a href="https://plume-md.com"><b>plume-md.com</b></a>
</p>

<p align="center">
  <a href="https://plume-md.com/download.html"><b>Download</b></a> ·
  <a href="https://plume-md.com/docs.html">Documentation</a> ·
  <a href="https://plume-md.com/app.html">Your vault</a> ·
  <a href="RELEASE-NOTES.md">Release notes</a> ·
  <a href="#features">Features</a> ·
  <a href="#vault">Vault &amp; sync</a> ·
  <a href="#keyboard">Keyboard</a> ·
  <a href="#build-from-source">Build</a>
</p>

<p align="center">
  <a href="https://github.com/Ishan-Nim/plume/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Ishan-Nim/plume?label=release&amp;color=6d4aff"></a>
  <a href="https://github.com/Ishan-Nim/plume/blob/master/LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-6d4aff"></a>
  <img alt="Windows, macOS and Linux" src="https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-free-6d4aff">
</p>

![Plume showing a note with its folder tree, a callout and a table](docs/screenshots/light.png)

## Screenshots

| Dark mode | Code, diagrams & outline |
|---|---|
| ![Plume in dark mode](docs/screenshots/dark.png) | ![Highlighted code, a Mermaid diagram and the outline sidebar](docs/screenshots/diagram.png) |
| **Reading settings** | **Welcome screen** |
| ![Theme, text size, width, font and line-break settings](docs/screenshots/reading.png) | ![Welcome screen with recent files](docs/screenshots/welcome.png) |

## Features

- **Opens with one double-click.** Plume registers itself for `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.mdtxt`, `.mdtext`. A second file opens in a new window of the already-running app — no cold start.
- **Reads Obsidian notes properly.** `[[wiki links]]`, `[[Note#Heading|alias]]`, `![[image.png|300]]`, `![[Note#Section]]` transclusion, callouts (`> [!tip]`, foldable `> [!warning]-`), `==highlights==`, `#tags`, `%%comments%%`, `^block` ids, front-matter Properties, and Obsidian-style line breaks (toggleable).
- **Full GitHub-flavoured Markdown.** Tables, task lists, footnotes, definition lists, emoji shortcodes, syntax highlighting (incl. PowerShell, Dockerfile, nginx…), KaTeX math, Mermaid diagrams.
- **Sidebar** with the folder tree around the file (the whole vault when the file is inside one) and an outline of headings with reading time.
- **Edits when you ask it to.** Press the pencil, or `Ctrl+E`, for the raw Markdown in a plain editor — no hidden formatting model. Nothing is written until you save, an unsaved change is never dropped silently, and a file changed elsewhere cannot overwrite your work.
- **Live reload** — save the file in any editor and Plume updates in place, keeping your scroll position.
- **Updates that ask first.** Plume tells you when a new version is out and installs it when you say so. Every download is checked against the release's published checksum.
- **Find in page**, back/forward between linked notes, image lightbox, copy buttons on code blocks.
- **Light / dark / auto theme**, text size, reading width, sans/serif.
- **Print** and **Export to PDF** (with a PDF outline from your headings).
- **Open in editor** (VS Code or Cursor if installed, otherwise the system text editor), **Open in Obsidian** for vault files, **Open with…** (Windows), **Show in folder**.
- Safe by default: documents are sanitised, scripts never run, links to programs are never executed.

## Vault &amp; sync

Plume reads the files already on your disk, and that needs no account. Create a free
one and you also get **Plume Vault**: 100 MB of storage for syncing documents between
your computers, and a browser to read them in. It is free — there is no paid tier.

- **Sync from the app.** The **Plume Vault** bar at the foot of the sidebar signs you in
  and pushes the open document up. Another machine pulls it down.
- **Or sync a whole folder.** Choose one folder and Plume keeps everything in it — notes,
  images and sub-folders — in your vault by itself, watching for changes while it runs.
  Only documents and images are ever uploaded; programs and archives are refused by an
  allow-list and stay on your computer. That is why a 1.5 GB notebook is usually a few
  megabytes of vault. Your folder is never moved or renamed, and folders are kept:
  `Projects/Plume.md` arrives as `Projects/Plume.md`.
- **Nothing is flattened.** Every upload carries the revision that machine last saw. If
  the vault copy moved on in the meantime the write is refused, and you choose which
  copy to keep — Plume can save the other one beside yours so neither is lost.
- **A graph** of how your documents link to each other, from wiki links and Markdown links.
- **Read them anywhere** at [plume-md.com/app.html](https://plume-md.com/app.html).

### Project memory for Claude Code and other MCP clients

Create an API token in the web vault and an AI assistant can keep project memory,
decisions and notes in it — somewhere that outlives the session and that you can read
in Plume afterwards.

```json
{
  "mcpServers": {
    "plume-vault": {
      "command": "node",
      "args": ["/path/to/plume/mcp/index.js"],
      "env": { "PLUME_TOKEN": "plm_your_token" }
    }
  }
}
```

See [`mcp/`](mcp) for the server and its tools.

The vault's own server is closed source; the app, the website and the MCP client in
this repository are not.

## Install

Download the package for your system from [Releases](https://github.com/Ishan-Nim/plume/releases/latest), or build it yourself (below). The packages are not code-signed yet.

**Windows 10 / 11 (64-bit):** run `Plume-Setup-<version>.exe`. Plume installs for all users in `C:\Program Files\Plume` — Windows asks for administrator approval once — and adds Start-menu and desktop shortcuts. If SmartScreen warns, choose **More info → Run anyway**. Uninstall from **Settings → Apps → Installed apps**.

**macOS (Apple silicon or Intel):** open `Plume-<version>-mac-<arch>.dmg` and drag Plume into Applications. Plume is not notarized, so macOS blocks the first launch: right-click Plume → **Open**, or allow it under **System Settings → Privacy & Security**, or run `xattr -cr /Applications/Plume.app`.

**Linux (x64):** `sudo apt install ./Plume-<version>-linux-amd64.deb`, or make `Plume-<version>-linux-x86_64.AppImage` executable and run it.

### Make Plume the default for .md (Windows)

Windows only lets *you* choose default apps, so this is one click on your side. Any of these works:

- Right-click any `.md` file → **Open with** → **Choose another app** → **Plume** → **Always**.
- **Settings → Apps → Default apps**, type `.md` in *Set a default for a file type*, and pick **Plume**.
- In Plume, open **⋯ → Make Plume the default for .md** — it jumps straight to Plume's page in Settings.

After that, a double-click opens Markdown files straight into Plume. Plume also appears in the right-click **Open with** menu for every Markdown extension.

On macOS, select a `.md` file in Finder → **Get Info** → **Open with: Plume** → **Change All…**. On Linux, choose Plume under **Open With** in your file manager and set it as the default.

## Keyboard

On macOS, use `⌘` in place of `Ctrl` and `⌥` in place of `Alt`.

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
npm run dist        # build release/Plume-Setup-<version>.exe (per-machine installer)
npm run dist:mac    # build the macOS .dmg and .zip (on a Mac)
npm run dist:linux  # build the Linux AppImage and .deb
```

End-to-end check of the whole vault flow in the real app — sign up with the emailed code,
sync, graph, sign out, reset the password with a code, five wrong codes (point it at a vault
API of your own, never production). The vault repository's `scripts/dev-server-memory.js`
runs one entirely in memory and prints the mail it would send, codes included; the test
reads the codes from that output:

```bash
node scripts/dev-server-memory.js > vault.log      # in plume-vault
PLUME_VAULT_API=http://127.0.0.1:8098/api PLUME_MAIL_LOG=../plume-vault/vault.log npx electron test/e2e/vault-flow.js
```

Visual smoke test (renders a document in the real app and saves a screenshot):

```bash
PLUME_OUT=shot.png npx electron test/e2e/capture.js test/fixtures/vault/kitchen-sink.md
```

The screenshots above come from the sample notes in [`docs/demo-notebook`](docs/demo-notebook), rendered by that harness.

## Project layout

```
src/main/       main process — windows, file access, settings, vault client, IPC, preload
src/renderer/   UI — markdown pipeline, DOM enhancements, find, sidebar, vault panel, graph
mcp/            MCP server, so an AI assistant can use the vault as project memory
site/           plume-md.com — the landing, download, docs and web-vault pages
resources/      icons (SVG sources + generated ICO/PNG), NSIS installer additions
scripts/        build + icon generation
test/           unit tests, e2e capture + vault-flow harnesses, fixture vault
docs/           screenshots and the demo notebook they are taken from
```

## Security

Markdown files are untrusted input. Plume renders them in a sandboxed, context-isolated window with a strict Content-Security-Policy; HTML is sanitised with DOMPurify, scripts never run, external links open in your browser, and links to local files only open documents, images, media and plain folders — programs, apps, scripts and shortcuts are only ever revealed in the file manager. A document cannot make Plume load files from other computers on your network.
