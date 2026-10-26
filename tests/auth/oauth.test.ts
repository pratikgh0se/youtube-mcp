import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/types.js';
import {
  createDesktopOAuthClient,
  OAuthService,
  type OAuthClient,
} from '../../src/auth/oauth.js';

const temporaryDirectories: string[] = [];
const forceSslScope = 'https://www.googleapis.com/auth/youtube.force-ssl';
const youtubeScope = 'https://www.googleapis.com/auth/youtube';
const readonlyScope = 'https://www.googleapis.com/auth/youtube.readonly';
const analyticsReadonlyScope = 'https://www.googleapis.com/auth/yt-analytics.readonly';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function config(
  stateDir: string,
  options: { oauthClientSecretFile?: string } = { oauthClientSecretFile: '/tmp/client-secret.json' },
): AppConfig {
  return {
    oauthClientSecretFile: options.oauthClientSecretFile,
    stateDir,
    diagnostics: () => 'safe diagnostics',
  };
}

async function stateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-oauth-'));
  temporaryDirectories.push(directory);
  return directory;
}

function client(overrides: Partial<OAuthClient> = {}): OAuthClient {
  return {
    authorize: async () => ({ refresh_token: 'refresh-token' }),
    refreshAccessToken: async () => ({ access_token: 'access-token' }),
    ...overrides,
  };
}

