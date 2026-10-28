import { z } from 'zod';

const id = z.string().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates.');
const maxResults = z.number().int().min(1).max(50).optional();
const dateRange = {
  startDate: date,
  endDate: date,
};

const rfc3339 = z.string().datetime({ offset: true, message: 'Use an RFC 3339 timestamp such as 2026-01-31T00:00:00Z.' });
export const searchSchema = z.object({
  query: z.string().min(1),
  maxResults,
  order: z.enum(['relevance', 'date', 'viewCount', 'rating', 'title']).optional(),
  publishedAfter: rfc3339.optional(),
  publishedBefore: rfc3339.optional(),
  videoDuration: z.enum(['any', 'short', 'medium', 'long']).optional(),
  channelId: z.string().min(1).optional(),
  regionCode: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter region code.').optional(),
  relevanceLanguage: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use an ISO 639-1 language code such as en or zh-Hans.').optional(),
  safeSearch: z.enum(['none', 'moderate', 'strict']).optional(),
  pageToken: z.string().min(1).optional(),
});
export const trendingSchema = z.object({
  regionCode: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter region code.').optional(),
  videoCategoryId: z.string().regex(/^\d+$/, 'Use a numeric video category ID (see youtube_list_video_categories).').optional(),
  maxResults,
  pageToken: z.string().min(1).optional(),
});
export const listChannelVideosSchema = z.object({
  channelId: z.string().min(1).describe('A channel ID (UC...) or an @handle.'),
  maxResults,
  pageToken: z.string().min(1).optional(),
});
export const videoSchema = z.object({ videoId: id });
export const channelSchema = z.object({ channelId: id });
export const commentsSchema = z.object({ videoId: id, maxResults });
export const listSchema = z.object({ maxResults });
export const listSubscriptionsSchema = z.object({
  maxResults,
  pageToken: z.string().min(1).optional(),
  details: z.boolean().optional().describe('Add subscriberCount, videoCount and lastUploadAt per channel. Costs roughly 1 extra quota unit per returned channel plus 1 per 50 channels.'),
});
export const emptySchema = z.object({});
export const pageSchema = z.object({ maxResults, pageToken: id.optional() });
export const videoCategoriesSchema = z.object({
  regionCode: z.string().regex(/^[A-Z]{2}$/i, 'Use a two-letter region code.').optional(),
  id: id.optional(),
}).refine((input) => Boolean(input.regionCode) !== Boolean(input.id), 'Provide exactly one of regionCode or id.');
export const ownedVideoSchema = z.object({ videoId: id });
export const playlistSchema = z.object({ playlistId: id });
export const playlistItemsSchema = pageSchema.extend({ playlistId: id });
export const moderationCommentsSchema = pageSchema.extend({
  moderationStatus: z.enum(['heldForReview', 'likelySpam', 'published']).optional(),
});
export const moderationCommentSchema = z.object({ commentId: id });
export const findCommentReplySchema = z.object({ parentId: id, text: z.string().min(1).max(10_000) });
export const captionTracksSchema = z.object({ videoId: id });

export const approveSchema = z.object({ approvalId: id, confirm: z.boolean().optional() });

const uploadFields = {
  filePath: z.string().min(1),
  title: z.string().min(1),
  description: z.string().max(5_000).optional(),
  privacyStatus: z.enum(['private', 'unlisted', 'public']).optional(),
  publishAt: z.string().datetime().optional(),
  publish: z.boolean().optional(),
};
export const preflightUploadSchema = z.object(uploadFields);
export const uploadVideoSchema = z.object({ ...uploadFields, approvalId: id, confirm: z.boolean().optional() });
export const preflightResumeUploadSchema = z.object({ ...uploadFields, uploadId: id });
export const resumeUploadSchema = z.object({ ...uploadFields, approvalId: id, uploadId: id, confirm: z.boolean().optional() });
export const uploadStatusSchema = z.object({ uploadId: id });
export const preflightCancelUploadSchema = z.object({ uploadId: id });
export const cancelUploadSchema = z.object({ approvalId: id, uploadId: id, confirm: z.boolean().optional() });

