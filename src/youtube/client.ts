import { google, type youtube_v3 } from 'googleapis';
import { createReadStream } from 'node:fs';

import { AppError } from '../errors.js';
import type { AppConfig } from '../types.js';

type ListResponse = { data: { items?: unknown[]; nextPageToken?: string | null } };
export type SearchListRequest = {
  part: string; fields?: string; q?: string; maxResults?: number; type?: string;
  order?: string; publishedAfter?: string; publishedBefore?: string; videoDuration?: string; channelId?: string;
  regionCode?: string; relevanceLanguage?: string; safeSearch?: string; pageToken?: string;
};
export type VideosListRequest = {
  part: string; fields?: string; id?: string; mine?: boolean; maxResults?: number; pageToken?: string;
  chart?: string; regionCode?: string; videoCategoryId?: string;
};
export type ChannelsListRequest = { part: string; fields?: string; id?: string; forHandle?: string; mine?: boolean; maxResults?: number };
export type CommentThreadsListRequest = {
  part: string;
  fields?: string;
  videoId?: string;
  allThreadsRelatedToChannelId?: string;
  maxResults?: number;
  pageToken?: string;
  moderationStatus?: string;
  textFormat?: string;
};
export type SubscriptionsListRequest = { part: string; mine?: boolean; id?: string; maxResults?: number; pageToken?: string };

export type ResumableUploadApi = {
  initialize(request: {
    title: string;
    description?: string;
    privacyStatus: 'private' | 'unlisted' | 'public';
    publishAt?: string;
    fileSize: number;
    mimeType: string;
  }): Promise<{ status: number; sessionUrl?: string }>;
  probe(sessionUrl: string, fileSize: number): Promise<{ status: number; offset?: number; videoId?: string }>;
  uploadChunk(request: { sessionUrl: string; filePath: string; fileDescriptor?: number; offset: number; fileSize: number; mimeType: string }): Promise<{ status: number; offset?: number; videoId?: string }>;
  cancel(sessionUrl: string): Promise<{ status: number }>;
};

export type YouTubeDataApi = {
  search: { list(request: SearchListRequest): Promise<ListResponse> };
  videos: {
    list(request: VideosListRequest): Promise<ListResponse>;
    rate?(request: Record<string, unknown>): Promise<{ data: unknown }>;
    update?(request: Record<string, unknown>): Promise<{ data: unknown }>;
  };
  channels: { list(request: ChannelsListRequest): Promise<ListResponse>; update?(request: Record<string, unknown>): Promise<{ data: unknown }> };
  commentThreads: {
    list(request: CommentThreadsListRequest): Promise<ListResponse>;
    insert?(request: Record<string, unknown>): Promise<{ data: unknown }>;
  };
  comments?: {
    list(request: Record<string, unknown>): Promise<{ data: unknown }>;
    insert(request: Record<string, unknown>): Promise<{ data: unknown }>;
    setModerationStatus(request: Record<string, unknown>): Promise<{ data: unknown }>;
    delete(request: Record<string, unknown>): Promise<{ data: unknown }>;
  };
  videoCategories: { list(request: youtube_v3.Params$Resource$Videocategories$List): Promise<{ data: { items?: unknown[] | null; nextPageToken?: string | null } }> };
  playlists: {
    list(request: youtube_v3.Params$Resource$Playlists$List): Promise<{ data: { items?: unknown[] | null; nextPageToken?: string | null } }>;
    insert?(request: Record<string, unknown>): Promise<{ data: unknown }>;
    update?(request: Record<string, unknown>): Promise<{ data: unknown }>;
    delete?(request: Record<string, unknown>): Promise<{ data: unknown }>;
  };
  playlistItems: {
    list(request: youtube_v3.Params$Resource$Playlistitems$List): Promise<{ data: { items?: unknown[] | null; nextPageToken?: string | null } }>;
    insert?(request: Record<string, unknown>): Promise<{ data: unknown }>;
    update?(request: Record<string, unknown>): Promise<{ data: unknown }>;
    delete?(request: Record<string, unknown>): Promise<{ data: unknown }>;
  };
  thumbnails?: { set(request: Record<string, unknown>): Promise<{ data: unknown }> };
  captions: {
    list(request: youtube_v3.Params$Resource$Captions$List): Promise<{ data: { items?: unknown[] | null; nextPageToken?: string | null } }>;
    insert?(request: Record<string, unknown>): Promise<{ data: unknown }>;
    update?(request: Record<string, unknown>): Promise<{ data: unknown }>;
    download?(request: Record<string, unknown>, options?: { responseType: 'arraybuffer' }): Promise<{ data: unknown }>;
    delete?(request: Record<string, unknown>): Promise<{ data: unknown }>;
  };
  subscriptions?: {
    delete(request: Record<string, unknown>): Promise<{ data: unknown }>;
    insert(request: Record<string, unknown>): Promise<{ data: unknown }>;
    list(request: SubscriptionsListRequest): Promise<{ data: { items?: unknown[]; nextPageToken?: string | null } }>;
  };
};

