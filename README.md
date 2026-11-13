# Apple Music library scripts

Scripts that bring an exported music library into Apple Music.

- `pnpm favourite` favourites (loves) every track in `favourite.csv` and also adds it to your library, as the Music app does by default.

The CSV files are exports from [TuneMyMusic](https://www.tunemymusic.com/). Export your liked songs from the source service as a CSV file and save it as `favourite.csv` in the project root.

The track names in a YouTube export look like `Artist · Writer · Writer - Title`, so the script uses the first artist and the title to search the Apple Music catalog. When the `Artist name` column is filled, it uses that instead. It only uses a result when both the artist and the title match. Duplicate rows are processed once.

## Requirements

- Node.js 24 or newer and [pnpm](https://pnpm.io/)
- Two Apple Music API tokens:
  - `APPLE_MUSIC_DEVELOPER_TOKEN`: a developer token (JWT)
  - `APPLE_MUSIC_USER_TOKEN`: your Music user token

Install the dependencies with `pnpm install`.

### Getting the tokens from the web player

If you don't have an Apple Developer account, take both tokens from your browser:

1. Sign in at <https://music.apple.com>.
2. Open the developer tools, go to the **Network** tab, and click around so that requests to `amp-api.music.apple.com` appear.
3. Open one of those requests and copy these request headers:
   - `authorization: Bearer <token>` → the developer token (with or without the `Bearer ` prefix)
   - `media-user-token: <token>` → this is the user token

These tokens expire after a while. If you get `401` or `403` errors, copy them again. If they still fail, point the script at the web player's API host with `APPLE_MUSIC_API_BASE=https://amp-api.music.apple.com`.

## Usage

Put both tokens in a `.env` file in the project root. The scripts load it automatically:

```sh
APPLE_MUSIC_DEVELOPER_TOKEN=...
APPLE_MUSIC_USER_TOKEN=...
```

```sh
# Check the matches first; nothing is changed
pnpm favourite --dry-run

# Favourite everything and add it to the library
pnpm favourite
```

Options:

| Option                | Description                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--csv <path>`        | CSV file to read (default `favourite.csv`)                                                                              |
| `--report <path>`     | JSON report, also used to resume (default `favourite-report.json`, or `favourite-report.dry-run.json` with `--dry-run`) |
| `--storefront <code>` | Catalog country, e.g. `de` (default: your account's storefront)                                                         |
| `--limit <n>`         | Process at most `n` tracks that aren't done yet, e.g. `--limit 3` to try a few first                                    |
| `--delay <ms>`        | Minimum pause between requests (default `1000`)                                                                         |
| `--no-library`        | Only favourite; don't add the songs to the library                                                                      |
| `--dry-run`           | Search and report without changing anything                                                                             |

The report is saved after every track. For each track it records the Apple Music song chosen and a status: `favourited`, `matched` (dry run), `unmatched`, or `failed`. Rows that couldn't be parsed (for example `Loathe`, which has no title) are listed under `skipped`.

Running the same command again resumes: it skips finished and unmatched tracks and retries failed ones. When Apple Music rate-limits the script, it waits, retries, and slows down for the rest of the run.

## Development

```sh
pnpm test         # unit tests
pnpm typecheck    # TypeScript
pnpm lint         # ESLint, with fixes
pnpm format       # Prettier
```

A Husky pre-commit hook runs ESLint and Prettier on the staged files and type-checks the project.
