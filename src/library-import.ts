import { readFile, rename, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { AppleMusic, type CatalogType } from "./apple-music.ts";
import {
  type CatalogResource,
  type Entry,
  type SkippedRow,
  type Status,
  type Tokens,
  errorMessage,
  parseCsv,
  pickBestMatch,
  searchTerms,
  selectPending,
  trackKey,
} from "./lib.ts";

export type ImportKind = {
  type: CatalogType;
  command: string;
  defaultCsv: string;
  reportName: string;
  singular: string;
  plural: string;
};

export const SONGS: ImportKind = {
  type: "songs",
  command: "favourite",
  defaultCsv: "favourite.csv",
  reportName: "favourite-report",
  singular: "song",
  plural: "tracks",
};

export const ALBUMS: ImportKind = {
  type: "albums",
  command: "import-albums",
  defaultCsv: "albums.csv",
  reportName: "albums-report",
  singular: "album",
  plural: "albums",
};

type MatchSummary = NonNullable<CatalogResource["attributes"]>;

type ImportRecord = Entry & {
  status: Status;
  id?: string;
  match?: MatchSummary;
  addedToLibrary?: boolean;
  error?: string;
};

type Report = {
  storefront: string;
  dryRun: boolean;
  updatedAt: string;
  summary: Partial<Record<Status, number>>;
  items: ImportRecord[];
  skipped: SkippedRow[];
};

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
  kind: ImportKind;
  api: AppleMusic;
  storefront: string;
  dryRun: boolean;
  addToLibrary: boolean;
  // Items already favourited earlier, so a second CSV row for the same item needs no request.
  doneIds: Set<string>;
};

function usage({ command, defaultCsv, reportName, plural, type }: ImportKind) {
  return `Usage: pnpm ${command} [options]

Favourites (loves) every ${type === "songs" ? "track" : "album"} listed in a CSV export on Apple Music
and adds it to your library.

Options:
  --csv <path>          CSV file to read (default: ${defaultCsv})
  --report <path>       JSON report, also used to resume (default: ${reportName}.json,
                        or ${reportName}.dry-run.json with --dry-run)
  --storefront <code>   Catalog storefront, e.g. de or us (default: your account's storefront)
  --limit <n>           Process at most n ${plural} that are not done yet
  --delay <ms>          Minimum pause between requests (default: 1000)
  --no-library          Only favourite; do not also add the ${type} to your library
  --dry-run             Search and report matches without changing anything
  -h, --help            Show this help

Progress is saved after every row. Running the same command again skips
finished ${plural} and retries the failed ones.

Environment:
  APPLE_MUSIC_DEVELOPER_TOKEN   Developer token (JWT) sent as "Authorization: Bearer ..."
  APPLE_MUSIC_USER_TOKEN        Music user token sent as "Music-User-Token"
`;
}

function readOptions(
  kind: ImportKind,
  args: string[],
  env: NodeJS.ProcessEnv,
): Options | number {
  const { values } = parseArgs({
    args,
    options: {
      csv: { type: "string", default: kind.defaultCsv },
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
    console.log(usage(kind));
    return 0;
  }

  const developerToken = env.APPLE_MUSIC_DEVELOPER_TOKEN;
  const userToken = env.APPLE_MUSIC_USER_TOKEN;
  if (!developerToken || !userToken) {
    console.error(
      "Missing APPLE_MUSIC_DEVELOPER_TOKEN or APPLE_MUSIC_USER_TOKEN.\n",
    );
    console.error(usage(kind));
    return 1;
  }

  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  const delay = Number(values.delay);
  if (!(limit > 0) || !(delay >= 0)) {
    console.error(
      "--limit must be a positive number and --delay a non-negative number of milliseconds.",
    );
    return 1;
  }

  const dryRun = values["dry-run"];
  return {
    csv: values.csv,
    reportPath:
      values.report ?? `${kind.reportName}${dryRun ? ".dry-run" : ""}.json`,
    storefront: values.storefront,
    limit,
    delay,
    addToLibrary: !values["no-library"],
    dryRun,
    tokens: { developerToken, userToken },
  };
}

async function find(run: Run, entry: Entry) {
  for (const term of searchTerms(entry)) {
    const results = await run.api.search(run.storefront, run.kind.type, term);
    const match = pickBestMatch(entry, results);
    if (match) return match;
  }
  return null;
}

async function loadRecords(path: string, dryRun: boolean) {
  let report: Partial<Report>;
  try {
    report = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Map<string, ImportRecord>();
    }
    throw error;
  }
  if (report.dryRun !== dryRun) {
    throw new Error(
      `${path} was written by a ${report.dryRun ? "dry" : "real"} run; pass a different --report path.`,
    );
  }
  return new Map(
    (report.items ?? []).map((record) => [trackKey(record), record]),
  );
}

async function saveReport(path: string, report: Report) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, path);
}

