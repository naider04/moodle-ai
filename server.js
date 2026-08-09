/**
 * Moodle Viewer — server
 *
 * A small Node/Express backend that speaks the same Moodle web service API the
 * official Moodle mobile app uses, plus an AI assistant endpoint (NVIDIA API)
 * that can drive your Moodle account through tool calls.
 *
 * Endpoints used by the frontend:
 *   POST /api/login        { siteUrl, username, password } -> login/token.php
 *   GET  /api/me           current session user
 *   POST /api/logout
 *   POST /api/ws           { wsfunction, params } -> webservice/rest/server.php
 *   GET  /api/proxy?u=URL  proxy moodle-hosted files (adds the auth token)
 *   POST /api/ai/chat      { messages } -> SSE stream from the active AI provider (with tools)
 *   GET  /api/ai/providers            list configured AI providers
 *   POST /api/ai/providers            add an OpenAI-compatible provider
 *   PUT /api/ai/providers/:id         edit a provider
 *   DELETE /api/ai/providers/:id      remove a provider
 *   POST /api/ai/active               { id } pick the active provider
 *   GET  /api/config       non-secret bootstrap config for the login form
 *   GET  /api/health
 */
'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const WS_SERVICE = process.env.WS_SERVICE || 'moodle_mobile_app';

app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'moodle-viewer-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  }),
);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Flatten nested objects/arrays into Moodle REST-style params. */
function flattenParams(obj, prefix = '', out = {}) {
  if (obj === null || obj === undefined) {
    if (prefix) out[prefix] = '';
    return out;
  }
  if (typeof obj !== 'object') {
    out[prefix] = obj;
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenParams(v, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    flattenParams(v, prefix ? `${prefix}[${k}]` : k, out);
  }
  return out;
}

/** Top-level params the AI tool sends that Moodle expects as integers. AI
 * models routinely emit these as strings (e.g. assignid: "123") or send the
 * wrong shape; Moodle answers with the generic "Detectado valor de parámetro no
 * válido", which the model can't act on — so we coerce numeric strings here and
 * reject non-numeric values up front with a precise hint. */
const INT_PARAMS = new Set([
  'userid', 'courseid', 'assignid', 'assignmentid', 'cmid', 'id',
  'conversationid', 'forumid', 'discussionid', 'postid', 'replytoid',
  'quizid', 'attemptid', 'groupingid', 'groupid', 'categoryid',
  'timesortfrom', 'timesortto', 'timefrom', 'timeto', 'aftereventid',
  'limitfrom', 'limitnum', 'limit', 'eventid', 'instanceid', 'reviewerid',
]);

/** Coerce known integer params in place. Returns the list of params that had
 * non-numeric values (so the caller can fail with a precise error instead of
 * letting Moodle reject them generically). */
function coerceIntParams(params) {
  const bad = [];
  for (const key of Object.keys(params)) {
    if (!INT_PARAMS.has(key)) continue;
    const v = params[key];
    if (v == null || typeof v === 'number') continue;
    if (typeof v === 'boolean') { params[key] = v ? 1 : 0; continue; }
    const s = String(v).trim();
    if (/^-?\d+$/.test(s)) { params[key] = Number(s); continue; }
    bad.push({ key, value: s.slice(0, 40) });
  }
  return bad;
}

/** Build the tool result payload Moodle sends back to the AI model on failure,
 * including the params it sent and a type hint so it can self-correct. */
function toolErrorContent(message, toolParams) {
  return JSON.stringify({
    error: message,
    request_params: toolParams,
    hint: 'IDs (userid, courseid, assignid, conversationid, …) must be integers; userid defaults to the current user when omitted/0.',
  });
}

/** Validate a site URL and normalize it to https://host form. */
function normalizeSiteUrl(raw) {
  if (!raw) return null;
  let url = String(raw).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    if (!u.hostname.includes('.')) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** When a Moodle endpoint returns HTML instead of JSON (a block page, an SSO /
 * firewall redirect, a maintenance page, a 404 landing page…), describe it so the
 * user sees *what* the site sent instead of a cryptic JSON-parse error. */
function describeNonJsonResponse(res, text) {
  const ctype = (res.headers.get('content-type') || '').split(';')[0].trim() || 'unknown';
  const titleMatch = String(text).match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const snippet = String(text).replace(/\s+/g, ' ').trim().slice(0, 140);
  const parts = [
    `got ${ctype} (HTTP ${res.status})`,
    title ? `page title: "${title}"` : '',
    snippet ? `starts with: ${snippet}` : '',
  ].filter(Boolean);
  return `the site returned an HTML page instead of the Moodle API (${parts.join('; ')}). This usually means the site blocks web-service login, is behind SSO/firewall, is in maintenance, or the URL is not a Moodle API endpoint.`;
}

/** Call a Moodle web service function using a user token. */
async function moodleCall(siteUrl, token, wsfunction, params = {}) {
  const url = `${siteUrl}/webservice/rest/server.php?moodlewsrestformat=json`;
  const body = new URLSearchParams(
    flattenParams({ wsfunction, wstoken: token, ...params }),
  );
  let res;
  try {
    res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(MOODLE_TIMEOUT_MS) });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      const err = new Error(`Moodle web service timed out after ${Math.round(MOODLE_TIMEOUT_MS / 1000)}s`);
      err.status = 504;
      throw err;
    }
    throw e;
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`Moodle web service error: ${describeNonJsonResponse(res, text)}`);
    err.status = 502;
    throw err;
  }
  if (data.errorcode || data.exception) {
    const err = new Error(data.message || data.errorcode || 'Moodle web service error');
    err.status = 400;
    err.details = data;
    throw err;
  }
  return data;
}

