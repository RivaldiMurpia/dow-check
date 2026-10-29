# DOW Check

Proof-first research assistant for Indonesian small merchants (repository: `dow-check`). Ask in Bahasa Indonesia — by text, receipt photo, or voice note — about a supplier, a price trend, or a news claim, and get a short cited verdict, risk flags, and one clear next action. When the evidence is weak, DOW Check says so honestly instead of producing a confident report.

Built for the Meta Global AI Developer Hackathon (Indie track, Build for Your World). The verdict engine uses the Meta Model API (Muse Spark, plus Muse Voice Transcribe for voice notes) behind a deterministic citation gate: no claim is rendered without a source, and confidence is graded by code, not by model vibes.

## Run it

```bash
npm install
cp .env.example .env   # fill in MODEL_API_KEY to enable Muse Spark
npm run dev            # http://localhost:3000
```

Without a Meta API key the app still runs: web search degrades to a keyless path and verdicts are built extractively from whatever real sources were found, clearly labeled as demo mode. With fewer than two independent sources, the answer is always an honest `INSUFFICIENT_EVIDENCE` refusal.

## Test and build

```bash
npm test
npm run build
npm start              # production server on http://localhost:3000
```

## Layout

- `app/` — mobile web UI (screens S1–S8) and API routes (`/api/queries`, `/api/media`, `/api/feedback`)
- `lib/engine.mjs` — classification, citation gate, and confidence grading (pure, unit-tested)
- `lib/providers.mjs` — web search providers, Meta Model API verdicts/transcription/receipt extraction
- `lib/service.mjs` — the search → verdict → gate → persist pipeline
- `lib/store.mjs` — local JSON persistence mirroring the background schema (queries, sources, verdicts, citations, feedback, jobs)
- `tests/` — deterministic rule tests

Planning documents (PRD, TRD, app flow, design brief, background schema, implementation plan) live in `docs/` and are intentionally git-ignored for this hackathon workspace.
