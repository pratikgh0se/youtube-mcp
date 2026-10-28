# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.0]

**Breaking changes.** Tool count is now 79.
- Removed tools: `youtube_approve_upload`, `youtube_approve_playlist`, `youtube_approve_moderation`, `youtube_approve_creator_content`. Use the single `youtube_approve` for every preflight preview.
- `youtube_download_caption` no longer needs an approval step, so `youtube_preflight_caption_download` is no longer part of the flow.
- `youtube_create_comment` now works on your own videos only.
- Node.js 22.13 or newer is required (local storage uses `node:sqlite`).
- Claude Code plugin settings that were optional are now required; see docs/SETUP.md.

### Added
- archive tools for owned videos (`youtube_archive_video` with preflight and approval)
- `youtube_creator_report`: allowlisted YouTube Analytics report (metrics, dimensions, filters, sort, maxResults; default last 28 days) with up-front `invalid_input` for known-invalid combinations
- `youtube_trending` (most popular chart, 1 quota unit)
- `youtube_list_channel_videos` (recent uploads with statistics for any channel ID or @handle, about 3 quota units per page)
- `youtube_preflight_update_channel` and `youtube_update_channel`: edit description, keywords, country and default language of the selected channel through preflight, `youtube_approve`, execute (untouched branding fields are kept)
- `youtube_preflight_unsubscribe_many` and `youtube_unsubscribe_many`: remove up to 100 subscriptions with one approval, per-item results, partial report if quota runs out
- `youtube_search` filters: `order`, `publishedAfter`, `publishedBefore`, `videoDuration`, `channelId`, `regionCode`, `relevanceLanguage`, `safeSearch`, plus `pageToken` and `nextPageToken` in results (backwards compatible)
- `youtube_list_subscriptions`: `pageToken` and `details: true` (subscriberCount, videoCount, lastUploadAt; about 1 extra quota unit per channel)
- live end-to-end test script (`scripts/live-e2e.mjs`) covering every tool group
- beginner setup guide: docs/SETUP.md

### Changed
- one `youtube_approve` tool replaces the four per-area approve tools (breaking, see above)
- caption download needs no approval; `youtube_create_comment` is limited to your own videos (breaking)
- the server launches from the release tarball; first start takes about 9 s, later starts use the npm cache
- local storage uses Node's built-in `node:sqlite` instead of the native `better-sqlite3` addon; Node.js 22.13+ required (breaking)
- one universal `.mcpb` bundle (`youtube-mcp-<version>.mcpb`) for macOS, Windows and Linux, with no native binaries
- storage open/IO failures surface as `storage_unavailable` (path omitted); a Node without `node:sqlite` is reported at startup and by `youtube_auth_status`
- plugin settings that are needed to run are now required in the Claude Code plugin

### Fixed
- caption and thumbnail uploads now send the media body correctly
- provider errors now include the HTTP status and reason
- read-after-write verification retries after create, so fresh resources are found
- smoke test passes the environment through to the server

## Earlier unreleased history (before 0.2.0)

### Fixed
- harden release safety and verification
- preserve exact, persisted Phase 2 approval bindings across MCP restarts
- return a non-retryable unknown-outcome error for ambiguous Phase 1 account mutations
- allow explicitly approved playlist and search curation candidates into a proposed queue
- make an absent exact playlist a successful `item: null` reconciliation result
- typecheck test sources in the release gate and ignore local runtime state
- close OAuth and playlist gaps
- request `youtube.force-ssl` alongside the existing YouTube and Analytics scopes, and re-open consent when a stored grant lacks it
- add guarded playlist deletion with an exact owned-resource preview and reconciliation read
- treat any completed 2xx resumable-upload response with a video ID as successful
- load project env at startup

### Added
- deterministic Node 22 CI and an opt-in private playlist create/delete/reconciliation smoke check

### Changed
- docs: add YouTube agent roadmaps
- docs: add phase two creator handoff
- chore: ignore local credential artifacts
- docs: clarify comment-thread tools
- docs: prepare isolated test-first implementation
- docs: plan YouTube MCP foundation
- docs: support open-source MCP harnesses
- docs: define cross-client MCP support
- docs: define YouTube MCP design

## [0.2.0]

### Added
- one-line install for Claude Code (plugin and marketplace), Claude Desktop (`.mcpb` bundle), Gemini CLI (extension), Cursor and VS Code (install links)
- ready-made configs for 14 clients in `configs/`, all using `npx -y github:pratikgh0se/youtube-mcp --transport stdio`
- `AGENTS.md` and `llms-install.md` so agents can install the server for a user
- `--version` flag, used to prewarm the first `npx` run
- the state directory is now a setting in the Claude Code plugin and Gemini extension

### Changed
- README install section reorganised as "Install in your AI agent"
- empty optional settings (blank values from plugin and extension hosts) count as unset
