# Apple Music favourite script

Favourites (loves) every track in `songs.csv` on Apple Music and also adds it to your library, as the Music app does by default.

The CSV's track names look like `Artist · Writer · Writer - Title`, so the script uses the first artist and the title to search the Apple Music catalog. It only uses a result when both the artist and the title match. Duplicate rows are processed once.

## Requirements

- Node.js 20 or newer (no dependencies)
- Two Apple Music API tokens:
  - `APPLE_MUSIC_DEVELOPER_TOKEN`: a developer token (JWT)
  - `APPLE_MUSIC_USER_TOKEN`: your Music user token

### Getting the tokens from the web player

If you don't have an Apple Developer account, take both tokens from your browser:

1. Sign in at <https://music.apple.com>.
2. Open the developer tools, go to the **Network** tab, and click around so that requests to `amp-api.music.apple.com` appear.
3. Open one of those requests and copy these request headers:
   - `authorization: Bearer <token>` → the developer token (with or without the `Bearer ` prefix)
   - `media-user-token: <token>` → this is the user token

These tokens expire after a while. If you get `401` or `403` errors, copy them again. If they still fail, point the script at the web player's API host with `APPLE_MUSIC_API_BASE=https://amp-api.music.apple.com`.

## Usage

```sh
export APPLE_MUSIC_DEVELOPER_TOKEN='...'
export APPLE_MUSIC_USER_TOKEN='...'

# Check the matches first; nothing is changed
node favourite.mjs --dry-run

# Favourite everything and add it to the library
node favourite.mjs
```

You can also put both variables in a `.env` file and run `node --env-file=.env favourite.mjs`.

Options:

| Option | Description |
| --- | --- |
| `--csv <path>` | CSV file to read (default `songs.csv`) |
| `--report <path>` | JSON report, also used to resume (default `favourite-report.json`, or `favourite-report.dry-run.json` with `--dry-run`) |
| `--storefront <code>` | Catalog country, e.g. `de` (default: your account's storefront) |
| `--limit <n>` | Process at most `n` tracks that aren't done yet, e.g. `--limit 3` to try a few first |
| `--delay <ms>` | Minimum pause between requests (default `1000`) |
| `--no-library` | Only favourite; don't add the songs to the library |
| `--dry-run` | Search and report without changing anything |

The report is saved after every track. For each track it records the Apple Music song chosen and a status: `favourited`, `matched` (dry run), `unmatched`, or `failed`. Rows that couldn't be parsed (for example `Loathe`, which has no title) are listed under `skipped`.

Running the same command again resumes: it skips finished and unmatched tracks and retries failed ones. When Apple Music rate-limits the script, it waits, retries, and slows down for the rest of the run.

## Tests

```sh
npm test
```
