# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.1]

### Added
- parameter descriptions for every tool input, so clients show what each argument means (no behaviour change)

### Changed
- `youtube_download_caption` supports the `sbv` format (alongside `srt`, `ttml` and `vtt`); `fileName` must end in the extension that matches `format` (for example `.sbv` for `sbv`), and `.txt` is no longer accepted. Without `format` (the track's original format), any of `.srt`, `.ttml`, `.vtt`, `.sbv` is allowed.

## [0.3.0]

**Breaking changes.** Tool count is now 79.
- Removed tools: `youtube_approve_upload`, `youtube_approve_playlist`, `youtube_approve_moderation`, `youtube_approve_creator_content`. Use the single `youtube_approve` for every preflight preview.
- `youtube_download_caption` now takes `fileName` (a plain name ending in .srt, .vtt, .sbv or .txt) instead of `outputPath`, writes only into `<state dir>/downloads/` (created 0700) and returns the absolute `path`. Its readOnlyHint annotation is removed because it writes a local file.
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
- Safety model wording: channel and content writes use preflight, `youtube_approve`, execute. Viewer actions (subscribe, unsubscribe, rate_video), `youtube_create_comment` and local curation and reset tools are single-step writes that require `confirm: true`.
- `youtube_unsubscribe_many` reports `unknown` (not `failed`) for items whose outcome is uncertain after a server or network error, with an action pointing to `youtube_list_subscriptions`. Bulk unsubscribe now also verifies that the signed-in account is the selected profile's channel.
- `youtube_creator_report` defaults its end date to the Pacific (America/Los_Angeles) day and fails with `provider_error` on an analytics response with missing column names.
- `youtube_update_channel` refuses an incomplete channel read instead of building an update from it.
- caption download needs no approval; `youtube_create_comment` is limited to your own videos (breaking)
- the server launches from the release tarball; first start takes about 9 s, later starts use the npm cache
- local storage uses Node's built-in `node:sqlite` instead of the native `better-sqlite3` addon; Node.js 22.13+ required (breaking)
- one universal `.mcpb` bundle (`youtube-mcp-<version>.mcpb`) for macOS, Windows and Linux, with no native binaries
- storage open/IO failures surface as `storage_unavailable` (path omitted); a Node without `node:sqlite` is reported at startup and by `youtube_auth_status`
- plugin settings that are needed to run are now required in the Claude Code plugin

### Fixed
- `youtube_preflight_update_channel` always failed with an incomplete-channel-result error because the real client adapter lacked `channels.update`
- account mutations (`youtube_create_comment`, `youtube_subscribe`, `youtube_unsubscribe`, `youtube_rate_video`) reported `provider_outcome_unknown` for every error; clean 4xx rejections now surface their status and reason, and only network, 5xx and ambiguous failures stay unknown. A comment with an empty `textDisplay` after insert falls back to `textOriginal`.
- `youtube_create_comment` reported `provider_outcome_unknown` although the comment was posted: YouTube's insert response carries no `authorDisplayName`, which the response check required. The comment id is now the only required field (author and text fall back).
- live e2e channel group verifies the stored brandingSettings description (via an unapproved preview) instead of `youtube_my_account`, whose snippet description lags the write
- scheduled publish: a 400 `invalidPublishAt` now explains that YouTube only schedules a private video that has never been public; tool descriptions say so, and the live e2e schedules before first publishing
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
