import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

// dist/sqlite/open-database.js -> package root
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The Claude Desktop bundle ships better-sqlite3 binaries for several Node ABIs
// under native/. Outside the bundle that directory is absent and the default
// better-sqlite3 resolution applies.
function bundledNativeBinding(): string | undefined {
  const candidate = join(
    packageRoot,
    'native',
    `abi-${process.versions.modules}-${process.platform}-${process.arch}`,
    'better_sqlite3.node',
  );
  return existsSync(candidate) ? candidate : undefined;
}

export function openDatabase(path: string, options: Database.Options = {}): Database.Database {
  const nativeBinding = bundledNativeBinding();
  return new Database(path, nativeBinding ? { ...options, nativeBinding } : options);
}