function summarize(records: ReadonlyMap<string, ImportRecord>) {
  const counts: Partial<Record<Status, number>> = {};
  for (const record of records.values())
    counts[record.status] = (counts[record.status] ?? 0) + 1;
  return counts;
}

function describe({ name, artistName, albumName }: MatchSummary) {
  const target = `${artistName} – ${name}`;
  return albumName ? `${target} (${albumName})` : target;
}

async function processEntry(
  run: Run,
  entry: Entry,
  previous: ImportRecord | undefined,
  label: string,
): Promise<ImportRecord> {
  const { kind, api } = run;
  let record: ImportRecord = { ...entry, status: "unmatched" };

  try {
    const resource: CatalogResource | null = previous?.id
      ? { id: previous.id, attributes: previous.match }
      : await find(run, entry);
    if (!resource) {
      console.log(`✗ ${label}: no match`);
      return record;
    }

    const { name, artistName, albumName, url } = resource.attributes ?? {};
    const match = { name, artistName, albumName, url };
    record = { ...record, id: resource.id, match };
    const target = describe(match);

    if (run.dryRun) {
      console.log(`? ${label} → ${target}`);
      return { ...record, status: "matched" };
    }
    if (run.doneIds.has(resource.id)) {
      console.log(`= ${label}: same ${kind.singular} as an earlier row`);
      return {
        ...record,
        status: "favourited",
        addedToLibrary: run.addToLibrary,
      };
    }

    await api.love(kind.type, resource.id);
    record = { ...record, status: "favourited", addedToLibrary: false };
    if (run.addToLibrary) {
      await api.addToLibrary(kind.type, [resource.id]);
      record.addedToLibrary = true;
    }
    run.doneIds.add(resource.id);
    console.log(`♥ ${label} → ${target}`);
    return record;
  } catch (error) {
    // Keep what we learned (e.g. the match) so a retry can skip the search.
    console.log(`! ${label}: ${errorMessage(error)}`);
    return { ...record, status: "failed", error: errorMessage(error) };
  }
}

export async function runImport(
  kind: ImportKind,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const options = readOptions(kind, args, env);
  if (typeof options === "number") return options;
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
    kind,
    api,
    storefront,
    dryRun,
    addToLibrary,
    doneIds: new Set(
      [...records.values()]
        .filter(
          (record) =>
            record.status === "favourited" &&
            (!addToLibrary || record.addedToLibrary),
        )
        .flatMap((record) => (record.id ? [record.id] : [])),
    ),
  };

  const save = () =>
    saveReport(reportPath, {
      storefront,
      dryRun,
      updatedAt: new Date().toISOString(),
      summary: summarize(records),
      items: [...records.values()],
      skipped,
    });

  console.log(
    `${entries.length} ${kind.plural} in ${csv}, ${records.size} already in ${reportPath}, ` +
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
    console.log(
      `Run the same command again to retry the failed ${kind.plural}.`,
    );
    return 1;
  }
  return 0;
}
