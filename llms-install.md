# Install YouTube MCP (for Cline and other agents)

Follow these steps in order. Do not write secrets into any file that is committed.

1. Check Node.js: run `node --version`. It must be 22.13 or newer. If not, tell the user to install Node.js 22.13+ and stop.
2. If the user has no keys yet, point them to [docs/SETUP.md](docs/SETUP.md) for the step-by-step Google setup. Ask the user for a YouTube Data API v3 key (Google Cloud console, "YouTube Data API v3", then Credentials, then API key). Optional, only for account and creator tools: a Desktop OAuth client JSON path, a profile name (e.g. `creator-main`) and a channel ID starting with `UC`.
3. Warm the cache so the first start does not time out (a few seconds): `npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz --version`
4. Add this server to the MCP settings file (`cline_mcp_settings.json`, opened from the MCP Servers panel, Configure, "Configure MCP Servers"). Use exactly this launch:

```json
{
  "mcpServers": {
    "youtube-mcp": {
      "command": "npx",
      "args": ["-y", "https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz", "--transport", "stdio"],
      "env": {
        "YOUTUBE_API_KEY": "<the user's key>"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

   Add `YOUTUBE_OAUTH_CLIENT_SECRET_FILE`, `YOUTUBE_MCP_PROFILE_ID` and `YOUTUBE_MCP_CHANNEL_ID` to `env` only if the user gave them. Leave `autoApprove` empty.
5. For account and creator tools, run the one-time sign-in in a terminal (it opens a browser):
   `YOUTUBE_OAUTH_CLIENT_SECRET_FILE=/abs/path/client_secret.json YOUTUBE_MCP_PROFILE_ID=creator-main npx -y https://github.com/pratikgh0se/youtube-mcp/releases/download/v0.3.0/youtube-mcp-0.3.0.tgz youtube-auth`
6. Confirm the `youtube-mcp` server shows its tools, then try `youtube_auth_status`.

Notes: every change to the user's YouTube account is previewed first and needs explicit approval. More detail is in [AGENTS.md](AGENTS.md) and [README.md](README.md).
