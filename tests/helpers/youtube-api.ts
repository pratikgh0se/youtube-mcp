import type { YouTubeDataApi } from '../../src/youtube/client.js';

export function testYouTubeApi(overrides: Partial<YouTubeDataApi> = {}): YouTubeDataApi {
  const api: YouTubeDataApi = {
    search: { list: async () => ({ data: { items: [] } }) },
    videos: { list: async () => ({ data: { items: [] } }) },
    channels: { list: async () => ({ data: { items: [] } }) },
    commentThreads: { list: async () => ({ data: { items: [] } }) },
    videoCategories: { list: async () => ({ data: { items: [] } }) },
    playlists: { list: async () => ({ data: { items: [] } }) },
    playlistItems: { list: async () => ({ data: { items: [] } }) },
    captions: { list: async () => ({ data: { items: [] } }) },
  };
  return Object.assign(api, overrides) as YouTubeDataApi;
}