export type YouTubeAnalyticsApi = {
  reports: {
    query(request: Record<string, unknown>): Promise<{
      data: { columnHeaders?: unknown[]; rows?: unknown[][] };
    }>;
  };
};

export type YouTubeClientDependencies = {
  createPublicApi(apiKey: string): YouTubeDataApi;
  createAuthorizedApi(accessToken: string): YouTubeDataApi;
  createAuthorizedAnalyticsApi?(accessToken: string): YouTubeAnalyticsApi;
  createResumableUpload?(accessToken: string): ResumableUploadApi;
};

export type GoogleOAuthClient = {
  setCredentials(credentials: { access_token: string }): void;
};

export type GoogleApiFactory = {
  createOAuthClient(): GoogleOAuthClient;
  createDataApi(auth: string | GoogleOAuthClient): YouTubeDataApi;
  createAnalyticsApi(auth: GoogleOAuthClient): YouTubeAnalyticsApi;
};

export class YouTubeClient {
  constructor(
    private readonly config: AppConfig,
    private readonly dependencies: YouTubeClientDependencies = defaultDependencies,
  ) {}

  public(): YouTubeDataApi {
    if (!this.config.apiKey) {
      throw new AppError(
        'api_key_required',
        'A YouTube API key is required for public YouTube reads.',
        'Set YOUTUBE_API_KEY and try again.',
        false,
      );
    }
    return this.dependencies.createPublicApi(this.config.apiKey);
  }

  authorized(accessToken: string): YouTubeDataApi {
    return this.dependencies.createAuthorizedApi(accessToken);
  }

  analytics(accessToken: string): YouTubeAnalyticsApi {
    return (this.dependencies.createAuthorizedAnalyticsApi ?? defaultDependencies.createAuthorizedAnalyticsApi!)(accessToken);
  }

  resumableUpload(accessToken: string): ResumableUploadApi {
    return (this.dependencies.createResumableUpload ?? createFetchResumableUpload)(accessToken);
  }
}

export function createGoogleClientDependencies(
  factory: GoogleApiFactory = defaultGoogleApiFactory,
): YouTubeClientDependencies {
  return {
    createPublicApi: (apiKey) => factory.createDataApi(apiKey),
    createAuthorizedApi: (accessToken) => factory.createDataApi(oauthWithToken(factory, accessToken)),
    createAuthorizedAnalyticsApi: (accessToken) => factory.createAnalyticsApi(oauthWithToken(factory, accessToken)),
    createResumableUpload: createFetchResumableUpload,
  };
}

function createFetchResumableUpload(accessToken: string): ResumableUploadApi {
  const headers = { Authorization: `Bearer ${accessToken}` };
  return {
    async initialize(request) {
      const response = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(request.fileSize),
          'X-Upload-Content-Type': request.mimeType,
        },
        body: JSON.stringify({
          snippet: { title: request.title, ...(request.description ? { description: request.description } : {}) },
          status: { privacyStatus: request.privacyStatus, ...(request.publishAt ? { publishAt: request.publishAt } : {}) },
        }),
      });
      return { status: response.status, ...(response.headers.get('location') ? { sessionUrl: response.headers.get('location')! } : {}) };
    },
    async probe(sessionUrl, fileSize) {
      const response = await fetch(sessionUrl, { method: 'PUT', headers: { ...headers, 'Content-Length': '0', 'Content-Range': `bytes */${fileSize}` } });
      return responseOf(response);
    },
    async uploadChunk(request) {
      const response = await fetch(request.sessionUrl, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': request.mimeType,
          'Content-Length': String(request.fileSize - request.offset),
          'Content-Range': `bytes ${request.offset}-${request.fileSize - 1}/${request.fileSize}`,
        },
        body: createReadStream(request.filePath, { ...(request.fileDescriptor === undefined ? {} : { fd: request.fileDescriptor, autoClose: false }), start: request.offset }),
        duplex: 'half',
      } as unknown as RequestInit);
      return responseOf(response);
    },
    async cancel(sessionUrl) {
      const response = await fetch(sessionUrl, { method: 'DELETE', headers });
      return { status: response.status };
    },
  };
}

