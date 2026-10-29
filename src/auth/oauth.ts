import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { google } from 'googleapis';

import type { AppConfig } from '../types.js';
import { AppError, invalidProfileError, toSafeError } from '../errors.js';

const tokenFileName = 'oauth-token.json';
const callbackPath = '/oauth2/callback';
const forceSslScope = 'https://www.googleapis.com/auth/youtube.force-ssl';
const youtubeScope = 'https://www.googleapis.com/auth/youtube';
const youtubeReadonlyScope = 'https://www.googleapis.com/auth/youtube.readonly';
const youtubeUploadScope = 'https://www.googleapis.com/auth/youtube.upload';
const analyticsReadonlyScope = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const youtubeScopes = [
  youtubeScope,
  forceSslScope,
  analyticsReadonlyScope,
];

export type OAuthCapability = 'youtube.read' | 'youtube.write' | 'youtube.upload' | 'analytics.read';

const capabilityScopes: Record<OAuthCapability, { required: string; accepted: readonly string[] }> = {
  'youtube.read': { required: youtubeReadonlyScope, accepted: [youtubeReadonlyScope, forceSslScope, youtubeScope] },
  'youtube.write': { required: forceSslScope, accepted: [forceSslScope, youtubeScope] },
  'youtube.upload': { required: youtubeUploadScope, accepted: [youtubeUploadScope, youtubeScope] },
  'analytics.read': { required: analyticsReadonlyScope, accepted: [analyticsReadonlyScope, youtubeReadonlyScope, youtubeScope] },
};

type AuthorizationTokens = {
  refresh_token?: string;
  scope?: string;
};

type StoredToken = {
  refreshToken: string;
  scopes: string[];
};

export type AuthStatus = {
  configured: boolean;
  authorized: boolean;
  tokenHealth?: 'stored' | 'not_authorized' | 'not_configured';
  apiKeyConfigured?: boolean;
  localStorage?: { available: false; code: string; message: string; action: string };
  localConsumption?: { databaseInitialized: boolean; hasImportedHistory: boolean };
  scopes: string[];
  scopeReadiness: { ready: boolean; required: string[]; missing: string[] };
  action?: string;
};

export type OAuthClient = {
  refreshAccessToken(refreshToken: string): Promise<{ access_token?: string }>;
  authorize(): Promise<AuthorizationTokens>;
};

type OAuth2Client = {
  generateAuthUrl(options: { access_type: 'offline'; prompt: 'consent'; scope: string[]; state: string }): string;
  getAccessToken(): Promise<{ token?: string | null }>;
  getToken(code: string): Promise<{ tokens: AuthorizationTokens }>;
  setCredentials(credentials: { refresh_token: string }): void;
};

type CallbackResult = {
  code?: string;
  error?: string;
  state?: string;
};

type CallbackServer = {
  close(): Promise<void>;
  redirectUri: string;
  waitForCallback(): Promise<CallbackResult>;
};

export type DesktopOAuthClientDependencies = {
  createOAuthClient(input: {
    clientId: string;
    clientSecret?: string;
    redirectUri?: string;
  }): OAuth2Client;
  createState(): string;
  openBrowser(url: string): Promise<void>;
  readClientSecretFile(path: string): Promise<string>;
  startCallbackServer(): Promise<CallbackServer>;
};

