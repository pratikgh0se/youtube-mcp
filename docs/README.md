# YouTube MCP

A local-first Model Context Protocol (MCP) server for YouTube discovery, deliberate account actions, creator analytics and content management, and private YouTube-consumption analysis from Google Takeout.

It uses the same MCP contract over stdio (the default, intended for local AI clients) and optional loopback-only Streamable HTTP. No server is started unless you explicitly start one.

## What it can do

- Public reads with an API key: search videos, inspect videos and channels, list comments for a specific video with `youtube_get_comments`, and attempt a public transcript.
- Authenticated actions: inspect your channel, subscriptions, and channel-related comment threads; subscribe, unsubscribe, rate a video, or create a comment.
- Creator analytics: owned-channel overview, top videos, and retention data. These reports are always scoped to `channel==MINE`.
- Creator resources: owned videos, categories, playlists and playlist items, moderation queues, and caption tracks.
- Guarded creator writes: resumable video uploads, metadata and thumbnails, captions, playlists (including deletion), replies, moderation, and author-owned comment deletion.
- Private consumption analytics: import local Google Takeout YouTube history and calculate local profile and trend summaries.
- Local curation: save allowlists and propose finite queues. Queue application is deliberately not exposed because one confirmation must never expand into an unbounded playlist mutation batch.

Every Phase 2 provider mutation uses a preflight → approve → execute flow. Approval is bound to the selected profile, channel, immutable target, desired change, fresh provider state, and a reconciliation read.

## Requirements and install

Use Node.js 22 or newer. From a checkout:

```bash
npm install
npm run build
```

For a packaged install, install the package normally, then use the `youtube-mcp` command supplied by its `bin` entry.

Copy the documented variable names into your normal environment or a local, uncommitted env file:

```bash
cp .env.example .env
```

Do not commit `.env`, OAuth client JSON, refresh-token state, or Takeout exports.

## Credentials and one-time OAuth

`YOUTUBE_API_KEY` enables only public discovery. It does **not** authorize account actions or creator analytics.

For account and creator tools, create a Google OAuth **desktop** client and set `YOUTUBE_OAUTH_CLIENT_SECRET_FILE` to its local JSON file. Phase 2 creator tools also require:

```bash
YOUTUBE_MCP_PROFILE_ID=creator-main
YOUTUBE_MCP_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxxxxxx
```

`YOUTUBE_MCP_PROFILE_ID` is a stable local name used to isolate state. `YOUTUBE_MCP_CHANNEL_ID` is the immutable channel ID that the authenticated OAuth principal must match; it is not a display name or handle. Authorize once:

```bash
npm run build
npm run auth
```

The command opens the local OAuth flow only when you explicitly run it. It stores a refresh token beneath `YOUTUBE_MCP_STATE_DIR` (default: `~/.youtube-mcp`) with user-only permissions. With a profile ID, the token is stored under that profile. Later account-tool calls refresh silently; they do not require browser authentication for every request. If authorization is revoked or a required capability is missing, run `npm run auth` again.

OAuth is checked per tool capability rather than requiring `youtube.force-ssl` globally:

- YouTube reads accept `youtube.readonly`, `youtube.force-ssl`, or the broader `youtube` grant.
- YouTube writes accept `youtube.force-ssl` or `youtube`.
- Upload transfer calls accept `youtube.upload` or `youtube`; the ownership check also needs a readable YouTube grant, so use `youtube`, or combine `youtube.upload` with `youtube.readonly`.
- Creator analytics accepts `yt-analytics.readonly`, `youtube.readonly`, or `youtube`.

The bundled desktop authorization requests `youtube`, `youtube.force-ssl`, and `yt-analytics.readonly` so the complete local server can be used. If a stored grant lacks any requested scope, `npm run auth` reopens consent and replaces the local refresh-token record. Stored grants are still validated against the capability of each invoked tool.

`YOUTUBE_MCP_STATE_DIR` also holds the local `consumption.sqlite` database derived from Takeout data. It is never sent to YouTube by the importer.

## Safety model

Every external account mutation requires `confirm: true` in the tool input, even if the AI client has its own approval UI:

