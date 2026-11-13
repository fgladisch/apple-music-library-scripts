function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

export function normalize(value) {
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return normalized || value.trim().toLowerCase();
}

export function baseTitle(title) {
  return normalize(
    title
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/\s+-\s+.*$/, '')
      .trim() || title,
  );
}

function readColumns(headerLine) {
  const header = splitCsvLine(headerLine).map((name) => name.trim().toLowerCase());
  const track = header.indexOf('track name');
  return { count: header.length, track: track === -1 ? 0 : track, artist: header.indexOf('artist name') };
}

function parseRow(line, columns) {
  const fields = splitCsvLine(line);
  // Titles may contain unquoted commas; any surplus fields belong to the track name.
  const extra = Math.max(0, fields.length - columns.count);
  const trackName = fields.slice(columns.track, columns.track + extra + 1).join(',').trim();
  const artistIndex = columns.artist > columns.track ? columns.artist + extra : columns.artist;
  const artistColumn = artistIndex === -1 ? '' : (fields[artistIndex] ?? '').trim();

  if (artistColumn) {
    return { raw: trackName, artist: artistColumn, title: trackName };
  }

  // Exported YouTube likes look like "Artist · Writer · Writer - Title".
  const separator = trackName.indexOf(' - ');
  if (separator === -1) return { raw: trackName, artist: '', title: '' };

  const artist = trackName.slice(0, separator).split(' · ')[0].trim();
  const title = trackName.slice(separator + 3).trim();
  return { raw: trackName, artist, title };
}

export function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const columns = readColumns(lines[0] ?? '');
  const entries = [];
  const skipped = [];
  const seen = new Set();

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const row = parseRow(line, columns);
    if (!row.artist || !row.title) {
      skipped.push({ raw: row.raw, reason: 'could not determine artist and title' });
      continue;
    }
    const key = trackKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(row);
  }

  return { entries, skipped };
}

function artistMatches(wanted, actual) {
  const a = normalize(wanted);
  const b = normalize(actual);
  return a === b || b.includes(a) || a.includes(b);
}

export function pickBestMatch(entry, songs) {
  const exactTitle = normalize(entry.title);
  const looseTitle = baseTitle(entry.title);
  let best = null;
  let bestScore = 0;

  for (const song of songs) {
    const { name = '', artistName = '' } = song.attributes ?? {};
    if (!artistMatches(entry.artist, artistName)) continue;

    let score = 0;
    if (normalize(name) === exactTitle) score = 3;
    else if (baseTitle(name) === looseTitle) score = 2;

    if (score > bestScore) {
      best = song;
      bestScore = score;
    }
  }

  return best;
}

export function authorizationHeader(developerToken) {
  return `Bearer ${developerToken.trim().replace(/^bearer\s+/i, '')}`;
}

export function trackKey(entry) {
  return `${normalize(entry.artist)}|${normalize(entry.title)}`;
}

function isDone(record, { dryRun, addToLibrary }) {
  if (!record) return false;
  if (record.status === 'unmatched') return true;
  if (record.status === 'favourited') return !addToLibrary || record.addedToLibrary === true;
  return dryRun && record.status === 'matched';
}

export function selectPending(entries, records, { dryRun, addToLibrary, limit = Infinity }) {
  return entries.filter((entry) => !isDone(records.get(trackKey(entry)), { dryRun, addToLibrary })).slice(0, limit);
}

const BASE_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;

export function retryDelay(attempt, retryAfter) {
  const seconds = Number(retryAfter);
  if (retryAfter && seconds > 0) return seconds * 1000;
  return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
}

export function requestHeaders(path, { developerToken, userToken }) {
  const headers = {
    Authorization: authorizationHeader(developerToken),
    // Tokens copied from the music.apple.com web player only work with this origin.
    Origin: 'https://music.apple.com',
  };
  // Catalog requests sent with a user token count against a much stricter per-account rate limit.
  if (path.startsWith('/v1/me/')) headers['Music-User-Token'] = userToken.trim();
  return headers;
}
