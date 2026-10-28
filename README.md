# YouTube MCP

**A local-first MCP server that lets AI assistants search YouTube, manage your channel and read your analytics, and asks you to approve every change first.**

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)
![MCP server](https://img.shields.io/badge/MCP-server-blue.svg)

YouTube MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server written in TypeScript. It exposes 72 tools to MCP clients such as Claude Code, Claude Desktop, Cursor and Codex. It runs on your own machine over stdio, keeps its OAuth tokens and working data on your disk, and never starts a network listener unless you ask for one.

Anything that changes your YouTube account goes through a **preflight, approve, execute** flow. The assistant first shows you exactly what it is about to do, and nothing happens until the exact previewed change is approved.

## Quick start

1. **Get your keys.** Follow the [beginner setup guide](docs/SETUP.md) (5 minutes for public research, about 15 with your own channel).
2. **Install in your agent.** Pick yours in [Install in your AI agent](#install-in-your-ai-agent).
3. **Sign in once** (only for your own channel): run the `youtube-auth` command in [Account and creator tools](#account-and-creator-tools-authorize-once).
4. **Ask your agent:** "Check my YouTube auth status", then "Search YouTube for talks about MCP".

## What it can do

**Read (no account needed, just an API key)**
- Search videos, look up videos and channels.
- List the public comments on a video.
- Fetch a public transcript (best effort; some videos have none).

**Read (your own account and channel, via OAuth)**
- Your channel, your subscriptions, and comment threads on your channel.
- Creator analytics: channel overview, top videos and audience retention for a date range.
- Your uploaded videos, playlists and playlist items, caption tracks, and the comment moderation queue.

**Write (your own account, every change needs approval)**
- Uploads: resumable video uploads, with status check, resume and cancel. Uploads are private unless you explicitly ask to publish.
- Videos: update title, description and other metadata, and set thumbnails.
- Captions: upload, update, download and delete caption tracks.
- Playlists: create, update, delete, and add, remove or reorder items. New playlists default to private.
- Comments and moderation: reply to comments, set a moderation status (including banning an author), and delete comments on your channel.
- Account actions: subscribe, unsubscribe, rate a video, post a top-level comment (these need a literal `confirm: true`).

**Private viewing analysis (local only)**
- Import your Google Takeout YouTube history and get a profile and trend comparison between two date ranges. The data stays in a local SQLite file.
- Save local curation allowlists and generate a finite, proposed queue. The server never applies a queue to your account.

## Safety model

Write tools are built so an AI client cannot make a surprise change:

1. **Preflight.** A `youtube_preflight_*` tool reads fresh state from YouTube, validates the request and returns an exact preview.
2. **Approve.** A separate `youtube_approve` call (one tool for every kind of change), with `confirm: true`, binds approval to the profile, channel, target, requested change and fresh state. Approvals expire. They are stored locally, so an approved operation survives a server restart until it expires.
3. **Execute.** The write tool runs only with the same approved inputs and `confirm: true`.

More guard rails, all from the code:
- Mutations are never retried automatically. Ambiguous outcomes are reconciled with a read.
- Public visibility, scheduling, synthetic-media changes and banning an author need an explicit, elevated flag.
- Comment deletion requires the comment to belong to your selected channel.
- Caption downloads never overwrite an existing path or follow symbolic links.
- Creator tools check that the signed-in Google account matches the channel ID you configured.
- The automated tests never make a live mutation.

Full details are in [docs/README.md](docs/README.md).

## Requirements

- Node.js 22 or newer
- A Google Cloud project with the **YouTube Data API v3** enabled (and the **YouTube Analytics API** for the creator analytics tools)
- A YouTube Data API key for public reads, and an OAuth desktop client for account and creator tools

## Install in your AI agent

No npm publish is needed. Every route below runs the server from the prebuilt tarball attached to the GitHub release with `npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz --transport stdio`, except the Claude Desktop bundle, which carries its own copy. You need Node.js 22+ on your `PATH` for the `npx` routes. Create your Google credentials first with the [beginner setup guide](docs/SETUP.md) (short version: [Google credentials](#google-credentials)). You need at least a YouTube Data API key.

| Agent | One-line install |
| --- | --- |
| [Claude Code](#claude-code) | `/plugin marketplace add pratikgh0se/youtube-mcp`, then `/plugin install youtube-mcp@youtube-mcp` |
| [Claude Desktop](#claude-desktop) | Download the `.mcpb` from [Releases](https://github.com/pratikgh0se/youtube-mcp/releases/latest) and double-click it |
| [Codex CLI](#codex-cli) | `codex mcp add youtube-mcp -- npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz --transport stdio` |
| [Gemini CLI](#gemini-cli) | `gemini extensions install https://github.com/pratikgh0se/youtube-mcp` |
| [Antigravity CLI](#antigravity-cli) | Add the server to `~/.gemini/config/mcp_config.json` |
| [Cursor](#cursor) | Install button, or `.cursor/mcp.json` |
| [VS Code / Copilot](#vs-code--copilot) | Install button, or `.vscode/mcp.json` |
| [Windsurf](#windsurf) | Add the server to `mcp_config.json` |
| [Cline](#cline) | Add the server to `cline_mcp_settings.json`, or point Cline at [`llms-install.md`](llms-install.md) |
| [Zed](#zed) | Add a `context_servers` entry |
| [goose](#goose) | `goose configure`, or `config.yaml` |
| [Other agents](#other-agents) | See [`AGENTS.md`](AGENTS.md) and [`configs/generic-stdio.json`](configs/generic-stdio.json) |

Ready-made files for each client are in [`configs/`](configs). Use the placeholders as shown and never paste a real key into a file you commit.

The first launch downloads the prebuilt release tarball and installs its dependencies, which takes a few seconds on a normal connection. Later launches use npm's cache. To be safe against a client start-up timeout on a slow network, warm the cache once in a terminal first:

```bash
npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz --version
```

### Claude Code

```bash
claude plugin marketplace add pratikgh0se/youtube-mcp
claude plugin install youtube-mcp@youtube-mcp
```

Or inside Claude Code: `/plugin marketplace add pratikgh0se/youtube-mcp`, then `/plugin install youtube-mcp@youtube-mcp`. Claude Code asks for your API key (stored in your OS credential store) and four more settings: OAuth client file, profile name and channel ID are required, and the state directory is optional (leave it blank to use `~/.youtube-mcp`). The plugin only holds config. The server itself still runs through `npx`.

### Claude Desktop

Download `youtube-mcp-<version>-<platform>-<arch>.mcpb` from [GitHub Releases](https://github.com/pratikgh0se/youtube-mcp/releases/latest) and double-click it. Claude Desktop shows an install dialog and asks for your API key. The bundle includes the server, so it needs no `npx` at run time. The macOS Apple Silicon build comes first. Other platforms are produced by the CI release builds.

Fallback if there is no bundle for your platform: add [`configs/claude-desktop.json`](configs/claude-desktop.json) to `claude_desktop_config.json` and restart. The first start downloads the package, which can take a few seconds.

```json
{
  "mcpServers": {
    "youtube-mcp": {
      "command": "npx",
      "args": ["-y", "https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz", "--transport", "stdio"],
      "env": { "YOUTUBE_API_KEY": "<your-youtube-api-key>" }
    }
  }
}
```

### Codex CLI

```bash
codex mcp add youtube-mcp --env YOUTUBE_API_KEY=<your-youtube-api-key> -- npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz --transport stdio
```

That stores the key in `~/.codex/config.toml`. To keep it out of the file, use [`configs/codex.toml`](configs/codex.toml) instead. It forwards the variables from your shell with `env_vars` (Codex does not expand `${VAR}`) and sets `startup_timeout_sec = 180`, because the default of 10 seconds is shorter than the first `npx` run.

```toml
[mcp_servers.youtube-mcp]
command = "npx"
args = ["-y", "https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz", "--transport", "stdio"]
env_vars = ["YOUTUBE_API_KEY"]
startup_timeout_sec = 180
```

### Gemini CLI

```bash
gemini extensions install https://github.com/pratikgh0se/youtube-mcp
```

Gemini prompts for your API key (kept in the system keychain, required) and the OAuth client file, profile name and channel ID (needed for your channel's tools; see the [setup guide](docs/SETUP.md)). Change them later with `gemini extensions config youtube-mcp`. A plain `settings.json` entry is in [`configs/gemini-settings.json`](configs/gemini-settings.json).

Note: Google stopped serving Gemini CLI to AI Pro, Ultra and free individual users on 2026-06-18. Paid API-key and enterprise users keep it ([source](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)). Everyone else should use Antigravity CLI below.

### Antigravity CLI

Add this to `~/.gemini/config/mcp_config.json` (global) or `<workspace>/.agents/mcp_config.json`. It is also in [`configs/antigravity.json`](configs/antigravity.json).

```json
{
  "mcpServers": {
    "youtube-mcp": {
      "command": "npx",
      "args": ["-y", "https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz", "--transport", "stdio"],
      "env": { "YOUTUBE_API_KEY": "<your-youtube-api-key>" }
    }
  }
}
```

### Cursor

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=youtube-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImh0dHBzOi8vZ2l0aHViLmNvbS9wcmF0aWtnaDBzZS95b3V0dWJlLW1jcC9yZWxlYXNlcy9kb3dubG9hZC92MC4zLjAveW91dHViZS1tY3AtMC4zLjAudGd6IiwiLS10cmFuc3BvcnQiLCJzdGRpbyJdLCJlbnYiOnsiWU9VVFVCRV9BUElfS0VZIjoiJHtlbnY6WU9VVFVCRV9BUElfS0VZfSJ9fQ%3D%3D)

The button reads `YOUTUBE_API_KEY` from your shell environment. Or add [`configs/cursor.json`](configs/cursor.json) to `.cursor/mcp.json` (or `~/.cursor/mcp.json`). It uses `${env:YOUTUBE_API_KEY}`, so no secret is written to the file.

### VS Code / Copilot

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?logo=visualstudiocode)](https://vscode.dev/redirect/mcp/install?name=youtube-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22https%3A%2F%2Fgithub.com%2Fpratikgh0se%2Fyoutube-mcp%2Freleases%2Fdownload%2Fv0.3.0%2Fyoutube-mcp-0.3.0.tgz%22%2C%22--transport%22%2C%22stdio%22%5D%7D)

The button installs the server without a key. Add one afterwards through the server's `env`, or use the file below, which prompts for it. From a terminal:

```bash
code --add-mcp '{"name":"youtube-mcp","type":"stdio","command":"npx","args":["-y","https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz","--transport","stdio"]}'
```

Or save [`configs/vscode.json`](configs/vscode.json) as `.vscode/mcp.json`. VS Code asks for the key on first start (`password: true`) and stores it securely.

```json
{
  "inputs": [
    { "type": "promptString", "id": "youtube-api-key", "description": "YouTube Data API v3 key", "password": true }
  ],
  "servers": {
    "youtube-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz", "--transport", "stdio"],
      "env": { "YOUTUBE_API_KEY": "${input:youtube-api-key}" }
    }
  }
}
```

### Windsurf

Use [`configs/windsurf.json`](configs/windsurf.json) (it reads `${env:YOUTUBE_API_KEY}`). The current Devin docs put the file at `~/.config/devin/mcp_config.json` (Windows: `%APPDATA%\devin\mcp_config.json`). The older path `~/.codeium/windsurf/mcp_config.json` is what many guides still show. Only the first is confirmed by the vendor's docs, so if one does not load, try the other.

### Cline

Open the MCP Servers panel, Configure, then "Configure MCP Servers", and add [`configs/cline.json`](configs/cline.json). For Cline CLI the file is `~/.cline/data/settings/cline_mcp_settings.json`. Cline does not document env interpolation, so the key goes in as a literal value in that file. You can also ask Cline to install it from [`llms-install.md`](llms-install.md).

### Zed

Add [`configs/zed.json`](configs/zed.json) to your Zed settings (run the `zed: open settings file` action). Zed calls the map `context_servers`. The key goes in as a literal value.

### goose

Run `goose configure`, choose Add Extension, then Command-Line Extension, and enter `npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz --transport stdio` with the key as an environment variable. Or add [`configs/goose.yaml`](configs/goose.yaml) to `~/.config/goose/config.yaml`. The deeplink form (paste it into a browser or `open`) sets only the command, so add the key afterwards:

```text
goose://extension?cmd=npx&arg=-y&arg=https%3A%2F%2Fgithub.com%2Fpratikgh0se%2Fyoutube-mcp%2Freleases%2Fdownload%2Fv0.3.0%2Fyoutube-mcp-0.3.0.tgz&arg=--transport&arg=stdio&id=youtube-mcp&name=YouTube%20MCP&description=Search%20YouTube%20and%20manage%20your%20channel%20with%20approval%20for%20every%20change
```

### Other agents

Any client that launches stdio MCP servers can use [`configs/generic-stdio.json`](configs/generic-stdio.json). Templates for OpenCode, OpenClaw and Hermes are in [`configs/`](configs) too. Agents installing this for a user should read [`AGENTS.md`](AGENTS.md).

### Account and creator tools: authorize once

Public tools need only the API key. For account and creator tools, add the OAuth client file, profile name and channel ID from [step 2](#2-set-environment-variables) to your client config, then run the one-time Google sign-in from a terminal with the same values:

```bash
YOUTUBE_OAUTH_CLIENT_SECRET_FILE=/absolute/path/to/client_secret.json \
YOUTUBE_MCP_PROFILE_ID=creator-main \
npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz youtube-auth
```

This opens a browser for Google consent on a local `127.0.0.1` callback and requests the `youtube`, `youtube.force-ssl` and `yt-analytics.readonly` scopes. The token is stored under `~/.youtube-mcp` for that profile, and later calls refresh it silently. Run it again if you revoke access.

## Google credentials

### 1. Create credentials

New to Google Cloud? Use the step-by-step [beginner setup guide](docs/SETUP.md). The short version:

In the [Google Cloud console](https://console.cloud.google.com/):

1. Create or pick a project, then enable **YouTube Data API v3** and **YouTube Analytics API**.
2. Create an **API key**. This is enough for the public tools.
3. For account and creator tools, configure the OAuth consent screen (add yourself as a test user while the app is in testing), then create an **OAuth client ID** of type **Desktop app** and download its JSON file.

### 2. Set environment variables

Put these in your client config (see [Install in your AI agent](#install-in-your-ai-agent)), or copy `.env.example` to `.env` (it is git-ignored) when running from a checkout. Never commit real values.

| Variable | Needed for | Meaning |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | Public tools | Your YouTube Data API key. |
| `YOUTUBE_OAUTH_CLIENT_SECRET_FILE` | Account and creator tools | Absolute path to the Desktop OAuth client JSON. |
| `YOUTUBE_MCP_PROFILE_ID` | Creator tools | A name you choose, e.g. `creator-main`. Keeps local state separate per profile. |
| `YOUTUBE_MCP_CHANNEL_ID` | Creator tools | Your channel ID (starts with `UC`). The signed-in account must own it. |
| `YOUTUBE_MCP_STATE_DIR` | Optional | Where local state lives. Defaults to `~/.youtube-mcp`. The Claude Code plugin and Gemini extension prompt for it (blank means the default). An empty value is treated as unset everywhere. |

## Run from a local checkout

For development, or to run without `npx`:

```bash
git clone https://github.com/pratikgh0se/youtube-mcp.git
cd youtube-mcp
npm ci
npm run build   # npm ci already builds via the prepare script
npm run auth    # one-time Google sign-in, same as the npx youtube-auth command
```

Point your client at the checkout with an absolute path:

```json
{
  "mcpServers": {
    "youtube-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/youtube-mcp/bin/youtube-mcp.mjs", "--transport", "stdio"],
      "env": {
        "YOUTUBE_API_KEY": "your-api-key",
        "YOUTUBE_OAUTH_CLIENT_SECRET_FILE": "/absolute/path/to/client_secret.json",
        "YOUTUBE_MCP_PROFILE_ID": "creator-main",
        "YOUTUBE_MCP_CHANNEL_ID": "UC..."
      }
    }
  }
}
```

More templates (one per client) are in [`configs/`](configs). They launch the server with `npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz --transport stdio`. To use your checkout instead, change the command to `node` with the path above.

### Optional: local HTTP

```bash
PORT=3000 node bin/youtube-mcp.mjs --transport http
```

This binds to `127.0.0.1` only. Do not expose it to the internet.

## Example prompts

- "Search YouTube for recent talks about the Model Context Protocol and summarise the top three."
- "Get the transcript for this video and list the main points."
- "Show my channel's top 10 videos for the last 90 days and where viewers drop off in the most recent one."
- "Preview a private upload of `/Users/me/videos/demo.mp4` titled 'Demo', and wait for me to approve it."
- "Create a private playlist called 'To review' and add these five videos to it. Show me the preview first."
- "List the unreplied comments on my latest video and draft replies for me to approve."
- "Import my Takeout watch history and compare what I watched in January with what I watched in June."

## Tools

72 tools, grouped by area. Tools marked "preflight and approve" need the three-step flow above.

| Area | Tools |
| --- | --- |
| Public reads (5) | `youtube_search`, `youtube_get_video`, `youtube_get_channel`, `youtube_get_comments`, `youtube_get_transcript` |
| Your account (7) | Read: `youtube_my_account`, `youtube_list_subscriptions`, `youtube_list_channel_comment_threads`. Write (`confirm: true`): `youtube_subscribe`, `youtube_unsubscribe`, `youtube_rate_video`, `youtube_create_comment` (only on videos your channel owns; other videos are refused with `ownership_required`) |
| Creator analytics (3) | `youtube_creator_overview`, `youtube_creator_top_videos`, `youtube_creator_retention` |
| Creator reads (10) | `youtube_list_owned_videos`, `youtube_get_owned_video`, `youtube_list_video_categories`, `youtube_list_playlists`, `youtube_get_playlist`, `youtube_list_playlist_items`, `youtube_list_caption_tracks`, `youtube_list_moderation_comments`, `youtube_get_moderation_comment`, `youtube_find_comment_reply` |
| Uploads (7) | `youtube_preflight_upload`, `youtube_upload_video`, `youtube_get_upload_status`, `youtube_preflight_resume_upload`, `youtube_resume_upload`, `youtube_preflight_cancel_upload`, `youtube_cancel_upload` |
| Video metadata, archive and thumbnails (6) | `youtube_preflight_update_metadata`, `youtube_update_metadata`, `youtube_preflight_archive_video`, `youtube_archive_video`, `youtube_preflight_set_thumbnail`, `youtube_set_thumbnail` |
| Captions (7) | `youtube_preflight_caption_upload`, `youtube_upload_caption`, `youtube_preflight_caption_update`, `youtube_update_caption`, `youtube_download_caption` (read-only, no approval), `youtube_preflight_caption_delete`, `youtube_delete_caption` |
| Playlists (12) | `youtube_preflight_create_playlist`, `youtube_create_playlist`, `youtube_preflight_update_playlist`, `youtube_update_playlist`, `youtube_preflight_delete_playlist`, `youtube_delete_playlist`, `youtube_preflight_add_playlist_item`, `youtube_add_playlist_item`, `youtube_preflight_remove_playlist_item`, `youtube_remove_playlist_item`, `youtube_preflight_reorder_playlist_item`, `youtube_reorder_playlist_item` |
| Comments and moderation (6) | `youtube_preflight_reply_to_comment`, `youtube_reply_to_comment`, `youtube_preflight_set_comment_moderation_status`, `youtube_set_comment_moderation_status`, `youtube_preflight_delete_comment`, `youtube_delete_comment` |
| Approval (1) | `youtube_approve`: approves any pending preview by `approvalId` and shows its kind, target and exact change |
| Local viewing analysis (7) | `youtube_import_takeout`, `youtube_consumption_profile`, `youtube_consumption_trends`, `youtube_save_curation_policy`, `youtube_save_curation_candidate`, `youtube_propose_consumption_queue`, `youtube_reset_consumption_data` |
| Status (1) | `youtube_auth_status` |

## Privacy and security

- The OAuth refresh token is stored on your machine under `~/.youtube-mcp` (or `YOUTUBE_MCP_STATE_DIR`), in a file with user-only permissions.
- Operation approvals, upload recovery state and your Takeout-derived SQLite database (`consumption.sqlite`) live in the same directory. The Takeout importer never sends data to YouTube.
- Your Google credentials go only to Google's APIs. The public transcript tool uses the `youtube-transcript` package to fetch captions from YouTube.
- The default transport is stdio. The optional HTTP transport binds to `127.0.0.1` only.
- Never commit `.env`, your OAuth client JSON, token state or Takeout exports. The `.gitignore` already excludes `.env` files.
- Running this server gives the AI client access to your YouTube account within the scopes you grant. Review each preview before approving it.
- To report a vulnerability, follow [SECURITY.md](SECURITY.md) and use GitHub's private reporting. Please do not open a public issue.

## Development

```bash
npm ci
npm run lint            # type check the source
npm run typecheck:tests # type check the tests
npm test                # vitest, fully offline (214 tests)
npm run build           # compile to dist/
npm run smoke:read-only # offline by default; set YOUTUBE_LIVE_SMOKE=1 with an API key for one live read
npm run dev:stdio       # run from source over stdio
```

Continuous integration (`.github/workflows/verify.yml`) runs the same checks on Node 22. See [docs/CHANGELOG.md](docs/CHANGELOG.md) for what has changed.

## Contributing

Issues and pull requests are welcome. Please run `npm run lint`, `npm run typecheck:tests` and `npm test` before opening a pull request, add tests for any behavior change, and keep write actions behind the preflight and approve flow. Never include real credentials, tokens or personal data in issues, tests or fixtures.

## License

[MIT](LICENSE) (c) 2026 Pratik Ghose