```json
{ "channelId": "UC...", "confirm": true }
```

Phase 1 writes require literal `confirm: true`. Phase 2 writes require an unexpired preflight, a separate approval call with `confirm: true`, and execution with the same approved inputs and `confirm: true`. The approval binding is persisted, so an approved Phase 2 operation remains executable after a server restart until it expires. Missing confirmation is rejected before the provider mutation. Tests never make a live mutation.

Delete previews return an exact target summary before approval. Playlist deletion reconciles with `youtube_get_playlist(playlistId)`. Comment deletion additionally requires the selected channel to match the comment's `authorChannelId`; being the channel associated with a viewer's comment is not deletion authority. Ambiguous status/delete outcomes reconcile with `youtube_get_moderation_comment(commentId)`, while ambiguous replies use `youtube_find_comment_reply(parentId, text)`, which exhausts the exact parent's reply pages and matches only replies authored by the selected channel. Mutations are never retried automatically.

Caption downloads create a new destination with user-only permissions. Existing paths and symbolic links are rejected and never overwritten. Resumable uploads keep only minimal local recovery state and expose their generated upload ID in the preflight reconciliation hint; an expired session must be reconciled and explicitly preflighted again. Upload completion is recorded only when YouTube returns its completed-upload response with the created video ID.

`youtube_get_comments(videoId)` is the public, specific-video comment-listing operation. `youtube_list_channel_comment_threads` lists comment threads associated with videos on the authenticated channel; those comments may be authored by anyone.

Transcript retrieval is best effort. A video may have no accessible transcript, and an unavailable transcript is reported as unavailable rather than turning otherwise public metadata into an error.

## Run locally

Stdio is the recommended transport for Codex, Claude, Cursor, OpenClaw, Hermes, OpenCode, DeepSeek-style harnesses, and compatible MCP clients:

```bash
npm run dev:stdio
# or, after build:
youtube-mcp --transport stdio
```

For a local Streamable HTTP endpoint, opt in explicitly. It binds to `127.0.0.1` and uses `PORT` (default 3000):

```bash
npm run dev:http
# or: PORT=3000 youtube-mcp --transport http
```

Remote deployment is a deliberate trust-boundary change: it would give that deployment access to the OAuth refresh-token state and local Takeout database. Do not expose a local instance directly to the internet. A cloud-based AI client needs an intentional, authenticated deployment or a secure bridge to access this local MCP.

## Client templates

Copy the matching template from `configs/`, adjust only the executable path if `youtube-mcp` is not on your `PATH`, and keep the environment-variable references—not literal secrets:

| Client | Template |
| --- | --- |
| Codex | `configs/codex.toml` |
| Claude Desktop | `configs/claude-desktop.json` |
| Cursor | `configs/cursor.json` |
| OpenClaw | `configs/openclaw.json` |
| Hermes | `configs/hermes.yaml` |
| OpenCode | `configs/opencode.json` |
| Generic stdio client / DeepSeek-style harness | `configs/generic-stdio.json` |

All templates launch `youtube-mcp --transport stdio` and support the same tool set. They are launch templates, not secret stores.

## Import Takeout locally

Export YouTube history through Google Takeout, keep the export local, then call `youtube_import_takeout` with the path of an exported YouTube-history JSON or HTML file. Re-importing the same logical history is idempotent. Derived profile/trend results remain in the state directory and distinguish watch activity from searches.

## Verify before testing with real credentials

All normal verification is offline:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:read-only
```

By default `npm run smoke:read-only` prints that live checks were skipped and makes no network request. To opt into one developer-owned, read-only public search request, set both `YOUTUBE_LIVE_SMOKE=1` and `YOUTUBE_API_KEY`. It performs no OAuth flow and no mutation.

For a deliberately opted-in private mutation check, set `YOUTUBE_LIVE_PRIVATE_SMOKE=1` and run `npm run smoke:private-playlist`. It creates one private playlist, deletes it through the MCP approval flow, and verifies that `youtube_get_playlist` returns `item: null`. Run it only against a developer-owned channel; it always uses a unique temporary title and performs no public publication, rating, subscription, comment, or upload.
