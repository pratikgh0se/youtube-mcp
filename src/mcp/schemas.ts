import { z } from 'zod';

const id = z.string().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates.');
const maxResults = z.number().int().min(1).max(50).optional().describe('Maximum number of items to return, 1-50; omit to use the tool default.');
const pageTokenField = z.string().min(1).optional().describe('Page token from the nextPageToken of a previous response, to fetch the next page.');
const videoId = id.describe('YouTube video ID (11 characters), e.g. dQw4w9WgXcQ.');
const channelIdField = id.describe('YouTube channel ID starting with UC, e.g. UCxxxxxxxxxxxxxxxxxxxxxx.');
const playlistId = id.describe('YouTube playlist ID, e.g. PLxxxxxxxxxxxxxxxx.');
const playlistItemId = id.describe('Playlist item ID (not the video ID), from youtube_list_playlist_items.');
const commentId = id.describe('YouTube comment ID, from the comment listing tools.');
const captionId = id.describe('Caption track ID, from youtube_list_caption_tracks.');
const uploadId = id.describe('Upload session ID returned by the upload preflight or youtube_get_upload_status.');
const filePath = z.string().min(1).describe('Absolute path to a local file on the machine running this server.');
const privacyStatus = z.enum(['private', 'unlisted', 'public']).optional().describe('Visibility: private, unlisted or public.');
const startDate = date.describe('Start date of the range, YYYY-MM-DD.');
const endDate = date.describe('End date of the range, YYYY-MM-DD.');
const dateRange = {
  startDate,
  endDate,
};
const confirmWrite = z.boolean().optional().describe('Must be true to perform this write; set it only after the user approved the action.');
const approvalOf = (preflight: string) => id.describe(`Approval ID from the ${preflight} preview, after approving it with youtube_approve.`);
const confirmExecute = z.boolean().optional().describe('Must be true to execute; set it only after youtube_approve approved this exact preview.');

const rfc3339 = z.string().datetime({ offset: true, message: 'Use an RFC 3339 timestamp such as 2026-01-31T00:00:00Z.' });
export const searchSchema = z.object({
  query: z.string().min(1).describe('Search text to look for on YouTube.'),
  maxResults,
  order: z.enum(['relevance', 'date', 'viewCount', 'rating', 'title']).optional().describe('Sort order: relevance, date, viewCount, rating or title.'),
  publishedAfter: rfc3339.optional().describe('Only return results published at or after this RFC 3339 timestamp.'),
  publishedBefore: rfc3339.optional().describe('Only return results published before this RFC 3339 timestamp.'),
  videoDuration: z.enum(['any', 'short', 'medium', 'long']).optional().describe('Filter by video length: any, short, medium or long.'),
  channelId: z.string().min(1).optional().describe('Restrict results to this channel ID (UC...).'),
  regionCode: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter region code.').optional().describe('Two-letter ISO 3166-1 region code, e.g. US.'),
  relevanceLanguage: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use an ISO 639-1 language code such as en or zh-Hans.').optional().describe('Prefer results in this language code, e.g. en or zh-Hans.'),
  safeSearch: z.enum(['none', 'moderate', 'strict']).optional().describe('Safe-search filtering level: none, moderate or strict.'),
  pageToken: pageTokenField,
});
export const trendingSchema = z.object({
  regionCode: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter region code.').optional().describe('Two-letter ISO 3166-1 region code, e.g. US.'),
  videoCategoryId: z.string().regex(/^\d+$/, 'Use a numeric video category ID (see youtube_list_video_categories).').optional().describe('Numeric video category ID from youtube_list_video_categories.'),
  maxResults,
  pageToken: pageTokenField,
});
export const listChannelVideosSchema = z.object({
  channelId: z.string().min(1).describe('A channel ID (UC...) or an @handle.'),
  maxResults,
  pageToken: pageTokenField,
});
export const videoSchema = z.object({ videoId });
export const channelSchema = z.object({ channelId: channelIdField.describe('Channel ID (UC...) of the channel to look up.') });
export const commentsSchema = z.object({ videoId, maxResults });
export const listSchema = z.object({ maxResults });
export const listSubscriptionsSchema = z.object({
  maxResults,
  pageToken: pageTokenField,
  details: z.boolean().optional().describe('Add subscriberCount, videoCount and lastUploadAt per channel. Costs roughly 1 extra quota unit per returned channel plus 1 per 50 channels.'),
});
export const emptySchema = z.object({});
export const pageSchema = z.object({ maxResults, pageToken: pageTokenField });
export const videoCategoriesSchema = z.object({
  regionCode: z.string().regex(/^[A-Z]{2}$/i, 'Use a two-letter region code.').optional().describe('Two-letter region code, e.g. US. Provide this or id, not both.'),
  id: id.optional().describe('Category ID to look up. Provide this or regionCode, not both.'),
}).refine((input) => Boolean(input.regionCode) !== Boolean(input.id), 'Provide exactly one of regionCode or id.');
export const ownedVideoSchema = z.object({ videoId: videoId.describe('ID of a video on the selected channel.') });
export const playlistSchema = z.object({ playlistId });
export const playlistItemsSchema = pageSchema.extend({ playlistId });
export const moderationCommentsSchema = pageSchema.extend({
  moderationStatus: z.enum(['heldForReview', 'likelySpam', 'published']).optional().describe('Only list comments with this moderation status.'),
});
export const moderationCommentSchema = z.object({ commentId });
export const findCommentReplySchema = z.object({ parentId: id.describe('ID of the top-level comment whose replies are searched.'), text: z.string().min(1).max(10_000).describe('Reply text to match, up to 10000 characters.') });
export const captionTracksSchema = z.object({ videoId });

