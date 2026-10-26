import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { extname } from 'node:path';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type HttpOptions = {
  host?: string;
  port?: number;
  path?: string;
};

export type RunningHttpServer = {
  url: string;
  close(): Promise<void>;
};

export type ClientLaunchConfig = {
  command: string;
  args: string[];
  envKeys: string[];
};

export function parseHttpPort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  return port;
}

export async function runHttp(createMcpServer: () => McpServer, options: HttpOptions = {}): Promise<RunningHttpServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;
  const path = options.path ?? '/mcp';
  const server = createServer((request, response) => handleRequest(request, response, createMcpServer, path));

  await listen(server, port, host);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The HTTP server did not expose a TCP address.');
  }

  return {
    url: `http://${host}:${(address as AddressInfo).port}${path}`,
    close: () => close(server),
  };
}

export async function loadClientTemplate(path: string): Promise<ClientLaunchConfig> {
  const source = await readFile(path, 'utf8');
  const extension = extname(path).toLowerCase();
  const config = extension === '.json'
    ? launchConfigFromJson(JSON.parse(source))
    : extension === '.toml'
      ? launchConfigFromToml(source)
      : launchConfigFromYaml(source);

  if (!config) {
    throw new Error(`No stdio launch contract found in ${path}.`);
  }
  return { ...config, envKeys: [...config.envKeys].sort() };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  createMcpServer: () => McpServer,
  path: string,
): Promise<void> {
  if (request.url !== path) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'MCP endpoint not found.' }));
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'MCP endpoint accepts POST requests only.' }));
    return;
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.once('close', () => {
    void transport.close().finally(() => server.close());
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch {
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null }));
    }
  }
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function launchConfigFromJson(value: unknown): ClientLaunchConfig | undefined {
  return findLaunchConfig(value);
}

function launchConfigFromToml(source: string): ClientLaunchConfig | undefined {
  const command = matchQuotedValue(source, /^command\s*=\s*"([^"]+)"\s*$/m);
  const args = matchStringArray(source, /^args\s*=\s*(\[[^\n]+\])\s*$/m);
  const envKeys = [...source.matchAll(/^([A-Z][A-Z0-9_]+)\s*=/gm)].map((match) => match[1]);
  return command && args && envKeys ? { command, args, envKeys } : undefined;
}

function launchConfigFromYaml(source: string): ClientLaunchConfig | undefined {
  const command = matchQuotedValue(source, /^\s*command:\s*"?([^"\n]+?)"?\s*$/m);
  const args = matchStringArray(source, /^\s*args:\s*(\[[^\n]+\])\s*$/m);
  const envKeys = [...source.matchAll(/^\s{6,}([A-Z][A-Z0-9_]+):\s*/gm)].map((match) => match[1]);
  return command && args && envKeys.length > 0 ? { command, args, envKeys } : undefined;
}

function findLaunchConfig(value: unknown): ClientLaunchConfig | undefined {
  if (!isRecord(value)) return undefined;

  const command = value.command;
  if (typeof command === 'string' && isStringArray(value.args)) {
    const envKeys = environmentKeys(value);
    if (envKeys.length > 0) return { command, args: value.args, envKeys };
  }
  if (isStringArray(command) && command.length > 0) {
    const envKeys = environmentKeys(value);
    if (envKeys.length > 0) return { command: command[0], args: command.slice(1), envKeys };
  }

  for (const child of Object.values(value)) {
    const found = findLaunchConfig(child);
    if (found) return found;
  }
  return undefined;
}

function environmentKeys(value: Record<string, unknown>): string[] {
  const explicit = value.env_vars;
  if (isStringArray(explicit)) return explicit;
  const environment = value.env ?? value.environment;
  return isRecord(environment) ? Object.keys(environment) : [];
}

function matchQuotedValue(source: string, pattern: RegExp): string | undefined {
  return source.match(pattern)?.[1];
}

function matchStringArray(source: string, pattern: RegExp): string[] | undefined {
  const literal = source.match(pattern)?.[1];
  if (!literal) return undefined;
  const parsed: unknown = JSON.parse(literal);
  return isStringArray(parsed) ? parsed : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