/** Request a user token via /login/token.php (same as the mobile app). */
async function moodleLogin(siteUrl, username, password) {
  const loginUrl = `${siteUrl}/login/token.php?lang=en`;
  const res = await fetch(loginUrl, {
    method: 'POST',
    body: new URLSearchParams({ username, password, service: WS_SERVICE }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`Login failed: ${describeNonJsonResponse(res, text)}`);
    err.status = 502;
    throw err;
  }
  if (!data || !data.token) {
    const err = new Error((data && data.error) || 'Invalid username or password');
    err.status = 401;
    throw err;
  }
  return { token: data.token, privateToken: data.privatetoken || '' };
}

/** 401 unless a session with a Moodle token exists. */
function requireAuth(req, res, next) {
  if (req.session && req.session.token && req.session.siteUrl) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

app.post('/api/login', async (req, res) => {
  try {
    const siteUrl = normalizeSiteUrl(req.body.siteUrl);
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!siteUrl) return res.status(400).json({ error: 'Invalid site URL' });
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const { token } = await moodleLogin(siteUrl, username, password);
    const info = await moodleCall(siteUrl, token, 'core_webservice_get_site_info');

    req.session.siteUrl = siteUrl;
    req.session.token = token;
    req.session.user = {
      id: info.userid,
      username: info.username,
      firstname: info.firstname,
      lastname: info.lastname,
      fullname: info.fullname,
      picture: info.userpictureurl || null,
      lang: info.lang || 'en',
      sitename: info.sitename,
      release: info.release,
    };
    await new Promise((resolve) => req.session.save(resolve));
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ user: req.session.user, siteUrl: req.session.siteUrl });
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    defaultSite: process.env.DEFAULT_SITE || '',
    defaultUsername: process.env.DEFAULT_USERNAME || '',
    aiConfigured: providers.length > 0,
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------------ *
 * Moodle web service proxy
 * ------------------------------------------------------------------ */

app.post('/api/ws', requireAuth, async (req, res) => {
  try {
    const { wsfunction, params } = req.body;
    if (!wsfunction) return res.status(400).json({ error: 'wsfunction is required' });
    // Only allow functions the official app uses (safety net for the AI agent too).
    const allowed = ALLOWED_FUNCTIONS;
    if (!allowed.includes(wsfunction)) {
      return res.status(403).json({ error: `Function ${wsfunction} is not allowed` });
    }
    const p = params || {};
    // The official app sends userid=0 (or omits it) to mean "current user", but
    // some Moodle versions require the explicit id. Substitute the session id.
    if (USERID_DEFAULT_FUNCTIONS.has(wsfunction) && (p.userid === undefined || p.userid === 0)) {
      p.userid = req.session.user.id;
    }
    const data = await moodleCall(req.session.siteUrl, req.session.token, wsfunction, p);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Web service call failed', details: e.details });
  }
});

/** Proxy moodle-hosted files (course images, avatars, attachments). */
app.get('/api/proxy', requireAuth, async (req, res) => {
  try {
    const raw = req.query.u;
    if (!raw) return res.status(400).json({ error: 'missing u' });
    let url;
    try {
      url = new URL(String(raw));
    } catch {
      return res.status(400).json({ error: 'bad url' });
    }
    const siteHost = new URL(req.session.siteUrl).host;
    if (url.host !== siteHost) return res.status(403).json({ error: 'host not allowed' });

    // The site-root /pluginfile.php needs a browser session cookie, not a web
    // service token, so it returns the login HTML page for token-based clients
    // (e.g. generated course thumbnails /course/generated/course.svg). The
    // official mobile app always uses /webservice/pluginfile.php, which honors
    // the token — rewrite to that variant so avatar/course images load.
    if (url.pathname === '/pluginfile.php' || url.pathname.startsWith('/pluginfile.php/')) {
      url.pathname = url.pathname.replace(/^\/pluginfile\.php/, '/webservice/pluginfile.php');
    }

    url.searchParams.set('token', req.session.token);
    const upstream = await fetch(url, { redirect: 'follow' });
    if (!upstream.ok) return res.status(upstream.status).end();

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentDisposition = upstream.headers.get('content-disposition');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', contentType);
    if (contentDisposition) res.set('Content-Disposition', contentDisposition);
    res.set('Cache-Control', 'private, max-age=600');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ *
 * AI assistant (NVIDIA API) with a Moodle tool
 * ------------------------------------------------------------------ */

const AI_MAX_TURNS = parseInt(process.env.AI_MAX_TURNS || '8', 10);
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '90000', 10); // per LLM call: connect + stream
const AI_STALL_MS = parseInt(process.env.AI_STALL_MS || '30000', 10); // abort if the provider sends no SSE bytes for this long (real dead connection)
const AI_STALL_WARN_MS = parseInt(process.env.AI_STALL_WARN_MS || '6000', 10); // warn the UI after this much silence — slow thinking ≠ stuck
const AI_RETRIES = parseInt(process.env.AI_RETRIES || '2', 10); // re-attempt stalled/timeout provider calls before giving up
const MOODLE_TIMEOUT_MS = parseInt(process.env.MOODLE_TIMEOUT_MS || '30000', 10); // per Moodle web service call
const AI_CONTEXT_BUDGET = parseInt(process.env.AI_CONTEXT_BUDGET || '120000', 10); // cap total chars of conversation content sent to the provider per turn

/* ------------------------------------------------------------------ *
 * AI providers — OpenAI-compatible endpoints, persisted in providers.json.
 * Two providers are seeded from env vars so the app works out of the box
 * and you can hand users a provider without touching the UI:
 *   - NVIDIA NIM      (NVIDIA_API_KEY / AI_MODEL / AI_ENDPOINT)
 *   - A personal one  (AI_PROVIDER_BASE_URL + AI_PROVIDER_API_KEY, plus
 *                      AI_PROVIDER_NAME / AI_PROVIDER_MODEL / AI_PROVIDER_DEFAULT)
 * You can also add/switch any other endpoint (e.g. OpenCode) in the UI.
 * ------------------------------------------------------------------ */

const PROVIDERS_FILE = path.join(__dirname, 'providers.json');

function loadProviders() {
  try {
    const data = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
    if (Array.isArray(data.providers)) return data.providers;
  } catch { /* no file yet */ }
  return [];
}

function saveProviders(list) {
  try {
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify({ providers: list }, null, 2));
  } catch (e) {
    console.error('Could not persist providers:', e.message);
  }
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Strip the API key before sending providers to the browser. */
function publicProvider(p) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model || '',
    apiKeyMasked: maskKey(p.apiKey),
    builtin: !!p.builtin,
    default: !!p.default,
  };
}

let providers = loadProviders();

// Seed / refresh the built-in NVIDIA provider from environment variables.
if (process.env.NVIDIA_API_KEY) {
  const existing = providers.find((p) => p.id === 'builtin-nvidia');
  if (existing) {
    existing.apiKey = process.env.NVIDIA_API_KEY;
    if (process.env.AI_MODEL) existing.model = process.env.AI_MODEL;
  } else {
    providers.unshift({
      id: 'builtin-nvidia',
      name: 'NVIDIA NIM',
      baseUrl: (process.env.AI_ENDPOINT || 'https://integrate.api.nvidia.com/v1/chat/completions')
        .replace(/\/chat\/completions$/, ''),
      apiKey: process.env.NVIDIA_API_KEY,
      model: process.env.AI_MODEL || 'stepfun-ai/step-3.7-flash',
      builtin: true,
      default: true,
      createdAt: Date.now(),
    });
    saveProviders(providers);
  }
}

// Seed / refresh a "personal" provider from env vars. Point it at any
// OpenAI-compatible endpoint (NVIDIA, OpenCode, …) and swap providers later
// by editing AI_PROVIDER_* on the server — no code or UI changes needed.
// The provider is only created when BOTH a base URL and an API key are set.
if (process.env.AI_PROVIDER_BASE_URL && process.env.AI_PROVIDER_API_KEY) {
  const personal = {
    id: 'env-personal',
    name: process.env.AI_PROVIDER_NAME || 'Personal LLM',
    baseUrl: String(process.env.AI_PROVIDER_BASE_URL).trim().replace(/\/+$/, ''),
    apiKey: process.env.AI_PROVIDER_API_KEY,
    model: process.env.AI_PROVIDER_MODEL || '',
    builtin: true,
    createdAt: Date.now(),
  };
  const idx = providers.findIndex((p) => p.id === 'env-personal');
  if (idx !== -1) {
    // Refresh values from env so dashboard changes take effect on redeploy.
    providers[idx] = Object.assign({}, providers[idx], {
      name: personal.name,
      baseUrl: personal.baseUrl,
      apiKey: personal.apiKey,
      model: personal.model,
      builtin: true,
    });
  } else {
    providers.unshift(personal);
  }
  // Optionally make the personal provider the default for new sessions.
  if (/^(1|true|yes|on)$/i.test(process.env.AI_PROVIDER_DEFAULT || '')) {
    providers.forEach((p) => { p.default = p.id === 'env-personal'; });
  }
  saveProviders(providers);
} else {
  // Env vars were removed — drop the env-seeded provider so it can't linger
  // as a stale, undeletable entry.
  const idx = providers.findIndex((p) => p.id === 'env-personal');
  if (idx !== -1) {
    providers.splice(idx, 1);
    saveProviders(providers);
  }
}

const MOODLE_TOOL = {
  type: 'function',
  function: {
    name: 'moodle_ws',
    description:
      'Call a Moodle web service function on behalf of the logged-in user. Use this to read (and, when the user asks, modify) anything in their Moodle account: courses, contents, grades, calendar, messages, forums, assignments, quizzes, files, etc. Only functions from the official Moodle mobile app are allowed.',
    parameters: {
      type: 'object',
      properties: {
        function: {
          type: 'string',
          description: 'Moodle web service function name, e.g. core_enrol_get_users_courses',
        },
        params: {
          type: 'object',
          description: 'Function parameters (userid defaults to the logged-in user when omitted).',
          additionalProperties: true,
        },
      },
      required: ['function'],
    },
  },
};

/** Keep only fields the chat API accepts when replaying an assistant turn. */
function sanitizeAssistantMessage(msg) {
  const clean = { role: 'assistant' };
  if (msg.content !== undefined && msg.content !== null) clean.content = msg.content;
  if (msg.tool_calls && msg.tool_calls.length) clean.tool_calls = msg.tool_calls;
  return clean;
}

app.get('/api/ai/providers', requireAuth, (req, res) => {
  res.json({ providers: providers.map(publicProvider), activeId: req.session.activeProviderId || null });
});

app.post('/api/ai/providers', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const baseUrl = String(req.body.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(req.body.apiKey || '').trim();
  const model = String(req.body.model || '').trim();
  if (!name) return res.status(400).json({ error: 'Provider name is required' });
  if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'Base URL must start with http(s)://' });
  if (!apiKey) return res.status(400).json({ error: 'API key is required' });
  providers.push({
    id: `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    baseUrl,
    apiKey,
    model,
    builtin: false,
    createdAt: Date.now(),
  });
  saveProviders(providers);
  res.json({ ok: true, providers: providers.map(publicProvider), activeId: req.session.activeProviderId || null });
});

app.put('/api/ai/providers/:id', requireAuth, (req, res) => {
  const p = providers.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  const { name, baseUrl, apiKey, model } = req.body;
  if (name !== undefined) p.name = String(name).trim() || p.name;
  if (baseUrl !== undefined) {
    const b = String(baseUrl).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(b)) return res.status(400).json({ error: 'Base URL must start with http(s)://' });
    p.baseUrl = b;
  }
  if (apiKey !== undefined && String(apiKey).trim()) p.apiKey = String(apiKey).trim();
  if (model !== undefined) p.model = String(model).trim();
  saveProviders(providers);
  res.json({ ok: true, providers: providers.map(publicProvider), activeId: req.session.activeProviderId || null });
});

app.delete('/api/ai/providers/:id', requireAuth, (req, res) => {
  const idx = providers.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Provider not found' });
  if (providers[idx].builtin) return res.status(400).json({ error: 'The built-in provider cannot be deleted' });
  providers.splice(idx, 1);
  if (req.session.activeProviderId === req.params.id) req.session.activeProviderId = undefined;
  saveProviders(providers);
  res.json({ ok: true, providers: providers.map(publicProvider), activeId: req.session.activeProviderId || null });
});

app.post('/api/ai/active', requireAuth, (req, res) => {
  const id = String(req.body.id || '');
  if (!providers.some((p) => p.id === id)) return res.status(404).json({ error: 'Provider not found' });
  req.session.activeProviderId = id;
  res.json({ ok: true, activeId: id });
});

/**
 * Build a "now" description for the AI: the server's current date/time and,
 * when the browser tells us its timezone, the user's local date/time too.
 * Falls back to the raw UTC offset (minutes east of UTC) when no IANA
 * timezone is available. Used so the model can reason about "today",
 * "this week", deadlines, and other time-sensitive questions.
 */
function describeNow(timezone, offsetMinutes) {
  const now = new Date();
  let serverTz = 'UTC';
  try { serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* keep UTC */ }
  const fmtOpts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };
  const serverLabel = now.toLocaleString('en-US', fmtOpts);

  const lines = [`The server's current date and time is ${serverLabel} (${serverTz}, ISO ${now.toISOString()}).`];

  const tz = typeof timezone === 'string' && timezone ? timezone : '';
  if (tz) {
    try {
      const userLabel = new Intl.DateTimeFormat('en-US', { ...fmtOpts, timeZone: tz }).format(now);
      lines.push(`The user's local date and time is ${userLabel} (${tz}). Treat this as "now" when answering questions about due dates, today, this week, or the current time.`);
      return lines.join('\n');
    } catch { /* invalid timezone -> fall back to the offset below */ }
  }
  const off = Number(offsetMinutes);
  if (Number.isFinite(off)) {
    const local = new Date(now.getTime() + off * 60000);
    const userLabel = local.toLocaleString('en-US', fmtOpts);
    const sign = off < 0 ? '-' : '+';
    const abs = Math.abs(off);
    const offsetLabel = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    lines.push(`The user's local date and time is ${userLabel} (${offsetLabel}). Treat this as "now" when answering questions about due dates, today, this week, or the current time.`);
  }
  return lines.join('\n');
}

app.post('/api/ai/chat', requireAuth, async (req, res) => {
  const activeProvider =
    providers.find((p) => p.id === req.session.activeProviderId) ||
    providers.find((p) => p.default) ||
    providers[0];
  if (!activeProvider) {
    return res.status(503).json({ error: 'No AI provider configured. Add one in the AI tab or set NVIDIA_API_KEY on the server.' });
  }
  const aiEndpoint = `${activeProvider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const aiKey = activeProvider.apiKey;
  const aiModel = activeProvider.model || '';

  const incoming = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (!incoming.length) return res.status(400).json({ error: 'messages is required' });

  const user = req.session.user;
  const system = [
    `You are the AI assistant inside a desktop Moodle viewer.`,
    `The logged-in user is ${user.fullname} (${user.username}) on the Moodle site ${req.session.siteUrl} (${user.sitename || ''}).`,
    describeNow(req.body.timezone, req.body.offsetMinutes),
    `You have full access to their Moodle account through the "moodle_ws" tool. Whenever you need any data from Moodle, call the tool with the right function name and params.`,
    `When the user asks for a summary (grades, pending tasks, calendar, messages...), gather the data with the tool and present a clear, friendly summary.`,
    `You may also perform actions on their behalf when they ask (e.g. mark messages read, post forum replies, submit forms), but never call write functions without the user's explicit request.`,
    `Respond in the same language the user writes in. Be concise but complete.`,
    `File links returned by the Moodle web service (fileurl, webservice/pluginfile.php) open and download directly in this viewer — always give those exact URLs when listing files, and do not suggest workarounds for opening them.`,
    `Data you already retrieved in this conversation is still in context — do not re-fetch it with another tool call unless it may have changed (e.g. after an action you performed).`,
    `To link to an activity use ${req.session.siteUrl}/mod/{modname}/view.php?id={coursemodule} (e.g. mod/quiz/view.php for quizzes). The coursemodule id comes from the mod_* functions (e.g. mod_quiz_get_quizzes_by_courses); core_enrol_get_users_courses returns no module ids.`,
    `Useful functions include: core_enrol_get_users_courses, core_course_get_contents, core_webservice_get_site_info, gradereport_user_get_grade_items, gradereport_overview_get_course_grades, core_calendar_get_action_events_by_timesort, core_message_get_conversations, core_message_get_conversation_messages, core_message_mark_all_conversation_messages_as_read, core_completion_get_activities_completion_status, mod_assign_get_assignments, mod_assign_get_submission_status, mod_forum_get_forums_by_courses, mod_forum_get_forum_discussions, mod_forum_add_discussion_post, mod_quiz_get_quizzes_by_courses, mod_quiz_get_user_attempts, core_files_get_files, core_user_get_course_user_profiles.`,
  ].join('\n');

  const history = [{ role: 'system', content: system }, ...incoming];
  const trace = [];

  // Stream the answer to the browser as Server-Sent Events:
  //   data: {"type":"status","status":"thinking"}        model is reasoning
  //   data: {"type":"reasoning","content":"..."}     reasoning tokens (shown dimmed, not saved)
  //   data: {"type":"status","status":"still_waiting"}  no bytes for AI_STALL_WARN_MS (slow, not stuck)
  //   data: {"type":"status","status":"retrying",     provider stalled/timed out; re-attempting
  //          "attempt":N,"max":M}
  //   data: {"type":"rollback","chars":N,            drop the last N content chars and M reasoning
  //          "reasoningChars":M}                       chars (stalled turn retried)
  //   data: {"type":"status","status":"error",          terminal failure; code identifies the cause
  //          "code":"...","message":"..."}
  //   data: {"type":"content","content":"..."}      visible answer tokens
  //   data: {"type":"tool","trace":{...}}            a Moodle tool ran
  //   data: {"type":"done","reply":"...","trace":[...],"code":optional}
  //   data: {"type":"error","error":"...","code":"..."}
  // Failure codes: timeout | stalled | rate_limit | auth | api_error |
  //                http_error | max_turns | client_disconnect | interrupted | unknown
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // A client navigating away mid-answer closes the connection; writes after
  // that throw EPIPE-style errors that would otherwise crash the process.
  res.on('error', () => {});
  const sendEvent = (payload) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Abort the upstream fetch if the browser disconnects, and stop the loop so
  // we don't keep spending tokens for a client that pressed Stop.
  const upstream = { controller: null };
  let disconnected = false;
  req.on('close', () => {
    disconnected = true;
    upstream.controller && upstream.controller.abort();
  });

  /**
   * Truncate a JSON string at a point that still parses as valid JSON, so the
   * model never receives a mid-document slice that breaks its tool results.
   * Cuts at an element boundary and closes the root container; the marker
   * line tells the model the data was cut, and the last resort is a minimal
   * valid placeholder rather than broken JSON.
   */
  function truncateJson(payload, max) {
    if (payload.length <= max) return payload;
    const rootClose = payload[0] === '[' ? ']' : payload[0] === '{' ? '}' : '';
    let end = max;
    for (let attempt = 0; attempt < 64; attempt++) {
      end = Math.max(
        payload.lastIndexOf(',', end),
        payload.lastIndexOf('}', end),
        payload.lastIndexOf(']', end),
      );
      if (end <= 0) break;
      // A comma cut must drop the comma (it would leave a trailing comma);
      // a brace cut keeps the closing brace of the complete element.
      const cutEnd = payload[end] === ',' ? end : end + 1;
      const candidate = payload.slice(0, cutEnd) + rootClose;
      try {
        JSON.parse(candidate);
        return `${candidate}\n[truncated: data exceeded ${max} characters — re-query with narrower params if needed]`;
      } catch {
        end -= 1; // cut earlier next try
      }
    }
    const minimal = rootClose ? `${payload[0]}${rootClose}` : 'null';
    return `${minimal}\n[truncated: data exceeded ${max} characters — re-query with narrower params if needed]`;
  }

  /**
   * Slim known-heavy tool results before they go into the model context:
   * drop fields that cost tokens (HTML summaries, embedded question lists)
   * but keep everything the model needs to answer and to build links.
   */
  function slimToolResult(fn, result) {
    if (fn === 'core_enrol_get_users_courses' && Array.isArray(result)) {
      return result.map((c) => ({
        id: c.id,
        fullname: c.fullname,
        shortname: c.shortname,
        idnumber: c.idnumber,
        startdate: c.startdate,
        enddate: c.enddate,
        visible: c.visible,
        ...(typeof c.progress === 'number' ? { progress: c.progress } : {}),
      }));
    }
    if (fn === 'mod_quiz_get_quizzes_by_courses' && Array.isArray(result)) {
      return result.map((q) => ({
        id: q.id,
        coursemodule: q.coursemodule,
        course: q.course,
        name: q.name,
        intro: q.intro ? String(q.intro).slice(0, 500) : '',
        timeopen: q.timeopen,
        timeclose: q.timeclose,
        timelimit: q.timelimit,
        attempts: q.attempts,
        attemptlimit: q.attemptlimit,
        hasquestions: q.hasquestions,
      }));
    }
    return result;
  }

  /** Execute tool calls, stream their traces, and push results into history. */
  async function runTools(calls) {
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      const fn = args.function;
      const toolParams = args.params || {};
      if (USERID_DEFAULT_FUNCTIONS.has(fn) && (toolParams.userid === undefined || toolParams.userid === 0)) {
        toolParams.userid = req.session.user.id;
      }
      if (!ALLOWED_FUNCTIONS.includes(fn)) {
        const t = { function: fn, ok: false, error: 'Function not allowed' };
        trace.push(t);
        sendEvent({ type: 'tool', trace: t });
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolErrorContent(`Function ${fn} is not available`, toolParams),
        });
        continue;
      }
      // Coerce integer params the model sent as strings; reject non-numeric
      // values up front with a precise hint so the model can self-correct.
      const bad = coerceIntParams(toolParams);
      if (bad.length) {
        const hint = `Invalid parameter value: ${bad.map((b) => `${b.key}=${JSON.stringify(b.value)}`).join(', ')} (these must be integers).`;
        const t = { function: fn, params: toolParams, ok: false, error: hint };
        trace.push(t);
        sendEvent({ type: 'tool', trace: t });
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolErrorContent(hint, toolParams),
        });
        continue;
      }
      try {
        const result = await moodleCall(req.session.siteUrl, req.session.token, fn, toolParams);
        const t = { function: fn, params: toolParams, ok: true };
        trace.push(t);
        sendEvent({ type: 'tool', trace: t });
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: truncateJson(JSON.stringify(slimToolResult(fn, result)), 60000),
        });
      } catch (e) {
        const t = { function: fn, params: toolParams, ok: false, error: e.message };
        trace.push(t);
        sendEvent({ type: 'tool', trace: t });
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolErrorContent(e.message, toolParams),
        });
      }
    }
  }

  /**
   * Keep the conversation context bounded so the provider's time-to-first-token
   * stays low: once the raw content exceeds AI_CONTEXT_BUDGET, blank the oldest
   * tool results (the model can re-fetch anything it still needs).
   */
  function compactHistory() {
    let total = history.reduce((s, m) => s + String(m.content || '').length, 0);
    if (total <= AI_CONTEXT_BUDGET) return;
    for (const m of history) {
      if (total <= AI_CONTEXT_BUDGET) break;
      if (m.role === 'tool' && m.content && !String(m.content).startsWith('[tool result omitted')) {
        total -= String(m.content).length;
        m.content = '[tool result omitted to keep the conversation fast — re-fetch with the moodle_ws tool if needed]';
      }
    }
  }

  /**
   * One streaming call to the AI provider. Returns { content, calls,
   * finishReason } or throws a classified error (see the SSE comment above
   * for the failure codes).
   */
  async function streamTurn() {
    const controller = new AbortController();
    upstream.controller = controller;

    // Watchdog: if the provider hasn't answered at all within the budget,
    // abort and report it as a timeout instead of hanging forever.
    const idleWatchdog = setTimeout(() => {
      const err = new Error(`No response from the AI provider after ${Math.round(AI_TIMEOUT_MS / 1000)}s`);
      err.code = 'timeout';
      controller.abort(err);
    }, AI_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(aiEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...(aiModel ? { model: aiModel } : {}),
          messages: history,
          tools: [MOODLE_TOOL],
          temperature: 0.3,
          max_tokens: 4000,
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(idleWatchdog);
      throw e;
    }

    if (!response.ok || !response.body) {
      clearTimeout(idleWatchdog);
      const text = await response.text();
      const err = new Error(`AI API error ${response.status}: ${text.slice(0, 500)}`);
      err.code = response.status === 429
        ? 'rate_limit'
        : response.status === 401 || response.status === 403 ? 'auth'
        : response.status >= 500 ? 'api_error'
        : 'http_error';
      err.status = response.status;
      throw err;
    }

    // Consume the upstream SSE, accumulating content and tool-call fragments.
    // Stall watchdog: if the provider stops sending bytes mid-stream, abort
    // and report it so we never leave the user staring at "Thinking…" forever.
    let lastChunkAt = Date.now();
    let stallWarned = false;
    const stallWatchdog = setInterval(() => {
      const idle = Date.now() - lastChunkAt;
      if (idle > AI_STALL_MS) {
        // Truly dead: the provider went silent past the hard limit.
        const err = new Error(`The AI provider sent no data for ${Math.round(AI_STALL_MS / 1000)}s`);
        err.code = 'stalled';
        controller.abort(err);
      } else if (idle > AI_STALL_WARN_MS && !stallWarned) {
        // Slow prefill / reasoning, not a failure — tell the UI to wait.
        stallWarned = true;
        sendEvent({ type: 'status', status: 'still_waiting' });
      }
    }, 2000);

    let content = '';
    let reasoning = '';
    let reasoningSeen = false;
    let finishReason = null;
    const toolSlots = [];

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastChunkAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (delta.reasoning || delta.reasoning_content) {
          if (!reasoningSeen) {
            reasoningSeen = true;
            sendEvent({ type: 'status', status: 'thinking' });
          }
          // Forward reasoning tokens so the UI can show them streaming
          // (display-only — never added to history or the final reply).
          const rText = delta.reasoning || delta.reasoning_content;
          reasoning += rText;
          sendEvent({ type: 'reasoning', content: rText });
        }
        if (delta.content) {
          content += delta.content;
          sendEvent({ type: 'content', content: delta.content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const slot = toolSlots[tc.index || 0] || (toolSlots[tc.index || 0] = { id: '', name: '', arguments: '' });
            if (tc.id) slot.id = tc.id;
            if (tc.function) {
              if (tc.function.name) slot.name += tc.function.name;
              if (tc.function.arguments) slot.arguments += tc.function.arguments;
            }
          }
        }
      }
    }
    } catch (e) {
      // A stalled/aborted turn may have already streamed reasoning and/or
      // answer tokens to the UI. Attach them so the retry loop can roll the
      // client back and the re-attempt doesn't duplicate text.
      if (e && typeof e === 'object') {
        e.partial = content;
        e.partialReasoning = reasoning;
      }
      throw e;
    } finally {
      clearInterval(stallWatchdog);
      clearTimeout(idleWatchdog);
    }

    // Replay this assistant turn into history (sanitized) for the next call.
    const calls = toolSlots
      .filter((s) => s.name || s.arguments)
      .map((s, i) => ({
        id: s.id || `call_${turn}_${i}`,
        type: 'function',
        function: { name: s.name, arguments: s.arguments || '{}' },
      }));
    return { content, calls, finishReason };
  }

  try {
    for (let turn = 0; turn < AI_MAX_TURNS; turn++) {
      if (disconnected) break;

      // NVIDIA NIM intermittently accepts a request and then sends zero bytes
      // for minutes (stalled/timeout). Auto-retry those so one flaky call
      // doesn't kill the whole answer — the next attempt usually succeeds.
      let turnOut;
      for (let attempt = 1; ; attempt++) {
        try {
          turnOut = await streamTurn();
          break;
        } catch (e) {
          if (disconnected || !(e.code === 'stalled' || e.code === 'timeout') || attempt > AI_RETRIES) throw e;
          // If the failed turn already streamed reasoning and/or answer tokens,
          // tell the client to drop them so the retried turn isn't duplicated.
          if (e.partial || e.partialReasoning) {
            sendEvent({
              type: 'rollback',
              chars: e.partial ? e.partial.length : 0,
              reasoningChars: e.partialReasoning ? e.partialReasoning.length : 0,
            });
          }
          console.error(`[ai] ${e.code}: provider hang, retrying (${attempt}/${AI_RETRIES})`);
          sendEvent({ type: 'status', status: 'retrying', attempt, max: AI_RETRIES });
        }
      }

      const { content, calls, finishReason } = turnOut;
      history.push(sanitizeAssistantMessage({ role: 'assistant', content: content || null, tool_calls: calls }));

      if (calls.length) {
        await runTools(calls);
        compactHistory(); // keep the prompt small so time-to-first-token stays low
        continue; // loop for the model's next turn
      }

      if (finishReason === 'length' && content) {
        history.push({ role: 'user', content: 'Please continue.' });
        continue;
      }

      sendEvent({ type: 'done', reply: content || '', trace });
      return res.end();
    }

    sendEvent({
      type: 'done',
      reply: `I could not finish answering in time — the model reached the ${AI_MAX_TURNS}-turn tool limit without a final answer. Please try a simpler question.`,
      trace,
      code: 'max_turns',
    });
    console.error(`[ai] max_turns: model used all ${AI_MAX_TURNS} turns without a final answer`);
    res.end();
  } catch (e) {
    if (!res.writableEnded) {
      let code = e.code || 'unknown';
      let message = e.message || String(e);
      const reason = upstream.controller && upstream.controller.signal.reason;
      if (e.name === 'AbortError') {
        if (disconnected) {
          code = 'client_disconnect';
          message = 'Connection to the browser was closed.';
        } else if (reason && reason.code) {
          code = reason.code;
          message = reason.message;
        } else {
          code = 'interrupted';
          message = 'The AI request was interrupted.';
        }
      }
      console.error(`[ai] ${code}: ${message}`);
      sendEvent({ type: 'status', status: 'error', code, message });
      sendEvent({ type: 'error', error: message, code });
      res.end();
    }
  }
});

