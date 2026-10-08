# Films

Ready-to-upload cuts of the Plume tour. All three are the same 34-second film —
the real application, driven and recorded by `scripts/film-app.js` — reframed
for where it is going.

No audio on any of them, which is correct: every feed autoplays muted, and the
headline is baked into the frame so the film reads without sound.

| File | Size | Shape | Where it is for |
|---|---|---|---|
| `plume-linkedin-square.mp4` | 1080 × 1080 | 1:1 | LinkedIn, Instagram feed, Mastodon |
| `plume-linkedin-portrait.mp4` | 1080 × 1350 | 4:5 | LinkedIn and Instagram, where 4:5 takes the most feed height |
| `plume-tour-landscape.mp4` | 1280 × 832 | ~3:2 | The website hero, YouTube, a slide, a README |

The two social cuts carry the headline above the window and `plume-md.com`
below it, so somebody scrolling past with the sound off still learns what it is
and where to get it. The landscape cut is the bare film, with nothing drawn over
it.

## Which to post where

**LinkedIn** — use the **portrait** cut. It occupies more of the feed than the
square one and considerably more than the landscape. There is a post written to
go with it in [`../announcements/linkedin-plume-1.1.md`](../announcements/linkedin-plume-1.1.md).

**X, Mastodon, Bluesky** — the **square** cut. Those timelines crop tall video.

**A README, a slide, YouTube** — the **landscape** cut.

## The shorter clips

The eight how-to clips are not duplicated here, because they are already
published and served from the website:

| Clip | Shows |
|---|---|
| `reading` | Scrolling a document: properties, callout, table, code, diagram |
| `outline` | The outline, and jumping from it to a heading |
| `find` | Typing in the find bar and stepping through matches |
| `themes` | Each palette in turn, then dark |
| `editing` | The editor opening and closing |
| `git` | The Git sync panel, and one press of Sync now |
| `vault` | The vault panel with a synced folder |
| `graph` | The vault graph settling, fitted and re-arranged |

Each is at `https://plume-md.com/assets/clips/<name>.mp4` (and `.webm`, and
`.jpg` for the poster), or in the repository under `site/assets/clips/`.

## Making more of them

`scripts/film-clips.js` records one clip per section; `scripts/film-app.js`
records the long tour. Both drive the real application rather than a mockup.
The technique — and the several ways it goes wrong — is written down in
[`.claude/agents/plume-filmmaker.md`](../../.claude/agents/plume-filmmaker.md).

To re-cut the social versions after re-filming the tour, the ffmpeg recipe is a
`scale`, a `pad` onto a `#0f0f13` canvas, and four `drawtext` layers. Keep
`-pix_fmt yuv420p` and even dimensions, or Safari and most Android players show
a black rectangle.
