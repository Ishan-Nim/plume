Plume is a feather-light Markdown viewer. Double-click a `.md` file and it opens straight into a clean reading view: no workspace to import, no project to set up, no editor chrome.

**This is a pre-release.** 1.0 is the number Plume will carry when it is out; until then the builds are numbered from zero, so that nobody mistakes a work in progress for a finished thing.

**Notes live in vaults.** A folder on disk is never silently one. You open a folder and it stays exactly what it was — editable, untouched, unable to sync. Making it a vault is a thing you choose, and it writes a `.plume/` folder into it: an id, its own settings, and an index of what is in it. That index is what backlinks, the graph and search across a whole notebook are built from. Delete `.plume/` and it is a folder again with every note where it was.

**Making one asks what it is called before it asks where it goes.** Plume makes the folder with the name you typed, and a line underneath says exactly which folder is about to appear. A new vault opens on a `Welcome.md` rather than on nothing. Claiming a folder of notes you already have writes nothing into it but the `.plume/` that makes the claim.

**It opens where you left off** — the vault you were last in, on the note you were last reading. Which note that is lives inside the vault and never leaves the computer that wrote it, so a laptop and a desktop on one vault each come back to their own place in it.

**As many vaults as you like.** The bar at the foot of the sidebar names the one you are in and lists the others, the one you are in ticked, with your account under them and the chooser under that. They sync at the same time, and two vaults holding a note of the same name never meet. The limit is on bytes in the cloud — one pool shared across every linked vault — not on how many vaults organise them. Local-only vaults and loose folders cost nothing at all.

**A vault that never leaves this computer is a finished state.** It works offline, forever, with no account: notes, backlinks, search, the graph. Linking one to an account is a second, separate choice, made per vault.
