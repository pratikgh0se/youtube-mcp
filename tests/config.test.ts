import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, loadProjectEnvFile } from '../src/config.js';

describe('loadConfig', () => {
  it('loads a project .env without replacing an explicitly supplied environment variable', () => {
    const projectDirectory = mkdtempSync(join(tmpdir(), 'youtube-mcp-config-'));
    const apiKeyName = 'YOUTUBE_MCP_TEST_API_KEY';
    const oauthName = 'YOUTUBE_MCP_TEST_OAUTH_FILE';
    const originalApiKey = process.env[apiKeyName];
    const originalOAuthFile = process.env[oauthName];

    try {
      writeFileSync(
        join(projectDirectory, '.env'),
        `${apiKeyName}=from-dotenv\n${oauthName}=from-dotenv-oauth\n`,
      );
      process.env[apiKeyName] = 'from-shell';
      delete process.env[oauthName];

      expect(loadProjectEnvFile(projectDirectory)).toBe(true);
      expect(process.env[apiKeyName]).toBe('from-shell');
      expect(process.env[oauthName]).toBe('from-dotenv-oauth');
    } finally {
      if (originalApiKey === undefined) delete process.env[apiKeyName];
      else process.env[apiKeyName] = originalApiKey;
      if (originalOAuthFile === undefined) delete process.env[oauthName];
      else process.env[oauthName] = originalOAuthFile;
      rmSync(projectDirectory, { force: true, recursive: true });
    }
  });

  it('does not fail when the project .env is absent or malformed', () => {
    const projectDirectory = mkdtempSync(join(tmpdir(), 'youtube-mcp-config-'));

    try {
      expect(loadProjectEnvFile(projectDirectory)).toBe(false);
      writeFileSync(join(projectDirectory, '.env'), 'not a valid dotenv declaration\n');
      expect(() => loadProjectEnvFile(projectDirectory)).not.toThrow();
    } finally {
      rmSync(projectDirectory, { force: true, recursive: true });
    }
  });

  it('uses the documented local state-dir default and never exposes secret values', () => {
    const config = loadConfig(
      {
        YOUTUBE_API_KEY: 'secret-key',
        YOUTUBE_OAUTH_CLIENT_SECRET_FILE: '/private/client-secret.json',
      },
      '/Users/tester',
    );

    expect(config.stateDir).toBe('/Users/tester/.youtube-mcp');
    expect(config.diagnostics()).not.toContain('secret-key');
    expect(config.diagnostics()).not.toContain('/private/client-secret.json');
    expect(config.diagnostics()).toContain('oauth=configured');
  });

  it('uses an explicit state directory when configured', () => {
    const config = loadConfig(
      { YOUTUBE_MCP_STATE_DIR: '/var/lib/youtube-mcp' },
      '/Users/tester',
    );

    expect(config.stateDir).toBe('/var/lib/youtube-mcp');
  });

  it('treats an empty-string variable as unset and falls back to the default', () => {
    const config = loadConfig(
      {
        YOUTUBE_API_KEY: '',
        YOUTUBE_OAUTH_CLIENT_SECRET_FILE: '',
        YOUTUBE_MCP_PROFILE_ID: '',
        YOUTUBE_MCP_CHANNEL_ID: '',
        YOUTUBE_MCP_STATE_DIR: '',
      },
      '/Users/tester',
    );

    expect(config.stateDir).toBe('/Users/tester/.youtube-mcp');
    expect(config.apiKey).toBeUndefined();
    expect(config.oauthClientSecretFile).toBeUndefined();
    expect(config.profileId).toBeUndefined();
    expect(config.channelId).toBeUndefined();
    expect(config.diagnostics()).toContain('apiKey=missing');
    expect(config.diagnostics()).toContain('oauth=missing');
  });

  it('keeps non-empty values for every variable', () => {
    const config = loadConfig(
      {
        YOUTUBE_API_KEY: 'key',
        YOUTUBE_OAUTH_CLIENT_SECRET_FILE: '/private/client.json',
        YOUTUBE_MCP_PROFILE_ID: 'creator-main',
        YOUTUBE_MCP_CHANNEL_ID: 'UC123',
        YOUTUBE_MCP_STATE_DIR: '/var/lib/youtube-mcp',
      },
      '/Users/tester',
    );

    expect(config).toMatchObject({
      apiKey: 'key',
      oauthClientSecretFile: '/private/client.json',
      profileId: 'creator-main',
      channelId: 'UC123',
      stateDir: '/var/lib/youtube-mcp',
    });
  });
});
