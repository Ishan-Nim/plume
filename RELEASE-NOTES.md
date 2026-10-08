# Plume 1.0.2

**Released 8 October 2026** · [plume-md.com](https://plume-md.com) · MIT licence

> **1.0.2 fixes the updater, which could not install an update.**
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

Press the pencil, or `Ctrl+E`, and the document becomes editable — the raw
Markdown, in a plain editor, with no hidden formatting model. `Ctrl+S` saves.
`Esc` goes back to reading.

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
| Windows 10 / 11, 64-bit | `Plume-Setup-1.0.2.exe` |
| macOS, Apple silicon | `Plume-1.0.2-mac-arm64.dmg` (or `.zip`) |
| macOS, Intel | `Plume-1.0.2-mac-x64.dmg` (or `.zip`) |
| Linux, x64 | `Plume-1.0.2-linux-x86_64.AppImage` or `Plume-1.0.2-linux-amd64.deb` |

Or get them from [plume-md.com/download](https://plume-md.com/download.html),
which offers the right build for your system.

Checksums for every file are in `SHA256SUMS.txt` on the
[release](https://github.com/Ishan-Nim/plume/releases/tag/v1.0.2).

## Installing

### Windows

Run `Plume-Setup-1.0.2.exe`. Plume installs for all users in
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
  `chmod +x Plume-1.0.2-linux-x86_64.AppImage`, then run it.
- **Debian / Ubuntu:** `sudo apt install ./Plume-1.0.2-linux-amd64.deb`. On
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
