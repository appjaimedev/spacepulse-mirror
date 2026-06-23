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

## Attribution & thanks

- Launch, agency, astronaut and event data: **[The Space Devs](https://thespacedevs.com)**
  — Launch Library 2. Huge thanks for the fantastic open API. Please consider
  [supporting them on Patreon](https://www.patreon.com/TheSpaceDevs).
- Planetary imagery: **NASA** open APIs.

All data remains © its respective providers and is cached here solely for
performance and offline resilience in a hobby app. If you maintain one of these
services and have any concern, please open an issue and we'll adjust immediately.