export class OAuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly client: OAuthClient = createDesktopOAuthClient(config),
  ) {}

  async authorize(): Promise<AuthStatus> {
    if (!this.config.oauthClientSecretFile) {
      return {
        configured: false,
        authorized: false,
        scopes: [],
        scopeReadiness: scopeReadiness([]),
        action: 'Set YOUTUBE_OAUTH_CLIENT_SECRET_FILE to a Google OAuth desktop-client JSON file.',
      };
    }

    const storedToken = await this.readStoredToken(false);
    if (storedToken && hasRequestedServerCapabilities(storedToken.scopes)) {
      return authorizedStatus(storedToken.scopes);
    }

    try {
      return await this.completeAuthorization(await this.client.authorize());
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async status(): Promise<AuthStatus> {
    if (!this.config.oauthClientSecretFile) {
      return {
        configured: false,
        authorized: false,
        tokenHealth: 'not_configured',
        scopes: [],
        scopeReadiness: scopeReadiness([]),
        action: 'Set YOUTUBE_OAUTH_CLIENT_SECRET_FILE to a Google OAuth desktop-client JSON file.',
      };
    }

    try {
      const storedToken = await this.readStoredToken(false);
      return storedToken
        ? authorizedStatus(storedToken.scopes, 'stored')
        : { configured: true, authorized: false, tokenHealth: 'not_authorized', scopes: [], scopeReadiness: scopeReadiness([]), action: 'Run youtube-auth to authorize this account.' };
    } catch (error) {
      const safe = toSafeError(error);
      return { configured: true, authorized: false, tokenHealth: 'not_authorized', scopes: [], scopeReadiness: scopeReadiness([]), action: safe.action };
    }
  }

  async getAccessToken(capability: OAuthCapability = 'youtube.read'): Promise<string> {
    const storedToken = await this.readStoredToken(true);
    const readiness = scopeReadiness(storedToken.scopes, capability);
    if (!readiness.ready) {
      throw new AppError(
        'reauthorization_required',
        'The stored YouTube authorization is missing required scopes.',
        'Run youtube-auth again to grant the required YouTube scopes.',
        false,
      );
    }

    try {
      const response = await this.client.refreshAccessToken(storedToken.refreshToken);
      if (!response.access_token) {
        throw new AppError(
          'provider_error',
          'The YouTube provider did not return an access token.',
          'Run youtube-auth to authorize this account.',
          false,
        );
      }
      return response.access_token;
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async completeAuthorization(tokens: AuthorizationTokens): Promise<AuthStatus> {
    if (!tokens.refresh_token) {
      throw new AppError(
        'authorization_failed',
        'Google did not provide a refresh token.',
        'Run youtube-auth again.',
        false,
      );
    }

    const scopes = tokens.scope?.split(' ').filter(Boolean) ?? [];
    await this.writeTokenAtomically({ refreshToken: tokens.refresh_token, scopes });
    return authorizedStatus(scopes);
  }

  private get tokenPath(): string {
    return this.config.profileId
      ? join(this.config.stateDir, 'profiles', safeProfileId(this.config.profileId), tokenFileName)
      : join(this.config.stateDir, tokenFileName);
  }

  private async readStoredToken(required: true): Promise<StoredToken>;
  private async readStoredToken(required: false): Promise<StoredToken | undefined>;
  private async readStoredToken(required: boolean): Promise<StoredToken | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.tokenPath, 'utf8'));
      if (!isStoredToken(parsed)) {
        throw new AppError(
          'reauthorization_required',
          'The stored YouTube authorization is invalid.',
          'Run youtube-auth to authorize this account.',
          false,
        );
      }
      return parsed;
    } catch (error) {
      if (isMissingFileError(error) && !required) {
        return undefined;
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        'reauthorization_required',
        'No valid YouTube authorization is stored locally.',
        'Run youtube-auth to authorize this account.',
        false,
      );
    }
  }

  private async writeTokenAtomically(token: StoredToken): Promise<void> {
    const tokenDirectory = dirname(this.tokenPath);
    const temporaryPath = join(tokenDirectory, `.${tokenFileName}.${randomUUID()}.tmp`);
    try {
      await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
      await chmod(tokenDirectory, 0o700);
      await writeFile(temporaryPath, JSON.stringify(token), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.tokenPath);
      await chmod(this.tokenPath, 0o600);
    } catch (error) {
      throw toSafeError(error);
    }
  }
}

function authorizedStatus(scopes: string[], tokenHealth?: 'stored'): AuthStatus {
  const readiness = scopeReadiness(scopes);
  return {
    configured: true,
    authorized: true,
    ...(tokenHealth ? { tokenHealth } : {}),
    scopes,
    scopeReadiness: readiness,
    ...(!readiness.ready ? { action: 'Run youtube-auth again to grant the required YouTube scopes.' } : {}),
  };
}

function scopeReadiness(scopes: string[], capability: OAuthCapability = 'youtube.read'): AuthStatus['scopeReadiness'] {
  const requirement = capabilityScopes[capability];
  const ready = requirement.accepted.some((scope) => scopes.includes(scope));
  return { ready, required: [requirement.required], missing: ready ? [] : [requirement.required] };
}

function hasRequestedServerCapabilities(scopes: string[]): boolean {
  return youtubeScopes.every((scope) => scopes.includes(scope));
}

function safeProfileId(profileId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(profileId)) {
    throw invalidProfileError();
  }
  return profileId;
}

