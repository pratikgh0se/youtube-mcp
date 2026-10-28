export type AppConfig = {
  apiKey?: string;
  oauthClientSecretFile?: string;
  profileId?: string;
  channelId?: string;
  stateDir: string;
  diagnostics(): string;
};

export type ConnectionProfile = {
  id: string;
  purpose: 'creator' | 'consumer' | 'research';
  channelId?: string;
};

export type OperationState = 'planned' | 'approved' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';

export type OperationReconciliation = {
  tool: string;
  arguments: Record<string, string>;
};

export type OperationPreview = {
  approvalId: string;
  profile: ConnectionProfile;
  kind: string;
  targetId: string;
  desired: Record<string, unknown>;
  desiredFingerprint: string;
  currentFingerprint: string;
  expiresAt: string;
  state: 'planned' | 'approved';
  reconciliation: OperationReconciliation;
};

export type OperationReceipt = {
  operationId: string;
  state: OperationState;
  reconciliation: OperationReconciliation;
};

export type AppError = {
  code: string;
  message: string;
  action: string;
  retryable: boolean;
  operationId?: string;
  reconciliation?: OperationReconciliation;
  status?: number;
  reason?: string;
};

export type QuotaContext = {
  quotaUnits: number;
  source: 'youtube_data_api' | 'best_effort';
};

export type ToolResult<T> = {
  items: T;
  context: QuotaContext;
};

export type SearchInput = {
  query: string;
  maxResults?: number;
};

export type VideoInput = {
  videoId: string;
};

export type VideoSummary = {
  id: string;
  title: string;
  channelId: string;
  description?: string;
  publishedAt?: string;
};

export type Page<T> = {
  items: T[];
  profile: ConnectionProfile & { channelId: string };
  fetchedAt: string;
  expiresAt: string;
  nextPageToken?: string;
};

export type OwnedVideo = VideoSummary & {
  privacyStatus?: string;
  publishAt?: string;
  processingStatus?: string;
  etag?: string;
};

export type VideoCategory = {
  id: string;
  title: string;
};

export type PlaylistSummary = {
  id: string;
  title: string;
  channelId: string;
  description?: string;
  privacyStatus?: string;
  etag?: string;
};

export type PlaylistItemSummary = {
  id: string;
  playlistId: string;
  videoId: string;
  title: string;
  channelId: string;
  position?: number;
  etag?: string;
};

export type ModerationComment = CommentSummary & {
  commentId: string;
  threadId: string;
  channelId: string;
  videoId?: string;
  replies: CommentSummary[];
  moderationStatus?: string;
  etag?: string;
};

export type CaptionTrack = {
  id: string;
  videoId: string;
  language: string;
  name?: string;
  trackKind?: string;
  status?: string;
  isDraft?: boolean;
  etag?: string;
};

export type ChannelSummary = {
  id: string;
  title: string;
  description?: string;
};

export type CommentSummary = {
  id: string;
  author: string;
  text: string;
  publishedAt?: string;
};

export type MutationInput = {
  confirm?: boolean;
};

export type SubscribeInput = MutationInput & {
  channelId: string;
};

export type UnsubscribeInput = MutationInput & {
  subscriptionId: string;
};

export type RateVideoInput = MutationInput & {
  videoId: string;
  rating: 'like' | 'dislike' | 'none';
};

export type CreateCommentInput = MutationInput & {
  videoId: string;
  text: string;
};

export type SubscriptionSummary = {
  subscriptionId: string;
  channelId: string;
  title?: string;
};

export type SubscriptionResult = {
  subscriptionId: string;
  channelId: string;
};

export type UnsubscribeResult = {
  subscriptionId: string;
  unsubscribed: true;
};

export type VideoRatingResult = {
  videoId: string;
  rating: RateVideoInput['rating'];
};

export type TranscriptResult = {
  available: boolean;
  source: 'best_effort' | 'owned_caption';
  text?: string;
};
