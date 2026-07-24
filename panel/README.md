# panel — observability UI for the events-pl pipeline

Angular 22 + Taiga UI 5, standalone components, signals (`httpResource`, `linkedSignal`),
strict TypeScript + strict templates, ESLint (angular-eslint), Prettier.

Reads `runs.json`, `events.json`, `sources.json` at runtime from
`raw.githubusercontent.com/Mackie-pl/events-pl/main` (public repo, CORS-friendly, ~5 min CDN
cache) — no backend, hostable on any static host.

## Pages

| route                          | view                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `/`                            | day overview: latest run stats, status breakdown, pipeline errors, run history (~2 days kept)     |
| `/run/:startedAt`              | all source runs of one pipeline run: sortable/filterable table with full per-source metrics       |
| `/run/:startedAt/source/:id`   | one source: fetch/LLM/geo details, followups, extracted events + live iframe preview on the right |

Notes: hash-based routing (`/#/run/...`) so deep links work on GitHub Pages; per-run events
aren't stored by the pipeline, so the source page always shows events from the latest
`events.json` (flagged in the UI when viewing an older run); many sites send
`X-Frame-Options` — the preview pane then stays blank, use the "Open" button.

## Commands

```bash
npm install
npm start                                        # dev server, http://localhost:4200
npm run build -- --base-href /events-pl/panel/   # production build (as used by CI)
npm run lint                                     # eslint
npm run format                                   # prettier
```

## Deployment

`.github/workflows/deploy-pages.yml` builds the panel on every push to `main` and publishes
GitHub Pages: the events frontend + data JSONs at the root, the panel under `/panel/`.

One-time setup: repo **Settings → Pages → Source: “GitHub Actions”**.

Live at: `https://mackie-pl.github.io/events-pl/panel/`
