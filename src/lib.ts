export type Entry = { raw: string; artist: string; title: string };

export type SkippedRow = { raw: string; reason: string };

export type Status = "favourited" | "matched" | "unmatched" | "failed";

export type Progress = { status: Status; addedToLibrary?: boolean };

export type CatalogResource = {
  id: string;
  type?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    url?: string;
  };
};

export type Tokens = { developerToken: string; userToken: string };

type Columns = { count: number; track: number; artist: number };

function splitCsvLine(line: string) {
  const fields: string[] = [];
  let field = "";
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
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

export function normalize(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return normalized || value.trim().toLowerCase();
}

export function baseTitle(title: string) {
  return normalize(
    title
      .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
      .replace(/\s+-\s+.*$/, "")
      .trim() || title,
  );
}

function readColumns(headerLine: string): Columns {
  const header = splitCsvLine(headerLine).map((name) =>
    name.trim().toLowerCase(),
  );
  const track = header.indexOf("track name");
  return {
    count: header.length,
    track: track === -1 ? 0 : track,
    artist: header.indexOf("artist name"),
  };
}

function parseRow(line: string, columns: Columns): Entry {
  const fields = splitCsvLine(line);
  // Titles may contain unquoted commas; any surplus fields belong to the track name.
  const extra = Math.max(0, fields.length - columns.count);
  const trackName = fields
    .slice(columns.track, columns.track + extra + 1)
    .join(",")
    .trim();
  const artistIndex =
    columns.artist > columns.track ? columns.artist + extra : columns.artist;
  const artistColumn =
    artistIndex === -1 ? "" : (fields[artistIndex] ?? "").trim();

  if (artistColumn) {
    return { raw: trackName, artist: artistColumn, title: trackName };
  }

  // Exported YouTube likes look like "Artist · Writer · Writer - Title".
  const separator = trackName.indexOf(" - ");
  if (separator === -1) return { raw: trackName, artist: "", title: "" };

  const artist = trackName.slice(0, separator).split(" · ")[0].trim();
  const title = trackName.slice(separator + 3).trim();
  return { raw: trackName, artist, title };
}

export function parseCsv(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const columns = readColumns(lines[0] ?? "");
  const entries: Entry[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Set<string>();

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const row = parseRow(line, columns);
    if (!row.artist || !row.title) {
      skipped.push({
        raw: row.raw,
        reason: "could not determine artist and title",
      });
      continue;
    }
    const key = trackKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(row);
  }

  return { entries, skipped };
}

function artistMatches(wanted: string, actual: string) {
  const a = normalize(wanted);
  const b = normalize(actual);
  return a === b || b.includes(a) || a.includes(b);
}

export function pickBestMatch<T extends CatalogResource>(
  entry: Pick<Entry, "artist" | "title">,
  songs: readonly T[],
) {
  const exactTitle = normalize(entry.title);
  const looseTitle = baseTitle(entry.title);
  let best: T | null = null;
  let bestScore = 0;

  for (const song of songs) {
    const { name = "", artistName = "" } = song.attributes ?? {};
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

export function searchTerms({
  artist,
  title,
}: Pick<Entry, "artist" | "title">) {
  const terms = [`${artist} ${title}`];
  const stripped = title
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && stripped !== title) terms.push(`${artist} ${stripped}`);
  terms.push(title);
  return terms;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function authorizationHeader(developerToken: string) {
  return `Bearer ${developerToken.trim().replace(/^bearer\s+/i, "")}`;
}

export function trackKey(entry: Pick<Entry, "artist" | "title">) {
  return `${normalize(entry.artist)}|${normalize(entry.title)}`;
}

type PendingOptions = {
  dryRun: boolean;
  addToLibrary: boolean;
  limit?: number;
};

function isDone(
  record: Progress | undefined,
  { dryRun, addToLibrary }: PendingOptions,
) {
  if (!record) return false;
  if (record.status === "unmatched") return true;
  if (record.status === "favourited")
    return !addToLibrary || record.addedToLibrary === true;
  return dryRun && record.status === "matched";
}

export function selectPending<T extends Entry>(
  entries: readonly T[],
  records: ReadonlyMap<string, Progress>,
  { dryRun, addToLibrary, limit = Infinity }: PendingOptions,
) {
  return entries
    .filter(
      (entry) =>
        !isDone(records.get(trackKey(entry)), { dryRun, addToLibrary }),
    )
    .slice(0, limit);
}

const BASE_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;

export function retryDelay(attempt: number, retryAfter: string | null) {
  const seconds = Number(retryAfter);
  if (retryAfter && seconds > 0) return seconds * 1000;
  return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
}

export function requestHeaders(
  path: string,
  { developerToken, userToken }: Tokens,
) {
  const headers: Record<string, string> = {
    Authorization: authorizationHeader(developerToken),
    // Tokens copied from the music.apple.com web player only work with this origin.
    Origin: "https://music.apple.com",
  };
  // Catalog requests sent with a user token count against a much stricter per-account rate limit.
  if (path.startsWith("/v1/me/"))
    headers["Music-User-Token"] = userToken.trim();
  return headers;
}
