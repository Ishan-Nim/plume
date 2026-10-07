Plume is a feather-light Markdown viewer. Double-click a `.md` file and it opens straight into a clean reading view: no vault, no project, no editor chrome.

**1.3.1 fixes a bug in 1.3.0 that could overwrite the wrong document, and closes everything a security audit of 1.3.0 turned up. If you edit in Plume, please update.**

## Fixed in 1.3.1

### Editing could overwrite a different document

In 1.3.0, editing one document and then opening another — from the file tree, with Back, or with `Ctrl+O` — left the editor open on the first document while the window moved to the second. Saving then wrote the first document's text over the second one, with a cheerful "Saved" and no warning. The second document's contents were gone.

A save is now tied to the document the editor actually opened, and is refused if the window has moved on. Opening anything else while there are unsaved changes asks first.

### From the security audit

- **The updater verified an installer and then stopped owning it.** The verified file sat at a predictable path in the shared temp folder until you pressed Install, and nothing re-checked it. Anything running as you could swap it in between — and because the installer asks for administrator rights, that was a way to gain them. The download now goes to a directory created fresh for it, refuses to open anything already there, and is hashed again immediately before it runs.
- **Only documents are written back to disk.** Plume opens many kinds of text file; it will now only ever *save* Markdown and text. A shell profile, a `.bashrc`, a `.bat` on your PATH or an editor config could previously be overwritten through a flaw in the document renderer.
- **Redirects during an update are checked at every hop**, rather than being followed wherever they lead.
- **Reaching a `\server` path** now goes through the same credential check everywhere, rather than on most paths but not all.
- **A name typed into the vault panel** cannot step outside your own vault, and syncing a folder cannot be pointed at one you did not choose.
- **The MCP server** refuses to send your token to a plain-HTTP address, and a single malformed line no longer stops it answering.
- **A development environment variable** that redirects Plume to another server is ignored in the packaged app — it is where your password goes.

Still true, and worth saying plainly: Plume is not code-signed, so the checksums that make an update safe come from the same place as the download itself. That protects against a corrupted or swapped download; it does not protect against someone who controls the release itself. Signing is the fix, and it is next.

## New in 1.3.0

### Editing

Press the pencil, or `Ctrl+E`, and the document becomes editable — the raw Markdown, in a plain editor, with no hidden formatting model. `Ctrl+S` saves. `Esc` goes back to reading.

Plume is still a reader first, so editing is a mode you turn on rather than the state you are always in. The rules it keeps:

- **Nothing is written until you ask.** Typing changes nothing on disk.
- **An unsaved change is never thrown away silently.** The title shows a dot while there is unsaved work, and leaving edit mode asks first.
- **A file changed elsewhere cannot overwrite your unsaved work.** If something else writes to the document while you are editing it, Plume tells you and lets you choose which version to keep.
- Tab indents, Shift+Tab outdents, and Enter continues a list the way you would expect.

`Ctrl+Shift+E` still hands the file to VS Code or your system editor.

### Updates

Plume looks for a new release shortly after it starts, and offers it in a bar at the top of the window. Nothing is downloaded until you press Install, and nothing is installed without you asking.

Every release now publishes `SHA256SUMS.txt`, and the installer is checked against it before it is allowed to run. A download that does not match is deleted rather than executed — which is what makes an automatic update safe to accept from an app that is not yet code-signed.

On macOS and Linux the bar offers the download page instead: an unsigned macOS app cannot replace itself, and Linux packages belong to your package manager.

**Not now** means not again for that version.

## New in 1.2.0

### Sync a folder, not one file at a time

Choose one folder and Plume keeps everything in it — notes, images and sub-folders — in your vault by itself, while you are signed in. It watches the folder while Plume is open and checks again every few minutes, so edits made in any editor go up on their own.

Only documents and images are ever uploaded: Markdown, text, CSV, JSON, YAML, and PNG, JPEG, GIF, WebP and AVIF. Programs, installers, archives and everything else are refused by an allow-list and stay on your computer. Pausing or stopping deletes nothing.

### Folders are kept

A note now arrives in the vault under the folder it lives in. `Projects/Plume.md` stays `Projects/Plume.md`.

Before this, every document was sent up under its bare file name, so two notes called `README` in different folders became one — and syncing the second replaced the first. If you synced a notebook on 1.1, sync it again on 1.2 and it will arrive with its structure intact.

### The vault moved to the foot of the sidebar

Signing in is not a document view, so it is no longer a tab beside Files and Outline. There is a **Plume Vault** bar at the bottom of the sidebar instead, which always shows what sync is doing, and opens the panel when you click it.

## Fixed in 1.1.1

- **Syncing a second document could overwrite the first.** The Vault panel offered the name of whichever document was open when it first drew, rather than the one open now — so syncing a second document sent it up under the first one's name and replaced it in the vault. The panel now always names the document you are looking at, and it asks before writing over a name something else already uses.
- **The graph no longer prints "sync some documents…" across a graph that is already drawn.**

