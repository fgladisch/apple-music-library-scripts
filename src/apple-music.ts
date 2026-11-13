import { setTimeout as sleep } from "node:timers/promises";
import {
  type CatalogResource,
  type Tokens,
  requestHeaders,
  retryDelay,
} from "./lib.ts";

export type CatalogType = "songs" | "albums";

const API_BASE =
  process.env.APPLE_MUSIC_API_BASE ?? "https://api.music.apple.com";
const MAX_ATTEMPTS = 8;
const MAX_INTERVAL_MS = 10000;

export class AppleMusic {
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

  async search(
    storefront: string,
    type: CatalogType,
    term: string,
  ): Promise<CatalogResource[]> {
    const query = new URLSearchParams({ term, types: type, limit: "25" });
    const result = await this.request(
      "GET",
      `/v1/catalog/${storefront}/search?${query.toString()}`,
    );
    return result?.results?.[type]?.data ?? [];
  }

  love(type: CatalogType, id: string) {
    return this.request(
      "PUT",
      `/v1/me/ratings/${type}/${encodeURIComponent(id)}`,
      {
        type: "rating",
        attributes: { value: 1 },
      },
    );
  }

  addToLibrary(type: CatalogType, ids: string[]) {
    const query = new URLSearchParams({ [`ids[${type}]`]: ids.join(",") });
    return this.request("POST", `/v1/me/library?${query.toString()}`);
  }
}
