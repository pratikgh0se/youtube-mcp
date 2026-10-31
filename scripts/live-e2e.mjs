// Live end-to-end test: exercises every tool of the YouTube MCP server against a real, dedicated test channel.
//
// Opt-in and guarded. Required env:
//   YOUTUBE_LIVE_E2E=1                       opt in
//   YOUTUBE_E2E_CONFIRM_CHANNEL=<channel id> must equal youtube_my_account id AND YOUTUBE_MCP_CHANNEL_ID
// Optional env:
//   YOUTUBE_E2E_REUSE_VIDEO_ID               skip the (1600-unit) upload; reuse a video from a previous run
//   YOUTUBE_E2E_COMMENT_VIDEO_ID             unlisted/public video owned by the channel that accepts comments;
//                                            without it the comment + moderation group is SKIPPED
//   YOUTUBE_E2E_GROUPS                       comma list of groups to run (account is always run); others are SKIPPED
//   YOUTUBE_E2E_FRESH_UPLOAD=1               lifecycle group: always upload a new test video instead of reusing an archived one
//                                            (reuse = newest private, unscheduled video titled "youtube-mcp e2e lifecycle ...").
//                                            The scheduled-publish step needs a never-published video, so it is SKIPPED on a reused one.
//   YOUTUBE_E2E_ARCHIVE_VIDEO_IDS            comma list of owned video ids to archive (private, unscheduled) at the end of the run;
//                                            each id must be confirmed as owned by the confirmed channel first
//   YOUTUBE_E2E_TAKEOUT                      path to a Takeout watch-history .json/.html instead of the synthetic one
//   YOUTUBE_E2E_OUT_DIR                      media + report directory (default: <os tmpdir>/youtube-mcp-e2e)
//   YOUTUBE_E2E_FFMPEG                       ffmpeg binary (default: /opt/homebrew/bin/ffmpeg or `ffmpeg`)
//
// Result statuses: PASS, PASS-GUARD (correct refusal because the precondition cannot be produced),
// BLOCKED (YouTube refused for an account-level reason), SKIPPED (optional input missing), FAIL.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const groupFilter = env.YOUTUBE_E2E_GROUPS ? new Set(env.YOUTUBE_E2E_GROUPS.split(',').map((g) => g.trim()).filter(Boolean)) : undefined;
const freshUpload = env.YOUTUBE_E2E_FRESH_UPLOAD === '1';
const archiveVideoIds = (env.YOUTUBE_E2E_ARCHIVE_VIDEO_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
const takeoutOverride = env.YOUTUBE_E2E_TAKEOUT || undefined;
const outDir = env.YOUTUBE_E2E_OUT_DIR || join(tmpdir(), 'youtube-mcp-e2e');
const mediaDir = join(outDir, 'e2e-media');
const ffmpeg = env.YOUTUBE_E2E_FFMPEG || (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const stamp = new Date().toISOString();
const fileStamp = stamp.replace(/[:.]/g, '-');
const PREFIX = 'youtube-mcp e2e ';
const runTitle = `${PREFIX}${stamp}`;
const LIFECYCLE_PREFIX = `${PREFIX}lifecycle `;

// Stable public fixtures.
const PUBLIC_VIDEO_CANDIDATES = ['dQw4w9WgXcQ', 'jNQXAC9IVRw', '9bZkp7q19f0'];
const SUBSCRIBE_CANDIDATES = ['UCBR8-60-B28hp2BmDPdntcQ', 'UC_x5XG1OV2P6uZZ5FSM9Ttw']; // YouTube, Google for Developers

// Approximate YouTube Data API quota cost per tool (used only when the server does not return context.quotaUnits).
// Tools not listed cost 1 (a single list/read). Local-only and Analytics-API tools cost 0 Data API units.
const QUOTA = {
  youtube_search: 100, youtube_upload_video: 1600, youtube_update_metadata: 50, youtube_set_thumbnail: 50,
  youtube_upload_caption: 400, youtube_update_caption: 450, youtube_download_caption: 200, youtube_delete_caption: 50,
  youtube_list_caption_tracks: 50, youtube_preflight_caption_update: 51, youtube_preflight_caption_delete: 51,
  youtube_create_playlist: 50, youtube_update_playlist: 50, youtube_delete_playlist: 50, youtube_add_playlist_item: 50,
  youtube_remove_playlist_item: 50, youtube_reorder_playlist_item: 50, youtube_create_comment: 50, youtube_reply_to_comment: 50,
  youtube_set_comment_moderation_status: 50, youtube_delete_comment: 50, youtube_subscribe: 50, youtube_unsubscribe: 50,
  youtube_rate_video: 50, youtube_archive_video: 50, youtube_preflight_archive_video: 2,
  youtube_auth_status: 0, youtube_get_upload_status: 0, youtube_creator_overview: 0, youtube_creator_top_videos: 0, youtube_creator_retention: 0,
  youtube_import_takeout: 0, youtube_consumption_profile: 0, youtube_consumption_trends: 0, youtube_save_curation_policy: 0,
  youtube_save_curation_candidate: 0, youtube_propose_consumption_queue: 0, youtube_reset_consumption_data: 0,
  youtube_approve: 0,
  // v0.3.0: reads that return context.quotaUnits use it; these are fallbacks for tools that do not.
  youtube_creator_report: 0, youtube_preflight_update_channel: 2, youtube_update_channel: 52,
  youtube_preflight_unsubscribe_many: 2, youtube_unsubscribe_many: 102,
};
const SPENT_BY = {};
let quotaUnits = 0;

// Tool groups; used for report grouping and for explaining "not covered" tools.
const GROUPS = {
  account: ['youtube_auth_status', 'youtube_my_account', 'youtube_get_channel'],
  public: ['youtube_search', 'youtube_trending', 'youtube_list_channel_videos', 'youtube_get_video', 'youtube_get_transcript', 'youtube_list_video_categories', 'youtube_get_comments'],
  uploads: ['youtube_preflight_upload', 'youtube_approve', 'youtube_upload_video', 'youtube_get_upload_status', 'youtube_preflight_resume_upload', 'youtube_resume_upload', 'youtube_preflight_cancel_upload', 'youtube_cancel_upload'],
  'your-videos': ['youtube_list_owned_videos', 'youtube_get_owned_video'],
  'edit-video': ['youtube_preflight_update_metadata', 'youtube_approve', 'youtube_update_metadata', 'youtube_preflight_set_thumbnail', 'youtube_set_thumbnail'],
  lifecycle: ['youtube_preflight_archive_video', 'youtube_archive_video'],
  captions: ['youtube_preflight_caption_upload', 'youtube_upload_caption', 'youtube_list_caption_tracks', 'youtube_preflight_caption_update', 'youtube_update_caption', 'youtube_download_caption', 'youtube_preflight_caption_delete', 'youtube_delete_caption'],
  playlists: ['youtube_list_playlists', 'youtube_get_playlist', 'youtube_list_playlist_items', 'youtube_preflight_create_playlist', 'youtube_approve', 'youtube_create_playlist', 'youtube_preflight_update_playlist', 'youtube_update_playlist', 'youtube_preflight_delete_playlist', 'youtube_delete_playlist', 'youtube_preflight_add_playlist_item', 'youtube_add_playlist_item', 'youtube_preflight_remove_playlist_item', 'youtube_remove_playlist_item', 'youtube_preflight_reorder_playlist_item', 'youtube_reorder_playlist_item'],
  comments: ['youtube_create_comment', 'youtube_list_channel_comment_threads', 'youtube_preflight_reply_to_comment', 'youtube_approve', 'youtube_reply_to_comment', 'youtube_find_comment_reply', 'youtube_list_moderation_comments', 'youtube_get_moderation_comment', 'youtube_preflight_set_comment_moderation_status', 'youtube_set_comment_moderation_status', 'youtube_preflight_delete_comment', 'youtube_delete_comment'],
  analytics: ['youtube_creator_overview', 'youtube_creator_top_videos', 'youtube_creator_retention', 'youtube_creator_report'],
  channel: ['youtube_preflight_update_channel', 'youtube_approve', 'youtube_update_channel'],
  viewer: ['youtube_list_subscriptions', 'youtube_subscribe', 'youtube_unsubscribe', 'youtube_preflight_unsubscribe_many', 'youtube_unsubscribe_many', 'youtube_rate_video'],
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

/**
 * YouTube needs a while (observed: more than 17s) to reprocess an updated caption, and a download in that window fails
 * with 404 captionNotFound. Only that failure is retriable here; every other error fails fast.
 */
const isCaptionNotReady = (error) => error.reason === 'captionNotFound' || /captionNotFound/.test(error.message ?? '')
  || (error.code === 'provider_error' && (error.status === 404 || /\b404\b/.test(error.message ?? '')));
const DOWNLOAD_BACKOFF_MS = [5_000, 10_000, 15_000, 20_000, 30_000]; // the last value repeats until the deadline

/**
 * One youtube_download_caption call, retried with growing backoff on retriable 404s until `deadline` (epoch ms).
 * `maxAttempts` (default unlimited, bounded by the deadline) caps the number of calls. Records one result at the end.
 * `label` (for example the format) prefixes the note of the recorded result as "label: ...".
 * Quota: each attempt (including failed ones) may cost about 200 units.
 */
async function downloadCaptionRetrying(args, deadline, maxAttempts = Infinity, label = '') {
  const started = Date.now();
  const tool = 'youtube_download_caption';
  for (let attempt = 0; ; attempt += 1) {
    try {
      const value = await call(tool, args);
      if (!(typeof value.path === 'string' && value.path.endsWith(args.fileName))) throw new E2EError('unexpected response: no path returned', 'unexpected_response', tool);
      record(tool, 'PASS', Date.now() - started, label ? `${label} downloaded` : undefined);
      return value;
    } catch (error) {
      const wait = DOWNLOAD_BACKOFF_MS[Math.min(attempt, DOWNLOAD_BACKOFF_MS.length - 1)];
      if (quotaAborted || !isCaptionNotReady(error) || attempt + 1 >= maxAttempts || Date.now() + wait >= deadline) {
        record(tool, 'FAIL', Date.now() - started, `${label ? `${label}: ` : ''}${error.code ?? 'error'}: ${error.message}${isCaptionNotReady(error) ? ` (still not ready after ${attempt + 1} attempts)` : ''}`);
        throw error;
      }
      log(`download not ready (${error.reason ?? error.code}); retry ${attempt + 1} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
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
async function retry(action, { attempts = 8, delayMs = 3_000, retryable = () => true } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (error) {
      lastError = error;
      if (quotaAborted || !retryable(error)) throw error;
    }
    await sleep(delayMs + attempt * 500);
  }
  throw lastError;
}

/** reconcile helper for idempotent changes that a following read-back verifies: the verification decides pass or fail. */
const verifiedByReadback = async () => ({ unverified: true });

/**
 * preflight -> approve -> execute, retried as a whole (approvals are single use and expire).
 * Retries only definitive failures. After provider_outcome_unknown the change may already exist, so it is NEVER
 * re-preflighted or re-executed: `reconcile(error)` (list and pick up the resource) decides, and no result means FAIL.
 * Per-tool results are recorded once the final outcome is known.
 */
async function approved({ pre, preArgs, approve, exec, execArgs, attempts = 1, delayMs = 4_000, blocked, timeout, reconcile }) {
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
      if (error.code === 'provider_outcome_unknown') {
        const reconciled = reconcile ? await Promise.resolve(reconcile(error)).catch(() => undefined) : undefined;
        if (reconciled) {
          for (const [tool, ms] of Object.entries(done)) record(tool, 'PASS', ms);
          record(exec, 'PASS', 0, 'outcome was unknown; reconciled by listing the resource');
          return reconciled;
        }
        break;
      }
      if (attempt + 1 < attempts) await sleep(delayMs + attempt * 1_000);
    }
  }
  for (const [tool, ms] of Object.entries(done)) record(tool, 'PASS', ms);
  record(lastError.phase, blocked?.(lastError) ? 'BLOCKED' : 'FAIL', 0, `${lastError.code ?? 'error'}: ${lastError.message}`);
  throw lastError;
}

async function runGroup(name, action) {
  if (groupFilter && name !== 'account' && !groupFilter.has(name)) {
    skipTools(GROUPS[name] ?? [], "not in this run's groups (YOUTUBE_E2E_GROUPS)");
    return;
  }
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
  // Approvals are single use: after provider_outcome_unknown never execute again; report it for manual reconciliation.
  await retry(() => call(exec, { ...execArgs, approvalId: preview.approvalId, confirm: true }), { attempts: 3, retryable: (error) => error.code !== 'provider_outcome_unknown' });
}
const deletePlaylistQuiet = (playlistId) => quietApproved('youtube_preflight_delete_playlist', { playlistId }, 'youtube_approve', 'youtube_delete_playlist', { playlistId });
const deleteCaptionQuiet = (videoId, captionId) => quietApproved('youtube_preflight_caption_delete', { videoId, captionId }, 'youtube_approve', 'youtube_delete_caption', { videoId, captionId });
/** Archive (private, unscheduled) without recording results; an already-archived video counts as success. Returns true if a change was made. */
async function archiveVideoQuiet(videoId) {
  try {
    await quietApproved('youtube_preflight_archive_video', { videoId }, 'youtube_approve', 'youtube_archive_video', { videoId });
    return true;
  } catch (error) {
    if (error.code === 'already_archived') return false;
    throw error;
  }
}
const deleteCommentQuiet = (commentId) => quietApproved('youtube_preflight_delete_comment', { commentId }, 'youtube_approve', 'youtube_delete_comment', { commentId });

/** Registers a cleanup; returns a function that marks it done (call after the main flow deleted the resource). */
function addCleanup(label, run) {
  const entry = { label, run, done: false };
  cleanups.push(entry);
  return () => { entry.done = true; };
}

/** Runs pending cleanups newest-first (optionally only those matching `only`); each runs at most once. */
async function runCleanups(only = () => true) {
  for (const entry of [...cleanups].reverse()) {
    if (entry.done || !only(entry)) continue;
    entry.done = true;
    try { await entry.run(); log(`cleaned up ${entry.label}`); } catch (error) { cleanupFailures.push(`${entry.label}: ${redact(error.message)}`); }
  }
}

async function ff(args) {
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 10 * 1024 * 1024 });
}

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

  if (reuseVideoId) state.videoId = reuseVideoId;
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
  await runGroup('lifecycle', lifecycleGroup);
  await runGroup('comments', commentsGroup);
  await runGroup('analytics', analyticsGroup);
  await runGroup('channel', channelGroup);
  await runGroup('viewer', viewerGroup);
  await runGroup('watch-history', watchHistoryGroup);
  // Cleanups (comment deletes etc.) must run before videos are archived: comments on a private video can no longer be deleted.
  await runCleanups();
  await archiveLeftovers();
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
  await step('youtube_search', { query: 'youtube', maxResults: 3, order: 'date', videoDuration: 'short', regionCode: 'US', relevanceLanguage: 'en', safeSearch: 'moderate', publishedAfter: new Date(Date.now() - 30 * 86_400_000).toISOString() },
    { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
  await step('youtube_trending', { regionCode: 'US', maxResults: 5 }, { check: (v) => (v.items?.length > 0 && v.items[0].viewCount !== undefined ? undefined : 'no trending videos with statistics') });
  const uploads = await step('youtube_list_channel_videos', { channelId: '@YouTube', maxResults: 5 }, {
    check: (v) => (v.items?.length > 0 && v.channelId && v.items.every((item) => item.channelId === v.channelId) ? undefined : 'no uploads for @YouTube'),
  });
  if (uploads.nextPageToken) {
    await step('youtube_list_channel_videos', { channelId: uploads.channelId, maxResults: 5, pageToken: uploads.nextPageToken }, {
      check: (v) => (v.items?.length > 0 && v.items[0].id !== uploads.items[0].id ? undefined : 'second page empty or repeated'),
    });
  }
  await step('youtube_get_video', { videoId: state.publicVideoId }, { check: (v) => (v.items?.[0]?.id === state.publicVideoId ? undefined : 'video not returned') });
  await step('youtube_list_video_categories', { regionCode: 'US' }, { check: (v) => (v.items?.length > 0 ? undefined : 'no categories') });
  await step('youtube_get_comments', { videoId: state.publicVideoId, maxResults: 3 }, { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
}

async function makeTestVideo(name) {
  const videoPath = join(mediaDir, name);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', videoPath]);
  return videoPath;
}

/** Best effort: wait for YouTube to finish processing (later steps retry on their own). */
async function waitForProcessing(videoId) {
  try {
    await retry(async () => {
      const owned = await call('youtube_get_owned_video', { videoId });
      const processing = owned.item?.processingStatus;
      if (processing !== 'succeeded' && processing !== 'processed') throw new E2EError(`processing ${processing ?? 'pending'}`, 'processing', 'youtube_get_owned_video');
    }, { attempts: 18, delayMs: 10_000 });
  } catch (error) {
    log(`processing not confirmed before timeout (${error.message}); continuing`);
  }
}

async function uploadsGroup() {
  const videoPath = await makeTestVideo('e2e-test.mp4');
  const uploadArgs = { filePath: videoPath, title: runTitle, description: 'Automated youtube-mcp live E2E test video. Safe to delete.', privacyStatus: 'private' };
  const bogus = 'e2e-no-such-upload';

  if (reuseVideoId) {
    state.videoId = reuseVideoId;
    // Preflight and approve cost no quota and are exercised; the upload itself is not executed.
    const preview = await step('youtube_preflight_upload', uploadArgs, { check: (v) => (v.approvalId ? undefined : 'no approvalId') });
    await step('youtube_approve', { approvalId: preview.approvalId, confirm: true });
    skipTools(['youtube_upload_video', 'youtube_get_upload_status', 'youtube_resume_upload', 'youtube_cancel_upload'], 'YOUTUBE_E2E_REUSE_VIDEO_ID set; no upload session in this run (unset it to run a real upload)');
    await guard('youtube_preflight_resume_upload', { ...uploadArgs, uploadId: bogus }, 'upload_not_found', 'no interrupted upload exists in this run; server correctly refuses an unknown uploadId');
    await guard('youtube_preflight_cancel_upload', { uploadId: bogus }, 'upload_not_found', 'no live upload session exists in this run; server correctly refuses an unknown uploadId');
    return;
  }

  const preview = await step('youtube_preflight_upload', uploadArgs, { check: (v) => (v.approvalId ? undefined : 'no approvalId') });
  await step('youtube_approve', { approvalId: preview.approvalId, confirm: true });
  const uploaded = await step('youtube_upload_video', { ...uploadArgs, approvalId: preview.approvalId, confirm: true }, {
    timeout: 600_000,
    check: (v) => (v.state === 'complete' && v.videoId ? undefined : `upload state ${v.state}`),
  });
  state.videoId = uploaded.videoId;
  state.uploadId = uploaded.uploadId;
  log(`uploaded video ${state.videoId}`);

  await step('youtube_get_upload_status', { uploadId: state.uploadId }, { check: (v) => (v.state === 'complete' && v.videoId === state.videoId ? undefined : `status ${v.state}`) });

  // Wait for YouTube to finish processing (best effort; later groups retry on their own).
  await waitForProcessing(state.videoId);

  // Resume: the server uploads in a single request, so an interrupted session cannot be produced.
  // Resuming the completed session is the truthful exercise: it must probe and reconcile to complete.
  try {
    const resumed = await approved({
      pre: 'youtube_preflight_resume_upload', preArgs: { ...uploadArgs, uploadId: state.uploadId },
      approve: 'youtube_approve', exec: 'youtube_resume_upload', execArgs: { ...uploadArgs, uploadId: state.uploadId },
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
      approve: 'youtube_approve', exec: 'youtube_cancel_upload', execArgs: { uploadId: state.uploadId },
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
    pre: 'youtube_preflight_update_metadata', preArgs: fields, approve: 'youtube_approve',
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
      pre: 'youtube_preflight_set_thumbnail', preArgs: thumb, approve: 'youtube_approve', exec: 'youtube_set_thumbnail', execArgs: thumb,
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

  // The reuse video may hold a track left by an aborted earlier run, which would make the upload fail with 409 captionExists.
  // Remove only tracks this harness creates: exactly its own track name AND language. Never touch any other track.
  const existingTracks = (await call('youtube_list_caption_tracks', { videoId })).items ?? [];
  const staleTracks = existingTracks.filter((track) => track.name === meta.name && track.language === meta.language);
  for (const stale of staleTracks) {
    log(`removing stale harness caption track ${stale.id} (name "${stale.name}", language ${stale.language}) from a previous run`);
    await deleteCaptionQuiet(videoId, stale.id).catch((error) => cleanupFailures.push(`stale caption ${stale.id}: ${error.message}`));
  }
  const knownCaptionIds = new Set(existingTracks.filter((track) => !staleTracks.includes(track)).map((track) => track.id));
  const captionId = (await approved({
    reconcile: async () => {
      const found = ((await call('youtube_list_caption_tracks', { videoId })).items ?? []).find((track) => !knownCaptionIds.has(track.id) && track.name === meta.name);
      return found ? { captionId: found.id } : undefined;
    },
    pre: 'youtube_preflight_caption_upload', preArgs: { ...meta, filePath: first }, approve: 'youtube_approve',
    exec: 'youtube_upload_caption', execArgs: { ...meta, filePath: first }, attempts: 2, delayMs: 8_000,
  })).captionId;
  const forget = addCleanup(`caption ${captionId}`, () => deleteCaptionQuiet(videoId, captionId));

  await step('youtube_list_caption_tracks', { videoId }, {
    attempts: 5, check: (v) => (v.items.some((track) => track.id === captionId) ? undefined : 'uploaded caption not listed'),
  });

  let updated = false;
  try {
    await approved({
      pre: 'youtube_preflight_caption_update', preArgs: { ...meta, captionId, filePath: second }, approve: 'youtube_approve',
      exec: 'youtube_update_caption', execArgs: { ...meta, captionId, filePath: second }, attempts: 2, delayMs: 6_000,
    });
    updated = true;
  } catch {
  }
  const expected = updated ? marker : 'Hello from youtube-mcp e2e';

  // Download and verify the updated content; processing may lag, so retry with a fresh output path each time.
  let downloaded = '';
  const downloadedPaths = [];
  addCleanup('downloaded caption files', async () => { await Promise.all(downloadedPaths.map((file) => rm(file, { force: true }))); });
  // Quota: about 200 units per attempt, failed 404 attempts included. srt is the gate: with the 120s deadline and
  // 5s/10s/15s/20s/30s backoff it makes at most 7 attempts (about 1,400 units) if YouTube never serves the caption,
  // and then the other formats are skipped entirely.
  const deadline = Date.now() + 120_000;
  let srtFailed = false;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    const fileName = `e2e-caption-download-${fileStamp}-${attempt}.srt`;
    const args = { videoId, captionId, fileName, format: 'srt' };
    // No preflight/approval. Ownership is verified server-side; the file lands in <state dir>/downloads/ and the tool returns its path.
    let result;
    try {
      result = await downloadCaptionRetrying(args, deadline);
    } catch (error) {
      if (quotaAborted || !isCaptionNotReady(error)) throw error;
      srtFailed = true; // already recorded as FAIL by the helper
      break;
    }
    downloadedPaths.push(result.path);
    downloaded = await readFile(result.path, 'utf8');
    if (downloaded.includes(expected)) break;
    await sleep(10_000);
  }
  if (!srtFailed && !downloaded.includes(expected)) record('youtube_download_caption', 'FAIL', 0, 'downloaded caption never contained the expected text');

  // Other formats of the same track, only once srt succeeded. YouTube's tfmt conversion lags behind srt after a
  // caption update, so wait 60s once first (no quota). Quota: about 200 units per download attempt, so about 800 for
  // these four when each succeeds first time; each format gets at most 4 attempts (backoff 5s, 10s, 15s) within a 90s
  // deadline, so the worst case is 4 x 4 x 200 = 3,200 units. Overall worst case: srt never ready about 1,400 units
  // (formats skipped); srt ready about 200 x (up to 12 content-check rounds) = 2,400 plus 3,200 = about 5,600 units,
  // well under 10,000.
  const formatChecks = {
    vtt: (t) => (t.startsWith('WEBVTT') ? undefined : 'does not start with WEBVTT'),
    ttml: (t) => (t.includes('<tt') ? undefined : 'no <tt element'),
    sbv: (t) => (/\b0:00:\d\d\.\d{3},\d+:\d\d:\d\d\.\d{3}/.test(t) ? undefined : 'no sbv-style 0:00:ss.mmm,h:mm:ss.mmm timestamps'),
    scc: (t) => (t.startsWith('Scenarist_SCC') ? undefined : 'does not start with Scenarist_SCC'),
  };
  if (srtFailed) log('skipped: srt never became downloadable');
  else if (downloaded.includes('-->') && /\d,\d{3}/.test(downloaded)) record('youtube_download_caption', 'PASS', 0, 'srt has --> and comma milliseconds');
  else record('youtube_download_caption', 'FAIL', 0, 'srt missing --> or comma milliseconds');
  if (!srtFailed) {
    log('waiting 60s for YouTube to convert the other caption formats');
    await sleep(60_000);
  }
  const failedFormats = [];
  for (const [format, looksRight] of srtFailed ? [] : Object.entries(formatChecks)) {
    const fileName = `e2e-caption-download-${fileStamp}-fmt.${format}`;
    let result;
    try {
      result = await downloadCaptionRetrying({ videoId, captionId, fileName, format }, Date.now() + 90_000, 4, format);
    } catch (error) {
      if (quotaAborted || !isCaptionNotReady(error)) throw error;
      failedFormats.push(format); // already recorded as FAIL (note starts with the format) by the helper
      continue;
    }
    downloadedPaths.push(result.path);
    const text = (await readFile(result.path, 'utf8')).replace(/^\uFEFF/, '');
    const problem = text.trim() ? looksRight(text) : 'file is empty';
    record('youtube_download_caption', problem ? 'FAIL' : 'PASS', 0, problem ? `${format}: ${problem}` : `${format} looks like ${format}`);
    if (problem) failedFormats.push(format);
  }
  // Stop before the delete step so the gate fails; the end-of-run cleanup still deletes the harness's own track.
  if (failedFormats.length) throw new E2EError(`caption formats failed: ${failedFormats.join(', ')}`, 'caption_formats_failed', 'youtube_download_caption');

  await approved({
    pre: 'youtube_preflight_caption_delete', preArgs: { videoId, captionId }, approve: 'youtube_approve',
    exec: 'youtube_delete_caption', execArgs: { videoId, captionId }, attempts: 3, reconcile: verifiedByReadback,
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
    pre: 'youtube_preflight_create_playlist', preArgs: createArgs, approve: 'youtube_approve',
    exec: 'youtube_create_playlist', execArgs: createArgs,
    reconcile: async () => {
      const found = (await call('youtube_list_playlists', { maxResults: 50 })).items.find((item) => item.title === title);
      return found ? { playlistId: found.id } : undefined;
    },
  });
  const playlistId = created.playlistId;
  const forget = addCleanup(`playlist ${playlistId}`, () => deletePlaylistQuiet(playlistId));

  await step('youtube_get_playlist', { playlistId }, { attempts: 12, delayMs: 5_000, check: (v) => (v.item?.id === playlistId ? undefined : 'playlist not found') });

  const add = (videoId) => approved({
    pre: 'youtube_preflight_add_playlist_item', preArgs: { playlistId, videoId }, approve: 'youtube_approve',
    exec: 'youtube_add_playlist_item', execArgs: { playlistId, videoId }, attempts: 4, delayMs: 4_000,
    reconcile: async () => {
      const found = (await call('youtube_list_playlist_items', { playlistId, maxResults: 50 })).items.find((item) => item.videoId === videoId);
      return found ? { playlistItemId: found.id } : undefined;
    },
  });
  const itemA = (await add(state.videoId)).playlistItemId;
  const itemB = (await add(state.publicVideoId)).playlistItemId;

  await step('youtube_list_playlist_items', { playlistId, maxResults: 50 }, {
    attempts: 6, check: (v) => (v.items.length >= 2 ? undefined : `expected 2 items, saw ${v.items.length}`),
  });

  const reorderArgs = { playlistId, playlistItemId: itemB, position: 0 };
  await approved({
    pre: 'youtube_preflight_reorder_playlist_item', preArgs: reorderArgs, approve: 'youtube_approve',
    exec: 'youtube_reorder_playlist_item', execArgs: reorderArgs, attempts: 3, reconcile: verifiedByReadback,
  });
  await retry(async () => {
    const page = await call('youtube_list_playlist_items', { playlistId, maxResults: 50 });
    if (page.items.find((item) => item.id === itemB)?.position !== 0) throw new E2EError('reorder not visible yet', 'verify_failed', 'youtube_list_playlist_items');
  }, { attempts: 6 }).catch((error) => record('youtube_reorder_playlist_item', 'FAIL', 0, `accepted but order unchanged: ${error.message}`));

  const newTitle = `${title} (renamed)`;
  await approved({
    pre: 'youtube_preflight_update_playlist', preArgs: { playlistId, title: newTitle }, approve: 'youtube_approve',
    exec: 'youtube_update_playlist', execArgs: { playlistId, title: newTitle }, attempts: 3, reconcile: verifiedByReadback,
  });
  await retry(async () => {
    const got = await call('youtube_get_playlist', { playlistId });
    if (got.item?.title !== newTitle) throw new E2EError('rename not visible yet', 'verify_failed', 'youtube_get_playlist');
  }).catch((error) => record('youtube_update_playlist', 'FAIL', 0, `accepted but title unchanged: ${error.message}`));

  await approved({
    pre: 'youtube_preflight_remove_playlist_item', preArgs: { playlistId, playlistItemId: itemA }, approve: 'youtube_approve',
    exec: 'youtube_remove_playlist_item', execArgs: { playlistId, playlistItemId: itemA }, attempts: 3, reconcile: verifiedByReadback,
  });
  await retry(async () => {
    const page = await call('youtube_list_playlist_items', { playlistId, maxResults: 50 });
    if (page.items.some((item) => item.id === itemA)) throw new E2EError('removed item still listed', 'verify_failed', 'youtube_list_playlist_items');
  }).catch((error) => record('youtube_remove_playlist_item', 'FAIL', 0, `accepted but item still listed: ${error.message}`));

  await approved({
    pre: 'youtube_preflight_delete_playlist', preArgs: { playlistId }, approve: 'youtube_approve',
    exec: 'youtube_delete_playlist', execArgs: { playlistId }, attempts: 4,
  });
  forget();
  await retry(async () => {
    const got = await call('youtube_get_playlist', { playlistId });
    if (got.item !== null) throw new E2EError('playlist still exists', 'verify_failed', 'youtube_get_playlist');
  }).catch((error) => record('youtube_delete_playlist', 'FAIL', 0, `accepted but playlist still readable: ${error.message}`));
}

// ---- Video lifecycle: one video through every visibility state, comments while public, then archive ----
const lifecycleSteps = []; // { step, status, note }
const lifecycleInfo = { videoId: undefined, reused: false };
const subStep = (step, status, note = '') => { lifecycleSteps.push({ step, status, note: redact(note).slice(0, 200) }); log(`lifecycle ${step}: ${status}${note ? ` (${redact(note).slice(0, 120)})` : ''}`); };

/** Newest private, unscheduled, processed video titled "youtube-mcp e2e lifecycle ..." (an earlier archived run), if any. */
async function findArchivedLifecycleVideo() {
  const page = await call('youtube_list_owned_videos', { maxResults: 50 });
  for (const item of (page.items ?? []).filter((entry) => entry.title?.startsWith(LIFECYCLE_PREFIX)).slice(0, 3)) {
    const owned = await call('youtube_get_owned_video', { videoId: item.id });
    const video = owned.item;
    if (video?.channelId === state.channelId && video.privacyStatus === 'private' && !video.publishAt && ['succeeded', 'processed'].includes(video.processingStatus)) return video.id;
  }
  return undefined;
}

async function lifecycleGroup() {
  let videoId;
  if (!freshUpload) {
    videoId = await findArchivedLifecycleVideo();
    if (videoId) { lifecycleInfo.reused = true; log(`lifecycle: reusing archived video ${videoId}`); }
  }
  if (!videoId) {
    const videoPath = await makeTestVideo('e2e-lifecycle.mp4');
    const uploadArgs = { filePath: videoPath, title: `${LIFECYCLE_PREFIX}${stamp}`, description: 'Automated youtube-mcp lifecycle E2E video. Archived (private) after each run; safe to delete.', privacyStatus: 'private' };
    const preview = await step('youtube_preflight_upload', uploadArgs, { check: (v) => (v.approvalId ? undefined : 'no approvalId') });
    await step('youtube_approve', { approvalId: preview.approvalId, confirm: true });
    const uploaded = await step('youtube_upload_video', { ...uploadArgs, approvalId: preview.approvalId, confirm: true }, {
      timeout: 600_000, check: (v) => (v.state === 'complete' && v.videoId ? undefined : `upload state ${v.state}`),
    });
    videoId = uploaded.videoId;
    log(`lifecycle: uploaded video ${videoId}`);
    await waitForProcessing(videoId);
  }
  lifecycleInfo.videoId = videoId;
  let archived = false;
  addCleanup(`archive lifecycle video ${videoId}`, async () => { if (!archived) await archiveVideoQuiet(videoId); });

  const ownedItem = async () => (await call('youtube_get_owned_video', { videoId })).item;
  /** Run update_metadata through preflight/approve/execute, then verify with get_owned_video (retried for lag). */
  async function setState(label, fields, verify, { blocked, attempts = 6 } = {}) {
    try {
      await approved({
        pre: 'youtube_preflight_update_metadata', preArgs: { videoId, ...fields }, approve: 'youtube_approve',
        exec: 'youtube_update_metadata', execArgs: { videoId, ...fields }, attempts: 3, blocked,
      });
      await retry(async () => {
        const problem = verify(await ownedItem());
        if (problem) throw new E2EError(problem, 'verify_failed', 'youtube_get_owned_video');
      }, { attempts });
      subStep(label, 'PASS');
      return 'PASS';
    } catch (error) {
      const refused = blocked?.(error) || (error.code === 'verify_failed' && /kept private/.test(error.message));
      subStep(label, refused ? 'BLOCKED' : 'FAIL', `${error.status ? `HTTP ${error.status} ${error.reason ?? ''}: ` : ''}${error.message}`);
      if (refused) return 'BLOCKED';
      throw error;
    }
  }
  const isPrivacy = (want) => (item) => (item?.privacyStatus === want ? undefined : `privacy is ${item?.privacyStatus}, expected ${want}`);
  // YouTube may silently keep a video private when the API project is unaudited; report that distinctly.
  const publicVerify = (item) => (item?.privacyStatus === 'public' ? undefined : item?.privacyStatus === 'private' ? 'update accepted but video was kept private (unaudited API project restriction?)' : `privacy is ${item?.privacyStatus}, expected public`);
  const publicFields = { privacyStatus: 'public', publish: true, elevated: true };
  const blocked403 = (error) => error.status === 403;

  try {
    const start = await ownedItem();
    if (start?.privacyStatus !== 'private' || start.publishAt) {
      // A leftover from an aborted run: bring it back to the known start state.
      await archiveVideoQuiet(videoId);
      await retry(async () => { const item = await ownedItem(); if (item?.privacyStatus !== 'private' || item.publishAt) throw new E2EError('not private yet', 'verify_failed', 'youtube_get_owned_video'); });
    }
    subStep('start: private', 'PASS', lifecycleInfo.reused ? 'reused archived video' : 'fresh upload');

    // Scheduled publish runs FIRST: YouTube only accepts status.publishAt on a private video that has never been published.
    // Set, verify publishAt, then clear it with the archive tools (update_metadata cannot remove publishAt).
    if (lifecycleInfo.reused) subStep('private + publishAt (+2d)', 'SKIPPED', 'reused video was already published; YouTube only schedules never-published private videos (set YOUTUBE_E2E_FRESH_UPLOAD=1)');
    else {
      const publishAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
      await setState('private + publishAt (+2d)', { privacyStatus: 'private', publishAt, elevated: true },
        (item) => (item?.publishAt && Math.abs(Date.parse(item.publishAt) - Date.parse(publishAt)) < 60_000 ? undefined : `publishAt is ${item?.publishAt ?? 'absent'}, expected ${publishAt}`));
      try {
        await approved({
          pre: 'youtube_preflight_archive_video', preArgs: { videoId }, approve: 'youtube_approve',
          exec: 'youtube_archive_video', execArgs: { videoId }, attempts: 3,
        });
        await retry(async () => {
          const item = await ownedItem();
          if (item?.privacyStatus !== 'private' || item.publishAt) throw new E2EError(`after clear: privacy ${item?.privacyStatus}, publishAt ${item?.publishAt ?? 'absent'}`, 'verify_failed', 'youtube_get_owned_video');
        });
        subStep('clear publishAt (archive_video)', 'PASS');
      } catch (error) {
        subStep('clear publishAt (archive_video)', 'FAIL', error.message);
        throw error;
      }
    }

    await setState('private -> unlisted', { privacyStatus: 'unlisted' }, isPrivacy('unlisted'));
    const firstPublic = await setState('unlisted -> public', publicFields, publicVerify, { blocked: blocked403 });
    let publicOk = firstPublic === 'PASS';
    if (publicOk) await setState('public -> private', { privacyStatus: 'private' }, isPrivacy('private'));
    else subStep('public -> private', 'SKIPPED', 'video never became public');

    if (publicOk) {
      const second = await setState('private -> public (again)', publicFields, publicVerify, { blocked: blocked403 });
      publicOk = second === 'PASS';
    } else subStep('private -> public (again)', 'SKIPPED', 'public visibility was refused earlier');

    if (publicOk) {
      await sleep(5_000); // let comments open on the newly public video
      try {
        await commentsFlow(videoId);
        state.lifecycleCommentsDone = true;
        subStep('comments on public video', 'PASS', 'create, reply, find, moderate, delete reply and comment');
      } catch (error) {
        subStep('comments on public video', 'FAIL', `${error.tool ?? ''} ${error.message}`);
        throw error;
      }
    } else {
      subStep('comments on public video', 'SKIPPED', 'BLOCKED: video could not be made public, so public-comment steps were skipped');
    }

    // End state: archive (private, unscheduled). From a public video this is the real transition; if the video never left
    // private it is already archived and preflight refuses with already_archived.
    if (publicOk) {
      await approved({
        pre: 'youtube_preflight_archive_video', preArgs: { videoId }, approve: 'youtube_approve',
        exec: 'youtube_archive_video', execArgs: { videoId }, attempts: 3,
      });
      await retry(async () => {
        const item = await ownedItem();
        if (item?.privacyStatus !== 'private' || item.publishAt) throw new E2EError(`after archive: privacy ${item?.privacyStatus}, publishAt ${item?.publishAt ?? 'absent'}`, 'verify_failed', 'youtube_get_owned_video');
      }).catch((error) => { record('youtube_archive_video', 'FAIL', 0, `archive accepted but ${error.message}`); throw error; });
      archived = true;
      subStep('archive public video -> private, unscheduled', 'PASS');
    } else {
      archived = true;
      subStep('archive', 'SKIPPED', 'video was never public; already private and unscheduled');
    }
    await guard('youtube_preflight_archive_video', { videoId }, 'already_archived', 'an already-private, unscheduled video is refused as already archived');
  } catch (error) {
    // Do not leave the video public/unlisted/scheduled if the run aborted midway. Comment cleanups go first: they need a non-private video.
    await runCleanups((entry) => /^(comment|reply) /.test(entry.label));
    try { await archiveVideoQuiet(videoId); archived = true; subStep('abort cleanup: archive', 'PASS'); } catch (cleanupError) { subStep('abort cleanup: archive', 'FAIL', cleanupError.message); }
    throw error;
  } finally {
    const row = results.get('youtube_archive_video');
    if (row) row.note = `${lifecycleSteps.map((entry) => `${entry.step}: ${entry.status}`).join(' | ')}${row.note ? ` | ${row.note}` : ''}`.slice(0, 600);
    log(`lifecycle approx quota so far: ${quotaUnits} units`);
  }
}

/** YOUTUBE_E2E_ARCHIVE_VIDEO_IDS: archive each listed video, but only if get_owned_video confirms the confirmed channel owns it. */
async function archiveLeftovers() {
  for (const videoId of archiveVideoIds) {
    const started = Date.now();
    try {
      const owned = await call('youtube_get_owned_video', { videoId });
      if (owned.item?.id !== videoId || owned.item?.channelId !== state.channelId) throw new E2EError(`not owned by ${state.channelId}`, 'ownership_required', 'youtube_get_owned_video');
      const changed = await archiveVideoQuiet(videoId);
      log(`archive leftover ${videoId}: ${changed ? 'archived' : 'already archived'}`);
      if (changed) record('youtube_archive_video', 'PASS', Date.now() - started, `archived leftover ${videoId}`);
    } catch (error) {
      cleanupFailures.push(`archive leftover ${videoId}: ${redact(error.message)}`);
    }
  }
}

async function commentsGroup() {
  if (!commentVideoId) {
    skipTools(GROUPS.comments, state.lifecycleCommentsDone ? 'covered by the lifecycle group (comments on its public video)' : 'set YOUTUBE_E2E_COMMENT_VIDEO_ID (an unlisted video owned by the channel that accepts comments) to enable');
    return;
  }
  const owned = await call('youtube_get_owned_video', { videoId: commentVideoId });
  log(`comment video ${commentVideoId}: privacyStatus=${owned.item?.privacyStatus} processingStatus=${owned.item?.processingStatus}`);
  if (owned.item?.privacyStatus === 'private') throw new E2EError('comment video is private; comments cannot work', 'video_private', 'youtube_create_comment');
  await commentsFlow(commentVideoId);
}

/** create -> channel threads -> reply -> find -> moderation reads/status -> delete reply and comment, on one video. */
async function commentsFlow(commentVideoId) {
  const text = `youtube-mcp e2e comment ${stamp}`;
  const replyText = `youtube-mcp e2e reply ${stamp}`;
  // A private video rejects comments (the server reports provider_outcome_unknown), so the video must be unlisted or public.
  // Comments are only allowed on videos the selected channel owns (spam guard); a public video of another channel must be refused.
  // A syntactically valid but non-existent id: a regression in the ownership check can never post on a real stranger's video.
  // The server retries the ownership read for a few seconds (read-after-write lag), so this guard takes about 7.5 s.
  await guard('youtube_create_comment', { videoId: 'aaaaaaaaaaa', text, confirm: true }, 'ownership_required', 'refused on a video the selected channel does not own (non-existent id)');
  const created = await step('youtube_create_comment', { videoId: commentVideoId, text, confirm: true }, { check: (v) => (v.id ? undefined : 'no comment id') })
    .catch((error) => { const row = results.get('youtube_create_comment'); if (row) row.note = `${row.note} -- hint: YOUTUBE_E2E_COMMENT_VIDEO_ID must be an unlisted/public video owned by the channel with comments enabled`.slice(0, 600); throw error; });
  const commentId = created.id;
  let commentDeleted = false;
  addCleanup(`comment ${commentId}`, async () => { if (!commentDeleted) await deleteCommentQuiet(commentId); });

  // The channel-wide listing (allThreadsRelatedToChannelId) lags; later steps look the comment up by id, so only the shape is required.
  {
    const started = Date.now();
    let seen = false;
    const deadline = Date.now() + 90_000;
    for (;;) {
      let page;
      try { page = await call('youtube_list_channel_comment_threads', { maxResults: 50 }); } catch (error) {
        if (quotaAborted || Date.now() > deadline) { record('youtube_list_channel_comment_threads', 'FAIL', Date.now() - started, `${error.code ?? 'error'}: ${error.message}`); throw error; }
        await sleep(5_000);
        continue;
      }
      if (!Array.isArray(page?.items)) { record('youtube_list_channel_comment_threads', 'FAIL', Date.now() - started, 'unexpected response: items missing'); throw new E2EError('unexpected response: items missing', 'unexpected_response', 'youtube_list_channel_comment_threads'); }
      seen = page.items.some((item) => item.id === commentId);
      if (seen || Date.now() > deadline) break;
      await sleep(10_000);
    }
    record('youtube_list_channel_comment_threads', 'PASS', Date.now() - started, seen ? 'new comment visible' : 'well-formed; new comment not yet indexed after 90s (YouTube listing lag)');
  }

  const reply = await approved({
    pre: 'youtube_preflight_reply_to_comment', preArgs: { commentId, text: replyText }, approve: 'youtube_approve',
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
      pre: 'youtube_preflight_set_comment_moderation_status', preArgs: { commentId, moderationStatus }, approve: 'youtube_approve',
      exec: 'youtube_set_comment_moderation_status', execArgs: { commentId, moderationStatus }, attempts: 3,
    });
  }

  await approved({
    pre: 'youtube_preflight_delete_comment', preArgs: { commentId: replyId }, approve: 'youtube_approve',
    exec: 'youtube_delete_comment', execArgs: { commentId: replyId }, attempts: 3,
  });
  replyDeleted = true;
  await approved({
    pre: 'youtube_preflight_delete_comment', preArgs: { commentId }, approve: 'youtube_approve',
    exec: 'youtube_delete_comment', execArgs: { commentId }, attempts: 3,
  });
  commentDeleted = true;
  // Verify both are gone (deleted comments can linger briefly in reads).
  for (const gone of [replyId, commentId]) {
    await retry(async () => {
      try { if (!(await call('youtube_get_moderation_comment', { commentId: gone })).item) return; } catch (error) { if (quotaAborted) throw error; return; }
      throw new E2EError(`comment ${gone} still readable`, 'verify_failed', 'youtube_get_moderation_comment');
    }, { attempts: 5 }).catch((error) => record('youtube_delete_comment', 'FAIL', 0, `delete accepted but ${error.message}`));
  }
}

async function analyticsGroup() {
  const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  const range = { startDate: day(28), endDate: day(1) };
  await step('youtube_creator_overview', range, { check: (v) => (v && typeof v === 'object' ? undefined : 'malformed') });
  await step('youtube_creator_top_videos', { ...range, limit: 5 }, { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
  await step('youtube_creator_retention', { videoId: state.videoId ?? state.publicVideoId }, { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
  // Zero rows are fine on a quiet test channel; the report must still come back well-formed.
  const wellFormed = (columns) => (v) => (Array.isArray(v.rows) && v.rowCount === v.rows.length && columns.every((name) => v.columns?.includes(name)) ? undefined : 'malformed report');
  await step('youtube_creator_report', { ...range, metrics: ['views', 'estimatedMinutesWatched'], dimensions: ['day'], sort: ['day'] }, { check: wellFormed(['day', 'views']) });
  await step('youtube_creator_report', { ...range, metrics: ['views'], dimensions: ['insightTrafficSourceType'], sort: ['-views'] }, { check: wellFormed(['insightTrafficSourceType', 'views']) });
  await step('youtube_creator_report', { ...range, metrics: ['views', 'averageViewDuration'], dimensions: ['deviceType'] }, { check: wellFormed(['deviceType', 'views']) });
}

/** Round trip on the dedicated test channel: description "<original> [e2e <ts>]", then the exact original again. */
async function channelGroup() {
  const field = (preview) => preview.desired?.current?.description ?? '';
  // The write goes to brandingSettings.channel.description; my_account reads snippet.description, which YouTube syncs with a lag.
  // So verify via an unapproved (never executed) preview whose "current" snapshot is the stored brandingSettings description.
  const readDescription = () => storedDescription();
  const marker = `[e2e ${stamp}]`;
  // YouTube trims surrounding whitespace and may normalise CRLF, so compare normalised strings (an empty original gets no leading space).
  // Unapproved probe: the preview's "current" snapshot is the exact stored description (my_account may trim).
  const probe = await step('youtube_preflight_update_channel', { description: `${PREFIX}probe ${stamp}` }, { check: (v) => (v.approvalId && v.kind === 'channel.update' && v.desired?.current ? undefined : 'malformed preview') });
  const original = field(probe);
  const suffix = original ? ` ${marker}` : marker;
  if (original.length + suffix.length > 1000) throw new E2EError('channel description too long to append the e2e marker (1000 char limit)', 'description_too_long', 'youtube_preflight_update_channel');
  const changed = `${original}${suffix}`;
  const forgetRestore = addCleanup('channel description', () => approvedQuiet(original).catch((error) => { if (error.code !== 'invalid_input') throw error; }));

  await approved({
    pre: 'youtube_preflight_update_channel', preArgs: { description: changed }, approve: 'youtube_approve', exec: 'youtube_update_channel', execArgs: { description: changed }, attempts: 2, reconcile: verifiedByReadback,
  });
  await retry(async () => {
    if (norm(await readDescription()) !== norm(changed)) throw new E2EError('description not updated yet', 'verify_failed', 'youtube_update_channel');
  }, { attempts: 10 }).catch((error) => record('youtube_update_channel', 'FAIL', 0, `accepted but not visible: ${error.message}`));

  await approved({
    pre: 'youtube_preflight_update_channel', preArgs: { description: original }, approve: 'youtube_approve', exec: 'youtube_update_channel', execArgs: { description: original }, attempts: 2, reconcile: verifiedByReadback,
  });
  forgetRestore();
  await retry(async () => {
    const now = await readDescription();
    if (norm(now) !== norm(original)) throw new E2EError('original description not restored exactly', 'verify_failed', 'youtube_update_channel');
  }, { attempts: 10 }).catch((error) => record('youtube_update_channel', 'FAIL', 0, `restore not verified: ${error.message}`));
  // Informational only: my_account (snippet.description) lags behind brandingSettings and is not part of pass/fail.
  const lagged = ((await call('youtube_my_account').catch(() => ({}))).description ?? '') === original;
  console.log(`  info: my_account description ${lagged ? 'matches' : 'still lags behind'} the restored brandingSettings description`);
}

/** Stored brandingSettings description, read via an unapproved preview of a different description (never executed). */
const norm = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();
async function storedDescription() {
  const preview = await call('youtube_preflight_update_channel', { description: `${PREFIX}read ${stamp} ${Date.now()}` });
  return preview.desired?.current?.description ?? '';
}

async function approvedQuiet(description) {
  // Nothing to restore if the description already matches (the server refuses a no-op preview with invalid_input).
  if (norm(await storedDescription()) === norm(description)) return;
  return quietApproved('youtube_preflight_update_channel', { description }, 'youtube_approve', 'youtube_update_channel', { description });
}

async function viewerGroup() {
  const subs = await step('youtube_list_subscriptions', { maxResults: 50 }, { check: (v) => (Array.isArray(v.items) ? undefined : 'items missing') });
  // details costs about 1 extra quota unit per returned channel; keep the page small.
  await step('youtube_list_subscriptions', { maxResults: 5, details: true }, {
    check: (v) => (Array.isArray(v.items) && v.context?.quotaUnits >= 1 && v.items.every((item) => item.subscriptionId && item.channelId && (item.subscriberCount !== undefined || item.subscriberCountHidden === true || item.videoCount !== undefined)) ? undefined : 'details missing'),
  });
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

  // Bulk removal: subscribe to the two stable public channels (only if neither is already subscribed), then remove both via preflight -> approve -> execute.
  const fresh = SUBSCRIBE_CANDIDATES.filter((id) => !subs.items.some((item) => item.channelId === id));
  if (fresh.length < SUBSCRIBE_CANDIDATES.length) {
    skipTools(['youtube_preflight_unsubscribe_many', 'youtube_unsubscribe_many'], 'a candidate channel was already subscribed; existing subscriptions are never touched');
  } else {
    const made = [];
    for (const channelId of fresh) {
      const sub = await step('youtube_subscribe', { channelId, confirm: true }, { check: (v) => (v.subscriptionId ? undefined : 'no subscriptionId') });
      made.push(sub.subscriptionId);
      addCleanup(`subscription ${sub.subscriptionId}`, () => call('youtube_unsubscribe', { subscriptionId: sub.subscriptionId, confirm: true }).catch((error) => { if (error.status !== 404) throw error; }));
    }
    const removal = await approved({
      pre: 'youtube_preflight_unsubscribe_many', preArgs: { subscriptionIds: made }, approve: 'youtube_approve', exec: 'youtube_unsubscribe_many', execArgs: { subscriptionIds: made }, attempts: 3, delayMs: 5_000,
    });
    if (!removal.complete || removal.summary?.removed + removal.summary?.alreadyGone !== made.length) {
      record('youtube_unsubscribe_many', 'FAIL', 0, `incomplete: ${JSON.stringify(removal.summary)} ${removal.stoppedEarly?.message ?? ''}`);
    }
    await retry(async () => {
      const page = await call('youtube_list_subscriptions', { maxResults: 50 });
      if (page.items.some((item) => made.includes(item.subscriptionId))) throw new E2EError('still subscribed', 'verify_failed', 'youtube_list_subscriptions');
    }, { attempts: 5 }).catch((error) => record('youtube_unsubscribe_many', 'FAIL', 0, `accepted but still listed: ${error.message}`));
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
  await runCleanups();
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
  lifecycleVideoId: lifecycleInfo.videoId,
  lifecycleReused: lifecycleInfo.reused,
  lifecycleSteps,
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
if (lifecycleSteps.length > 0) process.stdout.write(`Lifecycle video ${lifecycleInfo.videoId} (${lifecycleInfo.reused ? 'reused' : 'new'}, left private; delete by hand in YouTube Studio):\n${lifecycleSteps.map((entry) => `  ${entry.step}: ${entry.status}${entry.note ? ` - ${entry.note}` : ''}`).join('\n')}\n`);
if (cleanupFailures.length > 0) process.stdout.write(`Cleanup failures:\n${cleanupFailures.map((line) => `  ${line}`).join('\n')}\n`);

await mkdir(outDir, { recursive: true });
const base = join(outDir, `e2e-report-${fileStamp}`);
const markdown = [
  '# youtube-mcp live E2E report', '',
  `- Started: ${report.startedAt}`, `- Channel: ${report.channelId}`,
  `- Tools: ${report.toolCount}`, `- Summary: ${Object.entries(counts).map(([status, n]) => `${status}=${n}`).join(', ')}`,
  `- Approx. quota: ${quotaUnits} units`,
  report.uploadedVideoId ? `- Uploaded video (private, delete manually): ${report.uploadedVideoId}` : `- Reused video: ${reuseVideoId ?? 'n/a'}`,
  report.lifecycleVideoId ? `- Lifecycle video (${lifecycleInfo.reused ? 'reused' : 'new'}; left private, delete by hand in YouTube Studio): ${report.lifecycleVideoId}` : '- Lifecycle video: n/a',
  ...lifecycleSteps.map((entry) => `  - lifecycle ${entry.step}: ${entry.status}${entry.note ? ` (${entry.note})` : ''}`),
  cleanupFailures.length ? `- Cleanup failures: ${cleanupFailures.join('; ')}` : '- Cleanup failures: none', '',
  '| Tool | Group | Status | ms | Note |', '|---|---|---|---|---|',
  ...rows.map((row) => `| ${row.tool} | ${row.group} | ${row.status} | ${row.ms ?? 0} | ${(row.note ?? '').replace(/\|/g, '\\|')} |`), '',
].join('\n');
await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
await writeFile(`${base}.md`, markdown);
process.stdout.write(`Report: ${base}.{json,md}\n`);

process.exit(counts.FAIL ? 1 : exitCode);