const metadataFields = {
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(5_000).optional(),
  tags: z.array(z.string().min(1).max(500)).max(500).optional(),
  categoryId: id.optional(),
  defaultLanguage: z.string().min(2).max(16).optional(),
  privacyStatus: z.enum(['private', 'unlisted', 'public']).optional(),
  publishAt: z.string().datetime().optional(),
  containsSyntheticMedia: z.boolean().optional(),
  selfDeclaredMadeForKids: z.boolean().optional(),
  publish: z.boolean().optional(),
  elevated: z.boolean().optional(),
};
export const preflightMetadataUpdateSchema = z.object({ videoId: id, ...metadataFields });
export const updateMetadataSchema = preflightMetadataUpdateSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const preflightArchiveVideoSchema = z.object({ videoId: id });
export const archiveVideoSchema = preflightArchiveVideoSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const preflightThumbnailSchema = z.object({ videoId: id, filePath: z.string().min(1), mimeType: z.enum(['image/jpeg', 'image/png']) });
export const setThumbnailSchema = preflightThumbnailSchema.extend({ approvalId: id, confirm: z.boolean().optional() });

const captionMimeType = z.enum(['application/octet-stream', 'application/ttml+xml', 'text/plain', 'text/vtt']);
const captionUploadFields = { videoId: id, filePath: z.string().min(1), mimeType: captionMimeType, language: z.string().min(2).max(16), name: z.string().min(1).max(150), isDraft: z.boolean().optional() };
export const preflightCaptionUploadSchema = z.object(captionUploadFields);
export const uploadCaptionSchema = preflightCaptionUploadSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const preflightCaptionUpdateSchema = z.object({ ...captionUploadFields, captionId: id });
export const updateCaptionSchema = preflightCaptionUpdateSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const downloadCaptionSchema = z.object({ videoId: id, captionId: id, outputPath: z.string().min(1), format: z.enum(['srt', 'ttml', 'vtt']).optional() });
export const preflightCaptionDeleteSchema = z.object({ videoId: id, captionId: id });
export const deleteCaptionSchema = preflightCaptionDeleteSchema.extend({ approvalId: id, confirm: z.boolean().optional() });

const playlistFields = {
  title: z.string().min(1).max(150).optional(),
  description: z.string().max(5_000).optional(),
  privacyStatus: z.enum(['private', 'unlisted', 'public']).optional(),
};
export const preflightCreatePlaylistSchema = z.object({ ...playlistFields, title: z.string().min(1).max(150) });
export const createPlaylistSchema = preflightCreatePlaylistSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const preflightUpdatePlaylistSchema = z.object({ playlistId: id, ...playlistFields }).refine((input) => input.title !== undefined || input.description !== undefined || input.privacyStatus !== undefined, 'Provide at least one playlist field to update.');
export const updatePlaylistSchema = preflightUpdatePlaylistSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const preflightDeletePlaylistSchema = z.object({ playlistId: id });
export const deletePlaylistSchema = preflightDeletePlaylistSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const preflightAddPlaylistItemSchema = z.object({ playlistId: id, videoId: id });
export const addPlaylistItemSchema = preflightAddPlaylistItemSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const preflightRemovePlaylistItemSchema = z.object({ playlistId: id, playlistItemId: id });
export const removePlaylistItemSchema = preflightRemovePlaylistItemSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const preflightReorderPlaylistItemSchema = z.object({ playlistId: id, playlistItemId: id, position: z.number().int().min(0) });
export const reorderPlaylistItemSchema = preflightReorderPlaylistItemSchema.extend({ approvalId: id, confirm: z.boolean().optional() });