export const approveSchema = z.object({ approvalId: id.describe('Approval ID returned by any youtube_preflight_* tool for the exact change.'), confirm: z.boolean().optional().describe('Must be true to approve; set it only after the user reviewed the preview.') });

const uploadFields = {
  filePath: filePath.describe('Absolute path to the local video file to upload.'),
  title: z.string().min(1).describe('Video title; leading and trailing whitespace is trimmed.'),
  description: z.string().max(5_000).optional().describe('Video description, up to 5000 characters.'),
  privacyStatus,
  publishAt: z.string().datetime().optional().describe('Future ISO 8601 time to publish; only valid with privacyStatus private.'),
  publish: z.boolean().optional().describe('Must be true when privacyStatus is public, as a separate confirmation.'),
};
export const preflightUploadSchema = z.object(uploadFields);
export const uploadVideoSchema = z.object({ ...uploadFields, approvalId: approvalOf('youtube_preflight_upload'), confirm: confirmExecute });
export const preflightResumeUploadSchema = z.object({ ...uploadFields, uploadId });
export const resumeUploadSchema = z.object({ ...uploadFields, approvalId: approvalOf('youtube_preflight_resume_upload'), uploadId, confirm: confirmExecute });
export const uploadStatusSchema = z.object({ uploadId });
export const preflightCancelUploadSchema = z.object({ uploadId });
export const cancelUploadSchema = z.object({ approvalId: approvalOf('youtube_preflight_cancel_upload'), uploadId, confirm: confirmExecute });

const metadataFields = {
  title: z.string().min(1).max(100).optional().describe('New video title, up to 100 characters.'),
  description: z.string().max(5_000).optional().describe('New video description, up to 5000 characters.'),
  tags: z.array(z.string().min(1).max(500)).max(500).optional().describe('Replacement tag list, up to 500 tags of up to 500 characters each.'),
  categoryId: id.optional().describe('Numeric video category ID from youtube_list_video_categories.'),
  defaultLanguage: z.string().min(2).max(16).optional().describe('Default language code of the video, e.g. en.'),
  privacyStatus,
  publishAt: z.string().datetime().describe('Future ISO 8601 time. YouTube only schedules a private video that has never been public.').optional(),
  containsSyntheticMedia: z.boolean().optional().describe('Whether the video contains realistic altered or synthetic media; needs elevated: true.'),
  selfDeclaredMadeForKids: z.boolean().optional().describe('Whether the video is made for kids; needs elevated: true.'),
  publish: z.boolean().optional().describe('Must be true when privacyStatus is public, as a separate confirmation.'),
  elevated: z.boolean().optional().describe('Must be true for public, scheduled, synthetic-media or made-for-kids changes, after the user reviewed them.'),
};
export const preflightMetadataUpdateSchema = z.object({ videoId: videoId.describe('ID of an owned video to update.'), ...metadataFields });
export const updateMetadataSchema = preflightMetadataUpdateSchema.extend({ approvalId: approvalOf('youtube_preflight_update_metadata'), confirm: confirmExecute });
export const preflightArchiveVideoSchema = z.object({ videoId: videoId.describe('ID of an owned video to archive.') });
export const archiveVideoSchema = preflightArchiveVideoSchema.extend({ approvalId: approvalOf('youtube_preflight_archive_video'), confirm: confirmExecute });
export const preflightThumbnailSchema = z.object({ videoId: videoId.describe('ID of an owned video to set the thumbnail on.'), filePath: filePath.describe('Absolute path to the local thumbnail image.'), mimeType: z.enum(['image/jpeg', 'image/png']).describe('Thumbnail MIME type: image/jpeg or image/png.') });
export const setThumbnailSchema = preflightThumbnailSchema.extend({ approvalId: approvalOf('youtube_preflight_set_thumbnail'), confirm: confirmExecute });

