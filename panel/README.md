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
| `/run/:startedAt`              | all source runs of one pipeline run: sortable/filterable table, run-level decisions on top        |
| `/run/:startedAt/source/:id`   | one source: fetch/LLM/geo details, followups, **decision trail**, events + live iframe preview     |

Notes: clean paths (`/run/...`, no `#`). On GitHub Pages that works because the deploy step
copies `index.html` to `panel/404.html` — Pages serves it for any path that is not a real file,
the app boots and the router reads the URL. Drop that copy and deep links 404. Many sites send
`X-Frame-Options` — the preview pane then stays blank, use the "Open" button.

The source page reads events from `runs.json` (`SourceRun.produced`), so an older run shows what
it actually produced, including records that later lost dedupe (`merged → <source>`). Runs recorded
before that field existed fall back to filtering the latest `events.json`, flagged in the UI.

The decision trail comes from `audit.json`, which is **only fetched once you open a source page** —
it is the largest file in the set and useless on the overview.

## Reading model calls

`src/app/ui/` holds two shared pieces, used by the source page, the probe result and the discover
run:

- `app-code-view` — text as numbered lines, JSON coloured, **wrap / no-wrap toggle** in the block
  itself (the choice is shared and remembered). Long lines scroll inside the block, never widen
  the page.
- `app-llm-inspector` — a dialog with the model, the bill and tabs: prompt, response, system, raw.
  The response is parsed back **out of** the archived string and pretty-printed, because that is
  what every "why did the model do that" question is about. Opened by a step of kind `llm` in the
  decision trail, by any `llm/…` path in the archive list, and by a probe's model calls (those
  never touch the archive — the probe has them in memory).

Colouring is a ~40-line tokenizer (`code-lines.ts`), not an editor: Monaco would be ~5 MB added to
a static page whose job is to *read* a prompt.

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