const commentIdSchema = z.object({ commentId: id });
export const preflightReplyToCommentSchema = commentIdSchema.extend({ text: z.string().min(1).max(10_000) });
export const replyToCommentSchema = preflightReplyToCommentSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const preflightSetCommentModerationStatusSchema = commentIdSchema.extend({ moderationStatus: z.enum(['heldForReview', 'published', 'rejected']), banAuthor: z.boolean().optional(), elevated: z.boolean().optional() })
  .refine((input) => input.banAuthor !== true || input.moderationStatus === 'rejected', { message: 'banAuthor is allowed only with rejected.', path: ['banAuthor'] });
export const setCommentModerationStatusSchema = preflightSetCommentModerationStatusSchema.extend({ approvalId: id, confirm: z.boolean().optional() });
export const preflightDeleteCommentSchema = commentIdSchema;
export const deleteCommentSchema = preflightDeleteCommentSchema.extend({ approvalId: id, confirm: z.boolean().optional() });

export const subscribeSchema = z.object({ channelId: id, confirm: z.boolean().optional() });
export const unsubscribeSchema = z.object({ subscriptionId: id, confirm: z.boolean().optional() });
export const rateVideoSchema = z.object({
  videoId: id,
  rating: z.enum(['like', 'dislike', 'none']),
  confirm: z.boolean().optional(),
});
export const createCommentSchema = z.object({ videoId: id, text: z.string().min(1), confirm: z.boolean().optional() });

export const creatorOverviewSchema = z.object(dateRange);
export const creatorTopVideosSchema = z.object({ ...dateRange, limit: maxResults });
export const creatorRetentionSchema = z.object({ videoId: id });
export const creatorReportSchema = z.object({
  startDate: date.optional(),
  endDate: date.optional(),
  metrics: z.array(z.string().min(1)).min(1).max(12),
  dimensions: z.array(z.string().min(1)).max(3).optional(),
  filters: z.object({
    videoIds: z.array(id).min(1).max(500).optional(),
    country: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code.').optional(),
    insightTrafficSourceType: z.string().min(1).optional(),
  }).optional(),
  sort: z.array(z.string().min(1)).max(4).optional(),
  maxResults: z.number().int().min(1).max(200).optional(),
});

export const importTakeoutSchema = z.object({ inputPath: z.string().min(1) });
export const consumptionProfileSchema = z.object(dateRange);
export const consumptionTrendsSchema = z.object({
  baselineStartDate: date,
  baselineEndDate: date,
  comparisonStartDate: date,
  comparisonEndDate: date,
});

export const curationPolicySchema = z.object({
  allowedSources: z.array(id).max(500),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});
export const curationCandidateSchema = z.object({
  videoId: id,
  source: z.enum(['allowlist', 'playlist', 'search']),
  sourceId: id,
  title: z.string().min(1).max(500),
  reason: z.string().min(1).max(2_000).optional(),
  estimatedMinutes: z.number().int().min(1).max(24 * 60).optional(),
  apiFetchedAt: z.string().datetime().optional(),
});
export const proposeConsumptionQueueSchema = z.object({ minutes: z.number().positive().max(24 * 60) });
export const resetConsumptionDataSchema = z.object({ confirm: z.boolean().optional() });

export const preflightUpdateChannelSchema = z.object({
  description: z.string().max(1_000).optional(),
  keywords: z.string().max(500).optional(),
  country: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter ISO 3166-1 country code.').optional(),
  defaultLanguage: z.string().min(2).max(16).optional(),
}).refine((input) => Object.values(input).some((value) => value !== undefined), 'Provide at least one channel field to update.');
export const updateChannelSchema = z.object({
  description: z.string().max(1_000).optional(),
  keywords: z.string().max(500).optional(),
  country: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter ISO 3166-1 country code.').optional(),
  defaultLanguage: z.string().min(2).max(16).optional(),
  approvalId: id,
  confirm: z.boolean().optional(),
});
export const preflightUnsubscribeManySchema = z.object({ subscriptionIds: z.array(id).min(1).max(100) });
export const unsubscribeManySchema = preflightUnsubscribeManySchema.extend({ approvalId: id, confirm: z.boolean().optional() });
