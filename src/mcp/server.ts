import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import type { AuthStatus } from '../auth/oauth.js';
import type { ConsumptionInsights } from '../consumption/insights.js';
import type { TakeoutImporter } from '../consumption/importer.js';
import type { ProfileCurationService } from '../consumption/curation.js';
import { toSafeError } from '../errors.js';
import type {
  ChannelSummary,
  OperationPreview,
  CommentSummary,
  CreateCommentInput,
  RateVideoInput,
  SubscribeInput,
  SubscriptionResult,
  SubscriptionSummary,
  UnsubscribeInput,
  UnsubscribeResult,
  VideoRatingResult,
} from '../types.js';
import type { CreatorAnalyticsService } from '../youtube/analytics.js';
import type { AccountService } from '../youtube/account.js';
import type { PublicService } from '../youtube/public.js';
import type { ResourceService } from '../youtube/resources.js';
import type { UploadService } from '../youtube/uploads.js';
import type { CreatorContentService } from '../youtube/creator-content.js';
import type { PlaylistService } from '../youtube/playlists.js';
import type { ModerationService } from '../youtube/moderation.js';
import type { ChannelProfileService } from '../youtube/channel-profile.js';
import type { SubscriptionCurationService } from '../youtube/subscriptions.js';
import {
  channelSchema,
  commentsSchema,
  consumptionProfileSchema,
  consumptionTrendsSchema,
  createCommentSchema,
  creatorOverviewSchema,
  creatorRetentionSchema,
  creatorTopVideosSchema,
  creatorReportSchema,
  trendingSchema,
  listChannelVideosSchema,
  listSubscriptionsSchema,
  preflightUpdateChannelSchema,
  updateChannelSchema,
  preflightUnsubscribeManySchema,
  unsubscribeManySchema,
  captionTracksSchema,
  emptySchema,
  importTakeoutSchema,
  listSchema,
  moderationCommentsSchema,
  moderationCommentSchema,
  findCommentReplySchema,
  ownedVideoSchema,
  pageSchema,
  playlistSchema,
  playlistItemsSchema,
  rateVideoSchema,
  searchSchema,
  subscribeSchema,
  unsubscribeSchema,
  videoSchema,
  videoCategoriesSchema,
  cancelUploadSchema,
  preflightCancelUploadSchema,
  preflightResumeUploadSchema,
  preflightUploadSchema,
  resumeUploadSchema,
  uploadStatusSchema,
  uploadVideoSchema,
  deleteCaptionSchema,
  archiveVideoSchema,
  preflightArchiveVideoSchema,
  downloadCaptionSchema,
  preflightCaptionDeleteSchema,
  preflightCaptionUpdateSchema,
  preflightCaptionUploadSchema,
  preflightMetadataUpdateSchema,
  preflightThumbnailSchema,
  setThumbnailSchema,
  updateCaptionSchema,
  updateMetadataSchema,
  uploadCaptionSchema,
  addPlaylistItemSchema,
  approveSchema,
  createPlaylistSchema,
  deletePlaylistSchema,
  deleteCommentSchema,
  preflightAddPlaylistItemSchema,
  preflightCreatePlaylistSchema,
  preflightDeletePlaylistSchema,
  preflightDeleteCommentSchema,
  preflightRemovePlaylistItemSchema,
  preflightReorderPlaylistItemSchema,
  preflightReplyToCommentSchema,
  preflightSetCommentModerationStatusSchema,
  preflightUpdatePlaylistSchema,
  removePlaylistItemSchema,
  reorderPlaylistItemSchema,
  replyToCommentSchema,
  setCommentModerationStatusSchema,
  updatePlaylistSchema,
  curationCandidateSchema,
  curationPolicySchema,
  proposeConsumptionQueueSchema,
  resetConsumptionDataSchema,
} from './schemas.js';

type AccountTools = Pick<AccountService, 'myAccount' | 'listSubscriptions' | 'listSubscriptionsPage' | 'listChannelCommentThreads'> & {
  subscribe(input: SubscribeInput): Promise<SubscriptionResult>;
  unsubscribe(input: UnsubscribeInput): Promise<UnsubscribeResult>;
  rateVideo(input: RateVideoInput): Promise<VideoRatingResult>;
  createComment(input: CreateCommentInput): Promise<CommentSummary>;
};

