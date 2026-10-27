# YouTube MCP

**A local-first MCP server that lets AI assistants search YouTube, manage your channel and read your analytics, and asks you to approve every change first.**

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)
![MCP server](https://img.shields.io/badge/MCP-server-blue.svg)

YouTube MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server written in TypeScript. It exposes 74 tools to MCP clients such as Claude Code, Claude Desktop, Cursor and Codex. It runs on your own machine over stdio, keeps its OAuth tokens and working data on your disk, and never starts a network listener unless you ask for one.

Anything that changes your YouTube account goes through a **preflight, approve, execute** flow. The assistant first shows you exactly what it is about to do, and nothing happens until the exact previewed change is approved.

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
2. **Approve.** A separate `youtube_approve_*` call, with `confirm: true`, binds approval to the profile, channel, target, requested change and fresh state. Approvals expire. They are stored locally, so an approved operation survives a server restart until it expires.
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

## Install

Every install path below runs the server straight from GitHub with `npx -y github:pratikgh0se/youtube-mcp`, so there is nothing to publish or download first. You need Node.js 22+ on your `PATH`. The first launch clones the repo, installs dependencies and builds it from source, so it takes about a minute. Later launches use npm's cache.

Create your Google credentials first (see [Google credentials](#google-credentials)). You need at least a YouTube Data API key.

| Client | How to install |
| --- | --- |
| [Claude Code](#claude-code) | `/plugin marketplace add pratikgh0se/youtube-mcp`, then `/plugin install youtube-mcp@youtube-mcp` |
| [Claude Desktop](#claude-desktop) | Add an `npx` block to `claude_desktop_config.json` |
| [Codex](#codex) | `codex mcp add ...` or a block in `~/.codex/config.toml` |
| [Gemini CLI](#gemini-cli) | `gemini extensions install https://github.com/pratikgh0se/youtube-mcp` |
| [Cursor](#cursor) | Deeplink, or `.cursor/mcp.json` |
| [VS Code](#vs-code) | Install link, or `.vscode/mcp.json` |
| [Other clients](#other-clients) | Windsurf, Cline, Zed, Goose: the generic `npx` JSON |

Use placeholders as shown and never paste a real key into a file you commit.

### Claude Code

```bash
claude plugin marketplace add pratikgh0se/youtube-mcp
claude plugin install youtube-mcp@youtube-mcp
```

Or inside Claude Code: `/plugin marketplace add pratikgh0se/youtube-mcp`, then `/plugin install youtube-mcp@youtube-mcp`. On Claude Code 2.1.275 or later one step also works: `/plugin install youtube-mcp --marketplace pratikgh0se/youtube-mcp`. Claude Code asks for your API key (stored in your OS credential store) and the optional creator settings when you enable the plugin. The plugin only holds config. The server itself still runs through `npx`.

### Claude Desktop

Add this to `claude_desktop_config.json`, then restart Claude Desktop. The first start can take about a minute.

```json
{
  "mcpServers": {
    "youtube-mcp": {
      "command": "npx",
      "args": ["-y", "github:pratikgh0se/youtube-mcp", "--transport", "stdio"],
      "env": {
        "YOUTUBE_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Codex

```bash
codex mcp add youtube-mcp --env YOUTUBE_API_KEY=your-api-key -- npx -y github:pratikgh0se/youtube-mcp --transport stdio
```

Or put this in `~/.codex/config.toml`. `startup_timeout_sec` matters, because the default of 10 seconds is shorter than the first `npx` run. `env_vars` forwards the key from your shell, so it stays out of the file.

```toml
[mcp_servers.youtube-mcp]
command = "npx"
args = ["-y", "github:pratikgh0se/youtube-mcp", "--transport", "stdio"]
env_vars = ["YOUTUBE_API_KEY", "YOUTUBE_OAUTH_CLIENT_SECRET_FILE"]
startup_timeout_sec = 60

[mcp_servers.youtube-mcp.env]
YOUTUBE_MCP_PROFILE_ID = "creator-main"
```

### Gemini CLI

```bash
gemini extensions install https://github.com/pratikgh0se/youtube-mcp
```

Gemini prompts for your API key (kept in the system keychain) and the optional creator settings. Change them later with `gemini extensions config youtube-mcp`.

### Cursor

[Install in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=youtube-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImdpdGh1YjpwcmF0aWtnaDBzZS95b3V0dWJlLW1jcCIsIi0tdHJhbnNwb3J0Iiwic3RkaW8iXSwiZW52Ijp7IllPVVRVQkVfQVBJX0tFWSI6IiR7ZW52OllPVVRVQkVfQVBJX0tFWX0ifX0=) (the link reads `YOUTUBE_API_KEY` from your shell environment). Or add this to `.cursor/mcp.json` (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "youtube-mcp": {
      "command": "npx",
      "args": ["-y", "github:pratikgh0se/youtube-mcp", "--transport", "stdio"],
      "env": {
        "YOUTUBE_API_KEY": "${env:YOUTUBE_API_KEY}"
      }
    }
  }
}
```

### VS Code

[Install in VS Code](vscode:mcp/install?%7B%22name%22%3A%22youtube-mcp%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22github%3Apratikgh0se%2Fyoutube-mcp%22%2C%22--transport%22%2C%22stdio%22%5D%2C%22env%22%3A%7B%22YOUTUBE_API_KEY%22%3A%22%24%7Benv%3AYOUTUBE_API_KEY%7D%22%7D%7D) (reads `YOUTUBE_API_KEY` from your environment). Or add this to `.vscode/mcp.json`. VS Code prompts for the key on first start and stores it securely.

```json
{
  "inputs": [
    { "type": "promptString", "id": "ytkey", "description": "YouTube API key", "password": true }
  ],
  "servers": {
    "youtube-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:pratikgh0se/youtube-mcp", "--transport", "stdio"],
      "env": {
        "YOUTUBE_API_KEY": "${input:ytkey}"
      }
    }
  }
}
```

### Other clients

For Windsurf, Cline, Zed, Goose and anything else that launches stdio MCP servers, use this command, args and env in your client's own config format (usually a `mcpServers` map):

```json
{
  "mcpServers": {
    "youtube-mcp": {
      "command": "npx",
      "args": ["-y", "github:pratikgh0se/youtube-mcp", "--transport", "stdio"],
      "env": {
        "YOUTUBE_API_KEY": "your-api-key"
      }
    }
  }
}
```

Zed calls the map `context_servers`. Goose takes the same command in its `extensions:` list.

### Account and creator tools: authorize once

Public tools need only the API key. For account and creator tools, add the OAuth client file, profile name and channel ID from [step 2](#2-set-environment-variables) to your client config, then run the one-time Google sign-in from a terminal with the same values:

```bash
YOUTUBE_OAUTH_CLIENT_SECRET_FILE=/absolute/path/to/client_secret.json \
YOUTUBE_MCP_PROFILE_ID=creator-main \
npx -y github:pratikgh0se/youtube-mcp youtube-auth
```

This opens a browser for Google consent on a local `127.0.0.1` callback and requests the `youtube`, `youtube.force-ssl` and `yt-analytics.readonly` scopes. The token is stored under `~/.youtube-mcp` for that profile, and later calls refresh it silently. Run it again if you revoke access.

## Google credentials

### 1. Create credentials

In the [Google Cloud console](https://console.cloud.google.com/):

1. Create or pick a project, then enable **YouTube Data API v3** and **YouTube Analytics API**.
2. Create an **API key**. This is enough for the public tools.
3. For account and creator tools, configure the OAuth consent screen (add yourself as a test user while the app is in testing), then create an **OAuth client ID** of type **Desktop app** and download its JSON file.

### 2. Set environment variables

Put these in your client config (see [Install](#install)), or copy `.env.example` to `.env` (it is git-ignored) when running from a checkout. Never commit real values.

| Variable | Needed for | Meaning |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | Public tools | Your YouTube Data API key. |
| `YOUTUBE_OAUTH_CLIENT_SECRET_FILE` | Account and creator tools | Absolute path to the Desktop OAuth client JSON. |
| `YOUTUBE_MCP_PROFILE_ID` | Creator tools | A name you choose, e.g. `creator-main`. Keeps local state separate per profile. |
| `YOUTUBE_MCP_CHANNEL_ID` | Creator tools | Your channel ID (starts with `UC`). The signed-in account must own it. |
| `YOUTUBE_MCP_STATE_DIR` | Optional | Where local state lives. Defaults to `~/.youtube-mcp`. Set it in your shell or client `env`; the Claude Code plugin and Gemini extension do not prompt for it. |

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

More templates (Codex, Cursor, OpenClaw, Hermes, OpenCode, generic stdio) are in [`configs/`](configs). They launch the `youtube-mcp` command, so they assume it is on your `PATH`. Otherwise change the command to `node` with the path above.

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

74 tools, grouped by area. Tools marked "preflight and approve" need the three-step flow above.

| Area | Tools |
| --- | --- |
| Public reads (5) | `youtube_search`, `youtube_get_video`, `youtube_get_channel`, `youtube_get_comments`, `youtube_get_transcript` |
| Your account (7) | Read: `youtube_my_account`, `youtube_list_subscriptions`, `youtube_list_channel_comment_threads`. Write (`confirm: true`): `youtube_subscribe`, `youtube_unsubscribe`, `youtube_rate_video`, `youtube_create_comment` |
| Creator analytics (3) | `youtube_creator_overview`, `youtube_creator_top_videos`, `youtube_creator_retention` |
| Creator reads (10) | `youtube_list_owned_videos`, `youtube_get_owned_video`, `youtube_list_video_categories`, `youtube_list_playlists`, `youtube_get_playlist`, `youtube_list_playlist_items`, `youtube_list_caption_tracks`, `youtube_list_moderation_comments`, `youtube_get_moderation_comment`, `youtube_find_comment_reply` |
| Uploads (8) | `youtube_preflight_upload`, `youtube_approve_upload`, `youtube_upload_video`, `youtube_get_upload_status`, `youtube_preflight_resume_upload`, `youtube_resume_upload`, `youtube_preflight_cancel_upload`, `youtube_cancel_upload` |
| Video metadata and thumbnails (5) | `youtube_preflight_update_metadata`, `youtube_update_metadata`, `youtube_preflight_set_thumbnail`, `youtube_set_thumbnail`, `youtube_approve_creator_content` |
| Captions (8) | `youtube_preflight_caption_upload`, `youtube_upload_caption`, `youtube_preflight_caption_update`, `youtube_update_caption`, `youtube_preflight_caption_download`, `youtube_download_caption`, `youtube_preflight_caption_delete`, `youtube_delete_caption` |
| Playlists (13) | `youtube_preflight_create_playlist`, `youtube_create_playlist`, `youtube_preflight_update_playlist`, `youtube_update_playlist`, `youtube_preflight_delete_playlist`, `youtube_delete_playlist`, `youtube_preflight_add_playlist_item`, `youtube_add_playlist_item`, `youtube_preflight_remove_playlist_item`, `youtube_remove_playlist_item`, `youtube_preflight_reorder_playlist_item`, `youtube_reorder_playlist_item`, `youtube_approve_playlist` |
| Comments and moderation (7) | `youtube_preflight_reply_to_comment`, `youtube_reply_to_comment`, `youtube_preflight_set_comment_moderation_status`, `youtube_set_comment_moderation_status`, `youtube_preflight_delete_comment`, `youtube_delete_comment`, `youtube_approve_moderation` |
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
npm test                # vitest, fully offline (210 tests)
npm run build           # compile to dist/
npm run smoke:read-only # offline by default; set YOUTUBE_LIVE_SMOKE=1 with an API key for one live read
npm run dev:stdio       # run from source over stdio
```

Continuous integration (`.github/workflows/verify.yml`) runs the same checks on Node 22. See [docs/CHANGELOG.md](docs/CHANGELOG.md) for what has changed.

## Contributing

Issues and pull requests are welcome. Please run `npm run lint`, `npm run typecheck:tests` and `npm test` before opening a pull request, add tests for any behavior change, and keep write actions behind the preflight and approve flow. Never include real credentials, tokens or personal data in issues, tests or fixtures.

## License

[MIT](LICENSE) (c) 2026 Pratik Ghose
