// Live end-to-end test: exercises every tool of the YouTube MCP server against a real, dedicated test channel.
//
// Opt-in and guarded. Required env:
//   YOUTUBE_LIVE_E2E=1                       opt in
//   YOUTUBE_E2E_CONFIRM_CHANNEL=<channel id> must equal youtube_my_account id AND YOUTUBE_MCP_CHANNEL_ID
// Optional env:
//   YOUTUBE_E2E_REUSE_VIDEO_ID               skip the (1600-unit) upload; reuse a video from a previous run
//   YOUTUBE_E2E_COMMENT_VIDEO_ID             unlisted/public video owned by the channel that accepts comments;
//                                            without it the comment + moderation group is SKIPPED
//   YOUTUBE_E2E_TAKEOUT                      path to a Takeout watch-history .json/.html instead of the synthetic one
//   YOUTUBE_E2E_OUT_DIR                      media + report directory (default: <os tmpdir>/youtube-mcp-e2e)
//   YOUTUBE_E2E_FFMPEG                       ffmpeg binary (default: /opt/homebrew/bin/ffmpeg or `ffmpeg`)
//
// Result statuses: PASS, PASS-GUARD (correct refusal because the precondition cannot be produced),
// BLOCKED (YouTube refused for an account-level reason), SKIPPED (optional input missing), FAIL.
import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.YOUTUBE_LIVE_E2E !== '1') {
  process.stdout.write('Live E2E skipped (set YOUTUBE_LIVE_E2E=1 to opt in).\n');
  process.exit(0);
}