export type McpDependencies = {
  auth: { status(): Promise<AuthStatus> };
  public: Pick<PublicService, 'search' | 'trending' | 'listChannelVideos' | 'getVideo' | 'getChannel' | 'getComments' | 'getTranscript'>;
  account: AccountTools;
  creator: Pick<CreatorAnalyticsService, 'overview' | 'topVideos' | 'retention' | 'report'>;
  importer: Pick<TakeoutImporter, 'import'>;
  insights: Pick<ConsumptionInsights, 'profile' | 'trends'>;
  resources: Pick<ResourceService,
    'listOwnedVideos' | 'getOwnedVideo' | 'listVideoCategories' | 'listPlaylists' | 'getPlaylist' |
    'listPlaylistItems' | 'listModerationComments' | 'getModerationComment' | 'findCommentReply' | 'listCaptionTracks'
  >;
  uploads: Pick<UploadService, 'preflight' | 'preflightResume' | 'preflightCancel' | 'upload' | 'resume' | 'getStatus' | 'cancel'>;
  content: Pick<CreatorContentService,
    'preflightMetadataUpdate' | 'updateMetadata' | 'preflightArchiveVideo' | 'archiveVideo' | 'preflightThumbnail' | 'setThumbnail' |
    'preflightCaptionUpload' | 'uploadCaption' | 'preflightCaptionUpdate' | 'updateCaption' |
    'downloadCaption' | 'preflightCaptionDelete' | 'deleteCaption'
  >;
  playlists: Pick<PlaylistService, 'preflightCreate' | 'create' | 'preflightUpdate' | 'update' | 'preflightDelete' | 'delete' | 'preflightAdd' | 'add' | 'preflightRemove' | 'remove' | 'preflightReorder' | 'reorder'>;
  moderation: Pick<ModerationService, 'preflightReply' | 'reply' | 'preflightSetStatus' | 'setStatus' | 'preflightDelete' | 'delete'>;
  channelProfile: Pick<ChannelProfileService, 'preflightUpdate' | 'update'>;
  subscriptions: Pick<SubscriptionCurationService, 'preflightUnsubscribeMany' | 'unsubscribeMany'>;
  approvals: { approve(input: { approvalId: string; confirm?: boolean }): Promise<OperationPreview> };
  curation: Pick<ProfileCurationService, 'savePolicy' | 'saveCandidate' | 'propose' | 'reset'>;
};

// Same relative depth from src/mcp (tsx, vitest) and dist/mcp (built), so one path serves both.
const { version: SERVER_VERSION } = createRequire(import.meta.url)('../../package.json') as { version: string };