const captionMimeType = z.enum(['application/octet-stream', 'application/ttml+xml', 'text/plain', 'text/vtt']);
const captionUploadFields = {
  videoId: videoId.describe('ID of an owned video the caption belongs to.'),
  filePath: filePath.describe('Absolute path to the local caption file.'),
  mimeType: captionMimeType.describe('Caption file MIME type: application/octet-stream, application/ttml+xml, text/plain or text/vtt.'),
  language: z.string().min(2).max(16).describe('Caption language code, e.g. en.'),
  name: z.string().min(1).max(150).describe('Caption track name shown to viewers, up to 150 characters.'),
  isDraft: z.boolean().optional().describe('Whether the caption track is a draft that is not shown to viewers.'),
};
export const preflightCaptionUploadSchema = z.object(captionUploadFields);
export const uploadCaptionSchema = preflightCaptionUploadSchema.extend({ approvalId: approvalOf('youtube_preflight_caption_upload'), confirm: confirmExecute });
export const preflightCaptionUpdateSchema = z.object({ ...captionUploadFields, captionId });
export const updateCaptionSchema = preflightCaptionUpdateSchema.extend({ approvalId: approvalOf('youtube_preflight_caption_update'), confirm: confirmExecute });
export const downloadCaptionSchema = z.object({ videoId, captionId, fileName: z.string().min(1).max(120).describe('Plain new file name (no path) to write under <state dir>/downloads/; existing files are never overwritten.'), format: z.enum(['srt', 'ttml', 'vtt', 'sbv']).optional().describe('Caption format to convert to: srt, ttml, vtt, sbv. The fileName extension must match it. Omit for the track original.') });
export const preflightCaptionDeleteSchema = z.object({ videoId, captionId });
export const deleteCaptionSchema = preflightCaptionDeleteSchema.extend({ approvalId: approvalOf('youtube_preflight_caption_delete'), confirm: confirmExecute });

const playlistFields = {
  title: z.string().min(1).max(150).optional().describe('Playlist title, up to 150 characters.'),
  description: z.string().max(5_000).optional().describe('Playlist description, up to 5000 characters.'),
  privacyStatus: privacyStatus.describe('Playlist visibility: private, unlisted or public.'),
};
export const preflightCreatePlaylistSchema = z.object({ ...playlistFields, title: z.string().min(1).max(150).describe('Title of the new playlist, up to 150 characters.') });
export const createPlaylistSchema = preflightCreatePlaylistSchema.extend({ approvalId: approvalOf('youtube_preflight_create_playlist'), confirm: confirmExecute });
export const preflightUpdatePlaylistSchema = z.object({ playlistId, ...playlistFields }).refine((input) => input.title !== undefined || input.description !== undefined || input.privacyStatus !== undefined, 'Provide at least one playlist field to update.');
export const updatePlaylistSchema = preflightUpdatePlaylistSchema.extend({ approvalId: approvalOf('youtube_preflight_update_playlist'), confirm: confirmExecute });
export const preflightDeletePlaylistSchema = z.object({ playlistId });
export const deletePlaylistSchema = preflightDeletePlaylistSchema.extend({ approvalId: approvalOf('youtube_preflight_delete_playlist'), confirm: confirmExecute });
export const preflightAddPlaylistItemSchema = z.object({ playlistId, videoId: videoId.describe('ID of the video to add to the playlist.') });
export const addPlaylistItemSchema = preflightAddPlaylistItemSchema.extend({ approvalId: approvalOf('youtube_preflight_add_playlist_item'), confirm: confirmExecute });
export const preflightRemovePlaylistItemSchema = z.object({ playlistId, playlistItemId });
export const removePlaylistItemSchema = preflightRemovePlaylistItemSchema.extend({ approvalId: approvalOf('youtube_preflight_remove_playlist_item'), confirm: confirmExecute });
export const preflightReorderPlaylistItemSchema = z.object({ playlistId, playlistItemId, position: z.number().int().min(0).describe('New zero-based position of the item in the playlist.') });
export const reorderPlaylistItemSchema = preflightReorderPlaylistItemSchema.extend({ approvalId: approvalOf('youtube_preflight_reorder_playlist_item'), confirm: confirmExecute });

