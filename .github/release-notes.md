Plume is a feather-light Markdown viewer. Double-click a `.md` file and it opens straight into a clean reading view: no workspace to import, no project to set up, no editor chrome.

**1.8.0 gives them somewhere to live.**

A folder of Markdown is not a vault, and Plume used to be vague about the
difference. Opening a folder was most of the way to syncing it: sign in, pick a
folder, and that one folder was *the* synced folder — one per account, chosen
once, and changing it meant explaining to yourself what had happened to the
last one.

So a folder on disk is never silently a vault now. You open one and it stays
exactly what it was: editable, untouched, and unable to sync. Making it a vault
is a thing you choose, and it writes a `.plume/` folder into it — an id, its
own settings, and an index of what is in it. That index is what backlinks, the
graph and search across a whole notebook are built from. Delete `.plume/` and
it is a folder again with every note where it was.

**A vault that never leaves this computer is a finished state.** It works
offline, forever, with no account: notes, backlinks, search, the graph. It uses
none of your storage, and nothing nags you to connect it to anything.

**Linking is a second, separate choice, made per vault.** Sign in, pick a
vault, and *Link to my account* — then it syncs on every save, on every
computer you sign in on. Signing in on its own links nothing and uploads
nothing. On a second computer, your vaults are listed and *Put it here*
downloads one into a folder Plume makes for it.

**You can have as many vaults as you like.** They sync at the same time, and
two vaults holding a note of the same name never meet. The limit is on bytes in
the cloud — one pool shared across every linked vault — not on how many vaults
organise them. A hundred small vaults and one large one look the same to the
meter, and local-only vaults and loose folders cost nothing at all.

**Switching between them is Ctrl+Shift+V**, or the button beside the vault name
at the foot of the sidebar: every vault this computer knows about, the one you
are in marked, and a filter once there are more than a handful. A new window
opens on the same list rather than on a file chooser.

**Running out of room no longer stops you writing.** The save still happens —
it is your disk — and only the upload waits, recorded so it is still waiting
after a restart.

**When the same note changed in two places, both are kept.** The copy from the
cloud lands beside yours as `idea (conflict 2026-10-09 LAPTOP).md`, named for
the day and the machine, because a conflict from a laptop last week and one
from this desktop this morning are different things. Nothing is overwritten to
settle a disagreement, and a note deleted elsewhere goes to the vault's own
trash rather than off the disk.

**Unlinking is not deleting.** It stops the syncing and keeps both copies — the
folder here and the vault in your account — so the cloud copy goes on using
space until you say otherwise. Deleting a vault from your account is its own
named action, the only one that frees storage, and it leaves the copies on your
computers exactly where they are.

If you were syncing a folder before this, it becomes a linked vault on first
launch — same folder, same name, same documents. Nothing to redo.