export function createMcpServer(dependencies: McpDependencies): McpServer {
  const server = new McpServer({ name: 'youtube-mcp', version: SERVER_VERSION });

  server.registerTool('youtube_search', readTool('Search public YouTube videos (100 quota units per call). Optional filters: order, publishedAfter/publishedBefore (RFC 3339), videoDuration, channelId, regionCode, relevanceLanguage, safeSearch, pageToken.', searchSchema), (input) => resultOf(() => dependencies.public.search(input)));
  server.registerTool('youtube_trending', readTool('List the most popular videos for a region (default US), optionally in one video category. 1 quota unit.', trendingSchema), (input) => resultOf(() => dependencies.public.trending(input)));
  server.registerTool('youtube_list_channel_videos', readTool('List recent uploads with statistics for ANY public channel, by channel ID or @handle (about 3 quota units per page).', listChannelVideosSchema), (input) => resultOf(() => dependencies.public.listChannelVideos(input)));
  server.registerTool('youtube_get_video', readTool('Get a public YouTube video by ID.', videoSchema), (input) => resultOf(() => dependencies.public.getVideo(input)));
  server.registerTool('youtube_get_channel', readTool('Get a public YouTube channel by ID.', channelSchema), (input) => resultOf(() => dependencies.public.getChannel(input)));
  server.registerTool('youtube_get_comments', readTool('List public comment threads for a specific video.', commentsSchema), (input) => resultOf(() => dependencies.public.getComments(input)));
  server.registerTool('youtube_get_transcript', readTool('Get a best-effort public transcript for a video.', videoSchema), (input) => resultOf(() => dependencies.public.getTranscript(input)));

  server.registerTool('youtube_my_account', readTool('Get the authenticated YouTube channel.', emptySchema), () => resultOf(() => dependencies.account.myAccount()));
  server.registerTool('youtube_list_subscriptions', readTool('List subscriptions for the authenticated account, with pagination. details: true adds subscriberCount, videoCount and lastUploadAt per channel and costs about 1 extra quota unit per returned channel.', listSubscriptionsSchema), (input) => resultOf(() => dependencies.account.listSubscriptionsPage(input)));
  server.registerTool('youtube_list_channel_comment_threads', readTool('List comment threads associated with the authenticated channel; authors may be anyone.', listSchema), (input) => resultOf(() => dependencies.account.listChannelCommentThreads(input.maxResults)));
  server.registerTool('youtube_subscribe', writeTool('Subscribe the authenticated account to a channel.', subscribeSchema), (input) => resultOf(() => dependencies.account.subscribe(input)));
  server.registerTool('youtube_unsubscribe', writeTool('Remove an authenticated-account subscription.', unsubscribeSchema), (input) => resultOf(() => dependencies.account.unsubscribe(input)));
  server.registerTool('youtube_rate_video', writeTool('Rate a video for the authenticated account.', rateVideoSchema), (input) => resultOf(() => dependencies.account.rateVideo(input)));
  server.registerTool('youtube_create_comment', writeTool('Create a top-level comment as the selected channel, only on a video that channel owns (replies on your own videos); other videos are refused with ownership_required.', createCommentSchema), (input) => resultOf(() => dependencies.account.createComment(input)));

  server.registerTool('youtube_creator_overview', readTool('Get owned-channel creator analytics for a date range.', creatorOverviewSchema), (input) => resultOf(() => dependencies.creator.overview(input)));
  server.registerTool('youtube_creator_top_videos', readTool('Get top owned-channel videos for a date range.', creatorTopVideosSchema), (input) => resultOf(() => dependencies.creator.topVideos(input, input.limit)));
  server.registerTool('youtube_creator_retention', readTool('Get audience-retention data for an owned video.', creatorRetentionSchema), (input) => resultOf(() => dependencies.creator.retention(input.videoId)));

  server.registerTool('youtube_creator_report', readTool('Run an allowlisted YouTube Analytics report for the owned channel (default: last 28 days). Metrics: views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, subscribersGained, subscribersLost, likes, comments, shares (viewerPercentage only with ageGroup/gender). Dimensions: day, month, video, country, deviceType, operatingSystem, insightTrafficSourceType, insightTrafficSourceDetail (needs one video plus an insightTrafficSourceType filter), ageGroup, gender, subscribedStatus, sharingService (shares only). Invalid combinations are rejected with invalid_input before any API call. Rows come back as objects keyed by column name.', creatorReportSchema), (input) => resultOf(() => dependencies.creator.report(input)));

  server.registerTool('youtube_list_owned_videos', readTool('List videos owned by the selected creator profile.', pageSchema), (input) => resultOf(() => dependencies.resources.listOwnedVideos(input)));
  server.registerTool('youtube_get_owned_video', readTool('Get a video owned by the selected creator profile.', ownedVideoSchema), (input) => resultOf(() => dependencies.resources.getOwnedVideo(input.videoId)));
  server.registerTool('youtube_list_video_categories', readTool('List available YouTube video categories with freshness metadata.', videoCategoriesSchema), (input) => resultOf(() => dependencies.resources.listVideoCategories(input)));
  server.registerTool('youtube_list_playlists', readTool('List playlists owned by the selected creator profile.', pageSchema), (input) => resultOf(() => dependencies.resources.listPlaylists(input)));
  server.registerTool('youtube_get_playlist', readTool('Get one playlist owned by the selected creator profile.', playlistSchema), (input) => resultOf(() => dependencies.resources.getPlaylist(input.playlistId)));
  server.registerTool('youtube_list_playlist_items', readTool('List items from an owned creator playlist.', playlistItemsSchema), (input) => resultOf(() => dependencies.resources.listPlaylistItems(input)));
  server.registerTool('youtube_list_moderation_comments', readTool('List selected-channel moderation threads with available replies.', moderationCommentsSchema), (input) => resultOf(() => dependencies.resources.listModerationComments(input)));
  server.registerTool('youtube_get_moderation_comment', readTool('Read one immutable comment by ID for exact moderation reconciliation.', moderationCommentSchema), (input) => resultOf(() => dependencies.resources.getModerationComment(input.commentId)));
  server.registerTool('youtube_find_comment_reply', readTool('Exhaustively find an exact selected-channel reply under one immutable parent comment.', findCommentReplySchema), (input) => resultOf(() => dependencies.resources.findCommentReply(input)));
  server.registerTool('youtube_list_caption_tracks', readTool('List caption tracks for an owned creator video.', captionTracksSchema), (input) => resultOf(() => dependencies.resources.listCaptionTracks(input)));

  server.registerTool('youtube_approve', writeTool('Approve ANY pending preflight preview (upload, metadata, archive, thumbnail, caption, playlist, comment reply/moderation/delete, channel profile edit, bulk unsubscribe) by approvalId, with confirm: true. The result echoes the operation kind, target and exact desired change so the human can see precisely what is approved. Approval is single-use, expires, and is bound to the active profile and channel; then call the matching execute tool with confirm: true.', approveSchema), (input) => resultOf(() => dependencies.approvals.approve(input)));
  server.registerTool('youtube_preflight_upload', writeTool('Validate and preview a private resumable video upload.', preflightUploadSchema), (input) => resultOf(() => dependencies.uploads.preflight(input)));
  server.registerTool('youtube_upload_video', writeTool('Start an approved resumable video upload. Public visibility also needs publish: true.', uploadVideoSchema), (input) => resultOf(() => dependencies.uploads.upload(input)));
  server.registerTool('youtube_preflight_resume_upload', writeTool('Validate and preview an explicit resumable-upload continuation.', preflightResumeUploadSchema), (input) => resultOf(() => dependencies.uploads.preflightResume(input)));
  server.registerTool('youtube_resume_upload', writeTool('Resume an approved upload only after probing its existing session.', resumeUploadSchema), (input) => resultOf(() => dependencies.uploads.resume(input)));
  server.registerTool('youtube_get_upload_status', readTool('Probe a resumable upload session without sending media bytes.', uploadStatusSchema), (input) => resultOf(() => dependencies.uploads.getStatus(input)));
  server.registerTool('youtube_preflight_cancel_upload', writeTool('Preview cancellation of a resumable upload session.', preflightCancelUploadSchema), (input) => resultOf(() => dependencies.uploads.preflightCancel(input)));
  server.registerTool('youtube_cancel_upload', writeTool('Cancel an approved resumable upload session.', cancelUploadSchema), (input) => resultOf(() => dependencies.uploads.cancel(input)));

  server.registerTool('youtube_preflight_update_metadata', writeTool('Read, merge, and preview an owned-video metadata update. publishAt only works on a private video that has never been public, with a future ISO 8601 time.', preflightMetadataUpdateSchema), (input) => resultOf(() => dependencies.content.preflightMetadataUpdate(input)));
  server.registerTool('youtube_update_metadata', writeTool('Write approved merged owned-video metadata. Public, scheduled, and synthetic-media changes need elevated intent. publishAt only works on a private video that has never been public, with a future ISO 8601 time.', updateMetadataSchema), (input) => resultOf(() => dependencies.content.updateMetadata(input)));
  server.registerTool('youtube_preflight_archive_video', writeTool('Preview archiving an owned video: sets it to private and clears any scheduled publish time; title, description and everything else stay untouched. Reversible: make it public or unlisted again with youtube_update_metadata. Refuses with already_archived if it is already private and unscheduled.', preflightArchiveVideoSchema), (input) => resultOf(() => dependencies.content.preflightArchiveVideo(input)));
  server.registerTool('youtube_archive_video', writeTool('Archive an approved owned video (private, not scheduled; reversible via youtube_update_metadata). Approve the preview with youtube_approve, then call with confirm: true.', archiveVideoSchema), (input) => resultOf(() => dependencies.content.archiveVideo(input)));
  server.registerTool('youtube_preflight_set_thumbnail', writeTool('Validate and preview an owned-video thumbnail.', preflightThumbnailSchema), (input) => resultOf(() => dependencies.content.preflightThumbnail(input)));
  server.registerTool('youtube_set_thumbnail', writeTool('Set an approved thumbnail on an owned video.', setThumbnailSchema), (input) => resultOf(() => dependencies.content.setThumbnail(input)));
  server.registerTool('youtube_preflight_caption_upload', writeTool('Validate and preview a caption upload for an owned video.', preflightCaptionUploadSchema), (input) => resultOf(() => dependencies.content.preflightCaptionUpload(input)));
  server.registerTool('youtube_upload_caption', writeTool('Upload an approved caption file without returning media bytes.', uploadCaptionSchema), (input) => resultOf(() => dependencies.content.uploadCaption(input)));
  server.registerTool('youtube_preflight_caption_update', writeTool('Validate and preview an owned caption update.', preflightCaptionUpdateSchema), (input) => resultOf(() => dependencies.content.preflightCaptionUpdate(input)));
  server.registerTool('youtube_update_caption', writeTool('Update an approved owned caption track.', updateCaptionSchema), (input) => resultOf(() => dependencies.content.updateCaption(input)));
  server.registerTool('youtube_download_caption', downloadTool('Download an owned caption track into <state dir>/downloads/ as a new file you name with fileName (a plain name ending in .srt, .vtt, .sbv or .txt; no paths). Never overwrites; bytes are not returned, the absolute path written is. Read-only on YouTube: no approval needed; ownership of the video and caption is verified first.', downloadCaptionSchema), (input) => resultOf(() => dependencies.content.downloadCaption(input)));
  server.registerTool('youtube_preflight_caption_delete', writeTool('Preview deletion of an owned caption track.', preflightCaptionDeleteSchema), (input) => resultOf(() => dependencies.content.preflightCaptionDelete(input)));
  server.registerTool('youtube_delete_caption', writeTool('Delete an approved owned caption track.', deleteCaptionSchema), (input) => resultOf(() => dependencies.content.deleteCaption(input)));

  server.registerTool('youtube_preflight_create_playlist', writeTool('Preview creation of a creator playlist; private is the default visibility.', preflightCreatePlaylistSchema), (input) => resultOf(() => dependencies.playlists.preflightCreate(input)));
  server.registerTool('youtube_create_playlist', writeTool('Create an approved creator playlist.', createPlaylistSchema), (input) => resultOf(() => dependencies.playlists.create(input)));
  server.registerTool('youtube_preflight_update_playlist', writeTool('Read and preview an update to an owned playlist.', preflightUpdatePlaylistSchema), (input) => resultOf(() => dependencies.playlists.preflightUpdate(input)));
  server.registerTool('youtube_update_playlist', writeTool('Update an approved owned playlist.', updatePlaylistSchema), (input) => resultOf(() => dependencies.playlists.update(input)));
  server.registerTool('youtube_preflight_delete_playlist', writeTool('Read and preview deletion of an owned playlist.', preflightDeletePlaylistSchema), (input) => resultOf(() => dependencies.playlists.preflightDelete(input)));
  server.registerTool('youtube_delete_playlist', writeTool('Delete an approved owned playlist.', deletePlaylistSchema), (input) => resultOf(() => dependencies.playlists.delete(input)));
  server.registerTool('youtube_preflight_add_playlist_item', writeTool('Read and preview adding a video to an owned playlist.', preflightAddPlaylistItemSchema), (input) => resultOf(() => dependencies.playlists.preflightAdd(input)));
  server.registerTool('youtube_add_playlist_item', writeTool('Add a video to an approved owned playlist.', addPlaylistItemSchema), (input) => resultOf(() => dependencies.playlists.add(input)));
  server.registerTool('youtube_preflight_remove_playlist_item', writeTool('Read and preview removal of an immutable playlist item.', preflightRemovePlaylistItemSchema), (input) => resultOf(() => dependencies.playlists.preflightRemove(input)));
  server.registerTool('youtube_remove_playlist_item', writeTool('Remove an approved immutable playlist item.', removePlaylistItemSchema), (input) => resultOf(() => dependencies.playlists.remove(input)));
  server.registerTool('youtube_preflight_reorder_playlist_item', writeTool('Read and preview reordering an immutable playlist item.', preflightReorderPlaylistItemSchema), (input) => resultOf(() => dependencies.playlists.preflightReorder(input)));
  server.registerTool('youtube_reorder_playlist_item', writeTool('Reorder an item after an approved preview.', reorderPlaylistItemSchema), (input) => resultOf(() => dependencies.playlists.reorder(input)));

  server.registerTool('youtube_preflight_reply_to_comment', writeTool('Read and preview a reply to an immutable creator-channel comment.', preflightReplyToCommentSchema), (input) => resultOf(() => dependencies.moderation.preflightReply(input)));
  server.registerTool('youtube_reply_to_comment', writeTool('Reply to an approved immutable creator-channel comment.', replyToCommentSchema), (input) => resultOf(() => dependencies.moderation.reply(input)));
  server.registerTool('youtube_preflight_set_comment_moderation_status', writeTool('Read and preview a comment moderation action; banning requires elevated intent.', preflightSetCommentModerationStatusSchema), (input) => resultOf(() => dependencies.moderation.preflightSetStatus(input)));
  server.registerTool('youtube_set_comment_moderation_status', writeTool('Set an approved comment moderation status; banAuthor requires elevated intent.', setCommentModerationStatusSchema), (input) => resultOf(() => dependencies.moderation.setStatus(input)));
  server.registerTool('youtube_preflight_delete_comment', writeTool('Read and preview deletion of an immutable creator-channel comment.', preflightDeleteCommentSchema), (input) => resultOf(() => dependencies.moderation.preflightDelete(input)));
  server.registerTool('youtube_delete_comment', writeTool('Delete an approved immutable creator-channel comment.', deleteCommentSchema), (input) => resultOf(() => dependencies.moderation.delete(input)));

  server.registerTool('youtube_preflight_update_channel', writeTool('Preview an edit to the selected creator channel profile (description, keywords, country, defaultLanguage), showing current vs desired. Other branding settings are preserved on execute.', preflightUpdateChannelSchema), (input) => resultOf(() => dependencies.channelProfile.preflightUpdate(input)));
  server.registerTool('youtube_update_channel', writeTool('Apply an approved channel profile edit (read-modify-write of brandingSettings so untouched fields are kept). Approve with youtube_approve, then call with confirm: true and the same fields.', updateChannelSchema), (input) => resultOf(() => dependencies.channelProfile.update(input)));
  server.registerTool('youtube_preflight_unsubscribe_many', writeTool('Preview removing up to 100 subscriptions of the authenticated account: verifies each belongs to the account and lists every channel title to be removed, with approximate quota (50 units per removal).', preflightUnsubscribeManySchema), (input) => resultOf(() => dependencies.subscriptions.preflightUnsubscribeMany(input)));
  server.registerTool('youtube_unsubscribe_many', writeTool('Remove the approved subscriptions one by one and report each as removed, already_gone, failed (definitively rejected) or unknown (outcome uncertain after a server or network error: reconcile with youtube_list_subscriptions before retrying). Stops early (with a partial report) if YouTube quota runs out. Approve with youtube_approve first, then call with confirm: true.', unsubscribeManySchema), (input) => resultOf(() => dependencies.subscriptions.unsubscribeMany(input)));

  server.registerTool('youtube_import_takeout', {
    description: 'Import a local Google Takeout YouTube-history JSON or HTML file into local derived analytics.',
    inputSchema: importTakeoutSchema,
  }, (input) => resultOf(() => dependencies.importer.import(input.inputPath)));
  server.registerTool('youtube_consumption_profile', readTool('Summarize local consumption analytics for a date range.', consumptionProfileSchema), (input) => resultOf(() => dependencies.insights.profile(input)));
  server.registerTool('youtube_consumption_trends', readTool('Compare local consumption topics across two date ranges.', consumptionTrendsSchema), (input) => resultOf(() => dependencies.insights.trends(
    { startDate: input.baselineStartDate, endDate: input.baselineEndDate },
    { startDate: input.comparisonStartDate, endDate: input.comparisonEndDate },
  )));
  server.registerTool('youtube_save_curation_policy', writeTool('Save selected-profile local curation allowlists and API-data retention.', curationPolicySchema), (input) => resultOf(() => dependencies.curation.savePolicy(input)));
  server.registerTool('youtube_save_curation_candidate', writeTool('Save a selected-profile local curation candidate with source provenance.', curationCandidateSchema), (input) => resultOf(() => dependencies.curation.saveCandidate(input)));
  server.registerTool('youtube_propose_consumption_queue', writeTool('Create a finite selected-profile local consumption queue.', proposeConsumptionQueueSchema), (input) => resultOf(() => dependencies.curation.propose(input)));
  server.registerTool('youtube_reset_consumption_data', writeTool('Delete selected-profile local curation policy, candidates, and queues.', resetConsumptionDataSchema), (input) => resultOf(() => dependencies.curation.reset(input)));

  server.registerTool('youtube_auth_status', readTool('Report safe local YouTube authorization readiness.', emptySchema), () => resultOf(() => dependencies.auth.status()));
  return server;
}

function readTool<Schema extends z.ZodType>(description: string, inputSchema: Schema) {
  return { description, inputSchema, annotations: { readOnlyHint: true } };
}

function downloadTool<Schema extends z.ZodType>(description: string, inputSchema: Schema) {
  return { description, inputSchema, annotations: { destructiveHint: false } };
}

function writeTool<Schema extends z.ZodType>(description: string, inputSchema: Schema) {
  return { description, inputSchema, annotations: { destructiveHint: true } };
}

async function resultOf<T>(operation: () => Promise<T> | T) {
  try {
    return success(await operation());
  } catch (error) {
    const safe = toSafeError(error);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(safe) }],
      isError: true,
    };
  }
}

function success(value: unknown) {
  const structuredContent = isRecord(value) ? value : { items: value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
