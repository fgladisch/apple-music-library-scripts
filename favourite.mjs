#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseCsv, requestHeaders, pickBestMatch, retryDelay, selectPending, trackKey } from './lib.mjs';

const USAGE = `Usage: node favourite.mjs [options]

Favourites (loves) every track listed in a CSV export on Apple Music.

Options:
  --csv <path>          CSV file to read (default: songs.csv)
  --report <path>       JSON report, also used to resume (default: favourite-report.json,
                        or favourite-report.dry-run.json with --dry-run)
  --storefront <code>   Catalog storefront, e.g. de or us (default: your account's storefront)
  --limit <n>           Process at most n tracks that are not done yet
  --delay <ms>          Minimum pause between requests (default: 1000)
  --no-library          Only favourite; do not also add the songs to your library
  --dry-run             Search and report matches without changing anything
  -h, --help            Show this help

Progress is saved after every track. Running the same command again skips
finished tracks and retries the failed ones.

Environment:
  APPLE_MUSIC_DEVELOPER_TOKEN   Developer token (JWT) sent as "Authorization: Bearer ..."
  APPLE_MUSIC_USER_TOKEN        Music user token sent as "Music-User-Token"
`;

const API_BASE = process.env.APPLE_MUSIC_API_BASE ?? 'https://api.music.apple.com';
const MAX_ATTEMPTS = 8;
const MAX_INTERVAL_MS = 10000;

class AppleMusic {
  constructor(developerToken, userToken, interval) {
    this.interval = interval;
    this.lastRequestAt = 0;
    this.tokens = { developerToken, userToken };
  }

