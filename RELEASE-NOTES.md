# Plume 1.4.1

**Released 9 October 2026** · [plume-md.com](https://plume-md.com) · MIT licence

> **1.4.1 fixes a folder being synced into the wrong notebook.**
>
> Changing the synced folder moved the folder but kept the notebook name the
> old one had, so the documents went up under a name belonging to a folder they
> were not in. Opening a folder set both; choosing one in the vault panel set
> only half, which is the half nobody can see. The folder, the notebook and the
> folder shown in the sidebar now move together.
>
> **A sync that would delete a lot of documents stops and says so.** Pointing a
> folder at the wrong notebook, a drive that has not finished mounting, or a
> notebook name out of step with its folder all look from inside the sync like
> "everything here was deleted". When a sync is about to remove ten or more
> documents, and a third or more of what the notebook holds, it pauses instead
> and says what it was about to do.
>
> **Change folder…** is a button of its own, beside Stop, so moving to another
> project is one named thing rather than stopping and starting again.
>
> **Your vault reads as its folders.** A synced folder puts its whole shape up
> there, and a flat list of paths stopped being readable the moment it did.
> Folders fold, counts are on the right, and what is inside them is indented —
> in the app and in the web vault both.
>
> **1.4.0 makes the folder you are working in your vault.**
>
> **Sign in and the open folder is the vault.** There is nothing else to choose,
> and no second folder to pick in another panel. From that moment the folder and
> the vault are the same notebook: what you write here goes up, what was written
> on another computer or in the web vault comes down, and a document deleted on
> one side goes on the other. Plume watches the folder while it is open and
> checks again every few minutes. Opening a single file on its own still syncs
> nothing — a vault is a folder.
>
> **Nothing is destroyed to settle a disagreement.** Syncing both ways means two
> copies can move apart, so when they do, both are kept: yours stays where it is
> and the vault's is saved beside it as `note (vault copy …).md`. An edit always
> beats a delete. A delete that arrives from elsewhere moves the document into a
> hidden `.plume-trash` folder inside your folder rather than erasing it, so the
> one thing that can take a file off this disk is something you can undo.
>
> **A vault holds more than one notebook.** Each folder you sync takes a folder
> of its own inside the vault, named after itself, so choosing a different folder
> adds a second notebook rather than merging two into one. Three projects in
> three folders are three notebooks, and the one you switch away from is still
> there under its name.
>
> **Open a notebook on a computer that does not have it.** Install Plume, sign
> in, and the vault panel lists what you already have. **Open here** asks where
> it should go, makes the folder, and downloads what is in it. That folder is
> then your vault on that machine, syncing both ways like any other.
>
> **1.3.0 hides the Markdown syntax while you are not in it.**
>
> **Live preview goes a word at a time.** Until now, the block you were editing
> was raw Markdown: every `**`, every `(url)`, on show while you typed. Now the
> markers go when the caret leaves what they mark, and come back when it
> returns — so a bold word is bold, a link is its own text, and a heading keeps
> its size, while you are still typing Markdown into the same file. It works for
> bold, italics, strikethrough, inline code, links, images and headings.
>
> A heading is the one case with a rule of its own. Live preview opens one block
> at a time and a heading is a single line, so revealing the `#` whenever the
> caret was in the heading would mean revealing it the moment you clicked one.
> It comes back when the caret is in the `#` itself: type the words and the
> heading stays a heading, click to the far left when you want to change its
> level.
>
> What is saved has not changed. The hiding is drawn over the text, never a
> rewrite of it, and the file on disk is the Markdown you typed, exactly. `Ctrl+E`
> still shows the whole file as plain text, unchanged, and **Reading settings →
> Live preview** still turns the whole thing off.
>
> **Open folder now shows you the folder.** On the welcome screen it chose a
> folder, filled the tree and then showed nothing at all: the sidebar is tucked
> away on that screen, and the welcome screen is the only place the button lives.
> The folder *was* being remembered, so it turned up on the next launch with a
> document open, which made it look intermittent rather than broken. The sidebar
> now stays where it is when a folder is open.
>
> **1.2.0 adds live preview, and a button for opening a folder of notes.**
>
> **Live preview.** Click a paragraph and it becomes the Markdown it was
> written as, right where it sits — the stars around **bold**, the brackets
> around a link — while the rest of the page stays rendered, so nothing moves
> under you. Click somewhere else and it is a paragraph again. A list, a table
> or a code block opens whole, as the one thing it is; diagrams, maths blocks
> and images stay rendered, so a stray click cannot replace a diagram with its
> source. Arrow keys carry on into the next block, and clicking past the end of
> the document starts a new paragraph there. Editing a block replaces that
> block's own lines and passes the rest of the file through exactly as it was.
> It is on by default — **Reading settings → Live preview** turns it off — and
> `Ctrl+E` still shows the whole file as plain text when that is what you want.
>
> **Open folder** sits beside *Open file* on the welcome screen, and in
> **⋯ → Open folder…** once a document is open. Pick a folder of notes and the
> sidebar roots itself there and stays there; opening a note inside it reveals
> the file in the tree rather than re-rooting on the note's own folder. Plume
> remembers the folder, so it is waiting the next time you open the app.
> **Close folder** lets it go.
>
> **Typing one way no longer loses the other.** Live preview and the whole-file
> editor write into the same text, so `Ctrl+E` in the middle of a sentence
> keeps it, the reading view shows your unsaved edits rather than the last
> saved version, and `Esc` goes back to reading without throwing anything away.
> Re-reading the file from disk (`F5`) now asks first instead of discarding
> unsaved work.
>
> **1.2.0 prepares for the repository moving to its own organisation.** The
> updater accepted release downloads from one repository path, baked in at
> build time. Plume is moving to github.com/Plume-MD, and after that move
> GitHub answers an older copy of Plume with URLs under the new name — which
> that copy would have refused, stopping its own updates for good. This release
> accepts both, so the move costs nobody an update. **If you are on 1.1.0 or
> earlier, take this one before the move.**
>
> **1.1.0 adds Git sync, and four colour palettes.**
>
> **Git sync** keeps a folder of notes in a Git repository: pull what changed
> elsewhere, commit what changed here, push. It is in **⋯ → Git sync…**, and it
> is part of having a Plume Vault account. Plume never asks for a token and
> never stores one — it drives the Git already on your machine, so your
> credentials stay in your credential helper or SSH agent, and conflicts,
> submodules, LFS and signing behave exactly as they do in your terminal.
>
> **Starless, Greenwood, Commit and Lapis** sit beside Plume's own under
> **Reading settings → Palette**. A palette recolours whichever of light or dark
> is in force rather than replacing that choice, so Auto still follows the
> system inside every one. The same five are on the website and the web vault.
>
> **1.0.3 added four colour palettes.** Starless, Greenwood, Commit and Lapis
> sit beside Plume's own under **Reading settings → Palette**. A palette
> recolours whichever of light or dark is in force rather than replacing that
> choice, so Auto still follows the system inside every one of them. The same
> five are on the website and the web app, in the footer. They are derived from
> four MIT-licensed Obsidian community themes, credited in the README.
>
> **1.0.2 fixed the updater, which could not install an update.**
> "Install and restart" started the install *and* a second download at the same
> time, and the second one deleted the installer the first had just handed to
> Windows. Nothing was installed, Plume reopened on the old version, and
> offered the same update again — a loop with no way out of it.
>
> **If you are on 1.0.0 or 1.0.1, updating from inside Plume will not work,**
> because the broken updater is the one you are running. Download 1.0.2 from
> [plume-md.com/download](https://plume-md.com/download.html) and run it over
> the top — your files and settings are untouched. Updating from inside Plume
> works again from 1.0.2 onward.
>
> **1.0.1 fixed folder sync on a large notebook.** Syncing stopped partway
> through and reported a number of failures with no reason. The vault asks a
> caller to slow down after six hundred requests a minute; a thousand documents
> sent as fast as the network allows tripped that a few hundred in, and
> everything after it failed. Sync now paces itself and waits when asked, plans
> against the 100 MB quota up front, and says *why* when something is left out.

Plume is a feather-light Markdown viewer. Double-click a `.md` file and it opens
straight into a clean reading view: no workspace to import, no project to set
up, no editor chrome.

Windows, macOS (Apple silicon and Intel) and Linux. Free, and open source.

---

## What it does

### Opens the file you clicked

Plume registers itself for `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`,
`.mdwn`, `.mdtxt` and `.mdtext`. A second file opens in a new window of the
already-running app, so there is no cold start. Make it the default for `.md`
once and every note opens in a calm, distraction-free window.

### Reads Obsidian notes properly

`[[wiki links]]`, `![[embeds]]` and section transclusion, callouts including the
foldable `> [!warning]-` kind, `==highlights==`, `#tags`, `%%comments%%`, block
ids and front-matter Properties — rendered the way Obsidian renders them, and
resolved across the whole vault. For a note that really is inside an Obsidian
vault, **⋯ → Open in Obsidian** hands it over.

Everything GitHub-flavoured works too: tables, task lists, footnotes, definition
lists, emoji shortcodes, syntax highlighting, KaTeX maths and Mermaid diagrams.

### Edits when you ask it to

Click a paragraph and it becomes editable where it sits, with the rest of the
page still rendered. Inside it, the Markdown markers get out of the way:
`**bold**` reads as bold until the caret is in the word, and then the stars are
back to be edited. Press the pencil, or `Ctrl+E`, and the whole file shows as
plain text instead. Either way there is no hidden formatting model — what is
saved is the Markdown you typed. `Ctrl+S` saves. `Esc` goes back to reading.

Plume is a reader first, so editing is a mode you turn on rather than the state
you are always in. The rules it keeps:

- **Nothing is written until you ask.** Typing changes nothing on disk.
- **An unsaved change is never thrown away silently.** A dot marks it, and
  leaving asks first.
- **A file changed elsewhere cannot overwrite your unsaved work.** Plume tells
  you, and you choose.
- Tab indents, Shift+Tab outdents, Enter continues a list.

`Ctrl+Shift+E` hands the file to VS Code, Cursor or your system editor.

### Keeps a folder in sync, if you want

Create a free account and you get a **100 MB vault**. There is no card, no trial
and no paid tier.

Choose one folder and Plume keeps everything in it — notes, images and
sub-folders — in your vault by itself while you are signed in. It watches the
folder while Plume is open and checks again every few minutes, so edits made in
any editor go up on their own. Your folder stays exactly where it is; nothing is
moved or renamed.

- **Only documents and images are ever uploaded.** Markdown, text, CSV, JSON,
  YAML, and PNG, JPEG, GIF, WebP and AVIF. Programs, installers and archives are
  refused by an allow-list and stay on your computer. This is why a 1.5 GB
  notebook can be perfectly happy in a 100 MB vault — most of it never leaves.
- **Folders are kept.** `Projects/Plume.md` arrives as `Projects/Plume.md`.
- **Nothing is flattened.** Each upload carries the revision this machine last
  saw. If the vault copy changed on another computer meanwhile, Plume refuses
  the write and asks which copy to keep.
- **Read it anywhere** at [plume-md.com](https://plume-md.com/app.html),
  straight in a browser.
- Pausing or stopping sync deletes nothing.

Everything else Plume does works with no account at all. The vault is entirely
opt-in.

### Gives an assistant a memory

Plume Vault ships an **MCP server**. Create an API token, point Claude Code,
Codex or any MCP client at it, and it can keep project decisions, notes and
running logs somewhere that is still there next week — and that you can open in
Plume on any of your machines. Eight tools: list, read, write, append, search
and delete documents, plus the vault graph and storage status.

The notes are plain Markdown. Nothing is proprietary, and a token can be revoked
in one click.

### The rest

- A sidebar with the folder tree (or your whole vault) and an outline of
  headings.
- A graph of how your documents link to each other.
- Live reload when the file changes on disk — same scroll position, same spot on
  the page.
- Find in page with next, previous and a match count. Back and forward between
  linked notes.
- Light, dark and system themes, plus text size, reading width and font
  settings.
- Print and export to PDF, on white paper, with a real PDF outline built from
  your headings.
- Updates that ask first: Plume tells you when a new version is out and installs
  it when you say so.
- Nine languages on the website, following your browser.

---

## Safe by default

Documents are sanitised, scripts never run, and links never launch programs. A
note cannot make Plume pull files off other computers on your network. Plume
saves Markdown and text and nothing else, so a flaw in the renderer cannot
overwrite a shell profile or a script on your `PATH`.

Everything that touches the network happens in Plume's main process, so the
window that renders your documents never has network access and keeps its full
sandbox. Your vault password is hashed with scrypt; the account token is
encrypted at rest with your system keychain.

Every release publishes `SHA256SUMS.txt`, and an automatic update is checked
against it before it is allowed to run. A download that does not match is
deleted rather than executed.

**Plume is not code-signed.** Those checksums come from the same release as the
download itself, so they protect you against a corrupted or swapped download —
not against someone who controls the release. Signing is the fix, and it is
next. Until then, Windows SmartScreen and macOS Gatekeeper will both warn you on
first launch; the instructions below say how to proceed.

### Before release, 1.0.0 was audited

Two independent static audits were run over the desktop app, the website, the
MCP server and the vault API. Everything they found that was real has been
fixed, including:

- A document crafted to defeat the link parser could freeze the whole vault
  service — one upload, indefinitely. Every pattern is now bounded, and seven
  pathological inputs are held to a time budget by a regression test.
- A write landing at the same moment as a password change could put the old
  password back. Account records now take part in the same compare-and-swap the
  rest of the storage uses, proven by a test that runs twelve writes against a
  password change on a real database.
- The password-reset endpoint answered a registered address more slowly than an
  unregistered one, which told you which was which. It answers both the same way
  now.

What they could not find is worth saying too: no way for one account to read or
write another's documents, no injection into the database, no path out of a
vault, and no way to forge a session.

---

## Downloads

| System | File |
|---|---|
| Windows 10 / 11, 64-bit | `Plume-Setup-1.4.1.exe` |
| macOS, Apple silicon | `Plume-1.4.1-mac-arm64.dmg` (or `.zip`) |
| macOS, Intel | `Plume-1.4.1-mac-x64.dmg` (or `.zip`) |
| Linux, x64 | `Plume-1.4.1-linux-x86_64.AppImage` or `Plume-1.4.1-linux-amd64.deb` |

Or get them from [plume-md.com/download](https://plume-md.com/download.html),
which offers the right build for your system.

Checksums for every file are in `SHA256SUMS.txt` on the
[release](https://github.com/Ishan-Nim/plume/releases/tag/v1.4.1).

## Installing

### Windows

Run `Plume-Setup-1.4.1.exe`. Plume installs for all users in
`C:\Program Files\Plume`, so Windows asks for administrator approval once. The
installer is not code-signed yet: if SmartScreen shows "Windows protected your
PC", choose **More info → Run anyway**.

To make Plume the default for `.md`, right-click a Markdown file and choose
**Open with → Choose another app → Plume → Always**, or use
**⋯ → Make Plume the default for .md** inside Plume.

### macOS

Open the DMG and drag Plume into Applications. Plume is not notarized by Apple,
so macOS blocks the first launch. Use either of these:

- Right-click (or Control-click) Plume in Applications, choose **Open**, then
  **Open** again. On macOS 15 or later, try to open it once, then go to
  **System Settings → Privacy & Security** and click **Open Anyway**.
- Or run `xattr -cr /Applications/Plume.app` in Terminal.

### Linux

- **AppImage:** make it executable with
  `chmod +x Plume-1.4.1-linux-x86_64.AppImage`, then run it.
- **Debian / Ubuntu:** `sudo apt install ./Plume-1.4.1-linux-amd64.deb`. On
  Ubuntu 24.04 and later, use the `.deb`: it installs the AppArmor profile that
  Electron apps need to start there.

---

## Known limits

Said plainly, because finding out later is worse.

- **Not code-signed.** See above.
- **No email verification.** An account is created the moment you sign up.
- **No two-factor authentication.**
- **Password reset needs a mail provider configured.** The flow is built and
  deployed; until a key is set, `/auth/forgot` says so rather than pretending.
- **A vault holds 100 MB and 2,000 documents**, and a single file 10 MB. A
  folder larger than that syncs what fits and tells you what is waiting.
- **The desktop app is English only.** The website is in nine languages.

## Reporting a problem

[github.com/Ishan-Nim/plume/issues](https://github.com/Ishan-Nim/plume/issues).

For anything security-related, please open a private advisory rather than a
public issue.

---

Plume is free software by [Ishan Nim](https://github.com/Ishan-Nim), released
under the MIT licence. Not affiliated with Obsidian.

---

## Who makes it

Plume is written and maintained by **Ishan Nim** — [personal site and blog](https://ishan-nim-portfolio-74tdd.ondigitalocean.app) · [GitHub](https://github.com/Ishan-Nim) · [CyberCrew](https://cybercrew.co.jp).

Full credits, including the themes the colour palettes are derived from and every library that ships inside Plume, are in [docs/CREDITS.md](docs/CREDITS.md).