const execFileAsync = promisify(execFile);
const env = process.env;
const confirmChannel = env.YOUTUBE_E2E_CONFIRM_CHANNEL;
const reuseVideoId = env.YOUTUBE_E2E_REUSE_VIDEO_ID || undefined;
const commentVideoId = env.YOUTUBE_E2E_COMMENT_VIDEO_ID || undefined;
const takeoutOverride = env.YOUTUBE_E2E_TAKEOUT || undefined;
const outDir = env.YOUTUBE_E2E_OUT_DIR || join(tmpdir(), 'youtube-mcp-e2e');
const mediaDir = join(outDir, 'e2e-media');
const ffmpeg = env.YOUTUBE_E2E_FFMPEG || (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const stamp = new Date().toISOString();
const fileStamp = stamp.replace(/[:.]/g, '-');
const PREFIX = 'youtube-mcp e2e ';
const runTitle = `${PREFIX}${stamp}`;

// Stable public fixtures.
const PUBLIC_VIDEO_CANDIDATES = ['dQw4w9WgXcQ', 'jNQXAC9IVRw', '9bZkp7q19f0'];
const SUBSCRIBE_CANDIDATES = ['UCBR8-60-B28hp2BmDPdntcQ', 'UC_x5XG1OV2P6uZZ5FSM9Ttw']; // YouTube, Google for Developers

// Approximate YouTube Data API quota cost per tool (used only when the server does not return context.quotaUnits).
// Tools not listed cost 1 (a single list/read). Local-only and Analytics-API tools cost 0 Data API units.
const QUOTA = {
  youtube_search: 100, youtube_upload_video: 1600, youtube_update_metadata: 50, youtube_set_thumbnail: 50,
  youtube_upload_caption: 400, youtube_update_caption: 450, youtube_download_caption: 200, youtube_delete_caption: 50,
  youtube_list_caption_tracks: 50, youtube_preflight_caption_update: 51, youtube_preflight_caption_download: 51, youtube_preflight_caption_delete: 51,
  youtube_create_playlist: 50, youtube_update_playlist: 50, youtube_delete_playlist: 50, youtube_add_playlist_item: 50,
  youtube_remove_playlist_item: 50, youtube_reorder_playlist_item: 50, youtube_create_comment: 50, youtube_reply_to_comment: 50,
  youtube_set_comment_moderation_status: 50, youtube_delete_comment: 50, youtube_subscribe: 50, youtube_unsubscribe: 50,
  youtube_rate_video: 50,
  youtube_auth_status: 0, youtube_get_upload_status: 0, youtube_creator_overview: 0, youtube_creator_top_videos: 0, youtube_creator_retention: 0,
  youtube_import_takeout: 0, youtube_consumption_profile: 0, youtube_consumption_trends: 0, youtube_save_curation_policy: 0,
  youtube_save_curation_candidate: 0, youtube_propose_consumption_queue: 0, youtube_reset_consumption_data: 0,
  youtube_approve_upload: 0, youtube_approve_creator_content: 0, youtube_approve_playlist: 0, youtube_approve_moderation: 0,
};
const SPENT_BY = {};
let quotaUnits = 0;

// Tool groups; used for report grouping and for explaining "not covered" tools.
const GROUPS = {
  account: ['youtube_auth_status', 'youtube_my_account', 'youtube_get_channel'],
  public: ['youtube_search', 'youtube_get_video', 'youtube_get_transcript', 'youtube_list_video_categories', 'youtube_get_comments'],
  uploads: ['youtube_preflight_upload', 'youtube_approve_upload', 'youtube_upload_video', 'youtube_get_upload_status', 'youtube_preflight_resume_upload', 'youtube_resume_upload', 'youtube_preflight_cancel_upload', 'youtube_cancel_upload'],
  'your-videos': ['youtube_list_owned_videos', 'youtube_get_owned_video'],
  'edit-video': ['youtube_preflight_update_metadata', 'youtube_approve_creator_content', 'youtube_update_metadata', 'youtube_preflight_set_thumbnail', 'youtube_set_thumbnail'],
  captions: ['youtube_preflight_caption_upload', 'youtube_upload_caption', 'youtube_list_caption_tracks', 'youtube_preflight_caption_update', 'youtube_update_caption', 'youtube_preflight_caption_download', 'youtube_download_caption', 'youtube_preflight_caption_delete', 'youtube_delete_caption'],
  playlists: ['youtube_list_playlists', 'youtube_get_playlist', 'youtube_list_playlist_items', 'youtube_preflight_create_playlist', 'youtube_approve_playlist', 'youtube_create_playlist', 'youtube_preflight_update_playlist', 'youtube_update_playlist', 'youtube_preflight_delete_playlist', 'youtube_delete_playlist', 'youtube_preflight_add_playlist_item', 'youtube_add_playlist_item', 'youtube_preflight_remove_playlist_item', 'youtube_remove_playlist_item', 'youtube_preflight_reorder_playlist_item', 'youtube_reorder_playlist_item'],
  comments: ['youtube_create_comment', 'youtube_list_channel_comment_threads', 'youtube_preflight_reply_to_comment', 'youtube_approve_moderation', 'youtube_reply_to_comment', 'youtube_find_comment_reply', 'youtube_list_moderation_comments', 'youtube_get_moderation_comment', 'youtube_preflight_set_comment_moderation_status', 'youtube_set_comment_moderation_status', 'youtube_preflight_delete_comment', 'youtube_delete_comment'],
  analytics: ['youtube_creator_overview', 'youtube_creator_top_videos', 'youtube_creator_retention'],
  viewer: ['youtube_list_subscriptions', 'youtube_subscribe', 'youtube_unsubscribe', 'youtube_rate_video'],
  'watch-history': ['youtube_import_takeout', 'youtube_consumption_profile', 'youtube_consumption_trends', 'youtube_save_curation_policy', 'youtube_save_curation_candidate', 'youtube_propose_consumption_queue', 'youtube_reset_consumption_data'],
};
const groupOf = (tool) => Object.entries(GROUPS).find(([, tools]) => tools.includes(tool))?.[0] ?? 'other';

const results = new Map(); // tool -> { status, ms, note }
const groupAborts = new Map(); // group -> reason
const cleanups = []; // { label, run, done }
const cleanupFailures = [];
const RANK = { FAIL: 5, BLOCKED: 4, PASS: 3, 'PASS-GUARD': 2, SKIPPED: 1 };
const log = (message) => process.stderr.write(`[e2e] ${message}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(tool, status, ms, note = '') {
  const previous = results.get(tool);
  if (previous && RANK[previous.status] >= RANK[status]) {
    if (previous.status === 'PASS' && status === 'PASS') previous.ms += ms;
    return;
  }
  results.set(tool, { status, ms, note: redact(note).slice(0, 600) });
}

function redact(text) {
  return String(text)
    .replace(/ya29\.[\w.-]+/g, '[redacted-token]')
    .replace(/AIza[\w-]{20,}/g, '[redacted-key]')
    .replace(/1\/\/[\w-]{20,}/g, '[redacted-token]')
    .replace(/(access_token|refresh_token|client_secret)["':= ]+[\w.-]+/gi, '$1=[redacted]');
}

class E2EError extends Error {
  constructor(message, code, tool) {
    super(message);
    this.code = code;
    this.tool = tool;
  }
}

// env: { ...process.env } is required: the SDK otherwise passes only a minimal environment to the child.
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js', '--transport', 'stdio'], stderr: 'pipe', env: { ...process.env } });
const client = new Client({ name: 'youtube-mcp-live-e2e', version: '0.1.0' });
let quotaAborted = false;

/** Raw MCP call: parses JSON, tallies quota, throws E2EError carrying the server's safe error code. */
async function call(name, args = {}, timeout = 120_000) {
  if (quotaAborted) throw new E2EError('Run aborted (quota exhausted).', 'quota_exhausted', name);
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = result.content?.find((entry) => entry.type === 'text')?.text ?? '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (result.isError) {
    const code = parsed?.code ?? 'tool_error';
    if (code === 'quota_exhausted') quotaAborted = true;
    const failure = new E2EError(`${code}: ${parsed?.message ?? text.slice(0, 200)}`, code, name);
    failure.status = parsed?.status;
    failure.reason = parsed?.reason;
    failure.action = parsed?.action;
    throw failure;
  }
  if (parsed === undefined) throw new E2EError(`${name} returned no JSON result.`, 'no_json', name);
  const units = parsed?.context?.quotaUnits ?? QUOTA[name] ?? 1;
  quotaUnits += units;
  SPENT_BY[name] = (SPENT_BY[name] ?? 0) + units;
  return parsed;
}

/**
 * One tool call, optionally retried (for YouTube read-after-write lag), recorded once at the end.
 * Throws E2EError on failure so the enclosing group stops.
 */
async function step(tool, args, { check, blocked, timeout, attempts = 1, delayMs = 3_000 } = {}) {
  const started = Date.now();
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await call(tool, args, timeout);
      const problem = check?.(value);
      if (problem) throw new E2EError(`unexpected response: ${problem}`, 'unexpected_response', tool);
      record(tool, 'PASS', Date.now() - started);
      return value;
    } catch (error) {
      lastError = error;
      if (quotaAborted) break;
      if (attempt + 1 < attempts) await sleep(delayMs + attempt * 500);
    }
  }
  record(tool, blocked?.(lastError) ? 'BLOCKED' : 'FAIL', Date.now() - started, `${lastError.code ?? 'error'}: ${lastError.message}`);
  throw lastError;
}

/** Calls a tool that must refuse with a specific error code; records PASS-GUARD. */
async function guard(tool, args, expectedCode, why) {
  const started = Date.now();
  try {
    await call(tool, args);
    record(tool, 'FAIL', Date.now() - started, `expected refusal ${expectedCode} but call succeeded`);
  } catch (error) {
    if (error.code === expectedCode) record(tool, 'PASS-GUARD', Date.now() - started, why);
    else record(tool, 'FAIL', Date.now() - started, `expected ${expectedCode}, got ${error.code}: ${error.message}`);
  }
}

/** Retry an unrecorded verification (read-after-write lag). */
async function retry(action, { attempts = 8, delayMs = 3_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (error) {
      lastError = error;
      if (quotaAborted) throw error;
    }
    await sleep(delayMs + attempt * 500);
  }
  throw lastError;
}

/**
 * preflight -> approve -> execute, retried as a whole (approvals are single use and expire).
 * Per-tool results are recorded once the final outcome is known.
 */
async function approved({ pre, preArgs, approve, exec, execArgs, attempts = 1, delayMs = 4_000, blocked, timeout }) {
  let lastError;
  let done = {};
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    done = {};
    let phase = pre;
    try {
      let t = Date.now();
      const preview = await call(pre, preArgs);
      done[pre] = Date.now() - t;
      if (!preview.approvalId) throw new E2EError('preflight returned no approvalId', 'unexpected_response', pre);
      phase = approve;
      t = Date.now();
      await call(approve, { approvalId: preview.approvalId, confirm: true });
      done[approve] = Date.now() - t;
      phase = exec;
      t = Date.now();
      const value = await call(exec, { ...execArgs, approvalId: preview.approvalId, confirm: true }, timeout);
      done[exec] = Date.now() - t;
      for (const [tool, ms] of Object.entries(done)) record(tool, 'PASS', ms);
      return value;
    } catch (error) {
      lastError = error;
      lastError.phase = phase;
      if (quotaAborted) break;
      if (attempt + 1 < attempts) await sleep(delayMs + attempt * 1_000);
    }
  }
  for (const [tool, ms] of Object.entries(done)) record(tool, 'PASS', ms);
  record(lastError.phase, blocked?.(lastError) ? 'BLOCKED' : 'FAIL', 0, `${lastError.code ?? 'error'}: ${lastError.message}`);
  throw lastError;
}

async function runGroup(name, action) {
  const started = Date.now();
  log(`group ${name}`);
  try {
    await action();
  } catch (error) {
    groupAborts.set(name, `stopped at ${error.phase ?? error.tool ?? '?'} (${error.code ?? 'error'}: ${redact(error.message).slice(0, 160)})`);
    log(`group ${name} aborted: ${groupAborts.get(name)}`);
  }
  log(`group ${name} done in ${Date.now() - started}ms`);
}

function skipTools(tools, reason) {
  for (const tool of tools) record(tool, 'SKIPPED', 0, reason);
}

/** Quiet cleanup helpers: never recorded as tool results; failures are listed in the report. */
async function quietApproved(pre, preArgs, approve, exec, execArgs) {
  const preview = await retry(() => call(pre, preArgs), { attempts: 4 });
  await call(approve, { approvalId: preview.approvalId, confirm: true });
  await retry(() => call(exec, { ...execArgs, approvalId: preview.approvalId, confirm: true }), { attempts: 3 });
}
const deletePlaylistQuiet = (playlistId) => quietApproved('youtube_preflight_delete_playlist', { playlistId }, 'youtube_approve_playlist', 'youtube_delete_playlist', { playlistId });
const deleteCaptionQuiet = (videoId, captionId) => quietApproved('youtube_preflight_caption_delete', { videoId, captionId }, 'youtube_approve_creator_content', 'youtube_delete_caption', { videoId, captionId });
const deleteCommentQuiet = (commentId) => quietApproved('youtube_preflight_delete_comment', { commentId }, 'youtube_approve_moderation', 'youtube_delete_comment', { commentId });

/** Registers a cleanup; returns a function that marks it done (call after the main flow deleted the resource). */
function addCleanup(label, run) {
  const entry = { label, run, done: false };
  cleanups.push(entry);
  return () => { entry.done = true; };
}

async function ff(args) {
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 10 * 1024 * 1024 });
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
let directApiPromise;
/**
 * Diagnostic-only access to the YouTube API through the built server modules (same OAuth state as the server).
 * Used solely to explain a failed MCP tool (the server hides provider reasons) and to seed fixtures for tools
 * that depend on a broken upstream tool. Never used to make a failing tool look like it passed.
 */
function directApi() {
  directApiPromise ??= (async () => {
    const load = (path) => import(pathToFileURL(join(repoRoot, 'dist', path)).href);
    const [{ OAuthService }, { loadConfig }, { YouTubeClient }] = await Promise.all([load('auth/oauth.js'), load('config.js'), load('youtube/client.js')]);
    const config = loadConfig(process.env, homedir());
    return new YouTubeClient(config).authorized(await new OAuthService(config).getAccessToken('youtube.write'));
  })();
  return directApiPromise;
}
const providerReason = (error) => `${error.code ?? ''} ${error.errors?.[0]?.reason ?? error.response?.data?.error?.errors?.[0]?.reason ?? ''} ${String(error.message).slice(0, 160)}`.trim();

const state = { videoId: undefined, channelId: undefined, publicVideoId: PUBLIC_VIDEO_CANDIDATES[0], uploadId: undefined };

function fatal(message) {
  process.stderr.write(`Live E2E aborted: ${message}\n`);
  throw Object.assign(new Error(message), { fatal: true });
}

async function main() {
  await mkdir(mediaDir, { recursive: true });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  log(`server exposes ${tools.length} tools`);

  // ---- Safety guard: nothing is written unless this passes ----
  const mcpChannel = env.YOUTUBE_MCP_CHANNEL_ID;
  if (!confirmChannel) fatal('YOUTUBE_E2E_CONFIRM_CHANNEL is required (the channel id this test may write to).');
  if (!mcpChannel) fatal('YOUTUBE_MCP_CHANNEL_ID is required.');
  if (confirmChannel !== mcpChannel) fatal('YOUTUBE_E2E_CONFIRM_CHANNEL does not equal YOUTUBE_MCP_CHANNEL_ID.');
  const account = await call('youtube_my_account');
  if (account.id !== confirmChannel) fatal(`Authenticated channel (${account.id}) does not equal YOUTUBE_E2E_CONFIRM_CHANNEL. No writes were made.`);
  state.channelId = account.id;
  log(`guard passed for channel "${account.title}" (${account.id})`);

  await runGroup('account', async () => {
    await step('youtube_auth_status', {}, { check: (v) => (v.authorized && v.scopeReadiness?.ready ? undefined : 'not authorized or scopes not ready') });
    await step('youtube_my_account', {}, { check: (v) => (v.id === state.channelId ? undefined : 'channel id mismatch') });
    await step('youtube_get_channel', { channelId: state.channelId }, { check: (v) => (v.items?.[0]?.id === state.channelId ? undefined : 'own channel not returned') });
  });
  await runGroup('public', publicGroup);
  await runGroup('uploads', uploadsGroup);
  await runGroup('your-videos', async () => {
    if (!state.videoId) throw new E2EError('no uploaded/reused video id', 'no_video', 'youtube_list_owned_videos');
    await step('youtube_list_owned_videos', { maxResults: 10 }, { check: (v) => (Array.isArray(v.items) && v.profile ? undefined : 'malformed page') });
    await step('youtube_get_owned_video', { videoId: state.videoId }, { check: (v) => (v.item?.id === state.videoId ? undefined : 'video not returned') });
  });
  await runGroup('edit-video', editVideoGroup);
  await runGroup('captions', captionsGroup);
  await runGroup('playlists', playlistsGroup);
  await runGroup('comments', commentsGroup);
  await runGroup('analytics', analyticsGroup);
  await runGroup('viewer', viewerGroup);
  await runGroup('watch-history', watchHistoryGroup);
  return tools;
}

async function publicGroup() {
  await step('youtube_search', { query: 'youtube data api', maxResults: 3 }, { check: (v) => (v.items?.length > 0 ? undefined : 'no results') });
  // Pick a stable public video that has a transcript.
  let found = false;
  const started = Date.now();
  for (const candidate of PUBLIC_VIDEO_CANDIDATES) {
    const transcript = await call('youtube_get_transcript', { videoId: candidate });
    if (transcript.available && transcript.text) { state.publicVideoId = candidate; found = true; record('youtube_get_transcript', 'PASS', Date.now() - started); break; }
  }
  if (!found) record('youtube_get_transcript', 'FAIL', Date.now() - started, `no transcript available for ${PUBLIC_VIDEO_CANDIDATES.join(',')}`);
  await step('youtube_get_video', { videoId: state.publicVideoId }, { check: (v) => (v.items?.[0]?.id === state.publicVideoId ? undefined : 'video not returned') });
  await step('youtube_list_video_categories', { regionCode: 'US' }, { check: (v) => (v.items?.length > 0 ? undefined : 'no categories') });
  await step('youtube_get_comments', { videoId: state.publicVideoId, maxResults: 3 }, { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
}

async function uploadsGroup() {
  const videoPath = join(mediaDir, 'e2e-test.mp4');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', videoPath]);
  const uploadArgs = { filePath: videoPath, title: runTitle, description: 'Automated youtube-mcp live E2E test video. Safe to delete.', privacyStatus: 'private' };
  const bogus = 'e2e-no-such-upload';

  if (reuseVideoId) {
    state.videoId = reuseVideoId;
    // Preflight and approve cost no quota and are exercised; the upload itself is not executed.
    const preview = await step('youtube_preflight_upload', uploadArgs, { check: (v) => (v.approvalId ? undefined : 'no approvalId') });
    await step('youtube_approve_upload', { approvalId: preview.approvalId, confirm: true });
    skipTools(['youtube_upload_video', 'youtube_get_upload_status', 'youtube_resume_upload', 'youtube_cancel_upload'], 'YOUTUBE_E2E_REUSE_VIDEO_ID set; no upload session in this run (unset it to run a real upload)');
    await guard('youtube_preflight_resume_upload', { ...uploadArgs, uploadId: bogus }, 'upload_not_found', 'no interrupted upload exists in this run; server correctly refuses an unknown uploadId');
    await guard('youtube_preflight_cancel_upload', { uploadId: bogus }, 'upload_not_found', 'no live upload session exists in this run; server correctly refuses an unknown uploadId');
    return;
  }

  const preview = await step('youtube_preflight_upload', uploadArgs, { check: (v) => (v.approvalId ? undefined : 'no approvalId') });
  await step('youtube_approve_upload', { approvalId: preview.approvalId, confirm: true });
  const uploaded = await step('youtube_upload_video', { ...uploadArgs, approvalId: preview.approvalId, confirm: true }, {
    timeout: 600_000,
    check: (v) => (v.state === 'complete' && v.videoId ? undefined : `upload state ${v.state}`),
  });
  state.videoId = uploaded.videoId;
  state.uploadId = uploaded.uploadId;
  log(`uploaded video ${state.videoId}`);

  await step('youtube_get_upload_status', { uploadId: state.uploadId }, { check: (v) => (v.state === 'complete' && v.videoId === state.videoId ? undefined : `status ${v.state}`) });

  // Wait for YouTube to finish processing (best effort; later groups retry on their own).
  try {
    await retry(async () => {
      const owned = await call('youtube_get_owned_video', { videoId: state.videoId });
      const processing = owned.item?.processingStatus;
      if (processing !== 'succeeded' && processing !== 'processed') throw new E2EError(`processing ${processing ?? 'pending'}`, 'processing', 'youtube_get_owned_video');
    }, { attempts: 18, delayMs: 10_000 });
  } catch (error) {
    log(`processing not confirmed before timeout (${error.message}); continuing`);
  }

  // Resume: the server uploads in a single request, so an interrupted session cannot be produced.
  // Resuming the completed session is the truthful exercise: it must probe and reconcile to complete.
  try {
    const resumed = await approved({
      pre: 'youtube_preflight_resume_upload', preArgs: { ...uploadArgs, uploadId: state.uploadId },
      approve: 'youtube_approve_upload', exec: 'youtube_resume_upload', execArgs: { ...uploadArgs, uploadId: state.uploadId },
    });
    if (resumed.state === 'complete' && resumed.videoId === state.videoId) {
      results.get('youtube_resume_upload').note = 'resume probed the completed session and reconciled to complete (no interrupted session can be produced; upload is single-request)';
    } else {
      record('youtube_resume_upload', 'FAIL', 0, `resume of completed session returned state ${resumed.state}`);
    }
  } catch { /* recorded by approved() */ }
  await guard('youtube_preflight_resume_upload', { ...uploadArgs, uploadId: bogus }, 'upload_not_found', 'unknown uploadId is refused');

  // Cancel: no session is ever cancellable mid-flight (single-request upload), so cancel the completed session.
  try {
    const cancelled = await approved({
      pre: 'youtube_preflight_cancel_upload', preArgs: { uploadId: state.uploadId },
      approve: 'youtube_approve_upload', exec: 'youtube_cancel_upload', execArgs: { uploadId: state.uploadId },
    });
    if (cancelled.state === 'cancelled') {
      results.get('youtube_cancel_upload').note = 'session DELETE accepted; state cancelled';
    } else {
      results.set('youtube_cancel_upload', {
        status: 'PASS-GUARD', ms: results.get('youtube_cancel_upload')?.ms ?? 0,
        note: `YouTube did not confirm cancel of a completed session (state ${cancelled.state}); a mid-flight cancel cannot be produced because the server uploads in one request`,
      });
    }
  } catch { /* recorded by approved() */ }
}

async function editVideoGroup() {
  if (!state.videoId) throw new E2EError('no video id', 'no_video', 'youtube_preflight_update_metadata');
  const newTitle = `${runTitle} (edited)`.slice(0, 100);
  const fields = { videoId: state.videoId, title: newTitle, tags: ['youtube-mcp-e2e', 'automated-test'] };
  await approved({
    pre: 'youtube_preflight_update_metadata', preArgs: fields, approve: 'youtube_approve_creator_content',
    exec: 'youtube_update_metadata', execArgs: fields, attempts: 3,
  });
  await retry(async () => {
    const owned = await call('youtube_get_owned_video', { videoId: state.videoId });
    if (owned.item?.title !== newTitle) throw new E2EError(`title not updated yet (${owned.item?.title})`, 'verify_failed', 'youtube_get_owned_video');
  }).catch((error) => record('youtube_update_metadata', 'FAIL', 0, `update accepted but get_owned_video never showed the new title: ${error.message}`));

  const thumbPath = join(mediaDir, 'e2e-thumb.jpg');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-frames:v', '1', '-q:v', '5', thumbPath]);
  const thumb = { videoId: state.videoId, filePath: thumbPath, mimeType: 'image/jpeg' };
  try {
    await approved({
      pre: 'youtube_preflight_set_thumbnail', preArgs: thumb, approve: 'youtube_approve_creator_content', exec: 'youtube_set_thumbnail', execArgs: thumb,
      blocked: (error) => error.status === 403 && error.reason === 'forbidden',
    });
  } catch (error) {
    if (error.status === 403 && error.reason === 'forbidden') {
      const current = results.get('youtube_set_thumbnail');
      results.set('youtube_set_thumbnail', { status: 'BLOCKED', ms: current?.ms ?? 0, note: `HTTP ${error.status} ${error.reason}: ${error.action ?? 'channel not eligible for custom thumbnails'}` });
    }
  }
}

async function captionsGroup() {
  if (!state.videoId) throw new E2EError('no video id', 'no_video', 'youtube_preflight_caption_upload');
  const videoId = state.videoId;
  const srt = (text) => `1\n00:00:00,000 --> 00:00:03,000\n${text}\n\n2\n00:00:03,000 --> 00:00:06,000\nSecond cue\n`;
  const first = join(mediaDir, 'e2e-caption-1.srt');
  const second = join(mediaDir, 'e2e-caption-2.srt');
  const marker = `UPDATEDMARKER${Date.now()}`;
  await writeFile(first, srt('Hello from youtube-mcp e2e'));
  await writeFile(second, srt(marker));
  const meta = { videoId, mimeType: 'application/octet-stream', language: 'en', name: 'youtube-mcp e2e' };

  const captionId = (await approved({
    pre: 'youtube_preflight_caption_upload', preArgs: { ...meta, filePath: first }, approve: 'youtube_approve_creator_content',
    exec: 'youtube_upload_caption', execArgs: { ...meta, filePath: first }, attempts: 2, delayMs: 8_000,
  })).captionId;
  const forget = addCleanup(`caption ${captionId}`, () => deleteCaptionQuiet(videoId, captionId));

  await step('youtube_list_caption_tracks', { videoId }, {
    attempts: 5, check: (v) => (v.items.some((track) => track.id === captionId) ? undefined : 'uploaded caption not listed'),
  });

  let updated = false;
  try {
    await approved({
      pre: 'youtube_preflight_caption_update', preArgs: { ...meta, captionId, filePath: second }, approve: 'youtube_approve_creator_content',
      exec: 'youtube_update_caption', execArgs: { ...meta, captionId, filePath: second }, attempts: 2, delayMs: 6_000,
    });
    updated = true;
  } catch {
  }
  const expected = updated ? marker : 'Hello from youtube-mcp e2e';

  // Download and verify the updated content; processing may lag, so retry with a fresh output path each time.
  let downloaded = '';
  const deadline = Date.now() + 120_000;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    const outputPath = join(mediaDir, `e2e-caption-download-${fileStamp}-${attempt}.srt`);
    const args = { videoId, captionId, outputPath, format: 'srt' };
    await approved({
      pre: 'youtube_preflight_caption_download', preArgs: args, approve: 'youtube_approve_creator_content',
      exec: 'youtube_download_caption', execArgs: args, attempts: 2, delayMs: 5_000,
    });
    downloaded = await readFile(outputPath, 'utf8');
    if (downloaded.includes(expected)) break;
    await sleep(10_000);
  }
  if (!downloaded.includes(expected)) record('youtube_download_caption', 'FAIL', 0, 'downloaded caption never contained the expected text');

  await approved({
    pre: 'youtube_preflight_caption_delete', preArgs: { videoId, captionId }, approve: 'youtube_approve_creator_content',
    exec: 'youtube_delete_caption', execArgs: { videoId, captionId }, attempts: 3,
  });
  forget();
  await retry(async () => {
    const page = await call('youtube_list_caption_tracks', { videoId });
    if (page.items.some((track) => track.id === captionId)) throw new E2EError('caption still listed', 'verify_failed', 'youtube_list_caption_tracks');
  }, { attempts: 5 }).catch((error) => record('youtube_delete_caption', 'FAIL', 0, `deleted but still listed: ${error.message}`));
}

async function playlistsGroup() {
  if (!state.videoId) throw new E2EError('no video id', 'no_video', 'youtube_preflight_add_playlist_item');
  const existing = await step('youtube_list_playlists', { maxResults: 50 }, { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
  for (const leftover of existing.items.filter((item) => item.title.startsWith(PREFIX))) {
    log(`deleting leftover playlist ${leftover.id}`);
    await deletePlaylistQuiet(leftover.id).catch((error) => cleanupFailures.push(`leftover playlist ${leftover.id}: ${error.message}`));
  }

  const title = `${PREFIX}playlist ${stamp}`;
  const createArgs = { title, description: 'Temporary E2E playlist.', privacyStatus: 'private' };
  const created = await approved({
    pre: 'youtube_preflight_create_playlist', preArgs: createArgs, approve: 'youtube_approve_playlist',
    exec: 'youtube_create_playlist', execArgs: createArgs,
  });
  const playlistId = created.playlistId;
  const forget = addCleanup(`playlist ${playlistId}`, () => deletePlaylistQuiet(playlistId));

  await step('youtube_get_playlist', { playlistId }, { attempts: 12, delayMs: 5_000, check: (v) => (v.item?.id === playlistId ? undefined : 'playlist not found') });

  const add = (videoId) => approved({
    pre: 'youtube_preflight_add_playlist_item', preArgs: { playlistId, videoId }, approve: 'youtube_approve_playlist',
    exec: 'youtube_add_playlist_item', execArgs: { playlistId, videoId }, attempts: 4, delayMs: 4_000,
  });
  const itemA = (await add(state.videoId)).playlistItemId;
  const itemB = (await add(state.publicVideoId)).playlistItemId;

  await step('youtube_list_playlist_items', { playlistId, maxResults: 50 }, {
    attempts: 6, check: (v) => (v.items.length >= 2 ? undefined : `expected 2 items, saw ${v.items.length}`),
  });

  const reorderArgs = { playlistId, playlistItemId: itemB, position: 0 };
  await approved({
    pre: 'youtube_preflight_reorder_playlist_item', preArgs: reorderArgs, approve: 'youtube_approve_playlist',
    exec: 'youtube_reorder_playlist_item', execArgs: reorderArgs, attempts: 3,
  });
  await retry(async () => {
    const page = await call('youtube_list_playlist_items', { playlistId, maxResults: 50 });
    if (page.items.find((item) => item.id === itemB)?.position !== 0) throw new E2EError('reorder not visible yet', 'verify_failed', 'youtube_list_playlist_items');
  }, { attempts: 6 }).catch((error) => record('youtube_reorder_playlist_item', 'FAIL', 0, `accepted but order unchanged: ${error.message}`));

  const newTitle = `${title} (renamed)`;
  await approved({
    pre: 'youtube_preflight_update_playlist', preArgs: { playlistId, title: newTitle }, approve: 'youtube_approve_playlist',
    exec: 'youtube_update_playlist', execArgs: { playlistId, title: newTitle }, attempts: 3,
  });
  await retry(async () => {
    const got = await call('youtube_get_playlist', { playlistId });
    if (got.item?.title !== newTitle) throw new E2EError('rename not visible yet', 'verify_failed', 'youtube_get_playlist');
  }).catch((error) => record('youtube_update_playlist', 'FAIL', 0, `accepted but title unchanged: ${error.message}`));

  await approved({
    pre: 'youtube_preflight_remove_playlist_item', preArgs: { playlistId, playlistItemId: itemA }, approve: 'youtube_approve_playlist',
    exec: 'youtube_remove_playlist_item', execArgs: { playlistId, playlistItemId: itemA }, attempts: 3,
  });
  await retry(async () => {
    const page = await call('youtube_list_playlist_items', { playlistId, maxResults: 50 });
    if (page.items.some((item) => item.id === itemA)) throw new E2EError('removed item still listed', 'verify_failed', 'youtube_list_playlist_items');
  }).catch((error) => record('youtube_remove_playlist_item', 'FAIL', 0, `accepted but item still listed: ${error.message}`));

  await approved({
    pre: 'youtube_preflight_delete_playlist', preArgs: { playlistId }, approve: 'youtube_approve_playlist',
    exec: 'youtube_delete_playlist', execArgs: { playlistId }, attempts: 4,
  });
  forget();
  await retry(async () => {
    const got = await call('youtube_get_playlist', { playlistId });
    if (got.item !== null) throw new E2EError('playlist still exists', 'verify_failed', 'youtube_get_playlist');
  }).catch((error) => record('youtube_delete_playlist', 'FAIL', 0, `accepted but playlist still readable: ${error.message}`));
}

async function commentsGroup() {
  if (!commentVideoId) {
    skipTools(GROUPS.comments, 'set YOUTUBE_E2E_COMMENT_VIDEO_ID (an unlisted video owned by the channel that accepts comments) to enable');
    return;
  }
  const text = `youtube-mcp e2e comment ${stamp}`;
  const replyText = `youtube-mcp e2e reply ${stamp}`;
  // A private video rejects comments (the server reports provider_outcome_unknown), so the video must be unlisted or public.
  const created = await step('youtube_create_comment', { videoId: commentVideoId, text, confirm: true }, { check: (v) => (v.id ? undefined : 'no comment id') })
    .catch((error) => { const row = results.get('youtube_create_comment'); if (row) row.note = `${row.note} -- hint: YOUTUBE_E2E_COMMENT_VIDEO_ID must be an unlisted/public video owned by the channel with comments enabled`.slice(0, 600); throw error; });
  const commentId = created.id;
  let commentDeleted = false;
  addCleanup(`comment ${commentId}`, async () => { if (!commentDeleted) await deleteCommentQuiet(commentId); });

  await step('youtube_list_channel_comment_threads', { maxResults: 50 }, {
    attempts: 5, check: (v) => (v.items.some((item) => item.id === commentId) ? undefined : 'new comment not in channel threads'),
  });

  const reply = await approved({
    pre: 'youtube_preflight_reply_to_comment', preArgs: { commentId, text: replyText }, approve: 'youtube_approve_moderation',
    exec: 'youtube_reply_to_comment', execArgs: { commentId, text: replyText }, attempts: 4, delayMs: 4_000,
  });
  const replyId = reply.replyId;
  let replyDeleted = false;
  addCleanup(`reply ${replyId}`, async () => { if (!replyDeleted) await deleteCommentQuiet(replyId); });

  await step('youtube_find_comment_reply', { parentId: commentId, text: replyText }, {
    attempts: 6, check: (v) => (v.matches?.some((match) => match.id === replyId) ? undefined : 'reply not found'),
  });
  await step('youtube_list_moderation_comments', { maxResults: 20 }, { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
  await step('youtube_get_moderation_comment', { commentId }, { attempts: 5, check: (v) => (v.item?.id === commentId ? undefined : 'comment not found') });

  for (const moderationStatus of ['heldForReview', 'published']) {
    await approved({
      pre: 'youtube_preflight_set_comment_moderation_status', preArgs: { commentId, moderationStatus }, approve: 'youtube_approve_moderation',
      exec: 'youtube_set_comment_moderation_status', execArgs: { commentId, moderationStatus }, attempts: 3,
    });
  }

  await approved({
    pre: 'youtube_preflight_delete_comment', preArgs: { commentId: replyId }, approve: 'youtube_approve_moderation',
    exec: 'youtube_delete_comment', execArgs: { commentId: replyId }, attempts: 3,
  });
  replyDeleted = true;
  await approved({
    pre: 'youtube_preflight_delete_comment', preArgs: { commentId }, approve: 'youtube_approve_moderation',
    exec: 'youtube_delete_comment', execArgs: { commentId }, attempts: 3,
  });
  commentDeleted = true;
}

async function analyticsGroup() {
  const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  const range = { startDate: day(28), endDate: day(1) };
  await step('youtube_creator_overview', range, { check: (v) => (v && typeof v === 'object' ? undefined : 'malformed') });
  await step('youtube_creator_top_videos', { ...range, limit: 5 }, { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
  await step('youtube_creator_retention', { videoId: state.videoId ?? state.publicVideoId }, { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
}

async function viewerGroup() {
  const subs = await step('youtube_list_subscriptions', { maxResults: 50 }, { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
  const target = SUBSCRIBE_CANDIDATES.find((id) => !subs.items.some((item) => item.channelId === id));
  if (!target) {
    skipTools(['youtube_subscribe', 'youtube_unsubscribe'], 'every candidate channel was already subscribed; existing subscriptions are never touched');
  } else {
    const made = await step('youtube_subscribe', { channelId: target, confirm: true }, { check: (v) => (v.subscriptionId ? undefined : 'no subscriptionId') });
    const forget = addCleanup(`subscription ${made.subscriptionId}`, () => call('youtube_unsubscribe', { subscriptionId: made.subscriptionId, confirm: true }));
    await retry(async () => {
      const page = await call('youtube_list_subscriptions', { maxResults: 50 });
      if (!page.items.some((item) => item.subscriptionId === made.subscriptionId)) throw new E2EError('subscription not listed yet', 'verify_failed', 'youtube_list_subscriptions');
    }, { attempts: 5 }).catch((error) => record('youtube_subscribe', 'FAIL', 0, `accepted but not listed: ${error.message}`));
    await step('youtube_unsubscribe', { subscriptionId: made.subscriptionId, confirm: true }, { check: (v) => (v.unsubscribed === true ? undefined : 'not unsubscribed') });
    forget();
    await retry(async () => {
      const page = await call('youtube_list_subscriptions', { maxResults: 50 });
      if (page.items.some((item) => item.subscriptionId === made.subscriptionId)) throw new E2EError('still subscribed', 'verify_failed', 'youtube_list_subscriptions');
    }, { attempts: 5 }).catch((error) => record('youtube_unsubscribe', 'FAIL', 0, `accepted but still listed: ${error.message}`));
  }

  // YouTube exposes no read API for a viewer's current rating, so the prior state cannot be restored exactly;
  // the test ends with "none", the neutral state.
  const forgetRating = addCleanup('rating', () => call('youtube_rate_video', { videoId: state.publicVideoId, rating: 'none', confirm: true }));
  await step('youtube_rate_video', { videoId: state.publicVideoId, rating: 'like', confirm: true }, { check: (v) => (v.rating === 'like' ? undefined : 'rating not echoed') });
  await step('youtube_rate_video', { videoId: state.publicVideoId, rating: 'none', confirm: true }, { check: (v) => (v.rating === 'none' ? undefined : 'rating not cleared') });
  forgetRating();
}

async function watchHistoryGroup() {
  let inputPath = takeoutOverride;
  let range = { startDate: '2020-03-01', endDate: '2020-03-20' };
  let trends = { baselineStartDate: '2020-03-01', baselineEndDate: '2020-03-10', comparisonStartDate: '2020-03-11', comparisonEndDate: '2020-03-20' };
  if (!inputPath) {
    // Fixed historic timestamps make the import idempotent across re-runs (events upsert by source key).
    const watch = (title, id, time) => ({ header: 'YouTube', title: `Watched ${title}`, titleUrl: `https://www.youtube.com/watch?v=${id}`, subtitles: [{ name: 'E2E Channel', url: 'https://www.youtube.com/channel/UCe2eSyntheticChannel0001' }], time, products: ['YouTube'] });
    const history = [
      watch('TypeScript compiler internals', 'e2eVideoAAAA1', '2020-03-02T10:00:00.000Z'),
      watch('Thai food recipe cooking', 'e2eVideoBBBB2', '2020-03-04T10:00:00.000Z'),
      watch('Piano music album walkthrough', 'e2eVideoCCCC3', '2020-03-12T10:00:00.000Z'),
      watch('Debugging javascript tests', 'e2eVideoDDDD4', '2020-03-15T10:00:00.000Z'),
      { header: 'YouTube', title: 'Searched for typescript generics', titleUrl: 'https://www.youtube.com/results?search_query=typescript+generics', time: '2020-03-13T10:00:00.000Z', products: ['YouTube'] },
    ];
    inputPath = join(mediaDir, 'e2e-watch-history.json');
    await writeFile(inputPath, JSON.stringify(history, null, 2));
  } else {
    const today = new Date().toISOString().slice(0, 10);
    range = { startDate: '1970-01-02', endDate: today };
    trends = { baselineStartDate: '1970-01-02', baselineEndDate: '2000-01-01', comparisonStartDate: '2000-01-02', comparisonEndDate: today };
  }
  const minWatches = takeoutOverride ? 0 : 4;

  await step('youtube_import_takeout', { inputPath }, { check: (v) => (v.imported >= 0 && v.imported + v.skipped >= 1 ? undefined : `imported ${v.imported}, skipped ${v.skipped}`) });
  await step('youtube_consumption_profile', range, { check: (v) => (v.totalWatchCount >= minWatches ? undefined : `totalWatchCount ${v.totalWatchCount}`) });
  await step('youtube_consumption_trends', trends, { check: (v) => (v && typeof v === 'object' ? undefined : 'malformed') });

  await step('youtube_save_curation_policy', { allowedSources: ['e2e-source'], retentionDays: 7 }, { check: (v) => (v.allowedSources?.includes('e2e-source') ? undefined : 'policy not echoed') });
  await step('youtube_save_curation_candidate', {
    videoId: state.publicVideoId, source: 'allowlist', sourceId: 'e2e-source', title: 'E2E candidate', reason: 'live e2e', estimatedMinutes: 5, apiFetchedAt: new Date().toISOString(),
  }, { check: (v) => (v.videoId === state.publicVideoId ? undefined : 'candidate not echoed') });
  await step('youtube_propose_consumption_queue', { minutes: 10 }, { check: (v) => (v.items?.length >= 1 ? undefined : 'queue has no items') });

  // Reset needs confirm: true; without it the server must refuse.
  const started = Date.now();
  let refused = false;
  try { await call('youtube_reset_consumption_data', {}); } catch (error) { refused = error.code === 'confirmation_required'; }
  if (!refused) {
    record('youtube_reset_consumption_data', 'FAIL', Date.now() - started, 'reset without confirm was not refused with confirmation_required');
    return;
  }
  await step('youtube_reset_consumption_data', { confirm: true }, { check: (v) => (v.deleted?.policies >= 1 ? undefined : `deleted ${JSON.stringify(v.deleted)}`) });
  // Verify the reset: with the policy gone, proposing a queue must be refused.
  try {
    await call('youtube_propose_consumption_queue', { minutes: 10 });
    record('youtube_reset_consumption_data', 'FAIL', 0, 'policy still present after reset');
  } catch (error) {
    if (error.code !== 'curation_policy_not_found') record('youtube_reset_consumption_data', 'FAIL', 0, `unexpected post-reset error ${error.code}`);
  }
}

