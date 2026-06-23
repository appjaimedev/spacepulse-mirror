# SpacePulse data mirror

Static JSON mirror of [The Space Devs Launch Library 2](https://thespacedevs.com)
for the **SpacePulse: Mission Control** app, served over the GitHub Pages CDN.

## Why

The LL2 public API allows **15 requests/hour per IP** anonymously. Instead of
every app user hitting LL2 directly, a scheduled GitHub Action pulls the data a
few times a day (within that budget) and writes static JSON here. The app reads
those files from the CDN — effectively **unlimited reads for users**, with the
15 req/h spent only by this one cron.

This repo contains **no app source code** — only the data generator and the
mirrored public data.

## Endpoints

Base: `https://appjaimedev.github.io/spacepulse-mirror/api/`

| File | Contents |
|------|----------|
| `upcoming.json` | Next launches (detailed) |
| `historical/<decade>s.json` | Past launches per decade (1950s → now) |
| `astronauts.json` | People currently in space |
| `events.json` | Upcoming space events (EVAs, dockings…) |
| `mars-photos.json` | Latest Mars rover photo URLs |
| `index.json` | Manifest (counts, generation time) |

## Build modes

```bash
npm run upcoming   # only upcoming.json (cheap, frequent)
npm run backfill   # builds the oldest missing decade (one per run)
npm run build      # current decade + astronauts + events + Mars
npm run full       # all decades at once (needs LL2_TOKEN to be quick)
```

The Action runs `upcoming` every 20 min, `backfill` hourly (until 1957→now is
complete), and the full `build` daily. Set an optional `LL2_TOKEN` repo secret
to raise the cron to 1000 req/h.

Data © The Space Devs, NASA. Mirrored for performance.
