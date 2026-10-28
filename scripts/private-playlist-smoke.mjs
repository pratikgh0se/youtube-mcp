import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.YOUTUBE_LIVE_PRIVATE_SMOKE !== '1') {
  process.stdout.write('Private live smoke skipped (set YOUTUBE_LIVE_PRIVATE_SMOKE=1 to opt in).\n');
  process.exit(0);
}

const title = `youtube-mcp release smoke ${new Date().toISOString()}`;
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js', '--transport', 'stdio'], stderr: 'pipe', env: { ...process.env } });
const client = new Client({ name: 'youtube-mcp-private-smoke', version: '0.1.0' });
let playlistId;

try {
  await client.connect(transport);
  const status = await call('youtube_auth_status', {});
  if (!status.authorized || !status.scopeReadiness?.ready) throw new Error('OAuth authorization or required scopes are not ready.');
  const existing = await call('youtube_list_playlists', { maxResults: 50 });
  for (const item of existing.items.filter((candidate) => candidate.title.startsWith('youtube-mcp release smoke '))) {
    await deletePlaylist(item.id);
  }

  const created = await call('youtube_preflight_create_playlist', { title, description: 'Temporary release validation playlist.', privacyStatus: 'private' });
  await call('youtube_approve', { approvalId: created.approvalId, confirm: true });
  const playlist = await call('youtube_create_playlist', { title, description: 'Temporary release validation playlist.', privacyStatus: 'private', approvalId: created.approvalId, confirm: true });
  playlistId = playlist.playlistId;

  const deleted = await retry(() => call('youtube_preflight_delete_playlist', { playlistId }));
  await call('youtube_approve', { approvalId: deleted.approvalId, confirm: true });
  await retry(() => call('youtube_delete_playlist', { playlistId, approvalId: deleted.approvalId, confirm: true }));

  await retry(async () => {
    const reconciliation = await call('youtube_get_playlist', { playlistId });
    if (reconciliation.item !== null) throw new Error('Temporary playlist deletion could not be reconciled.');
    return reconciliation;
  });
  playlistId = undefined;
  process.stdout.write('Private playlist create/delete/reconciliation smoke passed.\n');
} finally {
  if (playlistId) await deletePlaylist(playlistId).catch(() => undefined);
  await client.close();
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content.map((entry) => entry.text ?? '').join('\n'));
  const text = result.content.find((entry) => entry.type === 'text')?.text;
  if (!text) throw new Error(`${name} returned no JSON result.`);
  return JSON.parse(text);
}

async function deletePlaylist(id) {
  const preview = await retry(() => call('youtube_preflight_delete_playlist', { playlistId: id }));
  await call('youtube_approve', { approvalId: preview.approvalId, confirm: true });
  await retry(() => call('youtube_delete_playlist', { playlistId: id, approvalId: preview.approvalId, confirm: true }));
}

async function retry(action, attempts = 8) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError;
}