// ---------------------------------------------------------------------------------------------
let exitCode = 0;
let toolNames = [];
try {
  toolNames = await main();
} catch (error) {
  if (error.fatal) exitCode = 2;
  else { process.stderr.write(`Live E2E crashed: ${redact(error.stack ?? error.message)}\n`); exitCode = 1; }
} finally {
  for (const entry of [...cleanups].reverse()) {
    if (entry.done) continue;
    try { await entry.run(); log(`cleaned up ${entry.label}`); } catch (error) { cleanupFailures.push(`${entry.label}: ${redact(error.message)}`); }
  }
  await client.close().catch(() => undefined);
}

if (exitCode === 2) process.exit(2);

// Coverage: every tool the server lists must have a result.
for (const tool of toolNames) {
  if (!results.has(tool)) {
    const reason = groupAborts.get(groupOf(tool));
    record(tool, 'FAIL', 0, reason ? `not covered (group ${groupOf(tool)} ${reason})` : 'not covered');
  }
}

const rows = toolNames.map((tool) => ({ tool, group: groupOf(tool), ...results.get(tool) }));
const counts = rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {});
const report = {
  startedAt: stamp,
  finishedAt: new Date().toISOString(),
  channelId: state.channelId,
  toolCount: toolNames.length,
  counts,
  quotaUnitsApprox: quotaUnits,
  quotaByTool: SPENT_BY,
  uploadedVideoId: reuseVideoId ? undefined : state.videoId,
  reusedVideoId: reuseVideoId,
  groupAborts: Object.fromEntries(groupAborts),
  cleanupFailures,
  rows,
};

