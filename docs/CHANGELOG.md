# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
