import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export async function runStdio(server: { connect(transport: StdioServerTransport): Promise<void> }): Promise<void> {
  await server.connect(new StdioServerTransport());
}
