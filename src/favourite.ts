import { readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  type CatalogResource,
  type Entry,
  type SkippedRow,
  type Status,
  type Tokens,
  parseCsv,
  pickBestMatch,
  requestHeaders,
  retryDelay,
  selectPending,
  trackKey,
} from "./lib.ts";

const USAGE = `Usage: pnpm favourite [options]

Favourites (loves) every track listed in a CSV export on Apple Music.

Options:
  --csv <path>          CSV file to read (default: favourite.csv)
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

const API_BASE =
  process.env.APPLE_MUSIC_API_BASE ?? "https://api.music.apple.com";
const MAX_ATTEMPTS = 8;
const MAX_INTERVAL_MS = 10000;

type SongSummary = {
  name?: string;
  artistName?: string;
  albumName?: string;
  url?: string;
};

type TrackRecord = Entry & {
  status: Status;
  songId?: string;
  song?: SongSummary;
  addedToLibrary?: boolean;
  error?: string;
};

type Report = {
  storefront: string;
  dryRun: boolean;
  updatedAt: string;
  summary: Partial<Record<Status, number>>;
  tracks: TrackRecord[];
  skipped: SkippedRow[];
};

class AppleMusic {
  private lastRequestAt = 0;

  constructor(
    private readonly tokens: Tokens,
    private interval: number,
  ) {}

  private async throttle() {
    const wait = this.lastRequestAt + this.interval - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private async request(method: string, path: string, body?: unknown) {
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          ...requestHeaders(path, this.tokens),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `${method} ${path} failed with ${response.status} ${response.statusText} ${detail}`.trim(),
        );
      }

      if (response.status === 429) {
        // Stay slower for the rest of the run instead of hitting the limit again.
        this.interval = Math.min(this.interval * 2 || 1000, MAX_INTERVAL_MS);
      }
      const delay = retryDelay(attempt, response.headers.get("retry-after"));
      console.log(
        `  … ${response.status} from Apple Music, retrying in ${Math.round(delay / 1000)}s`,
      );
      await sleep(delay);
    }
  }

  async storefront(): Promise<string> {
    const result = await this.request("GET", "/v1/me/storefront");
    return result.data[0].id;
  }

  async searchSongs(
    storefront: string,
    term: string,
  ): Promise<CatalogResource[]> {
    const query = new URLSearchParams({ term, types: "songs", limit: "25" });
    const result = await this.request(
      "GET",
      `/v1/catalog/${storefront}/search?${query.toString()}`,
    );
    return result?.results?.songs?.data ?? [];
  }

  love(songId: string) {
    return this.request(
      "PUT",
      `/v1/me/ratings/songs/${encodeURIComponent(songId)}`,
      {
        type: "rating",
        attributes: { value: 1 },
      },
    );
  }

  addToLibrary(songIds: string[]) {
    const query = new URLSearchParams({ "ids[songs]": songIds.join(",") });
    return this.request("POST", `/v1/me/library?${query.toString()}`);
  }
}

async function findSong(api: AppleMusic, storefront: string, entry: Entry) {
  const terms = [`${entry.artist} ${entry.title}`];
  const stripped = entry.title
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function loadRecords(path: string, dryRun: boolean) {
  let report: Partial<Report>;
  try {
    report = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Map<string, TrackRecord>();
    }
    throw error;
  }
  if (report.dryRun !== dryRun) {
    throw new Error(
      `${path} was written by a ${report.dryRun ? "dry" : "real"} run; pass a different --report path.`,
    );
  }
  return new Map(
    (report.tracks ?? []).map((record) => [trackKey(record), record]),
  );
}

async function saveReport(path: string, report: Report) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, path);
}

function summarize(records: ReadonlyMap<string, TrackRecord>) {
  const counts: Partial<Record<Status, number>> = {};
  for (const record of records.values())
    counts[record.status] = (counts[record.status] ?? 0) + 1;
  return counts;
}

type Options = {
  csv: string;
  reportPath: string;
  storefront?: string;
  limit: number;
  delay: number;
  addToLibrary: boolean;
  dryRun: boolean;
  tokens: Tokens;
};

type Run = {
  api: AppleMusic;
  storefront: string;
  dryRun: boolean;
  addToLibrary: boolean;
  // Songs already favourited earlier, so a second CSV row for the same song needs no request.
  doneSongIds: Set<string>;
};

function readOptions(): Options | undefined {
  const { values } = parseArgs({
    options: {
      csv: { type: "string", default: "favourite.csv" },
      report: { type: "string" },
      storefront: { type: "string" },
      limit: { type: "string" },
      delay: { type: "string", default: "1000" },
      "no-library": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return undefined;
  }

  const developerToken = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  const userToken = process.env.APPLE_MUSIC_USER_TOKEN;
  if (!developerToken || !userToken) {
    console.error(
      "Missing APPLE_MUSIC_DEVELOPER_TOKEN or APPLE_MUSIC_USER_TOKEN.\n",
    );
    console.error(USAGE);
    process.exitCode = 1;
    return undefined;
  }

  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  const delay = Number(values.delay);
  if (!(limit > 0) || !(delay >= 0)) {
    console.error(
      "--limit must be a positive number and --delay a non-negative number of milliseconds.",
    );
    process.exitCode = 1;
    return undefined;
  }

  const dryRun = values["dry-run"];
  return {
    csv: values.csv,
    reportPath:
      values.report ??
      (dryRun ? "favourite-report.dry-run.json" : "favourite-report.json"),
    storefront: values.storefront,
    limit,
    delay,
    addToLibrary: !values["no-library"],
    dryRun,
    tokens: { developerToken, userToken },
  };
}

async function processEntry(
  run: Run,
  entry: Entry,
  previous: TrackRecord | undefined,
  label: string,
): Promise<TrackRecord> {
  let record: TrackRecord = { ...entry, status: "unmatched" };

  try {
    const song: CatalogResource | null = previous?.songId
      ? { id: previous.songId, attributes: previous.song }
      : await findSong(run.api, run.storefront, entry);
    if (!song) {
      console.log(`✗ ${label}: no match`);
      return record;
    }

    const { name, artistName, albumName, url } = song.attributes ?? {};
    record = {
      ...record,
      songId: song.id,
      song: { name, artistName, albumName, url },
    };
    const target = `${artistName} – ${name} (${albumName})`;

    if (run.dryRun) {
      console.log(`? ${label} → ${target}`);
      return { ...record, status: "matched" };
    }
    if (run.doneSongIds.has(song.id)) {
      console.log(`= ${label}: same song as an earlier row`);
      return {
        ...record,
        status: "favourited",
        addedToLibrary: run.addToLibrary,
      };
    }

    await run.api.love(song.id);
    record = { ...record, status: "favourited", addedToLibrary: false };
    if (run.addToLibrary) {
      await run.api.addToLibrary([song.id]);
      record.addedToLibrary = true;
    }
    run.doneSongIds.add(song.id);
    console.log(`♥ ${label} → ${target}`);
    return record;
  } catch (error) {
    // Keep what we learned (e.g. the matched song) so a retry can skip the search.
    console.log(`! ${label}: ${errorMessage(error)}`);
    return { ...record, status: "failed", error: errorMessage(error) };
  }
}

async function main() {
  const options = readOptions();
  if (!options) return;
  const { csv, reportPath, dryRun, addToLibrary } = options;

  const { entries, skipped } = parseCsv(await readFile(csv, "utf8"));
  const records = await loadRecords(reportPath, dryRun);
  const pending = selectPending(entries, records, {
    dryRun,
    addToLibrary,
    limit: options.limit,
  });
  const api = new AppleMusic(options.tokens, options.delay);
  const storefront = options.storefront ?? (await api.storefront());
  const run: Run = {
    api,
    storefront,
    dryRun,
    addToLibrary,
    doneSongIds: new Set(
      [...records.values()]
        .filter(
          (record) =>
            record.status === "favourited" &&
            (!addToLibrary || record.addedToLibrary),
        )
        .flatMap((record) => (record.songId ? [record.songId] : [])),
    ),
  };

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
    `${entries.length} tracks in ${csv}, ${records.size} already in ${reportPath}, ` +
      `processing ${pending.length} (storefront: ${storefront}${dryRun ? ", dry run" : ""})`,
  );

  for (const [index, entry] of pending.entries()) {
    const label = `[${index + 1}/${pending.length}] ${entry.artist} – ${entry.title}`;
    const key = trackKey(entry);
    records.set(key, await processEntry(run, entry, records.get(key), label));
    await save();
  }

  if (pending.length === 0) await save();

  const counts = summarize(records);
  console.log(
    `\n${
      Object.entries(counts)
        .map(([status, count]) => `${status}: ${count}`)
        .join(", ") || "nothing to do"
    }`,
  );
  console.log(
    `Skipped rows without a title: ${skipped.length}. Report: ${reportPath}`,
  );
  if (counts.failed) {
    console.log("Run the same command again to retry the failed tracks.");
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`Error: ${errorMessage(error)}`);
  process.exitCode = 1;
}
