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
two protocols — Anthropic's, and anything OpenAI-compatible (Gemini, Groq,
OpenRouter, a local server). Configure with repository variables
`BRIEFING_PROVIDER`, `BRIEFING_BASE`, `BRIEFING_MODEL` and the secret
`BRIEFING_API_KEY` (or `ANTHROPIC_API_KEY`).

GitHub Models is **not** an option: it is being retired and answers `410
github_models_retirement_brownout` (verified 8 Aug 2026).

## Images of Solar System bodies

`img/planets/` and `img/bodies/` hold 256×256 crops used by the app's size
comparator and body cards. They are built by hand, not by the cron —
`scripts/fetch-planet-images.js` and `scripts/fetch-body-images.js`. The latter
picks from Wikimedia Commons under three rules worth keeping:

- **A declared licence or nothing.** Many NASA-looking files carry no licence
  field (PIA17485, PIA23017 expose only an author) and are rejected. "Almost
  certainly public domain" is not a licence.
- **A brightness floor.** Half of an astronomy frame is empty space; a crescent
  moon becomes a black circle at comparator size. Too-dark candidates are
  skipped in favour of the next one.
- **Trim, then fit to square**, so the body fills its circle instead of floating
  in black.

Every chosen file is recorded in `img/bodies/credits.json` with its title,
licence and author. That file is the app's source for attribution and for
whether an image is a photograph or an artist's impression — Eris, Makemake and
Haumea have no photograph in existence, and the app says so rather than passing
a rendering off as one.

## Attribution & thanks

- Launch, agency, astronaut and event data: **[The Space Devs](https://thespacedevs.com)**
  — Launch Library 2. Huge thanks for the fantastic open API. Please consider
  [supporting them on Patreon](https://www.patreon.com/TheSpaceDevs).
- Planetary imagery: **NASA** open APIs.

All data remains © its respective providers and is cached here solely for
performance and offline resilience in a hobby app. If you maintain one of these
services and have any concern, please open an issue and we'll adjust immediately.
