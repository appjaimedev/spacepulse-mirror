# SpacePulse — data cache

A small, **respectful** read-only cache of selected public spaceflight data,
served as static JSON over GitHub Pages.

## Purpose

This cache exists to be a **good API citizen**. Rather than have many app
clients each call the upstream public APIs, a single scheduled job fetches the
data a few times a day — **well within the public rate limits** — and stores it
as static files. End users then read from this CDN. The result is **less load on
the upstream services**, not more.

Nothing here is private or proprietary: it mirrors already-public data, with
full attribution below.

## Update cadence

Deliberately light. Historical data is immutable, so it is fetched **once** and
never re-requested; only the present (upcoming items and the current period) is
refreshed, on a conservative schedule. A request token can be configured to use
the higher authenticated quota, but is not required.

## What is served

Everything lives under `docs/api/`:

| File | What it is |
|---|---|
| `upcoming.json` | Next ~100 launches. Includes `net_precision`, which says how much of the date is actually known — most distant launches only have a year. |
| `historical/{decade}s.json` | Immutable past launches, one file per decade, plus a `-detail.json` companion loaded on demand. |
| `astronauts.json` | People in space right now, with live time-in-space figures. |
| `astronauts-all.json` | Full catalogue (~858), refreshed weekly, without biographies. |
| `events.json` · `mars-photos.json` · `moon-photos.json` | Supporting content. |
| `launches.ics` | Subscribable calendar of launches with a confirmed date. |
| `briefings/{lang}.json` | Optional model-written mission briefings. Absent unless configured. |
| `index.json` | Counts and `generatedAt`. |

## Safeguards

This cache is the app's only data source, so a bad publish is worse than a stale
one. Two guards enforce that:

- **The builder never replaces a good file with a worse one.** An empty or
  drastically shorter list is treated as an upstream hiccup and the previous
  file is kept.
- **`scripts/verify-mirror.js` gates the commit.** It parses every served file
  and checks shape and size; if anything is off, the job fails and nothing is
  published.

## Optional: model-written briefings

`scripts/generate-briefings.js` is off unless a provider is configured, and the
app falls back to its own local templates when the files are missing. It speaks
two protocols — Anthropic's, and anything OpenAI-compatible (GitHub Models,
Gemini, Groq, OpenRouter). Configure with repository variables
`BRIEFING_PROVIDER`, `BRIEFING_BASE`, `BRIEFING_MODEL` and, where needed, the
secret `BRIEFING_API_KEY`.

## Attribution & thanks

- Launch, agency, astronaut and event data: **[The Space Devs](https://thespacedevs.com)**
  — Launch Library 2. Huge thanks for the fantastic open API. Please consider
  [supporting them on Patreon](https://www.patreon.com/TheSpaceDevs).
- Planetary imagery: **NASA** open APIs.

All data remains © its respective providers and is cached here solely for
performance and offline resilience in a hobby app. If you maintain one of these
services and have any concern, please open an issue and we'll adjust immediately.