describe('OAuthService', () => {
  it('reports local authorization readiness without starting the browser flow', async () => {
    const directory = await stateDir();
    let authorizeCalls = 0;
    const service = new OAuthService(config(directory), client({
      authorize: async () => {
        authorizeCalls += 1;
        return { refresh_token: 'refresh-token' };
      },
    }));

    await expect(service.status()).resolves.toEqual({
      configured: true,
      authorized: false,
      tokenHealth: 'not_authorized',
      scopes: [],
      scopeReadiness: { ready: false, required: [readonlyScope], missing: [readonlyScope] },
      action: 'Run youtube-auth to authorize this account.',
    });
    expect(authorizeCalls).toBe(0);

    await service.completeAuthorization({ refresh_token: 'refresh-token', scope: 'scope-a' });

    await expect(service.status()).resolves.toEqual({
      configured: true,
      authorized: true,
      tokenHealth: 'stored',
      scopes: ['scope-a'],
      scopeReadiness: { ready: false, required: [readonlyScope], missing: [readonlyScope] },
      action: 'Run youtube-auth again to grant the required YouTube scopes.',
    });
  });

  it('refuses provider access when the stored grant lacks the required write scope', async () => {
    const directory = await stateDir();
    let refreshAttempts = 0;
    const service = new OAuthService(config(directory), client({
      refreshAccessToken: async () => {
        refreshAttempts += 1;
        return { access_token: 'access-token' };
      },
    }));
    await service.completeAuthorization({ refresh_token: 'refresh-token', scope: readonlyScope });

    await expect(service.getAccessToken('youtube.write')).rejects.toMatchObject({
      code: 'reauthorization_required',
      action: 'Run youtube-auth again to grant the required YouTube scopes.',
    });
    expect(refreshAttempts).toBe(0);
  });

  it('accepts a broad youtube grant for write tools without requiring force-ssl literally', async () => {
    const directory = await stateDir();
    const service = new OAuthService(config(directory), client());
    await service.completeAuthorization({ refresh_token: 'refresh-token', scope: youtubeScope });

    await expect(service.getAccessToken('youtube.write')).resolves.toBe('access-token');
  });

  it('checks OAuth capability per tool so readonly access is not blocked by write scopes', async () => {
    const directory = await stateDir();
    const service = new OAuthService(config(directory), client());
    await service.completeAuthorization({ refresh_token: 'refresh-token', scope: readonlyScope });

    await expect(service.getAccessToken('youtube.read')).resolves.toBe('access-token');
    await expect(service.getAccessToken('youtube.write')).rejects.toMatchObject({ code: 'reauthorization_required' });
  });

  it('reopens consent when a read-ready stored token is missing server write capabilities', async () => {
    const directory = await stateDir();
    let authorizationAttempts = 0;
    const service = new OAuthService(config(directory), client({
      authorize: async () => {
        authorizationAttempts += 1;
        return { refresh_token: 'replacement-refresh-token', scope: youtubeScope };
      },
    }));
    await service.completeAuthorization({ refresh_token: 'old-refresh-token', scope: readonlyScope });

    await expect(service.authorize()).resolves.toMatchObject({
      authorized: true,
      scopeReadiness: { ready: true, missing: [] },
    });
    expect(authorizationAttempts).toBe(1);
    expect(JSON.parse(await readFile(join(directory, 'oauth-token.json'), 'utf8'))).toEqual({
      refreshToken: 'replacement-refresh-token',
      scopes: [youtubeScope],
    });
  });

  it('reopens consent when a stored broad YouTube grant lacks the requested force-ssl scope', async () => {
    const directory = await stateDir();
    let authorizationAttempts = 0;
    const service = new OAuthService(config(directory), client({
      authorize: async () => {
        authorizationAttempts += 1;
        return {
          refresh_token: 'replacement-refresh-token',
          scope: `${youtubeScope} ${forceSslScope} ${analyticsReadonlyScope}`,
        };
      },
    }));
    await service.completeAuthorization({
      refresh_token: 'old-refresh-token',
      scope: `${youtubeScope} ${analyticsReadonlyScope}`,
    });

    await service.authorize();

    expect(authorizationAttempts).toBe(1);
    expect(JSON.parse(await readFile(join(directory, 'oauth-token.json'), 'utf8'))).toEqual({
      refreshToken: 'replacement-refresh-token',
      scopes: [youtubeScope, forceSslScope, analyticsReadonlyScope],
    });
  });

  it('writes the refresh token to the configured state directory with mode 0o600', async () => {
    const directory = await stateDir();
    const service = new OAuthService(config(directory), client());
    const tokenPath = join(directory, 'oauth-token.json');

    await service.completeAuthorization({ refresh_token: 'refresh-token', scope: `${forceSslScope} scope-a scope-b` });

    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    const savedToken = await readFile(tokenPath, 'utf8');
    expect(savedToken).toContain('refreshToken');
    expect(savedToken).not.toContain('access_token');
    expect(JSON.parse(savedToken)).toEqual({ refreshToken: 'refresh-token', scopes: [forceSslScope, 'scope-a', 'scope-b'] });

    await service.getAccessToken();
    expect(JSON.parse(await readFile(tokenPath, 'utf8'))).toEqual({
      refreshToken: 'refresh-token',
      scopes: [forceSslScope, 'scope-a', 'scope-b'],
    });
  });

  it('keeps a named profile OAuth token separate from the default profile', async () => {
    const directory = await stateDir();
    const profileConfig = { ...config(directory), profileId: 'creator-a' };
    const service = new OAuthService(profileConfig, client());

    await service.completeAuthorization({ refresh_token: 'creator-refresh-token' });

    const profileToken = join(directory, 'profiles', 'creator-a', 'oauth-token.json');
    expect(JSON.parse(await readFile(profileToken, 'utf8'))).toEqual({
      refreshToken: 'creator-refresh-token',
      scopes: [],
    });
    await expect(readFile(join(directory, 'oauth-token.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a profile ID that could escape its profile directory', async () => {
    const directory = await stateDir();
    const service = new OAuthService({ ...config(directory), profileId: '../default' }, client());

    await expect(service.completeAuthorization({ refresh_token: 'refresh-token' })).rejects.toMatchObject({
      code: 'invalid_profile',
    });
  });

  it('returns reauthorization guidance when refresh fails with invalid_grant', async () => {
    const directory = await stateDir();
    const service = new OAuthService(
      config(directory),
      client({ refreshAccessToken: async () => Promise.reject({ error: 'invalid_grant' }) }),
    );

    await service.completeAuthorization({ refresh_token: 'refresh-token', scope: forceSslScope });

    await expect(service.getAccessToken()).rejects.toMatchObject({
      code: 'reauthorization_required',
      action: 'Run youtube-auth to authorize this account.',
      retryable: false,
    });
  });

  it('runs the desktop OAuth callback and exchanges its code without a network request in tests', async () => {
    const directory = await stateDir();
    const calls = {
      browserUrls: [] as string[],
      callbackClosed: false,
      callbackState: '',
      clientSecretPath: '',
      exchangeCode: '',
      oauthClientInput: {} as Record<string, unknown>,
      authorizationOptions: {} as Record<string, unknown>,
    };
    const callback = {
      close: async () => {
        calls.callbackClosed = true;
      },
      redirectUri: 'http://127.0.0.1:43123/oauth2/callback',
      waitForCallback: async () => {
        calls.callbackState = 'state-123';
        return { code: 'authorization-code', state: 'state-123' };
      },
    };
    const desktopClient = createDesktopOAuthClient(config(directory), {
      createOAuthClient: (input) => ({
        generateAuthUrl: (options) => {
          calls.oauthClientInput = input;
          calls.authorizationOptions = options;
          return 'https://accounts.example.test/consent?state=state-123';
        },
        getAccessToken: async () => ({ token: 'access-token' }),
        getToken: async (code: string) => {
          calls.exchangeCode = code;
          return { tokens: { refresh_token: 'refresh-token', scope: `${forceSslScope} scope-a scope-b` } };
        },
        setCredentials: () => undefined,
      }),
      createState: () => 'state-123',
      openBrowser: async (url) => {
        calls.browserUrls.push(url);
      },
      readClientSecretFile: async (path) => {
        calls.clientSecretPath = path;
        return JSON.stringify({
          installed: { client_id: 'client-id', client_secret: 'client-secret' },
        });
      },
      startCallbackServer: async () => callback,
    });
    const service = new OAuthService(
      config(directory),
      desktopClient,
    );

    await expect(service.authorize()).resolves.toEqual({
      configured: true,
      authorized: true,
      scopes: [forceSslScope, 'scope-a', 'scope-b'],
      scopeReadiness: { ready: true, required: [readonlyScope], missing: [] },
    });
    expect(calls).toEqual({
      browserUrls: ['https://accounts.example.test/consent?state=state-123'],
      callbackClosed: true,
      callbackState: 'state-123',
      clientSecretPath: '/tmp/client-secret.json',
      exchangeCode: 'authorization-code',
      oauthClientInput: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://127.0.0.1:43123/oauth2/callback',
      },
      authorizationOptions: {
        access_type: 'offline',
        prompt: 'consent',
        scope: [
          youtubeScope,
          forceSslScope,
          analyticsReadonlyScope,
        ],
        state: 'state-123',
      },
    });
  });

  it('returns a safe configuration error before starting a callback for invalid desktop-client JSON', async () => {
    const directory = await stateDir();
    let callbackStarted = false;
    const desktopClient = createDesktopOAuthClient(config(directory), {
      createOAuthClient: () => {
        throw new Error('must not construct OAuth client');
      },
      createState: () => 'state-123',
      openBrowser: async () => undefined,
      readClientSecretFile: async () => '{}',
      startCallbackServer: async () => {
        callbackStarted = true;
        throw new Error('must not start callback');
      },
    });

    await expect(new OAuthService(config(directory), desktopClient).authorize()).rejects.toMatchObject({
      code: 'oauth_configuration_invalid',
      action: 'Set YOUTUBE_OAUTH_CLIENT_SECRET_FILE to a Google OAuth desktop-client JSON file.',
      retryable: false,
    });
    expect(callbackStarted).toBe(false);
  });

  it('returns a safe error when the local callback is denied without exchanging a code', async () => {
    const directory = await stateDir();
    let exchangeAttempted = false;
    const desktopClient = createDesktopOAuthClient(config(directory), {
      createOAuthClient: () => ({
        generateAuthUrl: () => 'https://accounts.example.test/consent',
        getAccessToken: async () => ({ token: 'access-token' }),
        getToken: async () => {
          exchangeAttempted = true;
          return { tokens: {} };
        },
        setCredentials: () => undefined,
      }),
      createState: () => 'state-123',
      openBrowser: async () => undefined,
      readClientSecretFile: async () => JSON.stringify({ installed: { client_id: 'id' } }),
      startCallbackServer: async () => ({
        close: async () => undefined,
        redirectUri: 'http://127.0.0.1:43123/oauth2/callback',
        waitForCallback: async () => ({ error: 'access_denied', state: 'state-123' }),
      }),
    });

    await expect(new OAuthService(config(directory), desktopClient).authorize()).rejects.toMatchObject({
      code: 'authorization_failed',
      action: 'Run youtube-auth again.',
      retryable: false,
    });
    expect(exchangeAttempted).toBe(false);
  });

  it('does not attempt authorization when the desktop client is not configured', async () => {
    const directory = await stateDir();
    const service = new OAuthService(config(directory, {}));

    await expect(service.authorize()).resolves.toEqual({
      configured: false,
      authorized: false,
      scopes: [],
      scopeReadiness: { ready: false, required: [readonlyScope], missing: [readonlyScope] },
      action: 'Set YOUTUBE_OAUTH_CLIENT_SECRET_FILE to a Google OAuth desktop-client JSON file.',
    });
  });

  it('does not accept a callback result without a refresh token', async () => {
    const directory = await stateDir();
    const service = new OAuthService(config(directory), client());

    await expect(service.completeAuthorization({ scope: 'scope-a' })).rejects.toMatchObject({
      code: 'authorization_failed',
      action: 'Run youtube-auth again.',
      retryable: false,
    });
  });

  it('does not expose filesystem details when token persistence fails', async () => {
    const directory = await stateDir();
    const blockedStateDir = join(directory, 'not-a-directory');
    await writeFile(blockedStateDir, 'blocked');
    const service = new OAuthService(config(blockedStateDir), client());

    await expect(service.completeAuthorization({ refresh_token: 'refresh-token' })).rejects.toMatchObject({
      code: 'provider_error',
      action: expect.any(String),
      message: expect.not.stringContaining('not-a-directory'),
    });
  });

  it('rejects an empty stored refresh token before calling the provider', async () => {
    const directory = await stateDir();
    let refreshAttempts = 0;
    await writeFile(
      join(directory, 'oauth-token.json'),
      JSON.stringify({ refreshToken: '', scopes: ['scope-a'] }),
    );
    const service = new OAuthService(
      config(directory),
      client({
        refreshAccessToken: async () => {
          refreshAttempts += 1;
          return { access_token: 'access-token' };
        },
      }),
    );

    await expect(service.getAccessToken()).rejects.toMatchObject({
      code: 'reauthorization_required',
      action: 'Run youtube-auth to authorize this account.',
    });
    expect(refreshAttempts).toBe(0);
  });
});
