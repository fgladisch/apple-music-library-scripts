import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Progress,
  authorizationHeader,
  parseCsv,
  pickBestMatch,
  requestHeaders,
  retryDelay,
  selectPending,
  trackKey,
} from "./lib.ts";

const song = (id: string, name: string, artistName: string) => ({
  id,
  type: "songs",
  attributes: { name, artistName },
});

test("parseCsv extracts primary artist and title from the track name column", () => {
  const csv = [
    "\uFEFFTrack name,Artist name,Album,Playlist name,Type",
    "Sunborn · Lino Chesnel · Leon Schmidt - Glacier,,,Liked videos,MySavedTracks",
    "Loathe - P.U.R.P.L.E.,,,Liked videos,MySavedTracks",
    "KennyHoopla · Travis Barker - 9-5 (love me) //,,,Liked videos,MySavedTracks",
    "",
  ].join("\n");

  assert.deepEqual(
    parseCsv(csv).entries.map(({ artist, title }) => ({ artist, title })),
    [
      { artist: "Sunborn", title: "Glacier" },
      { artist: "Loathe", title: "P.U.R.P.L.E." },
      { artist: "KennyHoopla", title: "9-5 (love me) //" },
    ],
  );
});

test("parseCsv keeps unquoted commas that belong to the title", () => {
  const csv =
    "Track name,Artist name,Album,Playlist name,Type\n" +
    "Have Heart - No Roses, No Skies,,,Liked videos,MySavedTracks\n" +
    "Viva Belgrado · Cándido Gálvez Medrán - Por la Mañana, Temprano,,,Liked videos,MySavedTracks\n";

  assert.deepEqual(
    parseCsv(csv).entries.map(({ artist, title }) => ({ artist, title })),
    [
      { artist: "Have Heart", title: "No Roses, No Skies" },
      { artist: "Viva Belgrado", title: "Por la Mañana, Temprano" },
    ],
  );
});

test("parseCsv uses the Artist name column when it is filled", () => {
  const csv =
    "Track name,Artist name,Album,Playlist name,Type\n" +
    '"Song, With Comma",Some Band,Some Album,Liked,MySavedTracks\n';

  const [entry] = parseCsv(csv).entries;
  assert.equal(entry.artist, "Some Band");
  assert.equal(entry.title, "Song, With Comma");
});

test("parseCsv drops duplicates and reports lines without a title", () => {
  const csv =
    "Track name,Artist name,Album,Playlist name,Type\n" +
    "Glare · Toni Ordaz - Bloom,,,Liked videos,MySavedTracks\n" +
    "Glare · Jes Morales - Bloom,,,Liked videos,MySavedTracks\n" +
    "Loathe,,,Liked videos,MySavedTracks\n";

  const { entries, skipped } = parseCsv(csv);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    skipped.map((s) => s.raw),
    ["Loathe"],
  );
});

test("pickBestMatch prefers an exact title by the same artist", () => {
  const songs = [
    song("1", "Void In Blue", "Glare"),
    song("2", "Void In Blue (2023 Remaster)", "Glare"),
    song("3", "Void In Blue (2023 Remaster)", "Someone Else"),
  ];
  assert.equal(
    pickBestMatch(
      { artist: "Glare", title: "Void In Blue (2023 Remaster)" },
      songs,
    )?.id,
    "2",
  );
});

test("pickBestMatch ignores case, accents, and version suffixes when no exact title exists", () => {
  const songs = [
    song("1", "Baltica", "Viva Belgrado"),
    song("2", "Höstsonaten", "Viva Belgrado"),
  ];
  assert.equal(
    pickBestMatch({ artist: "Viva Belgrado", title: "Höstsonaten" }, songs)?.id,
    "2",
  );
  assert.equal(
    pickBestMatch({ artist: "VIVA BELGRADO", title: "Báltica" }, songs)?.id,
    "1",
  );
  assert.equal(
    pickBestMatch({ artist: "Amenra", title: "Ogentroost" }, [
      song("9", "Ogentroost - Single Version", "AMENRA"),
    ])?.id,
    "9",
  );
});

test("pickBestMatch accepts artist names that contain each other", () => {
  const songs = [song("1", "Gravity", "Novelists")];
  assert.equal(
    pickBestMatch({ artist: "Novelists FR", title: "Gravity" }, songs)?.id,
    "1",
  );
});

test("pickBestMatch returns null when no song matches both artist and title", () => {
  const songs = [
    song("1", "Glacier", "Other Band"),
    song("2", "Nebula", "Sunborn"),
  ];
  assert.equal(
    pickBestMatch({ artist: "Sunborn", title: "Glacier" }, songs),
    null,
  );
});

