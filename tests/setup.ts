import { setReadAfterWriteSleep } from '../src/youtube/read-after-write.js';

// Keep the read-after-write backoff instant in unit tests.
setReadAfterWriteSleep(async () => undefined);
