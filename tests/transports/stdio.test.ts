import { describe, expect, it } from 'vitest';

import { runStdio } from '../../src/transports/stdio.js';

describe('runStdio', () => {
  it('connects the supplied server to a stdio transport', async () => {
    let transport: { constructor: { name: string } } | undefined;
    const server = {
      connect: async (value: { constructor: { name: string } }) => {
        transport = value;
      },
    };

    await runStdio(server);

    expect(transport?.constructor.name).toBe('StdioServerTransport');
  });
});