/* ------------------------------------------------------------------ *
 * Static frontend
 * ------------------------------------------------------------------ */

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Moodle Viewer running on http://localhost:${PORT}`);
});

/* ------------------------------------------------------------------ *
 * Allow-list of Moodle web service functions (mirrors the official app)
 * ------------------------------------------------------------------ */

/** Functions where userid=0/omitted means "the current user". */
const USERID_DEFAULT_FUNCTIONS = new Set([
  'core_enrol_get_users_courses',
  'core_course_get_enrolled_courses_by_timeline_classification',
  'core_course_get_recent_courses',
  'gradereport_user_get_grades_table',
  'gradereport_user_get_grade_items',
  'gradereport_overview_get_course_grades',
  'core_completion_get_course_completion_status',
  'core_calendar_get_calendar_events',
  'core_user_get_course_user_profiles',
  'core_notes_get_course_notes',
  'core_message_get_conversations',
  'core_message_get_unread_conversation_counts',
  'core_message_get_conversation_counts',
  'core_message_get_messages',
  'core_message_get_user_contacts',
  'core_message_get_contact_requests',
  'core_user_get_private_files_info',
  'core_user_get_user_preferences',
  'core_badges_get_user_badges',
  'mod_assign_get_submission_status',
  'mod_assign_get_submissions',
  'mod_assign_get_user_mappings',
  'mod_assign_get_grades',
  'mod_quiz_get_user_attempts',
  'core_completion_get_activities_completion_status',
  'core_message_get_conversation_messages',
  'core_message_get_messages',
]);

