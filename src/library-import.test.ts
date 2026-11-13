import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ALBUMS, type ImportKind, SONGS, runImport } from "./library-import.ts";

const HEADER = "Track name,Artist name,Album,Playlist name,Type,ISRC";
const ENV = {
  APPLE_MUSIC_DEVELOPER_TOKEN: "dev",
  APPLE_MUSIC_USER_TOKEN: "user",
};

type CatalogItem = { id: string; name: string; artistName: string };

type SavedReport = {
  summary: Record<string, number>;
  items: {
    title: string;
    status: string;
    id?: string;
    addedToLibrary?: boolean;
  }[];
};

async function setup(
  t: TestContext,
  csvRows: string[],
  catalog: CatalogItem[],
) {
  const dir = await mkdtemp(join(tmpdir(), "library-import-"));
  const csv = join(dir, "input.csv");
  const report = join(dir, "report.json");
  await writeFile(csv, `\uFEFF${[HEADER, ...csvRows].join("\n")}\n`);

  const requests: string[] = [];
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", (input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push(
      `${init?.method} ${url.pathname}${decodeURIComponent(url.search)}`,
    );
    if (url.pathname.endsWith("/search")) {
      const type = url.searchParams.get("types") ?? "";
      const data = catalog.map(({ id, ...attributes }) => ({
        id,
        type,
        attributes,
      }));
      return Promise.resolve(Response.json({ results: { [type]: { data } } }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });

  const run = (kind: ImportKind) =>
    runImport(
      kind,
      ["--csv", csv, "--report", report, "--storefront", "de", "--delay", "0"],
      ENV,
    );
  const readReport = async (): Promise<SavedReport> =>
    JSON.parse(await readFile(report, "utf8"));
  return { requests, run, readReport };
}

test("import-albums favourites each album and adds it to the library", async (t) => {
  const { requests, run, readReport } = await setup(
    t,
    ['"Dogma","Half Me","Dogma","Favorite Albums","Album",""'],
    [
      { id: "1", name: "Dogma - Single", artistName: "Half Me" },
      { id: "2", name: "Dogma", artistName: "Half Me" },
    ],
  );

  assert.equal(await run(ALBUMS), 0);

  assert.deepEqual(requests, [
    "GET /v1/catalog/de/search?term=Half+Me+Dogma&types=albums&limit=25",
    "PUT /v1/me/ratings/albums/2",
    "POST /v1/me/library?ids[albums]=2",
  ]);
  const report = await readReport();
  assert.deepEqual(report.summary, { favourited: 1 });
  assert.deepEqual(
    report.items.map(({ title, status, id, addedToLibrary }) => ({
      title,
      status,
      id,
      addedToLibrary,
    })),
    [{ title: "Dogma", status: "favourited", id: "2", addedToLibrary: true }],
  );
});

test("favourite loves songs and adds them to the library", async (t) => {
  const { requests, run } = await setup(
    t,
    ['"Half Me - Weather Eye","","","Liked videos","Favorite",""'],
    [{ id: "7", name: "Weather Eye", artistName: "Half Me" }],
  );

  assert.equal(await run(SONGS), 0);

  assert.deepEqual(requests, [
    "GET /v1/catalog/de/search?term=Half+Me+Weather+Eye&types=songs&limit=25",
    "PUT /v1/me/ratings/songs/7",
    "POST /v1/me/library?ids[songs]=7",
  ]);
});

test("a second run skips albums that are already done", async (t) => {
  const { requests, run } = await setup(
    t,
    ['"Dogma","Half Me","Dogma","Favorite Albums","Album",""'],
    [{ id: "2", name: "Dogma", artistName: "Half Me" }],
  );

  await run(ALBUMS);
  requests.length = 0;

  assert.equal(await run(ALBUMS), 0);
  assert.deepEqual(requests, []);
});
