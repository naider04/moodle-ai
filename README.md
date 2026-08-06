# Moodle Viewer

A desktop-grade **web viewer for Moodle** that speaks the exact same web service
API as the official Moodle mobile app — plus an **AI assistant agent** that has
full access to your Moodle account through function calling.

Built to be deployed on [Render](https://render.com) (free tier friendly).

## How it works

The official Moodle mobile app (`moodleapp`) talks to Moodle through two endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST {site}/login/token.php` | Exchange username/password for a user token (service `moodle_mobile_app`) |
| `POST {site}/webservice/rest/server.php?moodlewsrestformat=json` | Every web service call: `core_enrol_get_users_courses`, `core_course_get_contents`, `gradereport_user_get_grades_table`, `core_calendar_get_action_events_by_timesort`, … |
| `{site}/pluginfile.php` | File downloads (images, attachments) authenticated with the token |

This project mirrors that API. The server keeps your Moodle token **server-side**
in a session cookie — the browser never sees it — and proxies every call through
an allow-list of the ~250 functions the official app uses.

## Features

- **Dashboard** — greeting, stats, course progress bars, upcoming events
- **Courses** — full list with search + course detail with sections, activities,
  completion states and due dates (assignments, quizzes, forums, URLs…)
- **Grades** — per-course grade book rendered from `gradereport_user_get_grades_table`
- **Calendar** — upcoming action events from `core_calendar_get_action_events_by_timesort`
- **Messages** — conversations, unread counts, and replying
  (`core_message_*`)
- **AI Assistant** — a chat agent that can call any allow-listed Moodle web
  service on your behalf through the `moodle_ws` tool, run a full tool-call
  loop, and answer questions about your account. Answers are **streamed** to
  the browser as they are generated (with a "Thinking…" indicator while the
  model reasons, tool traces shown live).
- **Bring your own LLM** — configure any OpenAI-compatible provider (NVIDIA
  NIM, OpenCode, etc.) by name, base URL, API key and model, then switch
  between them from the AI tab. Built-in NVIDIA provider is seeded from env.
- **Markdown AI replies** — assistant answers are rendered as markdown
  (headings, lists, tables, code…) with sanitized, clickable links that open
  in a new tab.
- **Persistent chat history** — the AI conversation is saved to the browser's
  `localStorage` (scoped per Moodle site, so each account keeps its own
  thread) and survives page reloads. A **🧹 Clear chat** button in the AI tab
  wipes the stored history for the current site.
- **Downloadable Moodle files** — file links the assistant returns
  (`webservice/pluginfile.php` etc.) are rewritten through the app's token
  proxy, so attachments (submissions, PDFs) download with one click. This
  works on any Moodle site you log in with — the site host and token always
  come from your current session.

## Run locally

```bash
cp .env.example .env   # then edit
npm install
npm start
```

Open http://localhost:3000 and sign in with your Moodle site URL, username and
password. Credentials go straight to your Moodle server; nothing is stored.

## Deploy to Render

1. Push this folder to a GitHub repo (make sure `.env` is **not** committed — it is gitignored).
2. In Render: **New → Blueprint** and select the repo, or create a **Web Service** with:
   - Build command: `npm install --omit=dev`
   - Start command: `npm start`
   - Health check path: `/api/health`
3. Add the environment variables (see `render.yaml`):
   - `SESSION_SECRET` — generate a random one
   - `DEFAULT_SITE` — your Moodle URL (optional, pre-fills the form)
   - `NVIDIA_API_KEY` — required only for the AI assistant
   - `AI_MODEL` — defaults to `stepfun-ai/step-3.7-flash`

## API

| Route | Description |
| --- | --- |
| `POST /api/login` | `{ siteUrl, username, password }` → session |
| `GET /api/me` | Current session user |
| `POST /api/logout` | Destroy session |
| `POST /api/ws` | `{ wsfunction, params }` → Moodle REST (allow-listed) |
| `GET /api/proxy?u=` | Fetch Moodle-hosted files with the token attached |
| `POST /api/ai/chat` | `{ messages }` → SSE stream from the active AI provider (`status`/`content`/`tool`/`done`/`error` events) |
| `GET /api/ai/providers` | List configured AI providers (API keys masked) + active id |
| `POST /api/ai/providers` | `{ name, baseUrl, apiKey, model? }` → add an OpenAI-compatible provider |
| `PUT /api/ai/providers/:id` | Edit a provider (leave `apiKey` empty to keep the current key) |
| `DELETE /api/ai/providers/:id` | Remove a provider (built-in is protected) |
| `POST /api/ai/active` | `{ id }` → set the active provider for this session |
| `GET /api/health` | Health check |

### AI providers

Providers are OpenAI-compatible endpoints stored in `providers.json` (gitignored,
keys stay server-side; on Render the file lives on the instance's ephemeral disk,
so re-add providers after a redeploy). A built-in NVIDIA provider is seeded from
`NVIDIA_API_KEY` / `AI_MODEL` / `AI_ENDPOINT` env vars. To point the assistant at
another provider (e.g. OpenCode), add it in the AI tab with its base URL, API
key and model name — no code changes needed.

## Security notes

- The Moodle token and the NVIDIA key live only on the server.
- `POST /api/ws` and the AI tool allow only functions used by the official app
  (a ~250-entry allow-list). Write functions exist, but the AI agent is instructed
  to only use them when you explicitly ask.
- Sessions use an in-memory store: on Render's free tier a restart signs you out.
  Fine for personal use; swap in `connect-redis` if you need persistence.
