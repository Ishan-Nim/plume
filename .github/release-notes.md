Plume is a feather-light Markdown viewer. Double-click a `.md` file and it opens straight into a clean reading view: no vault, no project, no editor chrome.

**1.0.1 fixes problems found in 1.0.1 shortly after release. Please update, especially on macOS and Linux.**

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
| Windows 10 / 11, 64-bit | `Plume-Setup-1.0.1.exe` |
| macOS, Apple silicon | `Plume-1.0.1-mac-arm64.dmg` (or `.zip`) |
| macOS, Intel | `Plume-1.0.1-mac-x64.dmg` (or `.zip`) |
| Linux, x64 | `Plume-1.0.1-linux-x86_64.AppImage` or `Plume-1.0.1-linux-amd64.deb` |

## Installing

### Windows

Run `Plume-Setup-1.0.1.exe`. Plume installs for all users in `C:\Program Files\Plume`, so Windows asks for administrator approval once. The installer is not code-signed yet: if SmartScreen shows "Windows protected your PC", choose **More info → Run anyway**.

To make Plume the default for `.md`, right-click a Markdown file and choose **Open with → Choose another app → Plume → Always**, or use **⋯ → Make Plume the default for .md** inside Plume.

### macOS

Open the DMG and drag Plume into Applications. Plume is not notarized by Apple, so macOS blocks the first launch. Use either of these:

- Right-click (or Control-click) Plume in Applications, choose **Open**, then **Open** again. On macOS 15 or later, try to open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- Or run `xattr -cr /Applications/Plume.app` in Terminal.

### Linux

- **AppImage:** make it executable with `chmod +x Plume-1.0.1-linux-x86_64.AppImage`, then run it.
- **Debian / Ubuntu:** `sudo apt install ./Plume-1.0.1-linux-amd64.deb`. On Ubuntu 24.04 and later, use the `.deb`: it installs the AppArmor profile that Electron apps need to start there.
