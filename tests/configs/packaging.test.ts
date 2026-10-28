import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Canonical launch: change here (e.g. to pin a tag) and every check follows.
// ---------------------------------------------------------------------------
const PKG_VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const NPX_TARGET = `https://github.com/pratikgh0se/youtube-mcp/releases/download/v${PKG_VERSION}/youtube-mcp-${PKG_VERSION}.tgz`;
const CANONICAL_LAUNCH: readonly string[] = ['npx', '-y', NPX_TARGET, '--transport', 'stdio'];
const SERVER_NAME = 'youtube-mcp';
const BIN_PATH = './bin/youtube-mcp.mjs';
const ENV_NAMES = [
  'YOUTUBE_API_KEY',
  'YOUTUBE_OAUTH_CLIENT_SECRET_FILE',
  'YOUTUBE_MCP_PROFILE_ID',
  'YOUTUBE_MCP_CHANNEL_ID',
  'YOUTUBE_MCP_STATE_DIR',
] as const;
const EXPECTED_CONFIGS = [
  'claude-desktop.json',
  'codex.toml',
  'cursor.json',
  'vscode.json',
  'windsurf.json',
  'cline.json',
  'zed.json',
  'goose.yaml',
  'antigravity.json',
  'gemini-settings.json',
  'opencode.json',
  'openclaw.json',
  'hermes.yaml',
  'generic-stdio.json',
];
const SECRET_PATTERNS = [/AIza[0-9A-Za-z_-]{20,}/, /GOCSPX-/, /ya29\./, /1\/\/0/];

// ---------------------------------------------------------------------------
// Minimal parsers (no YAML/TOML dependency is installed).
// Supported: nested maps, block lists of scalars, flow arrays, quoted strings.
// ---------------------------------------------------------------------------
type Val = string | number | boolean | null | Val[] | { [k: string]: Val };
type Obj = { [k: string]: Val };

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stripComment(line: string, anywhere: boolean): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (anywhere || i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function splitFlow(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') cur += s[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '[' || c === '{') {
      depth++;
      cur += c;
    } else if (c === ']' || c === '}') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1);
  return s;
}

function scalar(raw: string): Val {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s.startsWith('[') && s.endsWith(']')) return splitFlow(s.slice(1, -1)).map(scalar);
  if (s.startsWith('{') && s.endsWith('}')) {
    const o: Obj = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const i = part.indexOf(':');
      if (i > 0) o[unquote(part.slice(0, i).trim())] = scalar(part.slice(i + 1));
    }
    return o;
  }
  if (s[0] === '"' || s[0] === "'") return unquote(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function parseYaml(text: string): Val {
  const lines = text
    .split('\n')
    .map((l) => stripComment(l, false))
    .filter((l) => l.trim() !== '')
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let i = 0;
  const isItem = (t: string) => t === '-' || t.startsWith('- ');

  function block(indent: number): Val {
    return isItem(lines[i]!.text) ? list(indent) : map(indent);
  }
  function list(indent: number): Val[] {
    const out: Val[] = [];
    while (i < lines.length && lines[i]!.indent === indent && isItem(lines[i]!.text)) {
      out.push(scalar(lines[i]!.text.slice(1)));
      i++;
    }
    return out;
  }
  function map(indent: number): Obj {
    const obj: Obj = {};
    while (i < lines.length && lines[i]!.indent === indent && !isItem(lines[i]!.text)) {
      const m = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(lines[i]!.text);
      if (!m) throw new Error(`mini-yaml: cannot parse line "${lines[i]!.text}"`);
      const key = unquote(m[1]!.trim());
      i++;
      if (m[2] !== undefined && m[2].trim() !== '') obj[key] = scalar(m[2]);
      else if (i < lines.length && (lines[i]!.indent > indent || (lines[i]!.indent === indent && isItem(lines[i]!.text))))
        obj[key] = block(lines[i]!.indent);
      else obj[key] = null;
    }
    return obj;
  }
  return lines.length === 0 ? {} : block(lines[0]!.indent);
}

function splitDotted(path: string): string[] {
  const parts = path.match(/"[^"]*"|'[^']*'|[^.\s]+/g) ?? [];
  return parts.map(unquote);
}

export function parseToml(text: string): Obj {
  const root: Obj = {};
  let cur = root;
  const raw = text.split('\n');
  for (let n = 0; n < raw.length; n++) {
    const line = stripComment(raw[n]!, true).trim();
    if (line === '') continue;
    const table = /^\[([^[\]].*)\]$/.exec(line);
    if (table) {
      cur = root;
      for (const p of splitDotted(table[1]!)) {
        if (!isObj(cur[p])) cur[p] = {};
        cur = cur[p] as Obj;
      }
      continue;
    }
    const kv = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`mini-toml: cannot parse line "${line}"`);
    let value = kv[2]!;
    const open = () => (value.match(/\[/g) ?? []).length > (value.match(/\]/g) ?? []).length;
    while (value.startsWith('[') && open() && n + 1 < raw.length) value += ' ' + stripComment(raw[++n]!, true).trim();
    value = value.replace(/,\s*\]/, ']');
    cur[unquote(kv[1]!)] = scalar(value);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Helpers under test
// ---------------------------------------------------------------------------
function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function readJson(path: string): Obj {
  return JSON.parse(readText(path)) as Obj;
}

function parseByExtension(path: string): Obj {
  const text = readText(path);
  if (path.endsWith('.json')) return JSON.parse(text) as Obj;
  if (path.endsWith('.toml')) return parseToml(text);
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return parseYaml(text) as Obj;
  throw new Error(`${path}: unsupported config extension`);
}

/** Every object stored under the key `youtube-mcp`, anywhere in the tree. */
export function findServerEntries(tree: Val, key = SERVER_NAME): Obj[] {
  const found: Obj[] = [];
  const walk = (v: Val) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      for (const [k, child] of Object.entries(v)) {
        if (k === key && isObj(child)) found.push(child);
        walk(child);
      }
    }
  };
  walk(tree);
  return found;
}

