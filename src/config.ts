import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AppConfig } from './types.js';

/** Loads a project-local .env once at startup, keeping shell values authoritative. */
export function loadProjectEnvFile(projectDirectory: string): boolean {
  const envFile = join(projectDirectory, '.env');
  if (!existsSync(envFile)) return false;

  try {
    process.loadEnvFile(envFile);
    return true;
  } catch {
    return false;
  }
}

/** Reads an environment variable, treating an empty string as unset (plugin and extension hosts pass "" for blank optional settings). */
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function loadConfig(env: NodeJS.ProcessEnv, homeDir: string): AppConfig {
  const stateDir = readEnv(env, 'YOUTUBE_MCP_STATE_DIR') ?? `${homeDir}/.youtube-mcp`;
  const apiKey = readEnv(env, 'YOUTUBE_API_KEY');
  const oauthClientSecretFile = readEnv(env, 'YOUTUBE_OAUTH_CLIENT_SECRET_FILE');

  return {
    apiKey,
    oauthClientSecretFile,
    profileId: readEnv(env, 'YOUTUBE_MCP_PROFILE_ID'),
    channelId: readEnv(env, 'YOUTUBE_MCP_CHANNEL_ID'),
    stateDir,
    diagnostics: () =>
      `stateDir=${stateDir}; apiKey=${apiKey ? 'configured' : 'missing'}; oauth=${oauthClientSecretFile ? 'configured' : 'missing'}`,
  };
}
