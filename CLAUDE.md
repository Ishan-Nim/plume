# Plume — working rules

## "Update" means everywhere, not just here

When Ishan says **update**, **ship**, **release** or **push to production**, it
is never one platform. Every one of these is part of the same job, and none of
them is finished until all of them are:

| What | Where it lives | How it is updated |
|---|---|---|
| Version | `package.json` | bump it — patch for a fix, minor for a feature |
| Release notes | `RELEASE-NOTES.md`, `.github/release-notes.md` | the new version at the top, in Plume's voice |
| Windows app | `.github/workflows/release.yml` | a pushed `v*` tag builds and publishes it |
| macOS app | same workflow (`macos-latest`) | same tag — dmg and zip, x64 and arm64 |
| Linux app | same workflow (`ubuntu-latest`) | same tag — AppImage and deb |
| Website | `site/` (plume-md.com) | version strings, download links, feature copy, `site/assets/site.js` `VERSION` |
| Web view | `src/web/` → `site/assets/web.js` | `node scripts/build.js` emits it; it ships with the site, not with the app |
| Docs | `site/docs.html`, `README.md`, `docs/` | anything the change makes untrue |
| Backend | `E:\plume-vault` (private repo, DigitalOcean app **plume-md**) | `PLUME_VERSIONS` must list the new version, or every download link 404s |
| Ishan's own machine | `release/Plume-Setup-<version>.exe` | build it locally and install it, so he is on what he just shipped |

Two of those cannot be done from a terminal here, so say so plainly rather
than reporting the release as complete:

- **`PLUME_VERSIONS` on DigitalOcean** — Apps → plume-md → the `api`
  component → Settings → Environment Variables. Newest first, keep the
  previous one or two. Until this is changed, `/api/download?file=…` for the
  new version redirects to a GitHub 404.
- **Code signing** — see below.

Order that avoids a broken window for anyone: commit and push the code, push
the tag, wait for the workflow to publish the release, *then* add the version
to `PLUME_VERSIONS`, and only then let the site advertise it. The backend is
built to serve several versions at once for exactly this reason.

## Code signing

Plume is **not code-signed** on any platform yet. Windows installers show
SmartScreen; macOS builds are ad-hoc signed (`mac.identity: "-"`) and need
right-click → Open. The build is already wired for certificates — it needs
the certificates themselves, nothing more:

- **Windows:** set `CSC_LINK` (path or base64 of a `.pfx`) and
  `CSC_KEY_PASSWORD` in the environment, or in the workflow as repository
  secrets. electron-builder signs the installer and the executable.
  An OV certificate now needs a hardware token or a cloud signing service
  (Azure Trusted Signing, SSL.com eSigner), so CI signing means one of those;
  an EV certificate clears SmartScreen immediately, an OV one earns it.
- **macOS:** a Developer ID Application certificate in `CSC_LINK`, set
  `mac.identity` to it, `hardenedRuntime: true`, and notarise with
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Remove
  `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` from the workflow when they exist.
- **Linux:** nothing to sign; the AppImage and deb are checked by SHA256SUMS.

Until then, what makes an unsigned auto-update safe is `SHA256SUMS.txt` in
every release: the updater refuses to run an installer whose hash is not in it.
Do not weaken that.

## The rest

- Tests: `npm test` (unit) and the end-to-end runs under `test/e2e/`
  (`edit-flow.js`, `live-flow.js`, `new-note-flow.js`, `organise-flow.js`,
  `qa-flow.js`, `vault-flow.js`, `vault-sync-flow.js`, `sweep-flow.js`,
  `web-flow.js`) with
  `npx electron`. Run the ones a change touches before shipping it, and
  `sweep-flow.js` — which presses every control in the window — before any
  release. The vault runs and the sweep need a vault API that is never
  production: `node scripts/dev-server-memory.js` in `E:\plume-vault` serves
  one in memory on port 8098, with no bucket and no database.
- The web view (`src/web/`) imports the renderer's `markdown.js` and
  `enhance.js` rather than copying them, and `scripts/build.js` slices the
  document rules, the theme variables and the palettes out of
  `src/renderer/styles.css` into `site/assets/web-doc.css`. Change how a
  document renders or is coloured in one place and both follow. The markers in
  that stylesheet are load-bearing — the build fails without them.
- Prose — comments, release notes, site copy — is written the way the rest of
  the repository is written: plain, specific, no marketing. Say what something
  does and why it is that way.
- `CREDENTIALS.md` is never committed and never quoted into a transcript.