const commentIdSchema = z.object({ commentId: commentId.describe('ID of a comment on the selected channel, from youtube_list_channel_comment_threads or youtube_list_moderation_comments.') });
export const preflightReplyToCommentSchema = commentIdSchema.extend({ text: z.string().min(1).max(10_000).describe('Reply text, up to 10000 characters.') });
export const replyToCommentSchema = preflightReplyToCommentSchema.extend({ approvalId: approvalOf('youtube_preflight_reply_to_comment'), confirm: confirmExecute });
export const preflightSetCommentModerationStatusSchema = commentIdSchema.extend({ moderationStatus: z.enum(['heldForReview', 'published', 'rejected']).describe('New moderation status: heldForReview, published or rejected.'), banAuthor: z.boolean().optional().describe('Also ban the comment author; allowed only with rejected and needs elevated: true.'), elevated: z.boolean().optional().describe('Must be true when banAuthor is true, after the user reviewed the ban.') })
  .refine((input) => input.banAuthor !== true || input.moderationStatus === 'rejected', { message: 'banAuthor is allowed only with rejected.', path: ['banAuthor'] });
export const setCommentModerationStatusSchema = preflightSetCommentModerationStatusSchema.extend({ approvalId: approvalOf('youtube_preflight_set_comment_moderation_status'), confirm: confirmExecute });
export const preflightDeleteCommentSchema = commentIdSchema;
export const deleteCommentSchema = preflightDeleteCommentSchema.extend({ approvalId: approvalOf('youtube_preflight_delete_comment'), confirm: confirmExecute });

export const subscribeSchema = z.object({ channelId: channelIdField.describe('Channel ID (UC...) to subscribe to.'), confirm: confirmWrite });
export const unsubscribeSchema = z.object({ subscriptionId: id.describe('Subscription ID (not the channel ID), from youtube_list_subscriptions.'), confirm: confirmWrite });
export const rateVideoSchema = z.object({
  videoId,
  rating: z.enum(['like', 'dislike', 'none']).describe('Rating to set: like, dislike or none to clear it.'),
  confirm: confirmWrite,
});
export const createCommentSchema = z.object({ videoId: videoId.describe('ID of a video on the selected channel to comment on.'), text: z.string().min(1).describe('Text of the new top-level comment.'), confirm: confirmWrite });

export const creatorOverviewSchema = z.object(dateRange);
export const creatorTopVideosSchema = z.object({ ...dateRange, limit: z.number().int().min(1).max(50).optional().describe('Maximum number of top videos to return, 1-50; omit to use the tool default.') });
export const creatorRetentionSchema = z.object({ videoId: videoId.describe('ID of an owned video to report audience retention for.') });
export const creatorReportSchema = z.object({
  startDate: date.optional().describe('Start date, YYYY-MM-DD; defaults to 28 days before endDate.'),
  endDate: date.optional().describe('End date, YYYY-MM-DD; defaults to today.'),
  metrics: z.array(z.string().min(1)).min(1).max(12).describe('YouTube Analytics metric names such as views, 1-12 items.'),
  dimensions: z.array(z.string().min(1)).max(3).optional().describe('YouTube Analytics dimension names to group by, up to 3.'),
  filters: z.object({
    videoIds: z.array(id).min(1).max(500).optional().describe('Video IDs to limit the report to, 1-500 items.'),
    country: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code.').optional().describe('Two-letter country code to filter by, e.g. US.'),
    insightTrafficSourceType: z.string().min(1).optional().describe('Traffic source type to filter by, e.g. YT_SEARCH.'),
  }).optional().describe('Optional filters to narrow the report.'),
  sort: z.array(z.string().min(1)).max(4).optional().describe('Sort keys, up to 4; prefix a key with - for descending, e.g. -views.'),
  maxResults: z.number().int().min(1).max(200).optional().describe('Maximum rows to return, 1-200; traffic-source-detail reports allow at most 25.'),
});

