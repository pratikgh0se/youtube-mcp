const enabled = process.env.YOUTUBE_LIVE_SMOKE === '1';

if (!enabled) {
  process.stdout.write('Read-only live smoke skipped (set YOUTUBE_LIVE_SMOKE=1 to opt in).\n');
  process.exit(0);
}

const apiKey = process.env.YOUTUBE_API_KEY;
if (!apiKey) {
  process.stderr.write('Read-only live smoke requires YOUTUBE_API_KEY when YOUTUBE_LIVE_SMOKE=1.\n');
  process.exit(1);
}

const url = new URL('https://www.googleapis.com/youtube/v3/search');
url.search = new URLSearchParams({
  part: 'id',
  type: 'video',
  maxResults: '1',
  q: 'YouTube',
  key: apiKey,
}).toString();

try {
  const response = await fetch(url);
  if (!response.ok) {
    process.stderr.write(`Read-only live smoke failed with HTTP ${response.status}.\n`);
    process.exit(1);
  }
  process.stdout.write('Read-only live smoke passed.\n');
} catch {
  process.stderr.write('Read-only live smoke could not reach the YouTube Data API.\n');
  process.exit(1);
}