/** Launch as one flat list, for command+args, cmd+args, or command-as-array shapes. */
export function launchOf(entry: Obj): string[] | undefined {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (Array.isArray(entry.command)) return entry.command.map(String);
  if (typeof entry.command === 'string') return [entry.command, ...args];
  if (typeof entry.cmd === 'string') return [entry.cmd, ...args];
  return undefined;
}

export function envNamesOf(entry: Obj): string[] {
  const names: string[] = [];
  for (const k of ['env', 'envs', 'environment']) {
    const v = entry[k];
    if (isObj(v)) names.push(...Object.keys(v));
  }
  if (Array.isArray(entry.env_vars)) {
    for (const v of entry.env_vars) {
      if (typeof v === 'string') names.push(v);
      else if (isObj(v) && typeof v.name === 'string') names.push(v.name);
    }
  }
  return names;
}

function singleEntry(file: string, tree: Val): Obj {
  const entries = findServerEntries(tree);
  expect(entries, `${file}: expected exactly one "${SERVER_NAME}" server entry`).toHaveLength(1);
  return entries[0]!;
}

function expectCanonical(file: string, entry: Obj): void {
  const launch = launchOf(entry);
  expect(launch, `${file}: launch must equal ${CANONICAL_LAUNCH.join(' ')}`).toEqual([...CANONICAL_LAUNCH]);
  expect(launch?.[0], `${file}: bare "youtube-mcp" command is not allowed`).not.toBe(SERVER_NAME);
}

function expectEnvSubset(file: string, entry: Obj): void {
  for (const name of envNamesOf(entry)) {
    expect(ENV_NAMES as readonly string[], `${file}: unexpected env var ${name}`).toContain(name);
  }
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((f) => listFiles(join(path, f)));
}