test('authorizationHeader accepts a developer token with or without a copied "Bearer " prefix', () => {
  assert.equal(authorizationHeader("abc.def.ghi"), "Bearer abc.def.ghi");
  assert.equal(authorizationHeader("Bearer abc.def.ghi"), "Bearer abc.def.ghi");
  assert.equal(
    authorizationHeader("  bearer   abc.def.ghi \n"),
    "Bearer abc.def.ghi",
  );
});

test("parseCsv finds columns by header name in fully quoted exports with extra columns", () => {
  const csv =
    "\uFEFFTrack name,Artist name,Album,Playlist name,Type,ISRC\n" +
    '"Bury Tomorrow - Black Flame","","","Liked videos","Favorite",""\n' +
    '"Have Heart - No Roses, No Skies","","","Liked videos","Favorite",""\n' +
    '"Weather Eye","Half Me","","Liked videos","Favorite","GBXXX0000001"\n';

  assert.deepEqual(
    parseCsv(csv).entries.map(({ artist, title }) => ({ artist, title })),
    [
      { artist: "Bury Tomorrow", title: "Black Flame" },
      { artist: "Have Heart", title: "No Roses, No Skies" },
      { artist: "Half Me", title: "Weather Eye" },
    ],
  );
});

const entry = (artist: string, title: string) => ({
  raw: `${artist} - ${title}`,
  artist,
  title,
});

test("trackKey treats spelling variants of the same track as one key", () => {
  assert.equal(
    trackKey(entry("AMENRA", "Báltica")),
    trackKey(entry("Amenra", "Baltica")),
  );
  assert.notEqual(
    trackKey(entry("Amenra", "Baltica")),
    trackKey(entry("Amenra", "Forlorn")),
  );
});

test("selectPending skips finished tracks, retries failed ones, and honours the limit", () => {
  const entries = [
    entry("A", "Favourited"),
    entry("A", "Unmatched"),
    entry("A", "Failed"),
    entry("A", "New one"),
    entry("A", "New two"),
  ];
  const records = new Map<string, Progress>([
    [trackKey(entries[0]), { status: "favourited", addedToLibrary: true }],
    [trackKey(entries[1]), { status: "unmatched" }],
    [trackKey(entries[2]), { status: "failed" }],
  ]);
  const options = { dryRun: false, addToLibrary: true };

  assert.deepEqual(
    selectPending(entries, records, options).map((e) => e.title),
    ["Failed", "New one", "New two"],
  );
  assert.deepEqual(
    selectPending(entries, records, { ...options, limit: 2 }).map(
      (e) => e.title,
    ),
    ["Failed", "New one"],
  );
});

test("selectPending redoes favourited tracks that still need adding to the library", () => {
  const entries = [entry("A", "Loved only")];
  const records = new Map<string, Progress>([
    [trackKey(entries[0]), { status: "favourited", addedToLibrary: false }],
  ]);

  assert.equal(
    selectPending(entries, records, { dryRun: false, addToLibrary: true })
      .length,
    1,
  );
  assert.equal(
    selectPending(entries, records, { dryRun: false, addToLibrary: false })
      .length,
    0,
  );
});

test("selectPending treats matched tracks as finished only in a dry run", () => {
  const entries = [entry("A", "Matched")];
  const records = new Map<string, Progress>([
    [trackKey(entries[0]), { status: "matched" }],
  ]);

  assert.equal(
    selectPending(entries, records, { dryRun: true, addToLibrary: true })
      .length,
    0,
  );
  assert.equal(
    selectPending(entries, records, { dryRun: false, addToLibrary: true })
      .length,
    1,
  );
});

test("retryDelay honours Retry-After and otherwise backs off exponentially up to a minute", () => {
  assert.equal(retryDelay(1, "7"), 7000);
  assert.equal(retryDelay(1, null), 5000);
  assert.equal(retryDelay(2, ""), 10000);
  assert.equal(retryDelay(4, "not-a-number"), 40000);
  assert.equal(retryDelay(10, null), 60000);
});

test("requestHeaders sends the user token only to /v1/me endpoints", () => {
  const tokens = { developerToken: "Bearer dev", userToken: " user \n" };

  assert.deepEqual(requestHeaders("/v1/catalog/de/search?term=x", tokens), {
    Authorization: "Bearer dev",
    Origin: "https://music.apple.com",
  });
  assert.deepEqual(requestHeaders("/v1/me/ratings/songs/1", tokens), {
    Authorization: "Bearer dev",
    Origin: "https://music.apple.com",
    "Music-User-Token": "user",
  });
});
