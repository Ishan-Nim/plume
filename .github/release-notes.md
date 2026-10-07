Plume is a feather-light Markdown viewer. Double-click a `.md` file and it opens straight into a clean reading view: no vault, no project, no editor chrome. This is the first public release, for Windows, macOS and Linux.

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
| Windows 10 / 11, 64-bit | `Plume-Setup-1.0.0.exe` |
| macOS, Apple silicon | `Plume-1.0.0-mac-arm64.dmg` (or `.zip`) |
| macOS, Intel | `Plume-1.0.0-mac-x64.dmg` (or `.zip`) |
| Linux, x64 | `Plume-1.0.0-linux-x86_64.AppImage` or `Plume-1.0.0-linux-amd64.deb` |

## Installing

### Windows

Run `Plume-Setup-1.0.0.exe`. Plume installs for all users in `C:\Program Files\Plume`, so Windows asks for administrator approval once. The installer is not code-signed yet: if SmartScreen shows "Windows protected your PC", choose **More info → Run anyway**.

To make Plume the default for `.md`, right-click a Markdown file and choose **Open with → Choose another app → Plume → Always**, or use **⋯ → Make Plume the default for .md** inside Plume.

### macOS

Open the DMG and drag Plume into Applications. Plume is not notarized by Apple, so macOS blocks the first launch. Use either of these:

- Right-click (or Control-click) Plume in Applications, choose **Open**, then **Open** again. On macOS 15 or later, try to open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- Or run `xattr -cr /Applications/Plume.app` in Terminal.

### Linux

- **AppImage:** make it executable with `chmod +x Plume-1.0.0-linux-x86_64.AppImage`, then run it.
- **Debian / Ubuntu:** `sudo apt install ./Plume-1.0.0-linux-amd64.deb`. On Ubuntu 24.04 and later, use the `.deb`: it installs the AppArmor profile that Electron apps need to start there.
