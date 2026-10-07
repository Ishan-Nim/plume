# Plume Vault — MCP server

Gives Claude Code, Codex or any MCP client a place to keep project memory, notes
and write-ups that survives between sessions and follows you between machines —
the same vault the [Plume](https://plume-md.com) app syncs to, and that you can
read in the app or in a browser afterwards.

## Setting it up

1. Create a free vault at [plume-md.com/app.html](https://plume-md.com/app.html).
2. Under **API tokens**, create one and copy it. It is shown once.
3. Add this to your MCP client's configuration:

```json
{
  "mcpServers": {
    "plume-vault": {
      "command": "node",
      "args": ["/path/to/plume/mcp/index.js"],
      "env": { "PLUME_TOKEN": "plm_your_token" }
    }
  }
}
```

Clone this repository and point `args` at `mcp/index.js` inside it — there is
nothing to install, the server has no dependencies. Once it is published to npm,
`npx -y @plume-md/vault-mcp` will work in its place.

In Claude Code that file is `~/.claude.json` (or a project `.mcp.json`).

## Tools

| Tool | Does |
|---|---|
| `list_notes` | Lists what is in the vault, optionally under one folder |
| `read_note` | Reads one document |
| `write_note` | Creates or replaces one |
| `append_note` | Adds to the end — safer than replacing, for a running log |
| `search_notes` | Searches the text of every document, returns matching lines |
| `delete_note` | Removes one |
| `vault_graph` | Shows the links, including ones pointing at documents that do not exist yet |
| `vault_status` | How much storage is used |

## A shape that works

One folder per project, the way a notes repository is laid out:

```
projects/plume/decisions.md     why things are the way they are
projects/plume/architecture.md  how it fits together
projects/plume/log.md           appended to as work happens
people/notes.md                 who said what, and when
```

Write links in `[[double brackets]]` and the vault graph draws the shape of what
has been remembered.

## Configuration

| Variable | Notes |
|---|---|
| `PLUME_TOKEN` | required; create it in the web vault |
| `PLUME_API` | defaults to `https://plume-md.com/api` |

## What it can reach

A token can read, change and delete every document in the vault it belongs to —
nothing else, and no other account. It cannot create or revoke tokens; that
always needs the account password. Revoke a token in the web vault and it stops
working immediately.

The server holds no state, writes nothing to disk, and talks only to the vault
API over HTTPS.

## Licence

MIT.
