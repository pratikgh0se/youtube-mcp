import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('published package artifact', () => {
  it('launches youtube-mcp from an extracted package tarball', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-package-'));

    try {
      const { stdout } = await execFileAsync('npm', [
        '--cache', join(directory, 'npm-cache'),
        'pack',
        '--json',
        '--pack-destination', directory,
      ]);
      const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>;
      await execFileAsync('tar', ['-xzf', join(directory, filename), '-C', directory]);
      await expect(access(join(directory, 'package', 'docs', 'CHANGELOG.md'))).resolves.toBeUndefined();
      await expect(access(join(directory, 'package', 'docs', 'README.md'))).resolves.toBeUndefined();
      await expect(access(join(directory, 'package', '.env.example'))).resolves.toBeUndefined();
      await expect(access(join(directory, 'package', 'scripts', 'read-only-smoke.mjs'))).resolves.toBeUndefined();
      await expect(access(join(directory, 'package', 'scripts', 'private-playlist-smoke.mjs'))).resolves.toBeUndefined();
      await symlink(join(process.cwd(), 'node_modules'), join(directory, 'package', 'node_modules'), 'dir');

      const result = await run(process.execPath, [
        join(directory, 'package', 'bin', 'youtube-mcp.mjs'),
        '--transport',
        'unsupported',
      ]);

      expect(result).toEqual({
        code: 1,
        stderr: 'Usage: youtube-mcp --transport stdio|http | youtube-mcp youtube-auth\n',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

function run(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, _stdout, stderr) => {
      if (error && 'code' in error) {
        resolve({ code: error.code as number | null, stderr });
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve({ code: 0, stderr });
    });
  });
}
