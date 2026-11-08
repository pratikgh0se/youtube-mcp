import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OAuthService, type OAuthClient } from '../src/auth/oauth.js';
import type { AppConfig } from '../src/types.js';

const youtubeScope = 'https://www.googleapis.com/auth/youtube';
const forceSslScope = 'https://www.googleapis.com/auth/youtube.force-ssl';
const analyticsScope = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const fullScopes = [youtubeScope, forceSslScope, analyticsScope];

const storedRefresh = 'FAKE-STORED-REFRESH-7f3a91c2';
const newRefresh = 'FAKE-NEW-REFRESH-b84e0d55';
const accessValue = 'FAKE-ACCESS-TOKEN-5c1d2e9a';
const usage = 'Usage: youtube-mcp --transport stdio|http | youtube-mcp youtube-auth [--force]';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'youtube-mcp-reauth-'));
  directories.push(d);
  return d;
}

function config(stateDir: string): AppConfig {
  return {
    oauthClientSecretFile: '/tmp/client-secret.json',
    stateDir,
    diagnostics: () => 'safe diagnostics',
  };
}

async function setup(refresh: OAuthClient['refreshAccessToken'], withToken = true) {
  const dir = await tempDir();
  const tokenPath = join(dir, 'oauth-token.json');
  if (withToken) {
    await writeFile(tokenPath, JSON.stringify({ refreshToken: storedRefresh, scopes: fullScopes }));
  }
  const calls = { refresh: 0, authorize: 0 };
  const client: OAuthClient = {
    refreshAccessToken: async (token) => {
      calls.refresh += 1;
      return refresh(token);
    },
    authorize: async () => {
      calls.authorize += 1;
      return { refresh_token: newRefresh, scope: fullScopes.join(' ') };
    },
  };
  const service = new OAuthService(config(dir), client);
  return { service, calls, tokenPath };
}

const readToken = (path: string) => readFile(path, 'utf8');

async function expectReplaced(tokenPath: string) {
  const saved = JSON.parse(await readToken(tokenPath));
  expect(saved.refreshToken).toBe(newRefresh);
}

describe('OAuthService.authorize re-authorization', () => {
  it('keeps a stored token whose refresh succeeds and does not open consent', async () => {
    const { service, calls, tokenPath } = await setup(async () => ({ access_token: accessValue }));
    const before = await readToken(tokenPath);

    await expect(service.authorize()).resolves.toMatchObject({ authorized: true });

    expect(calls.authorize).toBe(0);
    expect(await readToken(tokenPath)).toBe(before);
  });

  it.each([
    ['error invalid_grant', () => Promise.reject({ error: 'invalid_grant' })],
    ['response.data invalid_grant', () => Promise.reject({ response: { data: { error: 'invalid_grant' } } })],
    ['resolve without access_token', async () => ({})],
  ])('re-authorizes and replaces the token on %s', async (_name, refresh) => {
    const { service, calls, tokenPath } = await setup(refresh as OAuthClient['refreshAccessToken']);

    await expect(service.authorize()).resolves.toMatchObject({ authorized: true });

    expect(calls.authorize).toBe(1);
    await expectReplaced(tokenPath);
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'))],
    ['HTTP 503', () => Promise.reject({ response: { status: 503 } })],
  ])('throws a retryable provider_error and keeps the token on %s', async (_name, refresh) => {
    const { service, calls, tokenPath } = await setup(refresh as OAuthClient['refreshAccessToken']);
    const before = await readToken(tokenPath);

    await expect(service.authorize()).rejects.toMatchObject({ code: 'provider_error', retryable: true });

    expect(calls.authorize).toBe(0);
    expect(await readToken(tokenPath)).toBe(before);
  });

  it('forces consent without refreshing and replaces a valid stored token', async () => {
    const { service, calls, tokenPath } = await setup(async () => ({ access_token: accessValue }));

    await expect(service.authorize({ force: true })).resolves.toMatchObject({ authorized: true });

    expect(calls.refresh).toBe(0);
    expect(calls.authorize).toBe(1);
    await expectReplaced(tokenPath);
  });

  it('starts consent when no token is stored', async () => {
    const { service, calls, tokenPath } = await setup(async () => ({ access_token: accessValue }), false);

    await expect(service.authorize()).resolves.toMatchObject({ authorized: true });

    expect(calls.authorize).toBe(1);
    await expectReplaced(tokenPath);
  });

  it('never leaks token values in errors or returned status', async () => {
    const leaky = new Error(`getaddrinfo ENOTFOUND oauth2.googleapis.com ${storedRefresh}`);
    const transient = await setup(() => Promise.reject(leaky));
    const outputs: string[] = [];
    try {
      await transient.service.authorize();
    } catch (error) {
      const e = error as { message?: string; action?: string };
      outputs.push(String(e.message), String(e.action), JSON.stringify(error), String(error));
    }
    expect(outputs.length).toBeGreaterThan(0);

    const success = await setup(async () => ({ access_token: accessValue }));
    outputs.push(JSON.stringify(await success.service.authorize()));
    const forced = await setup(async () => ({ access_token: accessValue }));
    outputs.push(JSON.stringify(await forced.service.authorize({ force: true })));
    const rejected = await setup(() => Promise.reject({ error: 'invalid_grant' }));
    outputs.push(JSON.stringify(await rejected.service.authorize()));

    for (const output of outputs) {
      for (const secret of [storedRefresh, newRefresh, accessValue]) {
        expect(output).not.toContain(secret);
      }
    }
  });
});

describe('youtube-auth CLI', () => {
  it('rejects unknown flags with usage on stderr and opens no browser', async () => {
    const root = resolve(__dirname, '..');
    const entry = join(root, 'dist', 'index.js');
    if (!existsSync(entry)) {
      const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
      expect(build.status).toBe(0);
    }
    const dir = await tempDir();
    const result = spawnSync(process.execPath, [entry, 'youtube-auth', '--bogus'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        YOUTUBE_MCP_STATE_DIR: dir,
        BROWSER: 'true',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).toContain(usage);
  });
});
