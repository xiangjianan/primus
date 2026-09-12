**English** | [简体中文](README.zh-CN.md)

<div align="center">

# ⚛️ First Principles Engine

**Drill any goal all the way down to what you can do right now**

Enter a goal (or a long, rambling chunk of text) → distill the core goal → derive the **prerequisite purpose** layer by layer:
to achieve A, you must first achieve B; to achieve B, you must first achieve C — until you land on things you "can do right now."
Plain language throughout; no abstract theory.

[Features](#-features) · [Quick Start](#-quick-start) · [Usage Flow](#-usage-flow) · [API](#-api) · [Project Structure](#-project-structure) · [Roadmap](#-roadmap)

</div>

---

## ✨ Features

### Core concept: the prerequisite-purpose chain

- Each layer is an **"executable, more fundamental purpose"** — not parallel execution steps, not abstract philosophical principles
- Direction: concrete goal → increasingly fundamental prerequisites → **things you "can do right now"**
- Language style: plain words, one sentence, actionable (hard model constraint: no jargon / formulas / pedantry)

### UI & Interaction

| Capability | Description |
| --- | --- |
| 🎯 **Input & extraction** | Two modes: goal breakdown (enter a purpose) / freeform thoughts (paste rambling long text; the core intent is distilled first, then drilled down) |
| 🔁 **Layer-by-layer drill-down** | Any node can be derived further; each derivation combines **[the entire purpose chain + all past hints + the current hint]**; hard constraints: more fundamental, no repetition, no going in circles |
| 💬 **Always-visible hint box** | Each node has a persistent input box beneath it: enter your constraints/background/preferences and the model factors them into a better-fitting next layer; leave empty to derive directly |
| 🛡 **Double-click protection** | Buttons auto-disable while deriving, plus a second guard in the logic layer, preventing duplicate nodes |
| ✅ **Actionable marker** | `isActionable` nodes get a blue highlight border + an "⚡ Doable right now" badge |
| 🗂 **Session management** | Left workspace: a "current session" card + a "history" list (click to switch, hover to delete); "Collapse round" folds the current chain |
| 📋 **Summary (markdown)** | A plain-language summary of the whole chain: overall overview + common themes + action suggestions, rendered as markdown |
| 🔄 **Re-derive this layer** | Regenerate the chain's last layer with the same parameters (including the original hints) |
| 🌌 **Principle graph** | Tree visualization with a grayscale hierarchy that follows the theme; zoomable and pannable; click a node to jump to its card |
| 🌗 **Dual themes** | Dark/light (black-white-gray with a blue accent), follows system preference, manually switchable, persisted |
| 💾 **Persistence** | Session data lives in localStorage and survives refresh; export to Markdown supported |
| 📱 **PWA** | Installable to desktop/home screen, works offline (Service Worker caches the App Shell), and the mobile keyboard popping up doesn't shrink the page |

### UI Preview

| Dark theme | Light theme |
| :---: | :---: |
| ![Dark theme](docs/screenshots/dark.png) | ![Light theme](docs/screenshots/light.png) |

## 🚀 Quick Start

Requirements: **Node.js ≥ 18** (built-in `fetch`), zero third-party dependencies, no `npm install` needed.

```bash
# 1. Configure the API key (either way; environment variables take priority)
#    Option A: environment variables
export DEEPSEEK_API_KEY=sk-xxxxxxxx
export DEEPSEEK_MODEL=deepseek-v4-flash

#    Option B: edit config.json (gitignored, never committed)
#    { "apiKey": "sk-xxxxxxxx", "model": "deepseek-v4-flash" }

# 2. Start
node server.js

# 3. Open your browser
open http://127.0.0.1:3000
```

## 🧭 Usage Flow

```
Initial state: in the main area, type "a goal, or just ramble about what's on your mind"
  ↓
Enter a goal / long text → the core intent + layer-1 prerequisite purposes are distilled
  The main area becomes: a goal card + a node chain
  ↓
Click "Drill deeper"; optionally fill in "extra thoughts"
  → the next layer = the model derives it from [the whole chain + all past hints + this hint]
  ↓
… loop until you stop
  ↓
Click "Generate summary" → a plain-language summary of the whole chain (including the first thing you can do right now)
  ↓
Click "Collapse round" → folds the current chain; the left-side history lets you switch back anytime
```

## ☁️ Deploy to Cloudflare Pages

The project is adapted for [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/):
- **Static assets**: `public/` (hosted automatically by the Pages platform)
- **API (`/api/*`)**: the `functions/` directory compiles into Pages Functions (Workers runtime, no Node server needed)
- **Configuration**: model name / base URL in the `[vars]` of `wrangler.toml`; the API key is stored as a Cloudflare Secret

```bash
# 1. Log in to Cloudflare
wrangler login

# 2. Create the project (first time only)
wrangler pages project create first-principles-engine --production-branch main

# 3. Configure the API key (as a Secret, it never enters the code repository)
echo "sk-xxxxxxxx" | wrangler pages secret put DEEPSEEK_API_KEY --project-name first-principles-engine

# 4. Deploy (if the command hangs, disable telemetry first: WRANGLER_SEND_METRICS=false)
wrangler pages deploy --project-name first-principles-engine --branch main

# 5. Note: after changing Secrets/env vars, redeploy once for the change to take effect
```

> Live demo: https://first-principles-engine-1li.pages.dev

### Mobile & PWA

- **No keyboard zoom**: `viewport` set to `maximum-scale=1, user-scalable=no, interactive-widget=resizes-content` + `touch-action: manipulation` + input font size ≥16px (no auto-zoom on iOS focus)
- **Mobile adaptation**: drawer-style sidebar, touch targets ≥44px, safe-area support (notch), bottom-stuck action bar with horizontal scrolling, compact narrow-screen layout
- **PWA**: `manifest.webmanifest` (standalone + adaptive icons) + `sw.js` (App Shell precache + offline support; `/api/*` is network-first and not cached)
- Open the live URL in a mobile browser → menu "Add to Home Screen" to install

## ⚙️ Configuration

`config.json` (can be left empty; everything can go through environment variables):

```json
{
  "apiKey": "sk-xxxxxxxx",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com",
  "port": 3000
}
```

| Env var | Default | Description |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | required | API key (server-side only) |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | Model name |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API base URL (OpenAI-compatible) |
| `PORT` | `3000` | Server port |

## 📡 API

### `POST /api/derive` — purpose drill-down

Request:

```json
{
  "text": "lose 10 kg in 3 months",
  "mode": "goal",
  "hint": "I love snacks too much to resist",
  "context": { "depth": 0, "ancestors": [{ "label": "...", "principle": "...", "depth": 0 }] }
}
```

- `mode`: `goal` (goal breakdown) / `text` (freeform thoughts, returns essence) / `derive` (continue drilling down)
- `hint`: user-supplied extra thoughts (factored into the derivation)
- `context`: the purpose chain traversed so far (sent when continuing, to avoid repetition and circles)
- Response: `{ data: { label, principle, essence?, reasoning, keywords, isActionable }, thinking }`
- Resilience: `response_format: json_object` + a first-JSON-object extraction fallback + one automatic retry on parse failure (with a relaxed token limit)

### `POST /api/summarize` — whole-chain summary

```json
{ "nodes": [{ "label": "...", "principle": "...", "essence": "...", "depth": 0 }] }
```

→ `{ "data": { "summary": "markdown summary", "themes": [], "actions": [] } }`

### `GET /api/health` — health check

→ `{ "ok": true, "model": "deepseek-v4-flash", "apiKeySet": true }`

## 🏗 Project Structure

```
server.js            # Zero-dependency Node backend: static serving + DeepSeek proxy (with auto retry; used for local runs)
functions/           # Cloudflare Pages Functions (for online deployment, Workers runtime)
  api/_shared.js     #   Shared logic: prompts + DeepSeek calls + parsing fallbacks
  api/derive.js      #   POST /api/derive
  api/summarize.js   #   POST /api/summarize
  api/health.js      #   GET  /api/health
wrangler.toml        # Cloudflare Pages deployment config ([vars]: model name / base URL)
config.json          # Local API config (gitignored, not committed)
public/
  index.html         # Page structure (left workspace + main derivation area on the right)
  style.css          # Dual-theme (dark/light) Codex-style styling
  app.js             # Frontend logic (session management / rendering / export / persistence / theme)
  tree.js            # SVG graph (grayscale palette follows the theme, auto layout + zoom/pan)
  md.js              # Lightweight Markdown renderer
docs/screenshots/    # UI screenshots
```

> Dual entry points, local and online: `node server.js` (local development) and `functions/` (Cloudflare Pages) implement the same API, so the frontend needs no changes.

## 🛠 Tech Stack

- **Backend**: Node.js native `http` (zero dependencies)
- **Frontend**: vanilla HTML/CSS/JS (no framework, no build step)
- **Model**: DeepSeek (OpenAI-compatible API), any compatible model can be swapped in
- **Storage**: browser localStorage (no database needed)

## 🗺 Roadmap

- [ ] Streaming derivation (thinking stream shown in real time)
- [ ] Resumable derivation streams / mid-stream cancellation
- [ ] Session renaming and tags
- [ ] Parallel comparison derivations (drill the same node from multiple angles)
- [ ] One-click deployment scripts (Docker / cloud functions)

## 📄 License

[MIT](LICENSE)