async function responseOf(response: Response): Promise<{ status: number; offset?: number; videoId?: string }> {
  const range = response.headers.get('range');
  const offsetMatch = range?.match(/(\d+)$/);
  if (response.status === 308) return { status: 308, offset: offsetMatch ? Number(offsetMatch[1]) + 1 : 0 };
  if (response.status < 200 || response.status >= 300) return { status: response.status };
  try {
    const body: unknown = await response.json();
    const videoId = typeof body === 'object' && body !== null && typeof (body as { id?: unknown }).id === 'string'
      ? (body as { id: string }).id
      : undefined;
    return { status: response.status, ...(videoId ? { videoId } : {}) };
  } catch {
    return { status: response.status };
  }
}

function oauthWithToken(factory: GoogleApiFactory, accessToken: string): GoogleOAuthClient {
  const auth = factory.createOAuthClient();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

function createGoogleDataApi(auth: string | GoogleOAuthClient): YouTubeDataApi {
  const api = google.youtube({ version: 'v3', auth: auth as never });
  return {
    search: { list: async (request) => ({ data: (await api.search.list(request as never)).data }) },
    videos: {
      list: async (request) => ({ data: (await api.videos.list(request as never)).data }),
      rate: async (request) => ({ data: (await api.videos.rate(request as never)).data }),
      update: async (request) => ({ data: (await api.videos.update(request as never)).data }),
    },
    channels: { list: async (request) => ({ data: (await api.channels.list(request as never)).data }) },
    commentThreads: {
      list: async (request) => ({ data: (await api.commentThreads.list(request as never)).data }),
      insert: async (request) => ({ data: (await api.commentThreads.insert(request as never)).data }),
    },
    comments: {
      list: async (request) => ({ data: (await api.comments.list(request as never)).data }),
      insert: async (request) => ({ data: (await api.comments.insert(request as never)).data }),
      setModerationStatus: async (request) => ({ data: (await api.comments.setModerationStatus(request as never)).data }),
      delete: async (request) => ({ data: (await api.comments.delete(request as never)).data }),
    },
    videoCategories: { list: async (request) => ({ data: (await api.videoCategories.list(request)).data }) },
    playlists: {
      list: async (request) => ({ data: (await api.playlists.list(request)).data }),
      insert: async (request) => ({ data: (await api.playlists.insert(request as never)).data }),
      update: async (request) => ({ data: (await api.playlists.update(request as never)).data }),
      delete: async (request) => ({ data: (await api.playlists.delete(request as never)).data }),
    },
    playlistItems: {
      list: async (request) => ({ data: (await api.playlistItems.list(request)).data }),
      insert: async (request) => ({ data: (await api.playlistItems.insert(request as never)).data }),
      update: async (request) => ({ data: (await api.playlistItems.update(request as never)).data }),
      delete: async (request) => ({ data: (await api.playlistItems.delete(request as never)).data }),
    },
    thumbnails: { set: async (request) => ({ data: (await api.thumbnails.set(request as never)).data }) },
    captions: {
      list: async (request) => ({ data: (await api.captions.list(request)).data }),
      insert: async (request) => ({ data: (await api.captions.insert(request as never)).data }),
      update: async (request) => ({ data: (await api.captions.update(request as never)).data }),
      download: async (request, options) => ({ data: (await api.captions.download(request as never, options as never)).data }),
      delete: async (request) => ({ data: (await api.captions.delete(request as never)).data }),
    },
    subscriptions: {
      delete: async (request) => ({ data: (await api.subscriptions.delete(request as never)).data }),
      insert: async (request) => ({ data: (await api.subscriptions.insert(request as never)).data }),
      list: async (request) => ({ data: (await api.subscriptions.list(request as never)).data }),
    },
  };
}

function createGoogleAnalyticsApi(auth: GoogleOAuthClient): YouTubeAnalyticsApi {
  const api = google.youtubeAnalytics({ version: 'v2', auth: auth as never });
  return {
    reports: {
      query: async (request) => {
        const response = (await api.reports.query(request as never)).data;
        return {
          data: {
            columnHeaders: response.columnHeaders ?? undefined,
            rows: response.rows ?? undefined,
          },
        };
      },
    },
  };
}

const defaultGoogleApiFactory: GoogleApiFactory = {
  createOAuthClient: () => new google.auth.OAuth2(),
  createDataApi: createGoogleDataApi,
  createAnalyticsApi: createGoogleAnalyticsApi,
};

const defaultDependencies = createGoogleClientDependencies();
