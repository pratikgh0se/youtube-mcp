import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type CommandResult = { code: number | null; stderr: string };

describe('youtube-mcp package executable', () => {
  it('routes the template command through the package bin entrypoint', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { bin?: Record<string, string> };
    const executable = packageJson.bin?.['youtube-mcp'];

    expect(executable).toBe('./bin/youtube-mcp.mjs');
    await expect(run(process.execPath, [executable!, '--transport', 'unsupported'])).resolves.toEqual({
      code: 1,
      stderr: 'Usage: youtube-mcp --transport stdio|http | youtube-mcp youtube-auth\n',
    });
  }, 15_000);
});

function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}
