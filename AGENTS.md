# AGENTS.md

Two audiences. Part 1 is for an agent installing this MCP server for a user. Part 2 is for an agent changing this repo.

## Part 1. Installing this server for a user

Requirements: Node.js 22+ on `PATH`, and a YouTube Data API v3 key from the user. Never ask the user to paste a key into a file that is committed.

### Canonical launch

Every client config uses the same launch. Only the file format around it changes.

```
command: npx
args:    ["-y", "https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz", "--transport", "stdio"]
```

No npm publish is involved. `npx` downloads the prebuilt release tarball attached to the GitHub release (a few seconds on first run), then uses npm's cache. The release must exist: the URL returns 404 until the tag is published.

### Environment variables (these five only)

| Variable | Needed for |
| --- | --- |
| `YOUTUBE_API_KEY` | Public tools: search, videos, channels, public comments, transcripts. Required. |
| `YOUTUBE_OAUTH_CLIENT_SECRET_FILE` | Account and creator tools. Absolute path to a Google Desktop OAuth client JSON. |
| `YOUTUBE_MCP_PROFILE_ID` | Creator tools. A name the user chooses, e.g. `creator-main`. |
| `YOUTUBE_MCP_CHANNEL_ID` | Creator tools. Channel ID starting with `UC`. The signed-in account must own it. |
| `YOUTUBE_MCP_STATE_DIR` | Optional. Where tokens and local state live. Default `~/.youtube-mcp`. |

An empty string counts as unset for all five.

### Steps

1. Write the server entry into the client's config using the matching file in [`configs/`](configs). Do not invent another format.
2. Prewarm so the client does not time out on first start: `npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz --version`
3. Restart or reload the client and confirm the `youtube-mcp` server lists its tools.
4. For account and creator tools, run the one-time Google sign-in in a terminal with the same env values. It opens a browser:

```bash
YOUTUBE_OAUTH_CLIENT_SECRET_FILE=/absolute/path/to/client_secret.json \
YOUTUBE_MCP_PROFILE_ID=creator-main \
npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz youtube-auth
```

### Which config file

| Client | File in `configs/` |
| --- | --- |
| Claude Code | plugin: `/plugin marketplace add pratikgh0se/youtube-mcp`, `/plugin install youtube-mcp@youtube-mcp` |
| Claude Desktop | `.mcpb` from GitHub Releases, or `claude-desktop.json` |
| Codex CLI | `codex.toml` (uses `env_vars`, `startup_timeout_sec = 180`) |
| Gemini CLI | `gemini extensions install https://github.com/pratikgh0se/youtube-mcp`, or `gemini-settings.json` |
| Antigravity CLI | `antigravity.json` |
| Cursor, Windsurf | `cursor.json`, `windsurf.json` (`${env:VAR}`) |
| VS Code | `vscode.json` (`inputs` prompt for the key) |
| Cline, Zed, goose | `cline.json`, `zed.json`, `goose.yaml` |
| OpenCode, OpenClaw, Hermes | `opencode.json`, `openclaw.json`, `hermes.yaml` |
| Anything else | `generic-stdio.json` |

Safety: write tools follow preflight, approve, execute. Show the user each preview and never pass `confirm: true` without their approval.

## Part 2. Working on this repo

```bash
npm ci                   # install (also builds via the prepare script)
npm run build            # tsc to dist/
npm run lint             # tsc --noEmit
npm run typecheck        # tsc --noEmit
npm run typecheck:tests  # type check tests
npm test                 # vitest, fully offline
```

Rules:

- Never read `.env` or print credentials, tokens, or OAuth client JSON. Never commit them.
- Every config must keep the single entrypoint above. A test enforces it: no bare `youtube-mcp` command, no `node /absolute/path` launch (the README "Run from a local checkout" section is the only exception).
- Only the five env vars above may appear in configs. Codex configs must not contain `${`.
- Bump versions together: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`plugins[0].version`), `gemini-extension.json`, and `mcpb/manifest.json`. Add a `docs/CHANGELOG.md` entry.
- Bumping the version also means updating the `vX.Y.Z` tag and `youtube-mcp-X.Y.Z.tgz` filename in the release-tarball URL of every npx spec (configs, README links, `.mcp.json`, `gemini-extension.json`); `tests/configs/packaging.test.ts` enforces it.
- Write tools must stay behind the preflight and approve flow. Tests never make a live mutation.
