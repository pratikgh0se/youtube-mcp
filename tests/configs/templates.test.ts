import { describe, expect, it } from 'vitest';

import { loadClientTemplate } from '../../src/transports/http.js';

const ALLOWED_ENV_KEYS = [
  'YOUTUBE_API_KEY',
  'YOUTUBE_MCP_CHANNEL_ID',
  'YOUTUBE_MCP_PROFILE_ID',
  'YOUTUBE_MCP_STATE_DIR',
  'YOUTUBE_OAUTH_CLIENT_SECRET_FILE',
];

describe('loadClientTemplate', () => {
  it.each([
    'codex.toml',
    'claude-desktop.json',
    'cursor.json',
    'openclaw.json',
    'hermes.yaml',
    'opencode.json',
    'generic-stdio.json',
  ])('%s resolves to the canonical npx launch contract', async (name) => {
    const template = await loadClientTemplate(`configs/${name}`);
    expect(template.command).toBe('npx');
    expect(template.args).toEqual(['-y', 'github:pratikgh0se/youtube-mcp#v0.2.0', '--transport', 'stdio']);
    // Configs declare only the env they need; every key must be one of the five supported names.
    for (const key of template.envKeys) expect(ALLOWED_ENV_KEYS).toContain(key);
  });
});
