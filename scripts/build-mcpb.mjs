#!/usr/bin/env node
// Builds a per-platform Claude Desktop bundle (.mcpb). better-sqlite3 is a
// native addon, so each bundle is built on (and only valid for) its own OS/arch.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bump ELECTRON when Claude Desktop's Electron changes (ABI = its process.versions.modules).
const ELECTRON = { runtime: 'electron', target: '44.9.3', abi: 149 };
const NATIVE_TARGETS = [
  { runtime: 'node', target: '22.0.0', abi: 127 },
  { runtime: 'node', target: '24.0.0', abi: 137 },
  { runtime: 'node', target: '26.0.0', abi: 147 },
  ELECTRON,
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, '.mcpb-build');
const stage = join(buildDir, 'stage');
const MCPB = '@anthropic-ai/mcpb@2.1.2';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(cmd, args, cwd = root) {
  console.log(`\n> ${cmd} ${args.join(' ')}  (cwd: ${cwd})`);
  // shell:true is needed for .cmd shims on Windows; args are all static strings here.
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const pkg = readJson(join(root, 'package.json'));
const manifest = readJson(join(root, 'mcpb', 'manifest.json'));
if (manifest.version !== pkg.version) {
  throw new Error(`mcpb/manifest.json version ${manifest.version} != package.json version ${pkg.version}`);
}

// 1. TypeScript build
run(npm, ['run', 'build']);
if (!existsSync(join(root, 'dist'))) throw new Error('dist/ missing after build');

// 2. Clean staging dir
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const item of ['bin', 'dist', 'package.json', 'package-lock.json', 'LICENSE', 'README.md']) {
  if (!existsSync(join(root, item))) throw new Error(`missing required file: ${item}`);
  cpSync(join(root, item), join(stage, item), { recursive: true });
}
cpSync(join(root, 'mcpb', '.mcpbignore'), join(stage, '.mcpbignore'));

// 3. Staged manifest, narrowed to this platform
manifest.compatibility = { ...manifest.compatibility, platforms: [process.platform] };
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 4. Strip lifecycle scripts so the production install does not run tsc
const stagedPkg = readJson(join(stage, 'package.json'));
delete stagedPkg.scripts;
delete stagedPkg.devDependencies;
writeFileSync(join(stage, 'package.json'), JSON.stringify(stagedPkg, null, 2) + '\n');

// 5. Production install (fetches the better-sqlite3 prebuilt binary for this platform/arch)
run(npm, ['ci', '--omit=dev'], stage);

const nativeOk = (function find(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory() ? find(p) : e.name === 'better_sqlite3.node') return true;
  }
  return false;
})(join(stage, 'node_modules', 'better-sqlite3'));
if (!nativeOk) throw new Error('better_sqlite3.node not found in staged node_modules');

// 5b. Bundle better-sqlite3 binaries for several ABIs; picked at runtime by src/sqlite/open-database.ts
const sqliteDir = join(stage, 'node_modules', 'better-sqlite3');
const prebuildInstall = [
  join(sqliteDir, 'node_modules', 'prebuild-install', 'bin.js'),
  join(stage, 'node_modules', 'prebuild-install', 'bin.js'),
].find((p) => existsSync(p));
if (!prebuildInstall) throw new Error('prebuild-install not found in staged node_modules');
const gotAbis = [];
for (const t of NATIVE_TARGETS) {
  const tmp = join(buildDir, `prebuild-${t.abi}`);
  cpSync(sqliteDir, tmp, { recursive: true });
  rmSync(join(tmp, 'build'), { recursive: true, force: true });
  try {
    run(process.execPath, [prebuildInstall, '--runtime', t.runtime, '--target', t.target,
      '--arch', process.arch, '--platform', process.platform, '--verbose'], tmp);
    const built = join(tmp, 'build', 'Release', 'better_sqlite3.node');
    if (!existsSync(built)) throw new Error('no better_sqlite3.node produced');
    const dest = join(stage, 'native', `abi-${t.abi}-${process.platform}-${process.arch}`);
    mkdirSync(dest, { recursive: true });
    copyFileSync(built, join(dest, 'better_sqlite3.node'));
    gotAbis.push(`${t.abi} (${t.runtime} ${t.target})`);
  } catch (err) {
    console.warn(`\nWARNING: no prebuilt better-sqlite3 for ${t.runtime} ${t.target} (ABI ${t.abi}) on ${process.platform}-${process.arch}: ${err.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
if (gotAbis.length < 2) throw new Error(`only ${gotAbis.length} native targets bundled; need at least 2`);
console.log(`\nBundled native ABIs: ${gotAbis.join(', ')}`);

// 6. Validate and pack
run(npx, ['-y', MCPB, 'validate', join(stage, 'manifest.json')]);
const out = join(buildDir, `youtube-mcp-${pkg.version}-${process.platform}-${process.arch}.mcpb`);
run(npx, ['-y', MCPB, 'pack', stage, out]);
if (!existsSync(out)) throw new Error(`pack did not produce ${out}`);
console.log(`\nBuilt ${out}`);