  async throttle() {
    const wait = this.lastRequestAt + this.interval - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async request(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          ...requestHeaders(path, this.tokens),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        const detail = await response.text().catch(() => '');
        throw new Error(`${method} ${path} failed with ${response.status} ${response.statusText} ${detail}`.trim());
      }

      if (response.status === 429) {
        // Stay slower for the rest of the run instead of hitting the limit again.
        this.interval = Math.min(this.interval * 2 || 1000, MAX_INTERVAL_MS);
      }
      const delay = retryDelay(attempt, response.headers.get('retry-after'));
      console.log(`  … ${response.status} from Apple Music, retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }

  async storefront() {
    const result = await this.request('GET', '/v1/me/storefront');
    return result.data[0].id;
  }

  async searchSongs(storefront, term) {
    const query = new URLSearchParams({ term, types: 'songs', limit: '25' });
    const result = await this.request('GET', `/v1/catalog/${storefront}/search?${query}`);
    return result?.results?.songs?.data ?? [];
  }

  love(songId) {
    return this.request('PUT', `/v1/me/ratings/songs/${encodeURIComponent(songId)}`, {
      type: 'rating',
      attributes: { value: 1 },
    });
  }

  addToLibrary(songIds) {
    const query = new URLSearchParams({ 'ids[songs]': songIds.join(',') });
    return this.request('POST', `/v1/me/library?${query}`);
  }
}

async function findSong(api, storefront, entry) {
  const terms = [`${entry.artist} ${entry.title}`];
  const stripped = entry.title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== entry.title) {
    terms.push(`${entry.artist} ${stripped}`);
  }
  terms.push(entry.title);

  for (const term of terms) {
    const match = pickBestMatch(entry, await api.searchSongs(storefront, term));
    if (match) return match;
  }
  return null;
}

async function loadRecords(path, dryRun) {
  let report;
  try {
    report = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  if (report.dryRun !== dryRun) {
    throw new Error(`${path} was written by a ${report.dryRun ? 'dry' : 'real'} run; pass a different --report path.`);
  }
  return new Map((report.tracks ?? []).map((record) => [trackKey(record), record]));
}

async function saveReport(path, report) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, path);
}

function summarize(records) {
  const counts = {};
  for (const record of records.values()) counts[record.status] = (counts[record.status] ?? 0) + 1;
  return counts;
}

async function main() {
  const { values } = parseArgs({
    options: {
      csv: { type: 'string', default: 'songs.csv' },
      report: { type: 'string' },
      storefront: { type: 'string' },
      limit: { type: 'string' },
      delay: { type: 'string', default: '1000' },
      'no-library': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const developerToken = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  const userToken = process.env.APPLE_MUSIC_USER_TOKEN;
  if (!developerToken || !userToken) {
    console.error('Missing APPLE_MUSIC_DEVELOPER_TOKEN or APPLE_MUSIC_USER_TOKEN.\n');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  const delay = Number(values.delay);
  if (!(limit > 0) || !(delay >= 0)) {
    console.error('--limit must be a positive number and --delay a non-negative number of milliseconds.');
    process.exitCode = 1;
    return;
  }

  const dryRun = values['dry-run'];
  const addToLibrary = !values['no-library'];
  const reportPath = values.report ?? (dryRun ? 'favourite-report.dry-run.json' : 'favourite-report.json');

  const { entries, skipped } = parseCsv(await readFile(values.csv, 'utf8'));
  const records = await loadRecords(reportPath, dryRun);
  const pending = selectPending(entries, records, { dryRun, addToLibrary, limit });
  const api = new AppleMusic(developerToken, userToken, delay);
  const storefront = values.storefront ?? (await api.storefront());

  // Songs already favourited earlier, so a second CSV row for the same song needs no request.
  const doneSongIds = new Set(
    [...records.values()]
      .filter((record) => record.status === 'favourited' && (!addToLibrary || record.addedToLibrary))
      .map((record) => record.songId),
  );

  const save = () =>
    saveReport(reportPath, {
      storefront,
      dryRun,
      updatedAt: new Date().toISOString(),
      summary: summarize(records),
      tracks: [...records.values()],
      skipped,
    });

  console.log(
    `${entries.length} tracks in ${values.csv}, ${records.size} already in ${reportPath}, `
      + `processing ${pending.length} (storefront: ${storefront}${dryRun ? ', dry run' : ''})`,
  );

  for (const [index, entry] of pending.entries()) {
    const label = `[${index + 1}/${pending.length}] ${entry.artist} – ${entry.title}`;
    const key = trackKey(entry);
    const previous = records.get(key);
    const record = { ...entry };

    try {
      const song = previous?.songId
        ? { id: previous.songId, attributes: previous.song }
        : await findSong(api, storefront, entry);
      if (!song) {
        record.status = 'unmatched';
        console.log(`✗ ${label}: no match`);
      } else {
        const { name, artistName, albumName, url } = song.attributes;
        Object.assign(record, { songId: song.id, song: { name, artistName, albumName, url } });
        const target = `${artistName} – ${name} (${albumName})`;

        if (dryRun) {
          record.status = 'matched';
          console.log(`? ${label} → ${target}`);
        } else if (doneSongIds.has(song.id)) {
          Object.assign(record, { status: 'favourited', addedToLibrary: addToLibrary });
          console.log(`= ${label}: same song as an earlier row`);
        } else {
          await api.love(song.id);
          record.status = 'favourited';
          record.addedToLibrary = false;
          if (addToLibrary) {
            await api.addToLibrary([song.id]);
            record.addedToLibrary = true;
          }
          doneSongIds.add(song.id);
          console.log(`♥ ${label} → ${target}`);
        }
      }
    } catch (error) {
      // Keep what we learned (e.g. the matched song) so a retry can skip the search.
      Object.assign(record, { status: 'failed', error: error.message });
      console.log(`! ${label}: ${error.message}`);
    }

    records.set(key, record);
    await save();
  }

  if (pending.length === 0) await save();

  const counts = summarize(records);
  console.log(`\n${Object.entries(counts).map(([status, count]) => `${status}: ${count}`).join(', ') || 'nothing to do'}`);
  console.log(`Skipped rows without a title: ${skipped.length}. Report: ${reportPath}`);
  if (counts.failed) {
    console.log('Run the same command again to retry the failed tracks.');
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
