# LinkedIn — Plume 1.1 announcement

Paste the body below into LinkedIn. It is written to be read on a phone: short
paragraphs, no preamble, the point in the first two lines before the "see more"
cut. Everything below the line is optional extra, including a shorter variant.

---

## Post

I built a Markdown reader, because nothing opened a `.md` file the way my photo
viewer opens a `.png`.

Every good Markdown app assumes you are starting a project. Import a vault.
Choose a workspace. Configure a theme. Fine if you are writing. Backwards if
somebody just sent you a README and you want to read it.

**Plume is the other half of that problem.** Double-click a `.md` file, a window
opens, the text is set properly, and nothing else is in the way.

It reads the Obsidian dialect — wiki links, callouts, transclusion, highlights,
tags, front matter — plus GitHub-flavoured Markdown, KaTeX maths and Mermaid
diagrams. There is an editor behind Ctrl+E when you want one.

What shipped in 1.1:

→ **Git sync.** Keep a folder of notes in a Git repository: pull, commit, push.
It drives the git already on your machine, so Plume never asks for a token and
never stores one — your credentials stay in your credential helper or SSH agent.

→ **Five colour palettes**, each with a light and a dark side. The theme and the
palette are separate choices, so Auto still follows your system inside any of
them.

→ **Plume Vault** — 100 MB free, optional, for reading your notes on another
machine.

Free, open source, MIT. Windows, macOS and Linux.

A note on the security of it, since that is my day job: every document is
sanitised before it renders, the renderer is sandboxed and isolated with
navigation blocked, every update is checked against a published checksum before
it is allowed to run, and I ran a full static and dynamic audit over it before
this release — findings, fixes and all, written up properly.

The honest caveats: it is young, and it is not code-signed yet, so Windows and
macOS will both warn you on first launch. Signing is next.

→ plume-md.com

#markdown #opensource #devtools #electron #notetaking

---

## Shorter variant, if the above feels long

I built a Markdown reader.

Every good Markdown app assumes you are starting a project — import a vault,
choose a workspace, configure a theme. Fine if you are writing. Backwards if
somebody just sent you a README.

Plume opens a `.md` file the way your photo viewer opens a `.png`. Double-click,
read, close.

Reads the Obsidian dialect, GitHub-flavoured Markdown, KaTeX and Mermaid. Git
sync and an optional 100 MB vault if you want your notes on another machine.
Free, open source, MIT, all three platforms.

Not code-signed yet, so expect a warning on first launch. That is next.

→ plume-md.com

#markdown #opensource #devtools

---

## Notes before posting

- **Attach something visual.** LinkedIn flattens text-only posts. The hero film
  at plume-md.com is the strongest asset — screen-record a few seconds of it, or
  use `site/assets/shots/palettes.png`, which shows all five palettes at once.
- **Do not put the link in the first comment.** That advice is years out of date
  and the current ranking does not punish an in-post link the way people claim.
- **Reply to every comment in the first hour.** That is the part that actually
  moves reach.
- Swap `plume-md.com` for a UTM link if you want to measure it.
