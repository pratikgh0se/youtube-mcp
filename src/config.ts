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

export function loadConfig(env: NodeJS.ProcessEnv, homeDir: string): AppConfig {
  const stateDir = env.YOUTUBE_MCP_STATE_DIR ?? `${homeDir}/.youtube-mcp`;

  return {
    apiKey: env.YOUTUBE_API_KEY,
    oauthClientSecretFile: env.YOUTUBE_OAUTH_CLIENT_SECRET_FILE,
    profileId: env.YOUTUBE_MCP_PROFILE_ID,
    channelId: env.YOUTUBE_MCP_CHANNEL_ID,
    stateDir,
    diagnostics: () =>
      `stateDir=${stateDir}; apiKey=${env.YOUTUBE_API_KEY ? 'configured' : 'missing'}; oauth=${env.YOUTUBE_OAUTH_CLIENT_SECRET_FILE ? 'configured' : 'missing'}`,
  };
}