const ALLOWED_FUNCTIONS = [
  'core_webservice_get_site_info',
  'core_enrol_get_users_courses',
  'core_enrol_get_course_enrolment_methods',
  'core_course_get_contents',
  'core_course_get_courses',
  'core_course_get_courses_by_field',
  'core_course_get_course_module',
  'core_course_get_course_module_by_instance',
  'core_course_get_enrolled_courses_by_timeline_classification',
  'core_course_get_recent_courses',
  'core_course_get_user_navigation_options',
  'core_course_get_user_administration_options',
  'core_course_check_updates',
  'core_course_search_courses',
  'core_course_set_favourite_courses',
  'core_course_view_course',
  'core_course_view_module_instance_list',
  'core_courseformat_get_overview_information',
  'core_completion_get_activities_completion_status',
  'core_completion_get_course_completion_status',
  'core_completion_mark_course_self_completed',
  'core_completion_update_activity_completion_status_manually',
  'core_calendar_get_calendar_monthly_view',
  'core_calendar_get_calendar_day_view',
  'core_calendar_get_calendar_upcoming_view',
  'core_calendar_get_calendar_events',
  'core_calendar_get_calendar_event_by_id',
  'core_calendar_get_action_events_by_timesort',
  'core_calendar_get_action_events_by_course',
  'core_calendar_get_action_events_by_courses',
  'core_calendar_create_calendar_events',
  'core_calendar_delete_calendar_events',
  'core_message_get_conversations',
  'core_message_get_conversation',
  'core_message_get_conversation_between_users',
  'core_message_get_conversation_messages',
  'core_message_get_conversation_counts',
  'core_message_get_unread_conversation_counts',
  'core_message_get_messages',
  'core_message_get_member_info',
  'core_message_get_user_contacts',
  'core_message_send_instant_messages',
  'core_message_send_messages_to_conversation',
  'core_message_mark_all_conversation_messages_as_read',
  'core_message_mark_all_notifications_as_read',
  'core_message_mark_message_read',
  'core_message_mark_notification_read',
  'core_message_get_unread_notification_count',
  'core_message_search_contacts',
  'core_message_message_search_users',
  'core_message_delete_message',
  'core_message_delete_conversations_by_id',
  'core_message_block_user',
  'core_message_unblock_user',
  'core_message_mute_conversations',
  'core_message_unmute_conversations',
  'core_message_set_favourite_conversations',
  'core_message_unset_favourite_conversations',
  'core_message_create_contact_request',
  'core_message_confirm_contact_request',
  'core_message_decline_contact_request',
  'core_message_delete_contacts',
  'core_message_get_contact_requests',
  'core_message_get_received_contact_requests_count',
  'core_grades_get_gradeitems',
  'gradereport_user_get_grades_table',
  'gradereport_user_get_grade_items',
  'gradereport_user_get_access_information',
  'gradereport_user_view_grade_report',
  'gradereport_overview_get_course_grades',
  'gradereport_overview_view_grade_report',
  'core_user_get_course_user_profiles',
  'core_user_get_users_by_field',
  'core_user_get_user_preferences',
  'core_user_update_user_preferences',
  'core_user_view_user_profile',
  'core_user_view_user_list',
  'core_user_get_private_files_info',
  'core_user_agree_site_policy',
  'core_files_get_files',
  'core_files_delete_draft_files',
  'core_notes_get_course_notes',
  'core_notes_create_notes',
  'core_notes_delete_notes',
  'core_notes_view_notes',
  'core_comment_get_comments',
  'core_comment_add_comments',
  'core_comment_delete_comments',
  'core_tag_get_tag_cloud',
  'core_tag_get_tag_collections',
  'core_tag_get_tagindex_per_area',
  'core_search_get_results',
  'core_search_get_search_areas_list',
  'core_search_view_results',
  'core_block_get_course_blocks',
  'core_block_get_dashboard_blocks',
  'core_blog_get_entries',
  'core_blog_add_entry',
  'core_blog_delete_entry',
  'core_blog_prepare_entry_for_edition',
  'core_blog_update_entry',
  'core_blog_view_entries',
  'core_rating_get_item_ratings',
  'core_rating_add_rating',
  'core_question_update_flag',
  'core_get_component_strings',
  'core_group_get_course_user_groups',
  'core_group_get_activity_allowed_groups',
  'core_group_get_activity_groupmode',
  'core_enrol_get_enrolled_users',
  'core_enrol_search_users',
  'enrol_self_get_instance_info',
  'enrol_self_enrol_user',
  'enrol_guest_get_instance_info',
  'enrol_guest_validate_password',
  'message_popup_get_popup_notifications',
  'message_popup_get_unread_popup_notification_count',
  'mod_assign_get_assignments',
  'mod_assign_get_grades',
  'mod_assign_get_submission_status',
  'mod_assign_get_submissions',
  'mod_assign_get_user_mappings',
  'mod_assign_list_participants',
  'mod_assign_view_assign',
  'mod_assign_view_grading_table',
  'mod_assign_view_submission_status',
  'mod_assign_start_submission',
  'mod_assign_save_submission',
  'mod_assign_submit_for_grading',
  'mod_assign_remove_submission',
  'mod_book_get_books_by_courses',
  'mod_book_view_book',
  'mod_forum_get_forums_by_courses',
  'mod_forum_get_forum_discussions',
  'mod_forum_get_forum_discussions_paginated',
  'mod_forum_get_discussion_posts',
  'mod_forum_get_forum_discussion_posts',
  'mod_forum_get_discussion_post',
  'mod_forum_view_forum',
  'mod_forum_view_forum_discussion',
  'mod_forum_add_discussion',
  'mod_forum_add_discussion_post',
  'mod_forum_update_discussion_post',
  'mod_forum_delete_post',
  'mod_forum_can_add_discussion',
  'mod_forum_get_forum_access_information',
  'mod_forum_set_lock_state',
  'mod_forum_set_pin_state',
  'mod_forum_toggle_favourite_state',
  'mod_quiz_get_quizzes_by_courses',
  'mod_quiz_get_user_attempts',
  'mod_quiz_get_user_best_grade',
  'mod_quiz_get_attempt_data',
  'mod_quiz_get_attempt_summary',
  'mod_quiz_get_attempt_review',
  'mod_quiz_get_combined_review_options',
  'mod_quiz_get_quiz_access_information',
  'mod_quiz_get_attempt_access_information',
  'mod_quiz_get_quiz_required_qtypes',
  'mod_quiz_get_quiz_feedback_for_grade',
  'mod_quiz_start_attempt',
  'mod_quiz_save_attempt',
  'mod_quiz_process_attempt',
  'mod_quiz_view_attempt',
  'mod_quiz_view_attempt_summary',
  'mod_quiz_view_attempt_review',
  'mod_quiz_view_quiz',
  'mod_resource_get_resources_by_courses',
  'mod_resource_view_resource',
  'mod_folder_get_folders_by_courses',
  'mod_folder_view_folder',
  'mod_url_get_urls_by_courses',
  'mod_url_view_url',
  'mod_page_get_pages_by_courses',
  'mod_page_view_page',
  'mod_label_get_labels_by_courses',
  'mod_imscp_get_imscps_by_courses',
  'mod_imscp_view_imscp',
  'mod_lti_get_ltis_by_courses',
  'mod_lti_get_tool_launch_data',
  'mod_lti_view_lti',
  'mod_glossary_get_glossaries_by_courses',
  'mod_glossary_get_entries_by_letter',
  'mod_glossary_get_entries_by_date',
  'mod_glossary_get_entries_by_author',
  'mod_glossary_get_entries_by_category',
  'mod_glossary_get_entries_by_search',
  'mod_glossary_get_entry_by_id',
  'mod_glossary_get_categories',
  'mod_glossary_add_entry',
  'mod_glossary_update_entry',
  'mod_glossary_delete_entry',
  'mod_glossary_prepare_entry_for_edition',
  'mod_glossary_view_entry',
  'mod_glossary_view_glossary',
  'mod_wiki_get_wikis_by_courses',
  'mod_wiki_view_wiki',
  'mod_wiki_view_page',
  'mod_wiki_get_subwikis',
  'mod_wiki_get_subwiki_pages',
  'mod_wiki_get_subwiki_files',
  'mod_wiki_get_page_contents',
  'mod_wiki_get_page_for_editing',
  'mod_wiki_new_page',
  'mod_wiki_edit_page',
  'mod_data_get_databases_by_courses',
  'mod_data_view_database',
  'mod_data_get_data_access_information',
  'mod_data_get_entries',
  'mod_data_get_entry',
  'mod_data_get_fields',
  'mod_data_search_entries',
  'mod_data_add_entry',
  'mod_data_update_entry',
  'mod_data_delete_entry',
  'mod_data_approve_entry',
  'mod_lesson_get_lessons_by_courses',
  'mod_lesson_get_lesson',
  'mod_lesson_get_lesson_access_information',
  'mod_lesson_get_pages',
  'mod_lesson_get_page_data',
  'mod_lesson_launch_attempt',
  'mod_lesson_process_page',
  'mod_lesson_finish_attempt',
  'mod_lesson_get_user_attempt',
  'mod_lesson_get_user_timers',
  'mod_lesson_get_content_pages_viewed',
  'mod_lesson_get_attempts_overview',
  'mod_lesson_view_lesson',
  'mod_scorm_get_scorms_by_courses',
  'mod_scorm_view_scorm',
  'mod_scorm_get_scorm_attempt_count',
  'mod_scorm_get_scorm_scoes',
  'mod_scorm_get_scorm_user_data',
  'mod_scorm_insert_scorm_tracks',
  'mod_scorm_launch_sco',
  'mod_scorm_get_scorm_access_information',
  'mod_survey_get_surveys_by_courses',
  'mod_survey_view_survey',
  'mod_survey_get_questions',
  'mod_survey_submit_answers',
  'mod_choice_get_choices_by_courses',
  'mod_choice_view_choice',
  'mod_choice_get_choice_options',
  'mod_choice_get_choice_results',
  'mod_choice_submit_choice_response',
  'mod_choice_delete_choice_responses',
  'mod_feedback_get_feedbacks_by_courses',
  'mod_feedback_view_feedback',
  'mod_feedback_get_feedback_access_information',
  'mod_feedback_get_items',
  'mod_feedback_launch_feedback',
  'mod_feedback_get_page_items',
  'mod_feedback_process_page',
  'mod_feedback_get_analysis',
  'mod_feedback_get_current_completed_tmp',
  'mod_feedback_get_unfinished_responses',
  'mod_feedback_get_finished_responses',
  'mod_feedback_get_last_completed',
  'mod_feedback_get_responses_analysis',
  'mod_feedback_get_non_respondents',
  'mod_workshop_get_workshops_by_courses',
  'mod_workshop_view_workshop',
  'mod_workshop_get_workshop_access_information',
  'mod_workshop_get_user_plan',
  'mod_workshop_view_submission',
  'mod_workshop_add_submission',
  'mod_workshop_update_submission',
  'mod_workshop_delete_submission',
  'mod_workshop_get_submissions',
  'mod_workshop_get_submission',
  'mod_workshop_get_submission_assessments',
  'mod_workshop_get_reviewer_assessments',
  'mod_workshop_get_assessment',
  'mod_workshop_get_assessment_form_definition',
  'mod_workshop_update_assessment',
  'mod_workshop_get_grades',
  'mod_workshop_evaluate_assessment',
  'mod_workshop_get_grades_report',
  'mod_workshop_evaluate_submission',
  'mod_h5pactivity_get_h5pactivities_by_courses',
  'mod_h5pactivity_view_h5pactivity',
  'mod_h5pactivity_get_h5pactivity_access_information',
  'mod_h5pactivity_get_attempts',
  'mod_h5pactivity_get_results',
  'mod_h5pactivity_get_user_attempts',
  'mod_h5pactivity_log_report_viewed',
  'mod_bigbluebuttonbn_get_bigbluebuttonbns_by_courses',
  'mod_bigbluebuttonbn_view_bigbluebuttonbn',
  'mod_bigbluebuttonbn_meeting_info',
  'mod_bigbluebuttonbn_get_join_url',
  'mod_bigbluebuttonbn_get_recordings',
  'mod_bigbluebuttonbn_end_meeting',
  'mod_bigbluebuttonbn_can_join',
  'block_recentlyaccesseditems_get_recent_items',
  'block_starredcourses_get_starred_courses',
  'core_competency_list_course_competencies',
  'tool_lp_data_for_course_competencies_page',
  'tool_lp_data_for_plans_page',
  'tool_lp_data_for_plan_page',
  'tool_lp_data_for_user_competency_summary',
  'tool_lp_data_for_user_competency_summary_in_course',
  'tool_lp_data_for_user_competency_summary_in_plan',
  'core_badges_get_badges',
  'core_badges_get_user_badges',
  'core_badges_get_badge',
  'core_badges_get_user_badge_by_hash',
  'core_badges_view_user_badges',
  'core_my_view_page',
  'core_filters_get_available_in_context',
  'core_filters_get_all_states',
  'core_h5p_get_trusted_h5p_file',
  'core_xapi_statement_post',
  'core_xapi_post_state',
  'core_xapi_get_state',
  'core_xapi_get_states',
  'core_xapi_delete_state',
  'core_reportbuilder_list_reports',
  'core_reportbuilder_retrieve_report',
  'core_reportbuilder_retrieve_system_report',
  'core_reportbuilder_can_view_system_report',
  'core_reportbuilder_view_report',
  'core_table_get_dynamic_table_content',
  'core_user_add_user_device',
  'core_user_remove_user_device',
  'core_user_update_user_device_public_key',
  'message_airnotifier_is_system_configured',
  'message_airnotifier_are_notification_preferences_configured',
  'message_airnotifier_get_user_devices',
  'message_airnotifier_enable_device',
  'report_insights_action_executed',
];
