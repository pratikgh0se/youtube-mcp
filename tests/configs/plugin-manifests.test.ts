import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const LAUNCH_PREFIX = ['npx', '-y', 'github:pratikgh0se/youtube-mcp'];
const MANIFESTS = [
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.mcp.json',
  'gemini-extension.json',
] as const;

type Json = Record<string, unknown>;
type Server = { command?: string; args?: string[] };

async function load(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, 'utf8')) as Json;
}

function launchCommand(server: Server): string[] {
  return [server.command ?? '', ...(server.args ?? [])].slice(0, LAUNCH_PREFIX.length);
}

describe('install manifests', () => {
  it.each(MANIFESTS)('%s is valid JSON', async (path) => {
    await expect(load(path)).resolves.toBeTypeOf('object');
  });

  it('every manifest version equals the package.json version', async () => {
    const { version } = (await load('package.json')) as { version: string };
    const plugin = (await load('.claude-plugin/plugin.json')) as { version: string };
    const marketplace = (await load('.claude-plugin/marketplace.json')) as { plugins: Array<{ version: string }> };
    const gemini = (await load('gemini-extension.json')) as { version: string };

    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.version).toBe(version);
    expect(gemini.version).toBe(version);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
    for (const entry of marketplace.plugins) expect(entry.version).toBe(version);
  });

  it('every launch command is npx -y github:pratikgh0se/youtube-mcp over stdio', async () => {
    const claude = (await load('.mcp.json')) as { mcpServers: Record<string, Server> };
    const gemini = (await load('gemini-extension.json')) as { mcpServers: Record<string, Server> };

    for (const servers of [claude.mcpServers, gemini.mcpServers]) {
      expect(Object.keys(servers)).toEqual(['youtube-mcp']);
      for (const server of Object.values(servers)) {
        expect(launchCommand(server)).toEqual(LAUNCH_PREFIX);
        expect(server.args).toEqual(['-y', 'github:pratikgh0se/youtube-mcp', '--transport', 'stdio']);
      }
    }
  });

  it('the Claude Code marketplace points at the plugin in this repo', async () => {
    const marketplace = (await load('.claude-plugin/marketplace.json')) as { plugins: Array<{ name: string; source: string }> };
    const plugin = (await load('.claude-plugin/plugin.json')) as { name: string };

    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({ name: plugin.name, source: './' });
  });

  it('plugin.json userConfig covers every env var that .mcp.json substitutes', async () => {
    const plugin = (await load('.claude-plugin/plugin.json')) as { userConfig: Record<string, { sensitive?: boolean }> };
    const claude = (await load('.mcp.json')) as { mcpServers: Record<string, { env: Record<string, string> }> };
    const env = claude.mcpServers['youtube-mcp']!.env;

    for (const [name, value] of Object.entries(env)) {
      const key = /^\$\{user_config\.([A-Za-z0-9_]+)\}$/.exec(value)?.[1];
      expect(key, `${name} must map to \${user_config.KEY}`).toBeDefined();
      expect(plugin.userConfig[key!], `${key} must be declared in userConfig`).toBeDefined();
    }
    expect(plugin.userConfig.YOUTUBE_API_KEY?.sensitive).toBe(true);
  });
});