// ---------------------------------------------------------------------------
// Self-tests: prove the matchers pass good input and fail bad input
// ---------------------------------------------------------------------------
describe('packaging test helpers', () => {
  const good = { command: 'npx', args: ['-y', NPX_TARGET, '--transport', 'stdio'] };

  it('accepts the three launch shapes', () => {
    expectCanonical('inline', good);
    expectCanonical('inline', { cmd: 'npx', args: ['-y', NPX_TARGET, '--transport', 'stdio'] });
    expectCanonical('inline', { command: [...CANONICAL_LAUNCH] });
  });

  it('rejects wrong launches', () => {
    expect(() => expectCanonical('inline', { command: 'youtube-mcp', args: ['--transport', 'stdio'] })).toThrow();
    expect(() => expectCanonical('inline', { command: 'npx', args: ['-y', 'youtube-mcp', '--transport', 'stdio'] })).toThrow();
    expect(() => expectCanonical('inline', { command: 'node', args: ['/abs/bin.mjs'] })).toThrow();
    expect(() => expectCanonical('inline', {})).toThrow();
  });

  it('finds nested entries and counts them', () => {
    expect(findServerEntries({ a: { b: { 'youtube-mcp': good } }, name: 'youtube-mcp' })).toHaveLength(1);
    expect(() => singleEntry('inline', { a: { 'youtube-mcp': good }, b: { 'youtube-mcp': good } })).toThrow();
    expect(() => singleEntry('inline', {})).toThrow();
  });

  it('flags env names outside the allowed set', () => {
    expectEnvSubset('inline', { env: { YOUTUBE_API_KEY: 'x' }, env_vars: ['YOUTUBE_MCP_STATE_DIR'] });
    expect(() => expectEnvSubset('inline', { env: { OTHER: 'x' } })).toThrow();
    expect(() => expectEnvSubset('inline', { env_vars: ['SECRET'] })).toThrow();
  });

  it('parses TOML shapes', () => {
    const t = parseToml('[mcp_servers.youtube-mcp]\ncommand = "npx"\nargs = ["-y", "a#b"] # c\nenv_vars = [\n  "X",\n  "Y",\n]\n[mcp_servers.youtube-mcp.env]\nK = "v"\n');
    const e = singleEntry('inline', t);
    expect(e.command).toBe('npx');
    expect(e.args).toEqual(['-y', 'a#b']);
    expect(envNamesOf(e)).toEqual(['K', 'X', 'Y']);
  });

  it('parses YAML shapes (flow and block lists)', () => {
    const y = parseYaml('extensions:\n  youtube-mcp:\n    cmd: "npx" # c\n    args:\n      - "-y"\n      - github:x/y\n    envs: {}\n    other: [a, "b"]\n');
    const e = singleEntry('inline', y);
    expect(e.cmd).toBe('npx');
    expect(e.args).toEqual(['-y', 'github:x/y']);
    expect(e.other).toEqual(['a', 'b']);
    const y2 = parseYaml('mcp_servers:\n  youtube-mcp:\n    command: "npx"\n    args: ["-y", "z"]\n    env:\n      A: "${A}"\n');
    expect(envNamesOf(singleEntry('inline', y2))).toEqual(['A']);
  });
});

// ---------------------------------------------------------------------------
// C1 / C2: launch in every config
// ---------------------------------------------------------------------------
const configFiles = existsSync('configs') ? readdirSync('configs').sort() : [];

describe('C2 configs/ directory', () => {
  it('contains the expected 14-file set', () => {
    for (const name of EXPECTED_CONFIGS) expect(configFiles, `configs/${name} is missing`).toContain(name);
    expect(EXPECTED_CONFIGS).toHaveLength(14);
  });

  it.each(configFiles.map((f) => `configs/${f}`))('%s holds one canonical npx server entry', (file) => {
    expectCanonical(file, singleEntry(file, parseByExtension(file)));
  });
});

describe('C1/C2 manifests with a server entry', () => {
  it.each(['.mcp.json', 'gemini-extension.json'])('%s holds one canonical npx server entry', (file) => {
    expectCanonical(file, singleEntry(file, readJson(file)));
  });
});

