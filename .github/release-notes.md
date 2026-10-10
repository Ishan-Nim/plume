Plume is a feather-light Markdown viewer. Double-click a `.md` file and it opens straight into a clean reading view: no workspace to import, no project to set up, no editor chrome.

**This is a pre-release.** 1.0 is the number Plume will carry when it is out; until then the builds are numbered from zero.

**0.0.4 fixes dark mode in the web view, and counts vaults rather than people.**

Dark arrives two ways and they are not the same selector: chosen, which marks the page, and inherited from the system, which marks nothing at all. The web view only had a rule for the second, so pressing the moon on a light machine turned the page around the note dark and left the note white. Every palette and the base theme are now written for both, and for choosing light on a dark machine as well.

The counter on the home page said "vaults created" and counted sign-ups. A vault is now counted when the first document lands under a name that was not there before, and the stored number can be corrected from the data.

**0.0.3 put your notes in a browser tab.**

A linked vault now opens at [plume-md.com/notes.html](https://plume-md.com/notes.html): the vaults in your account on the left, the documents in the one you are looking at beneath them, and a note in the middle. It is rendered by the same pipeline the desktop app uses — the same wiki links, tables, callouts, highlights, task lists, maths and syntax colouring, from the same source files — so a note reads the same in both.

**Press Edit for the Markdown and Ctrl+S to save it back.** A save carries the revision the note was opened at, so if the same note changed somewhere else in the meantime the write is refused and says so, rather than writing over work that was not on screen. `Ctrl+K` searches, `Ctrl+E` toggles the editor, and the address bar carries the note you are on.

**It shows cloud vaults, and only those.** A browser cannot reach the folders on your disk, so loose folders and local-only vaults are not there — they were never uploaded. Link a vault from the desktop app and it appears; unlink it and it stops.

**Notes live in vaults.** A folder on disk is never silently one. Making it a vault writes a `.plume/` folder into it: an id, its own settings, and an index of what is in it. Delete `.plume/` and it is a folder again with every note where it was.

**Making one asks what it is called before it asks where it goes,** and Plume makes the folder with the name you typed. A new vault opens on a `Welcome.md` rather than on nothing.

**It opens where you left off** — the vault you were last in, on the note you were last reading, remembered inside the vault and never leaving the computer that wrote it.

**As many vaults as you like.** The limit is bytes in the cloud — one pool shared across every linked vault — not how many vaults organise them. Local-only vaults and loose folders cost nothing at all.