## Plume Vault (new in 1.1)


Open **⋯ → Plume Vault**, create an account with an email and a password, and you get 100 MB of storage. It is free: there is no card, no trial and no paid tier.

- **Sync the open document** to the vault with one click, and pull it down on another computer.
- **Read your documents anywhere** at [plume-md.com](https://plume-md.com/app.html), straight in a browser.
- **Nothing is flattened.** Each upload carries the revision this machine last saw. If the vault copy changed on another computer in the meantime, Plume refuses the write and asks which copy to keep — it can save the vault's version beside yours so neither is lost.
- **Private by design.** Passwords are hashed with scrypt, documents sit in private storage no one else can list, and the account token is encrypted at rest with your system keychain. All network calls happen in Plume's main process, so the window that renders your documents never touches the network and keeps its full sandbox.
- Everything Plume did before still works with no account at all. The vault is entirely opt-in.

## Fixed in 1.0.1

- **macOS:** a link in a document can no longer launch an app. App bundles are folders, and folder links used to open without asking. Now only plain folders open; apps are only shown in Finder.
- **Linux:** the window's minimise, maximise and close buttons no longer cover the Find, Reading and More buttons.
- **macOS:** a File menu with Open and New Window, which works even after the last window is closed.
- **Copy buttons:** a document can no longer lay its own content over a real code block, so what you see is what the Copy button copies.
- **Large documents (over about 250 KB):** live reload, F5 and Back/Forward return you to where you were reading.
- **Obsidian comments:** a `%%comment` that starts mid-line and ends at the start of a later line no longer hides the text after it.
- **Wiki links:** they now ignore letter case on macOS and Linux, as Obsidian does, and new notes are found right away.
- **Print and PDF from the dark theme:** Mermaid diagrams are redrawn in the light theme for paper.
- **Theme switching:** quickly switching theme no longer leaves diagrams in the wrong theme. Diagrams can no longer draw over Plume's own toolbar.
- **File tree:** opening a note inside a hidden folder (such as `.github`) shows it correctly.
- **Drag and drop:** extensionless text files such as `README` and `CHANGELOG` open again.
- **Moving the folder:** moving the open note's folder away (for example to the Recycle Bin) shows the "moved or deleted" notice.
- **Hardening:** the installed app refuses Chromium's command-launcher switches.

## Highlights

- Opens `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.mdtxt` and `.mdtext` files. Another file opens in a new window of the running app, with no cold start.
- Reads Obsidian notes: `[[wiki links]]`, `![[embeds]]` and section transclusion, callouts, `==highlights==`, `#tags`, `%%comments%%`, block ids and front-matter Properties.
- GitHub-flavoured Markdown: tables, task lists, footnotes, syntax highlighting, KaTeX math and Mermaid diagrams.
- A sidebar with the folder tree (or the whole vault) and an outline of headings.
- Live reload when the file changes on disk, find in page, and back/forward between linked notes.
- Light, dark and system themes, plus text size, reading width and font settings.
- Print and Export to PDF.
- Safe by default: documents are sanitised, scripts never run, links never launch programs, and a document cannot make Plume load files from other computers on your network.

## Downloads

| System | File |
|---|---|
| Windows 10 / 11, 64-bit | `Plume-Setup-1.3.1.exe` |
| macOS, Apple silicon | `Plume-1.3.1-mac-arm64.dmg` (or `.zip`) |
| macOS, Intel | `Plume-1.3.1-mac-x64.dmg` (or `.zip`) |
| Linux, x64 | `Plume-1.3.1-linux-x86_64.AppImage` or `Plume-1.3.1-linux-amd64.deb` |

Or get them from [plume-md.com/download](https://plume-md.com/download.html), which offers the right build for your system.

## Installing

### Windows

Run `Plume-Setup-1.3.1.exe`. Plume installs for all users in `C:\Program Files\Plume`, so Windows asks for administrator approval once. The installer is not code-signed yet: if SmartScreen shows "Windows protected your PC", choose **More info → Run anyway**.

To make Plume the default for `.md`, right-click a Markdown file and choose **Open with → Choose another app → Plume → Always**, or use **⋯ → Make Plume the default for .md** inside Plume.

### macOS

Open the DMG and drag Plume into Applications. Plume is not notarized by Apple, so macOS blocks the first launch. Use either of these:

- Right-click (or Control-click) Plume in Applications, choose **Open**, then **Open** again. On macOS 15 or later, try to open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- Or run `xattr -cr /Applications/Plume.app` in Terminal.

### Linux

- **AppImage:** make it executable with `chmod +x Plume-1.3.1-linux-x86_64.AppImage`, then run it.
- **Debian / Ubuntu:** `sudo apt install ./Plume-1.3.1-linux-amd64.deb`. On Ubuntu 24.04 and later, use the `.deb`: it installs the AppArmor profile that Electron apps need to start there.
