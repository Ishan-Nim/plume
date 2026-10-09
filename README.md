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
  <a href="#vaults">Vaults</a> ·
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
- **Live preview.** Click a paragraph and it becomes editable where it sits; move away and it is a paragraph again. The rest of the page stays rendered. Inside the block you are editing, the Markdown markers hide themselves: `**bold**` reads as bold until the caret is in the word, then the stars are back to be edited — the same for italics, strikethrough, inline code, links, images and headings. The file is the Markdown you typed either way. A list, table or code block opens whole; diagrams, maths and images stay rendered. Editing a block rewrites only that block's own lines. Turn it off in **Reading settings → Live preview**.
- **Or the whole file as text.** Press the pencil, or `Ctrl+E`, for the raw Markdown in a plain editor — no hidden formatting model. Both ways of typing share one buffer, so `Ctrl+E` loses nothing. Nothing is written until you save, an unsaved change is never dropped silently, and a file changed elsewhere cannot overwrite your work.
- **New notes from the sidebar.** The `+` in the **Files** header starts one in the folder the tree is showing; every folder has a `+` of its own for a note inside it, and `Ctrl+Shift+N` does the first of those from the keyboard. You name it in the tree where the note will be — `Enter` creates it, opens it and leaves you ready to type, `Esc` leaves nothing behind. The button beside it makes a folder. A name Windows cannot open is refused on every platform, and an existing note is never overwritten.
- **Rename, move and delete from the tree.** Right-click any row for a menu — rename (`F2`), move to trash, open in a new window, copy path — and drag a note onto a folder to move it. **Renaming rewrites every link that pointed at the note:** `[[Plan]]`, `![[Plan]]`, `[[Plan#Heading|alias]]` and `[the plan](Plan.md)`, across the whole folder, with a count of what changed. Deleting goes to the system trash and asks first.
- **Open a folder** of notes from the welcome screen or **⋯ → Open folder…**: the sidebar roots itself there and stays there, and Plume remembers it for next time. Opening a folder is all it is — nothing is written beside your notes, and the folder is not a vault until you make it one.
- **Vaults, when you want one.** **Create vault** writes a `.plume/` folder into a folder of notes and indexes the Markdown already there, which is what backlinks across the whole folder, search and the graph are built on. It needs no account and no network, and it is a finished state on its own. Link a vault to an account and it syncs between your computers. See [Vaults](#vaults).
- **Live reload** — save the file in any editor and Plume updates in place, keeping your scroll position.
- **Updates that ask first.** Plume tells you when a new version is out and installs it when you say so. Every download is checked against the release's published checksum.
- **Find in page**, back/forward between linked notes, image lightbox, copy buttons on code blocks.
- **Light / dark / auto theme**, text size, reading width, sans/serif.
- **Git sync.** Keep a folder of notes in a Git repository — pull, commit, push — from **⋯ → Git sync…**, for Plume Vault account holders. It drives the Git already on your machine, so Plume never asks for a token and never stores one, and conflicts, submodules, LFS and signing behave as they do in your terminal.
- **Five colour palettes** — Plume, Starless, Greenwood, Commit and Lapis. A palette recolours whichever of light or dark is in force rather than replacing that choice, so auto still follows the system inside every one of them. The same five are on the website and the web app.
- **Print** and **Export to PDF** (with a PDF outline from your headings).
- **Open in editor** (VS Code or Cursor if installed, otherwise the system text editor), **Open in Obsidian** for vault files, **Open with…** (Windows), **Show in folder**.
- Safe by default: documents are sanitised, scripts never run, links to programs are never executed.

## Vaults

Plume reads the files already on your disk, and that needs no account. A folder on
disk is never silently a vault, and a vault never silently syncs. Those are two
separate decisions, made in that order, and a folder can stop at either of them.

### A loose file or folder

Open a `.md` file, or a folder of them, and you can read and write everything in
it. Plume has decided nothing about the folder: no identity, no settings, no index
— so no backlinks across the folder and no graph — and **it can never sync**. That
last part is a guarantee rather than a default. The main process has no channel
that could carry a loose path to the cloud, so there is nothing to misconfigure.

### A local-only vault

**Create vault** writes a `.plume/` directory into the folder. From then on the
folder has a permanent id, settings of its own and an index of its files, which is
what backlinks, search and the graph across the whole vault are built on.

This works with no account and no network, forever, and uses none of your storage.
It is a finished state, not a step on the way to something else.

Creating a vault in a folder that is already full of Markdown adopts those notes
where they lie. Nothing is moved, copied or re-imported.

### A linked vault

Sign in, then press **Link to my account** on a vault, and it syncs from then on.
Signing in by itself links nothing and syncs nothing: linking is done one vault at
a time, by name, so holding an account never decides anything about a folder for
you.

On a second computer, sign in and press **Put it here** on a vault from your
account. Plume makes the folder, downloads what is in it, and syncs from then on.

### How sync behaves

- **Both ways, by itself.** What you write here goes up; what was written on
  another computer or in the web vault comes down; a document deleted on one side
  goes on the other. Plume watches while it runs and checks again every few minutes.
- **Nothing is destroyed to settle a disagreement.** Edited here *and* somewhere
  else before the two met? Both are kept: yours stays where it is and the remote
  copy lands beside it as `idea (conflict 2026-10-09 LAPTOP).md`, named for the day
  and the machine because a conflict found a week later has to say where it came
  from. An edit always beats a delete, and a delete arriving from elsewhere moves
  the file into `.plume/sync/trash/` rather than erasing it.
- **Nothing is flattened.** Every upload carries the revision that machine last
  saw. If the copy in the account moved on in the meantime the write is refused
  rather than applied.
- **Only documents and images are ever uploaded.** Programs and archives are
  refused by an allow-list and stay on your computer, which is why a 1.5 GB folder
  of notes is usually a few megabytes in the account. Your folder is never moved or
  renamed, and the tree is kept: `Projects/Plume.md` arrives as `Projects/Plume.md`.
- **A graph** of how your documents link to each other, from wiki links and
  Markdown links.
- **Read them anywhere** at [plume-md.com/app.html](https://plume-md.com/app.html).

### Storage

**The number of vaults is unlimited; the limit is on bytes in the cloud.** Those
two read as a contradiction until you see that they count different things: the
cap is on how much is stored in your account, not on how many vaults organise it.
Every linked vault draws on one shared pool. A free account is 100 MB, and there
is no paid tier.

Local-only vaults and loose folders cost nothing at all, because nothing of them
is in the account.

Running out is a soft stop on the upload and nothing else. The edit is already
saved to your disk; only its journey up waits, in `.plume/sync/pending/`, and it
goes when there is room.

### Unlinking is not deleting

**Unlink** stops a vault syncing and keeps both copies: the folder on this
computer with every note in it, and the copy in your account, which goes on using
storage.

**Delete** removes a vault from your account. It is the only thing that frees
space, which is why it is a separate act with its own name, and it leaves the
copies on your computers alone.

### What `.plume/` holds

```
.plume/
  vault.json           identity: vault_id, name, created_at, schema_version
  config.json          this vault's settings
  link.json            the account link — absent on a local-only vault
  sync/manifest.json   path -> { hash, size, mtime, rev }, what sync diffs against
  sync/state.json      this device's sync cursor and pause flag (never synced)
  sync/pending/        uploads waiting on quota
  sync/trash/          documents removed because the remote said so, recoverable
  workspace.json       open tabs and panes (never synced)
  cache/               search index and thumbnails, rebuildable
```

Delete `.plume/` and the folder is loose again with every note untouched. That is
the property that makes the claim safe to make in the first place. A vault cannot
be nested inside another vault — both directions are refused — because nesting
makes it ambiguous which vault owns a file, and so where that file syncs.

### Coming from an older Plume

If you were syncing a folder on 1.7 or earlier, it becomes a linked vault on first
launch: the same folder on disk, the same name in your account. Nobody loses a
sync by updating.

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
| New note in the folder shown | `Ctrl+Shift+N` |
| Rename in the file tree | `F2` |
| Close window | `Ctrl+W` |
| Find / next / previous | `Ctrl+F`, `Enter` / `F3`, `Shift+Enter` / `Shift+F3` |
| Back / forward | `Alt+←` / `Alt+→`, mouse side buttons |
| Toggle sidebar | `Ctrl+\` |
| Text size | `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, `Ctrl`+wheel |
| Reload | `F5` / `Ctrl+R` |
| Edit one block, where it is | click it |
| Edit the whole file as text | `Ctrl+E` |
| Save | `Ctrl+S` |
| Open in your editor | `Ctrl+Shift+E` |
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

End-to-end checks of the account and of the vault model, in the real app — the
first signs up, syncs, draws the graph and signs out; the second walks a folder
through loose, local-only and linked, makes two copies disagree on purpose, then
clones, unlinks and deletes. Point them at a vault API of your own, never
production: both create an account and write and delete real documents.

```bash
PLUME_VAULT_API=http://127.0.0.1:8098/api npx electron test/e2e/vault-flow.js
PLUME_VAULT_API=http://127.0.0.1:8098/api npx electron test/e2e/vault-sync-flow.js
```

Visual smoke test (renders a document in the real app and saves a screenshot):

```bash
PLUME_OUT=shot.png npx electron test/e2e/capture.js test/fixtures/vault/kitchen-sink.md
```

The screenshots above come from the sample notes in [`docs/demo-notebook`](docs/demo-notebook), rendered by that harness.

## Project layout

```
src/main/       main process — windows, file access, settings, vaults, sync, account, IPC, preload
src/renderer/   UI — markdown pipeline, DOM enhancements, find, sidebar, vault panel, graph
mcp/            MCP server, so an AI assistant can use the vault as project memory
site/           plume-md.com — the landing, download, docs and web-vault pages
resources/      icons (SVG sources + generated ICO/PNG), NSIS installer additions
scripts/        build + icon generation
test/           unit tests, e2e capture + flow harnesses, fixture vault
docs/           screenshots and the demo notebook they are taken from
```

## Credits

Written and maintained by **Ishan Nim** — [personal site and blog](https://ishan-nim-portfolio-74tdd.ondigitalocean.app). Full credits are in [docs/CREDITS.md](docs/CREDITS.md).


The four colour palettes beyond Plume's own are derived from Obsidian community
themes, each MIT licensed. The CSS in this repository is Plume's; the colour
schemes are theirs, and the names here are different so neither is mistaken for
the other.

| Palette | Derived from | Author |
|---|---|---|
| Starless | [Void](https://github.com/0crazy-0/obsidian-void) | 0crazy-0 |
| Greenwood | [Everforest Enchanted](https://github.com/fireisgood/obsidian-everforest-enchanted) | fireisgood |
| Commit | [GitHub Flavored Markdown](https://github.com/tofrankie/obsidian-theme-gfm) | tofrankie |
| Lapis | [Sodalite](https://github.com/tomzorz/Sodalite) | tomzorz |

Void and Sodalite are dark-only upstream; their light sides are built from the
same hues so that Light and Auto keep working when one of them is chosen.

## Security

Markdown files are untrusted input. Plume renders them in a sandboxed, context-isolated window with a strict Content-Security-Policy; HTML is sanitised with DOMPurify, scripts never run, external links open in your browser, and links to local files only open documents, images, media and plain folders — programs, apps, scripts and shortcuts are only ever revealed in the file manager. A document cannot make Plume load files from other computers on your network.
