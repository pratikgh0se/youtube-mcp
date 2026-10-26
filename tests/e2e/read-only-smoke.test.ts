import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type PackageJson = { scripts?: Record<string, string> };

describe('test-ready local handoff', () => {
  it('ships every documented local command and all portable client templates', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as PackageJson;

    expect(pkg.scripts).toMatchObject({
      auth: expect.any(String),
      'dev:stdio': expect.any(String),
      'dev:http': expect.any(String),
      'smoke:read-only': expect.any(String),
    });

    await expect(readFile('docs/README.md', 'utf8')).resolves.toContain('confirm: true');
    await expect(readFile('.env.example', 'utf8')).resolves.toContain('YOUTUBE_LIVE_SMOKE=0');

    await expect(Promise.all([
      'claude-desktop.json',
      'codex.toml',
      'cursor.json',
      'generic-stdio.json',
      'hermes.yaml',
      'openclaw.json',
      'opencode.json',
    ].map((template) => readFile(`configs/${template}`, 'utf8')))).resolves.toHaveLength(7);
  });

  it('keeps the default smoke command offline and read-only', async () => {
    const smokeCommand = JSON.parse(await readFile('package.json', 'utf8')) as PackageJson;
    expect(smokeCommand.scripts?.['smoke:read-only']).toBe('node scripts/read-only-smoke.mjs');
    expect(smokeCommand.scripts?.['smoke:read-only']).not.toContain('youtube-auth');
    await expect(readFile('scripts/read-only-smoke.mjs', 'utf8')).resolves.toContain("YOUTUBE_LIVE_SMOKE === '1'");
  });
});
