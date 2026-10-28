import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isSqliteExperimentalWarning } from '../../src/sqlite/warning-filter.js';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');

describe('sqlite experimental warning filter', () => {
  it('matches only the SQLite ExperimentalWarning', () => {
    const sqlite = Object.assign(new Error('SQLite is an experimental feature and might change at any time'), { name: 'ExperimentalWarning' });
    const other = Object.assign(new Error('Fetch is an experimental feature'), { name: 'ExperimentalWarning' });
    expect(isSqliteExperimentalWarning(sqlite)).toBe(true);
    expect(isSqliteExperimentalWarning('SQLite is an experimental feature', 'ExperimentalWarning')).toBe(true);
    expect(isSqliteExperimentalWarning(other)).toBe(false);
    expect(isSqliteExperimentalWarning(new Error('SQLite deprecated'))).toBe(false);
  });

  it('drops the sqlite warning but keeps other warnings, and never writes to stdout', () => {
    const script = `
      import { suppressSqliteExperimentalWarning } from './dist/sqlite/warning-filter.js';
      import { openDatabase } from './dist/sqlite/open-database.js';
      suppressSqliteExperimentalWarning();
      openDatabase(':memory:').close();
      process.emitWarning('other experimental thing', 'ExperimentalWarning');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toMatch(/SQLite is an experimental/i);
    expect(result.stderr).toMatch(/other experimental thing/);
  });
});
