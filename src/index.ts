import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OAuthService } from './auth/oauth.js';
import { loadConfig, loadProjectEnvFile } from './config.js';
import { ConsumptionInsights } from './consumption/insights.js';
import { TakeoutImporter } from './consumption/importer.js';
import { ConsumptionStore } from './consumption/store.js';
import { CurationStore } from './consumption/curation-store.js';
import { CurationService, ProfileCurationService } from './consumption/curation.js';
import { createMcpServer } from './mcp/server.js';
import { createApprovalTool } from './operations/approval.js';
import { OperationService } from './operations/service.js';
import { OperationStore } from './operations/store.js';
import { parseHttpPort, runHttp } from './transports/http.js';
import { runStdio } from './transports/stdio.js';
import { CreatorAnalyticsService } from './youtube/analytics.js';
import { AccountService } from './youtube/account.js';
import { YouTubeClient } from './youtube/client.js';
import { PublicService } from './youtube/public.js';
import { ResourceService } from './youtube/resources.js';
import { UploadStore } from './youtube/upload-store.js';
import { UploadService } from './youtube/uploads.js';
import { CreatorContentService, createCreatorContentProvider } from './youtube/creator-content.js';
import { PlaylistService, createPlaylistProvider } from './youtube/playlists.js';
import { ModerationService, createModerationProvider } from './youtube/moderation.js';
import { ChannelProfileService, createChannelProvider } from './youtube/channel-profile.js';
import { SubscriptionCurationService, createSubscriptionProvider } from './youtube/subscriptions.js';
import type { AppConfig } from './types.js';

async function main(arguments_: string[]): Promise<void> {
  if (arguments_[0] === '--version') {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };
    process.stdout.write(`${manifest.version}\n`);
    return;
  }

  loadProjectEnvFile(process.cwd());
  const config = loadConfig(process.env, homedir());
  const oauth = new OAuthService(config);

  if (arguments_[0] === 'youtube-auth') {
    process.stdout.write(`${JSON.stringify(await oauth.authorize())}\n`);
    return;
  }

  if (arguments_[0] !== '--transport' || !arguments_[1]) {
    throw new Error('Usage: youtube-mcp --transport stdio|http | youtube-mcp youtube-auth');
  }

  const client = new YouTubeClient(config);
  const consumptionDatabasePath = join(config.stateDir, 'consumption.sqlite');
  const store = new ConsumptionStore(consumptionDatabasePath);
  const operations = new OperationService(new OperationStore(config.stateDir));
  const resources = new ResourceService(oauth, client, selectedCreatorProfile(config));
  const creatorProfile = selectedCreatorProfile(config);
  const uploads = new UploadService(operations, new UploadStore(config.stateDir, { profileId: creatorProfile.id, channelId: creatorProfile.channelId }), {
    initialize: async (input) => client.resumableUpload(await oauth.getAccessToken('youtube.upload')).initialize(input),
    probe: async (sessionUrl, fileSize) => client.resumableUpload(await oauth.getAccessToken('youtube.upload')).probe(sessionUrl, fileSize),
    uploadChunk: async (input) => client.resumableUpload(await oauth.getAccessToken('youtube.upload')).uploadChunk(input),
    cancel: async (sessionUrl) => client.resumableUpload(await oauth.getAccessToken('youtube.upload')).cancel(sessionUrl),
  }, creatorProfile, resources);
  const content = new CreatorContentService(operations, resources, createCreatorContentProvider(oauth, client), selectedCreatorProfile(config));
  const playlists = new PlaylistService(operations, createPlaylistProvider(oauth, client), selectedCreatorProfile(config), resources);
  const moderation = new ModerationService(operations, createModerationProvider(oauth, client), creatorProfile, resources);
  const curationStore = new CurationStore(consumptionDatabasePath);
  const curation = new ProfileCurationService(new CurationService(curationStore), curationStore, config.profileId ?? '');
  const dependencies = {
    auth: {
      status: async () => ({
        ...await oauth.status(),
        apiKeyConfigured: Boolean(config.apiKey),
        localConsumption: existsSync(consumptionDatabasePath)
          ? { databaseInitialized: true, hasImportedHistory: store.hasImportedHistory() }
          : { databaseInitialized: false, hasImportedHistory: false },
      }),
    },
    public: new PublicService(client),
    account: new AccountService(oauth, client, resources),
    creator: new CreatorAnalyticsService(oauth, client),
    resources,
    uploads,
    content,
    playlists,
    moderation,
    channelProfile: new ChannelProfileService(operations, createChannelProvider(oauth, client), creatorProfile, resources),
    subscriptions: new SubscriptionCurationService(operations, createSubscriptionProvider(oauth, client), creatorProfile),
    approvals: createApprovalTool(operations, creatorProfile),
    curation,
    importer: new TakeoutImporter(store),
    insights: new ConsumptionInsights(store),
  };
  const createServer = () => createMcpServer(dependencies);

  if (arguments_[1] === 'stdio') {
    await runStdio(createServer());
    return;
  }
  if (arguments_[1] === 'http') {
    await runHttp(createServer, { host: '127.0.0.1', port: parseHttpPort(process.env.PORT) });
    return;
  }
  throw new Error('Usage: youtube-mcp --transport stdio|http | youtube-mcp youtube-auth');
}

function selectedCreatorProfile(config: AppConfig): { id: string; purpose: 'creator'; channelId: string } {
  return { id: config.profileId ?? '', purpose: 'creator', channelId: config.channelId ?? '' };
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'YouTube MCP could not start.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
