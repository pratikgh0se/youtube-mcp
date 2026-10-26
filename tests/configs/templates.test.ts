import { describe, expect, it } from 'vitest';

import { loadClientTemplate } from '../../src/transports/http.js';

describe('loadClientTemplate', () => {
  it.each([
    'codex.toml',
    'claude-desktop.json',
    'cursor.json',
    'openclaw.json',
    'hermes.yaml',
    'opencode.json',
    'generic-stdio.json',
  ])('%s resolves to the portable local launch contract', async (name) => {
    await expect(loadClientTemplate(`configs/${name}`)).resolves.toEqual({
      command: 'youtube-mcp',
      args: ['--transport', 'stdio'],
      envKeys: [
        'YOUTUBE_API_KEY',
        'YOUTUBE_MCP_CHANNEL_ID',
        'YOUTUBE_MCP_PROFILE_ID',
        'YOUTUBE_MCP_STATE_DIR',
        'YOUTUBE_OAUTH_CLIENT_SECRET_FILE',
      ],
    });
  });
});
