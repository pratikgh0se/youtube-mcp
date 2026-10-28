# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## 0.3.0 (unreleased)

- Faster first start: launch from the release tarball (about 9 s cold start)
- Tool count is now 79 (72 + 7 new tools below)
- Added `youtube_creator_report`: allowlisted YouTube Analytics report (metrics, dimensions, filters, sort, maxResults; default last 28 days) with up-front `invalid_input` for known-invalid combinations; `youtube_creator_overview`, `youtube_creator_top_videos` and `youtube_creator_retention` are unchanged
- `youtube_search` gains optional `order`, `publishedAfter`, `publishedBefore`, `videoDuration`, `channelId`, `regionCode`, `relevanceLanguage`, `safeSearch` and `pageToken` (backwards compatible; results include `nextPageToken`)
- Added `youtube_trending` (videos.list chart=mostPopular, 1 quota unit) and `youtube_list_channel_videos` (recent uploads with statistics for any channel ID or @handle, about 3 quota units per page)
- Added `youtube_preflight_update_channel` and `youtube_update_channel`: edit description, keywords, country and defaultLanguage of the selected channel through preflight, `youtube_approve`, execute; sends the complete brandingSettings (read-modify-write) so untouched fields are kept
- `youtube_list_subscriptions` gains `pageToken` and `details: true` (subscriberCount, videoCount, lastUploadAt; about 1 extra quota unit per returned channel)
- Added `youtube_preflight_unsubscribe_many` and `youtube_unsubscribe_many`: bulk removal of up to 100 subscriptions with one approval, per-item results, early stop with a partial report on quota exhaustion
- Live E2E: new `channel` group, plus steps for every new tool
- TODO (orchestrator): list the rest of the 0.3.0 changes here (smoke fixes, required plugin settings, live e2e script, media-body/error/retry fixes, archive tools, docs/SETUP.md, tool trim to 72 tools with a single `youtube_approve`)

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