describe('C1 bundled and remote launches resolve to one bin file', () => {
  const pkg = () => readJson('package.json');
  const mcpb = () => readJson('mcpb/manifest.json');
  const server = () => mcpb().server as Obj;

  it('package.json bin points at the entrypoint and the file exists', () => {
    expect((pkg().bin as Obj)[SERVER_NAME], 'package.json bin["youtube-mcp"]').toBe(BIN_PATH);
    expect(existsSync('bin/youtube-mcp.mjs'), 'bin/youtube-mcp.mjs must exist').toBe(true);
  });

  it('mcpb/manifest.json server fields are exactly as specified', () => {
    const s = server();
    expect(s.type, 'mcpb/manifest.json server.type').toBe('node');
    expect(s.entry_point, 'mcpb/manifest.json server.entry_point').toBe('bin/youtube-mcp.mjs');
    const cfg = s.mcp_config as Obj;
    expect(cfg.command, 'mcpb/manifest.json mcp_config.command').toBe('node');
    expect(cfg.args, 'mcpb/manifest.json mcp_config.args').toEqual(['${__dirname}/bin/youtube-mcp.mjs', '--transport', 'stdio']);
  });

  it('mcpb entry_point equals the package bin path without "./"', () => {
    const bin = (pkg().bin as Obj)[SERVER_NAME] as string;
    expect(server().entry_point, 'mcpb/manifest.json server.entry_point vs package.json bin').toBe(bin.replace(/^\.\//, ''));
  });
});

// ---------------------------------------------------------------------------
// C3: environment variables and secrets
// ---------------------------------------------------------------------------
describe('C3 environment variables', () => {
  const serverFiles = ['.mcp.json', 'gemini-extension.json', ...configFiles.map((f) => `configs/${f}`)];

  it.each(serverFiles)('%s server entry only uses the five allowed env names', (file) => {
    expectEnvSubset(file, singleEntry(file, parseByExtension(file)));
  });

  it('plugin.json userConfig covers all five, API key sensitive', () => {
    const uc = readJson('.claude-plugin/plugin.json').userConfig as Obj;
    for (const name of ENV_NAMES) expect(Object.keys(uc), `.claude-plugin/plugin.json userConfig.${name}`).toContain(name);
    expect((uc.YOUTUBE_API_KEY as Obj).sensitive, '.claude-plugin/plugin.json YOUTUBE_API_KEY.sensitive').toBe(true);
  });

  it('gemini-extension.json settings cover all five, API key sensitive', () => {
    const settings = readJson('gemini-extension.json').settings as Obj[];
    expect(Array.isArray(settings), 'gemini-extension.json settings must be an array').toBe(true);
    const envVars = settings.map((s) => s.envVar);
    for (const name of ENV_NAMES) expect(envVars, `gemini-extension.json settings envVar ${name}`).toContain(name);
    expect(settings.find((s) => s.envVar === 'YOUTUBE_API_KEY')?.sensitive, 'gemini-extension.json YOUTUBE_API_KEY.sensitive').toBe(true);
  });

  it('mcpb user_config covers all five and mcp_config.env maps them', () => {
    const m = readJson('mcpb/manifest.json');
    const uc = m.user_config as Obj;
    const env = ((m.server as Obj).mcp_config as Obj).env as Obj;
    for (const name of ENV_NAMES) {
      const key = name.toLowerCase();
      expect(Object.keys(uc), `mcpb/manifest.json user_config.${key}`).toContain(key);
      expect(env?.[name], `mcpb/manifest.json mcp_config.env.${name}`).toBe(`\${user_config.${key}}`);
    }
    expect((uc.youtube_api_key as Obj).sensitive, 'mcpb/manifest.json youtube_api_key.sensitive').toBe(true);
  });

  it('configs/codex.toml forwards via env_vars and has no ${ expansion', () => {
    const text = readText('configs/codex.toml');
    const code = text.split('\n').map((l) => stripComment(l, true)).join('\n');
    expect(code, 'configs/codex.toml must not contain "${" outside comments').not.toContain('${');
    expect(text, 'configs/codex.toml must use env_vars').toContain('env_vars');
  });

  it('no packaging file contains a real-looking secret', () => {
    const files = [
      ...listFiles('configs'),
      ...listFiles('.mcp.json'),
      ...listFiles('.claude-plugin'),
      ...listFiles('gemini-extension.json'),
      ...listFiles('mcpb').filter((f) => !/\.(mcpb|zip|png|jpe?g|gif|ico)$/i.test(f)),
      ...listFiles('README.md'),
      ...listFiles('AGENTS.md'),
      ...listFiles('llms-install.md'),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readText(file);
      for (const re of SECRET_PATTERNS) expect(re.test(text), `${file} matches secret pattern ${re}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// C4: versions and names
// ---------------------------------------------------------------------------
describe('C4 versions and names', () => {
  it('all versions equal package.json', () => {
    const version = readJson('package.json').version;
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    const marketplace = readJson('.claude-plugin/marketplace.json').plugins as Obj[];
    expect(readJson('.claude-plugin/plugin.json').version, '.claude-plugin/plugin.json version').toBe(version);
    expect(marketplace[0]?.version, '.claude-plugin/marketplace.json plugins[0].version').toBe(version);
    expect(readJson('gemini-extension.json').version, 'gemini-extension.json version').toBe(version);
    expect(readJson('mcpb/manifest.json').version, 'mcpb/manifest.json version').toBe(version);
  });

  it('the npx release-tarball URL carries v + package.json version in tag and filename', () => {
    const version = readJson('package.json').version as string;
    const m = /^https:\/\/github\.com\/pratikgh0se\/youtube-mcp\/releases\/download\/v([^/]+)\/youtube-mcp-([^/]+)\.tgz$/.exec(NPX_TARGET);
    expect(m, `NPX_TARGET ${NPX_TARGET} must match the release tarball URL pattern`).not.toBeNull();
    expect(m?.[1], 'tag version in URL').toBe(version);
    expect(m?.[2], 'filename version in URL').toBe(version);
  });

  it('package.json "files" covers the bin and dist directories', () => {
    const files = readJson('package.json').files as string[];
    expect(Array.isArray(files), 'package.json files must be an array').toBe(true);
    for (const dir of ['bin', 'dist']) {
      expect(
        files.some((f) => f.replace(/^\.\//, '').replace(/\/$/, '') === dir),
        `package.json files must include "${dir}"`,
      ).toBe(true);
    }
  });

  it('all names are youtube-mcp and marketplace source is "./"', () => {
    const marketplace = readJson('.claude-plugin/marketplace.json').plugins as Obj[];
    expect(readJson('.claude-plugin/plugin.json').name, '.claude-plugin/plugin.json name').toBe(SERVER_NAME);
    expect(marketplace[0]?.name, '.claude-plugin/marketplace.json plugins[0].name').toBe(SERVER_NAME);
    expect(readJson('gemini-extension.json').name, 'gemini-extension.json name').toBe(SERVER_NAME);
    expect(readJson('mcpb/manifest.json').name, 'mcpb/manifest.json name').toBe(SERVER_NAME);
    expect(marketplace[0]?.source, '.claude-plugin/marketplace.json plugins[0].source').toBe('./');
  });
});

// ---------------------------------------------------------------------------
// C5: install links in docs
// ---------------------------------------------------------------------------
const LINK_END = '[^\\s)"\'`<>\\]]+';
const CURSOR_RE = new RegExp(`https://cursor\\.com/install-mcp\\?${LINK_END}`, 'g');
const VSCODE_RE = new RegExp(`https://vscode\\.dev/redirect/mcp/install\\?${LINK_END}`, 'g');
const GOOSE_RE = new RegExp(`goose://extension\\?${LINK_END}`, 'g');

function query(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf('?') + 1));
}

export function decodeCursorConfig(url: string): Obj {
  const config = query(url).get('config') ?? '';
  return JSON.parse(Buffer.from(config, 'base64').toString('utf8')) as Obj;
}

export function decodeVscodeConfig(url: string): Obj {
  return JSON.parse(query(url).get('config') ?? '') as Obj;
}

describe('C5 link decoders', () => {
  const server = { command: 'npx', args: ['-y', NPX_TARGET, '--transport', 'stdio'] };
  it('round-trips cursor and vscode links, and rejects wrong ones', () => {
    const b64 = Buffer.from(JSON.stringify(server)).toString('base64');
    const cursor = `https://cursor.com/install-mcp?name=youtube-mcp&config=${encodeURIComponent(b64)}`;
    expectCanonical('inline', decodeCursorConfig(cursor));
    const vs = `https://vscode.dev/redirect/mcp/install?name=youtube-mcp&config=${encodeURIComponent(JSON.stringify({ type: 'stdio', ...server }))}`;
    expect(decodeVscodeConfig(vs).type).toBe('stdio');
    expectCanonical('inline', decodeVscodeConfig(vs));
    const bad = Buffer.from(JSON.stringify({ command: 'youtube-mcp', args: [] })).toString('base64');
    expect(() => expectCanonical('inline', decodeCursorConfig(`https://cursor.com/install-mcp?config=${bad}`))).toThrow();
    expect(`see (${cursor}) and \`${vs}\``.match(CURSOR_RE)).toEqual([cursor]);
  });
});

const docFiles = ['README.md', 'AGENTS.md'].filter((f) => existsSync(f));

describe('C5 install links', () => {
  it('README.md has the install heading', () => {
    expect(readText('README.md').split('\n'), 'README.md missing "## Install in your AI agent"').toContain('## Install in your AI agent');
  });

  it('README.md has at least one Cursor and one VS Code link', () => {
    const text = readText('README.md');
    expect(text.match(CURSOR_RE)?.length ?? 0, 'README.md cursor.com/install-mcp links').toBeGreaterThan(0);
    expect(text.match(VSCODE_RE)?.length ?? 0, 'README.md vscode.dev redirect links').toBeGreaterThan(0);
  });

  it.each(docFiles)('%s Cursor links decode to the canonical launch', (file) => {
    for (const url of readText(file).match(CURSOR_RE) ?? []) {
      expect(query(url).get('name'), `${file}: cursor link name`).toBe(SERVER_NAME);
      expectCanonical(`${file} (cursor link)`, decodeCursorConfig(url));
    }
  });

  it.each(docFiles)('%s VS Code links decode to a canonical stdio server', (file) => {
    for (const url of readText(file).match(VSCODE_RE) ?? []) {
      expect(query(url).get('name'), `${file}: vscode link name`).toBe(SERVER_NAME);
      const cfg = decodeVscodeConfig(url);
      expect(cfg.type, `${file}: vscode link type`).toBe('stdio');
      expectCanonical(`${file} (vscode link)`, cfg);
    }
  });

  it.each(docFiles)('%s goose deeplinks carry the canonical cmd and ordered args', (file) => {
    for (const url of readText(file).match(GOOSE_RE) ?? []) {
      const q = query(url);
      expect([q.get('cmd'), ...q.getAll('arg')], `${file}: goose deeplink`).toEqual([...CANONICAL_LAUNCH]);
      expect(q.get('id'), `${file}: goose id`).toBe(SERVER_NAME);
    }
  });

  it('README.md has a goose deeplink', () => {
    expect(readText('README.md').match(GOOSE_RE)?.length ?? 0, 'README.md goose:// deeplinks').toBeGreaterThan(0);
  });

  it.each(docFiles)('%s has no cursor:// or vscode: links', (file) => {
    const text = readText(file);
    expect(/cursor:\/\//.test(text), `${file} contains a cursor:// link`).toBe(false);
    expect(text.includes(']('+'vscode:'), `${file} contains a vscode: link`).toBe(false);
  });

  it('README.md has the Claude Code and Gemini install commands', () => {
    const text = readText('README.md');
    expect(text, 'README.md').toContain('/plugin marketplace add pratikgh0se/youtube-mcp');
    expect(text, 'README.md').toContain('/plugin install youtube-mcp@youtube-mcp');
    expect(text, 'README.md').toContain('gemini extensions install https://github.com/pratikgh0se/youtube-mcp');
  });

  it.each(['README.md', 'AGENTS.md', 'llms-install.md'])('%s npx invocations use the release tarball URL', (file) => {
    if (!existsSync(file)) return;
    const hits = readText(file).match(/\bnpx\s[^\n"'`]*?youtube-mcp(?:[^\s"'`]*\.tgz)?/g) ?? [];
    for (const hit of hits) expect(hit, `${file}: npx invocation "${hit}"`).toContain(NPX_TARGET);
  });

  it('README.md shows at least one npx invocation', () => {
    expect(/\bnpx\s[^\n"'`]*?youtube-mcp/.test(readText('README.md')), 'README.md npx invocation').toBe(true);
  });
});