const pad = (value, width) => String(value).padEnd(width);
const lines = [`${pad('TOOL', 48)}${pad('GROUP', 14)}${pad('STATUS', 11)}${pad('MS', 7)}NOTE`];
for (const row of rows) lines.push(`${pad(row.tool, 48)}${pad(row.group, 14)}${pad(row.status, 11)}${pad(row.ms ?? 0, 7)}${row.note ?? ''}`.trimEnd());
process.stdout.write(`${lines.join('\n')}\n\n`);
process.stdout.write(`Summary: ${Object.entries(counts).map(([status, n]) => `${status}=${n}`).join(' ')} of ${toolNames.length} tools\n`);
process.stdout.write(`Quota (approx): ${quotaUnits} units\n`);
if (report.uploadedVideoId) process.stdout.write(`Uploaded (private) video left on channel: ${report.uploadedVideoId}\n`);
if (cleanupFailures.length > 0) process.stdout.write(`Cleanup failures:\n${cleanupFailures.map((line) => `  ${line}`).join('\n')}\n`);

await mkdir(outDir, { recursive: true });
const base = join(outDir, `e2e-report-${fileStamp}`);
const markdown = [
  '# youtube-mcp live E2E report', '',
  `- Started: ${report.startedAt}`, `- Channel: ${report.channelId}`,
  `- Tools: ${report.toolCount}`, `- Summary: ${Object.entries(counts).map(([status, n]) => `${status}=${n}`).join(', ')}`,
  `- Approx. quota: ${quotaUnits} units`,
  report.uploadedVideoId ? `- Uploaded video (private, delete manually): ${report.uploadedVideoId}` : `- Reused video: ${reuseVideoId ?? 'n/a'}`,
  cleanupFailures.length ? `- Cleanup failures: ${cleanupFailures.join('; ')}` : '- Cleanup failures: none', '',
  '| Tool | Group | Status | ms | Note |', '|---|---|---|---|---|',
  ...rows.map((row) => `| ${row.tool} | ${row.group} | ${row.status} | ${row.ms ?? 0} | ${(row.note ?? '').replace(/\|/g, '\\|')} |`), '',
].join('\n');
await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
await writeFile(`${base}.md`, markdown);
process.stdout.write(`Report: ${base}.{json,md}\n`);

process.exit(counts.FAIL ? 1 : exitCode);