function isStoredToken(value: unknown): value is StoredToken {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { refreshToken?: unknown; scopes?: unknown };
  return (
    typeof candidate.refreshToken === 'string' &&
    candidate.refreshToken.trim().length > 0 &&
    Array.isArray(candidate.scopes) &&
    candidate.scopes.every((scope) => typeof scope === 'string')
  );
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function createDesktopOAuthClient(
  config: AppConfig,
  dependencies: DesktopOAuthClientDependencies = defaultDesktopOAuthClientDependencies,
): OAuthClient {
  return {
    async authorize(): Promise<AuthorizationTokens> {
      const credentials = await loadDesktopCredentials(config, dependencies);
      const callbackServer = await dependencies.startCallbackServer();

      try {
        const oauthClient = dependencies.createOAuthClient({
          ...credentials,
          redirectUri: callbackServer.redirectUri,
        });
        const state = dependencies.createState();
        const authorizationUrl = oauthClient.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: youtubeScopes,
          state,
        });
        await dependencies.openBrowser(authorizationUrl);

        const callback = await callbackServer.waitForCallback();
        if (callback.error || !callback.code || callback.state !== state) {
          throw new AppError(
            'authorization_failed',
            'Google authorization was not completed.',
            'Run youtube-auth again.',
            false,
          );
        }

        return (await oauthClient.getToken(callback.code)).tokens;
      } finally {
        await callbackServer.close();
      }
    },

    async refreshAccessToken(refreshToken: string): Promise<{ access_token?: string }> {
      const credentials = await loadDesktopCredentials(config, dependencies);
      const oauthClient = dependencies.createOAuthClient(credentials);
      oauthClient.setCredentials({ refresh_token: refreshToken });
      const response = await oauthClient.getAccessToken();
      return { access_token: response.token ?? undefined };
    },
  };
}

async function loadDesktopCredentials(
  config: AppConfig,
  dependencies: DesktopOAuthClientDependencies,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!config.oauthClientSecretFile) {
    throw new AppError(
      'oauth_configuration_invalid',
      'The OAuth desktop-client configuration is missing.',
      'Set YOUTUBE_OAUTH_CLIENT_SECRET_FILE to a Google OAuth desktop-client JSON file.',
      false,
    );
  }

  try {
    const parsed: unknown = JSON.parse(await dependencies.readClientSecretFile(config.oauthClientSecretFile));
    const installed = (parsed as { installed?: unknown }).installed;
    if (typeof installed !== 'object' || installed === null) {
      throw new Error('missing installed OAuth client');
    }

    const candidate = installed as { client_id?: unknown; client_secret?: unknown };
    if (typeof candidate.client_id !== 'string' || candidate.client_id.trim().length === 0) {
      throw new Error('missing OAuth client id');
    }

    return {
      clientId: candidate.client_id,
      ...(typeof candidate.client_secret === 'string' ? { clientSecret: candidate.client_secret } : {}),
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      'oauth_configuration_invalid',
      'The OAuth desktop-client configuration is invalid.',
      'Set YOUTUBE_OAUTH_CLIENT_SECRET_FILE to a Google OAuth desktop-client JSON file.',
      false,
    );
  }
}

const defaultDesktopOAuthClientDependencies: DesktopOAuthClientDependencies = {
  createOAuthClient: ({ clientId, clientSecret, redirectUri }) => {
    const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    return {
      generateAuthUrl: (options) => client.generateAuthUrl(options),
      getAccessToken: async () => ({ token: (await client.getAccessToken()).token }),
      getToken: async (code) => {
        const { tokens } = await client.getToken(code);
        return { tokens: { refresh_token: tokens.refresh_token ?? undefined, scope: tokens.scope } };
      },
      setCredentials: (credentials) => client.setCredentials(credentials),
    };
  },
  createState: randomUUID,
  openBrowser: openBrowser,
  readClientSecretFile: (path) => readFile(path, 'utf8'),
  startCallbackServer: startCallbackServer,
};

function openBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];

  return new Promise((resolve, reject) => {
    const browser = spawn(command, args, { detached: true, stdio: 'ignore' });
    browser.once('error', reject);
    browser.once('spawn', () => {
      browser.unref();
      resolve();
    });
  });
}

async function startCallbackServer(): Promise<CallbackServer> {
  let resolveCallback: (result: CallbackResult) => void;
  const callback = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== callbackPath) {
      response.writeHead(404).end('Not found');
      return;
    }

    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Authorization complete. You can close this window.');
    resolveCallback({
      code: url.searchParams.get('code') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not start the local OAuth callback.'));
        return;
      }

      resolve({
        close: () => closeServer(server),
        redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`,
        waitForCallback: () => callback,
      });
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