export const importTakeoutSchema = z.object({ inputPath: z.string().min(1).describe('Local path to a Google Takeout watch-history file ending in .json, .html or .htm (max 25 MiB).') });
export const consumptionProfileSchema = z.object(dateRange);
export const consumptionTrendsSchema = z.object({
  baselineStartDate: date.describe('Start date of the baseline period, YYYY-MM-DD.'),
  baselineEndDate: date.describe('End date of the baseline period, YYYY-MM-DD.'),
  comparisonStartDate: date.describe('Start date of the comparison period, YYYY-MM-DD.'),
  comparisonEndDate: date.describe('End date of the comparison period, YYYY-MM-DD.'),
});

export const curationPolicySchema = z.object({
  allowedSources: z.array(id).max(500).describe('Source IDs (channel or playlist IDs) whose candidates may be queued, up to 500.'),
  retentionDays: z.number().int().min(1).max(3650).optional().describe('Days to keep curation data, 1-3650; defaults to 30.'),
});
export const curationCandidateSchema = z.object({
  videoId,
  source: z.enum(['allowlist', 'playlist', 'search']).describe('How the candidate was found: allowlist, playlist or search.'),
  sourceId: id.describe('ID of the source it came from; it must be in allowedSources to be queued.'),
  title: z.string().min(1).max(500).describe('Video title, up to 500 characters.'),
  reason: z.string().min(1).max(2_000).optional().describe('Why this video was picked, up to 2000 characters.'),
  estimatedMinutes: z.number().int().min(1).max(24 * 60).optional().describe('Estimated watch time in whole minutes; candidates without it are never queued.'),
  apiFetchedAt: z.string().datetime().optional().describe('ISO 8601 time the video data was fetched from the YouTube API.'),
});
export const proposeConsumptionQueueSchema = z.object({ minutes: z.number().positive().max(24 * 60).describe('Time budget in minutes, greater than 0 and at most 1440.') });
export const resetConsumptionDataSchema = z.object({ confirm: z.boolean().optional().describe('Must be true to delete the local consumption data; set it only after the user approved.') });

export const preflightUpdateChannelSchema = z.object({
  description: z.string().max(1_000).optional().describe('New channel description, up to 1000 characters.'),
  keywords: z.string().max(500).optional().describe('New channel keywords as one string, up to 500 characters.'),
  country: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter ISO 3166-1 country code.').optional().describe('Two-letter ISO 3166-1 country code of the channel, e.g. US.'),
  defaultLanguage: z.string().min(2).max(16).optional().describe('Default language code of the channel, e.g. en.'),
}).refine((input) => Object.values(input).some((value) => value !== undefined), 'Provide at least one channel field to update.');
export const updateChannelSchema = z.object({
  description: z.string().max(1_000).optional().describe('New channel description, up to 1000 characters.'),
  keywords: z.string().max(500).optional().describe('New channel keywords as one string, up to 500 characters.'),
  country: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter ISO 3166-1 country code.').optional().describe('Two-letter ISO 3166-1 country code of the channel, e.g. US.'),
  defaultLanguage: z.string().min(2).max(16).optional().describe('Default language code of the channel, e.g. en.'),
  approvalId: approvalOf('youtube_preflight_update_channel'),
  confirm: confirmExecute,
});
export const preflightUnsubscribeManySchema = z.object({ subscriptionIds: z.array(id).min(1).max(100).describe('Subscription IDs to remove, 1-100, from youtube_list_subscriptions.') });
export const unsubscribeManySchema = preflightUnsubscribeManySchema.extend({ approvalId: approvalOf('youtube_preflight_unsubscribe_many'), confirm: confirmExecute });
