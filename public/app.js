'use strict';

/* ------------------------------------------------------------------ *
 * State & helpers
 * ------------------------------------------------------------------ */

const state = {
  user: null,
  siteUrl: null,
  view: 'dashboard',
  courses: [],
  courseDetail: null,
  aiMessages: [],
  conversation: null,
  aiBusy: false,
  providers: [],
  activeProviderId: null,
};

const $ = (sel) => document.querySelector(sel);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Session expired, please sign in again.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

/** Stream the AI answer (SSE) and call back as tokens/tools arrive. */
async function streamAI(messages, handlers) {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal: handlers.signal,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Session expired, please sign in again.');
  }
  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  }
  if (!res.body) throw new Error('Streaming is not supported by this browser');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let reply = '';
  const trace = [];

  const dispatch = (evt) => {
    switch (evt.type) {
      case 'status': handlers.onStatus && handlers.onStatus(evt.status); break;
      case 'content': reply += evt.content; handlers.onContent && handlers.onContent(evt.content); break;
      case 'tool': trace.push(evt.trace); handlers.onTool && handlers.onTool(evt.trace); break;
      case 'done': return { reply, trace };
      case 'error': throw new Error(evt.error);
    }
    return null;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        const result = dispatch(evt);
        if (result) return result;
      }
    }
  }
  return { reply, trace };
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Markdown rendering for AI replies ---------- */
if (window.marked) {
  marked.use({
    gfm: true,
    breaks: true,
    renderer: {
      // Open links in a new tab, safely; route Moodle file URLs through the
      // token proxy so attachments are downloadable straight from the chat.
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const target = moodleFileUrl(href);
        return `<a href="${target}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${text}</a>`;
      },
      image({ href, title, text }) {
        const src = moodleFileUrl(href);
        return `<img src="${src}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''}>`;
      },
    },
  });
}

/** Render markdown → sanitized HTML (plain text fallback if libs missing). */
const renderMarkdown = (text) => {
  if (!window.marked) return esc(text);
  const html = marked.parse(String(text ?? ''));
  return window.DOMPurify ? DOMPurify.sanitize(html) : html;
};

const fmtDate = (ts) => {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtDateTime = (ts) => {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/** Moodle-hosted media goes through our token proxy. */
function img(url) {
  if (!url) return '';
  try {
    if (new URL(url).host === new URL(state.siteUrl).host) {
      return `/api/proxy?u=${encodeURIComponent(url)}`;
    }
  } catch { /* not a url */ }
  return url;
}

/**
 * Rewrite Moodle file URLs (pluginfile.php etc.) to our token proxy so
 * attachments are downloadable straight from the chat. Non-Moodle links and
 * other hosts are left untouched.
 */
function moodleFileUrl(url) {
  if (!url || !state.siteUrl) return url;
  try {
    const u = new URL(url, state.siteUrl); // resolves relative paths too
    if (
      u.host === new URL(state.siteUrl).host &&
      /(^|\/)(webservice\/)?(pluginfile|draftfile)\.php\//.test(u.pathname)
    ) {
      return `/api/proxy?u=${encodeURIComponent(u.href)}`;
    }
  } catch { /* not a url */ }
  return url;
}

/* ---------- Chat history persistence (localStorage) ---------- */
const aiStorageKey = () => `moodle-viewer:ai:${state.siteUrl || 'unknown'}`;

function saveAIMessages() {
  try {
    localStorage.setItem(aiStorageKey(), JSON.stringify(state.aiMessages));
  } catch { /* storage unavailable */ }
}

function loadAIMessages() {
  try {
    const raw = localStorage.getItem(aiStorageKey());
    const arr = raw ? JSON.parse(raw) : [];
    state.aiMessages = Array.isArray(arr) ? arr : [];
  } catch {
    state.aiMessages = [];
  }
}

const MOD_ICONS = {
  assign: '&#128221;', book: '&#128214;', chat: '&#128172;', choice: '&#128203;',
  data: '&#128451;', feedback: '&#128236;', folder: '&#128193;', forum: '&#128172;',
  glossary: '&#128218;', h5pactivity: '&#127916;', imscp: '&#128218;', label: '&#128204;',
  lesson: '&#127891;', lti: '&#127760;', page: '&#128196;', quiz: '&#129488;',
  resource: '&#128194;', scorm: '&#127919;', subsection: '&#128269;', survey: '&#128213;',
  url: '&#128279;', wiki: '&#128220;', workshop: '&#128736;', bigbluebuttonbn: '&#127909;',
};
const modIcon = (modname) => MOD_ICONS[modname] || '&#128209;';

const moduleType = (m) => {
  const sub = [];
  if (m.customdata) {
    try {
      const cd = JSON.parse(m.customdata);
      if (cd.duedate) sub.push(`Due ${fmtDateTime(cd.duedate)}`);
      if (cd.timeclose) sub.push(`Closes ${fmtDateTime(cd.timeclose)}`);
    } catch { /* ignore */ }
  }
  if (m.dates && m.dates.length) {
    for (const d of m.dates) sub.push(`${d.label} ${fmtDateTime(d.timestamp)}`);
  }
  if (m.contents && m.contents.length) sub.push(`${m.contents.length} file${m.contents.length > 1 ? 's' : ''}`);
  return sub.join(' · ');
};

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

const VIEW_TITLES = {
  dashboard: 'Dashboard',
  courses: 'Courses',
  grades: 'Grades',
  calendar: 'Calendar',
  messages: 'Messages',
  ai: 'AI Assistant',
};

function navigate(view, params = {}) {
  state.view = view;
  state.courseDetail = params.course || null;
  state.conversation = params.conversation || null;
  $('#view-title').textContent = VIEW_TITLES[view] || view;
  document.querySelectorAll('.nav-item[data-view]').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
  const content = $('#content');
  content.innerHTML = '<div class="loader">Loading…</div>';

  const routes = {
    dashboard: renderDashboard,
    courses: renderCourses,
    grades: renderGrades,
    calendar: renderCalendar,
    messages: renderMessages,
    ai: renderAI,
  };
  (routes[view] || renderDashboard)(content).catch((e) => {
    content.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  });
}

/* ---------- Dashboard ---------- */

async function renderDashboard(content) {
  const [courses, events, msgCounts] = await Promise.all([
    api('/api/ws', { method: 'POST', body: { wsfunction: 'core_enrol_get_users_courses', params: { userid: 0 } } }),
    api('/api/ws', { method: 'POST', body: {
      wsfunction: 'core_calendar_get_action_events_by_timesort',
      params: { timesortfrom: Math.floor(Date.now() / 1000) - 86400, timesortto: Math.floor(Date.now() / 1000) + 90 * 86400, limitnum: 10 },
    } }).catch(() => ({ events: [] })),
    api('/api/ws', { method: 'POST', body: { wsfunction: 'core_message_get_unread_conversation_counts', params: {} } }).catch(() => ({ favourites: 0, types: {} })),
  ]);

  state.courses = courses || [];
  const unreadTotal = (msgCounts.types ? Object.values(msgCounts.types).reduce((a, b) => a + (Number(b) || 0), 0) : 0) + (Number(msgCounts.favourites) || 0);
  updateMsgBadge(unreadTotal);

  const withProgress = state.courses.filter((c) => c.progress != null);
  const avg = withProgress.length ? Math.round(withProgress.reduce((a, c) => a + c.progress, 0) / withProgress.length) : 0;

  content.innerHTML = `
    <div class="banner">
      <h3>Welcome back, ${esc(state.user.firstname)}</h3>
      <p>${esc(state.user.sitename)} — you are enrolled in ${state.courses.length} course${state.courses.length !== 1 ? 's' : ''}.</p>
    </div>
    <div class="stat-row">
      <div class="card stat-card"><div class="stat-num">${state.courses.length}</div><div class="stat-label">Courses</div></div>
      <div class="card stat-card"><div class="stat-num">${unreadTotal}</div><div class="stat-label">Unread messages</div></div>
      <div class="card stat-card"><div class="stat-num">${events.events ? events.events.length : 0}</div><div class="stat-label">Upcoming events</div></div>
      <div class="card stat-card"><div class="stat-num">${avg}%</div><div class="stat-label">Average progress</div></div>
    </div>
    <h3 style="margin: 6px 0 12px;">Your courses</h3>
    <div class="grid">${courseCards(state.courses.slice(0, 4))}
      ${state.courses.length > 4 ? `<div class="card course-card" onclick="navigate('courses')"><div class="course-body" style="align-items:center;justify-content:center;color:var(--text-dim)"><div style="font-size:28px;margin-bottom:6px;">&#8230;</div>View all ${state.courses.length} courses</div></div>` : ''}
    </div>
    ${events.events && events.events.length ? `
      <h3 style="margin: 24px 0 12px;">Upcoming events</h3>
      <div class="card">${eventRows(events.events.slice(0, 5))}</div>` : ''}
  `;
}

function courseCards(courses) {
  if (!courses.length) return '<div class="empty-state">No courses.</div>';
  return courses.map((c) => `
    <div class="card course-card" onclick="navigate('course', { course: ${c.id} })">
      <div class="course-cover">${c.courseimage ? `<img src="${esc(img(c.courseimage))}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}</div>
      <div class="course-body">
        <h3>${esc(c.displayname || c.fullname)}</h3>
        <div class="course-meta">${esc(c.coursecategory || c.category || '')}${c.enddate ? ` · ends ${fmtDate(c.enddate)}` : ''}</div>
        ${c.progress != null ? `<div class="progress-wrap">
          <div class="progress-label"><span>Progress</span><span>${Math.round(c.progress)}%</span></div>
          <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, Math.max(0, c.progress))}%"></div></div>
        </div>` : ''}
      </div>
    </div>`).join('');
}

function eventRows(events) {
  return events.map((e) => {
    const d = new Date(e.timesort * 1000);
    return `
    <div class="event-row">
      <div class="event-date"><div class="d">${d.getDate()}</div><div class="m">${d.toLocaleDateString(undefined, { month: 'short' })}</div></div>
      <div class="event-info">
        <div class="e-name">${esc(e.name)}</div>
        <div class="e-course">${esc(e.course ? e.course.fullname : '')}${e.overdue ? ' · <span style="color:var(--err)">overdue</span>' : ''}${e.action && e.action.url ? ` · <a href="${esc(e.action.url)}" target="_blank" rel="noopener" style="color:var(--accent-dark)">${esc(e.action.name || 'open')}</a>` : ''}</div>
      </div>
    </div>`;
  }).join('');
}

/* ---------- Courses ---------- */

async function renderCourses(content) {
  if (!state.courses.length) {
    state.courses = await api('/api/ws', { method: 'POST', body: { wsfunction: 'core_enrol_get_users_courses', params: { userid: 0 } } });
  }
  content.innerHTML = `
    <div class="toolbar">
      <input type="text" id="course-filter" placeholder="Filter courses…" style="max-width:280px;" />
    </div>
    <div class="grid" id="courses-grid">${courseCards(state.courses)}</div>`;
  $('#course-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = state.courses.filter((c) => (c.displayname || c.fullname).toLowerCase().includes(q));
    $('#courses-grid').innerHTML = courseCards(filtered);
  });
}

async function renderCourseView(content, courseId) {
  const course = state.courses.find((c) => c.id === courseId);
  const sections = await api('/api/ws', { method: 'POST', body: { wsfunction: 'core_course_get_contents', params: { courseid: courseId } } });
  content.innerHTML = `
    <a class="back-link" onclick="navigate('courses')">&#8592; All courses</a>
    <div class="banner">
      <h3>${esc(course ? course.displayname || course.fullname : 'Course')}</h3>
      <p>${esc(course ? course.summary || '' : '')}${course && course.progress != null ? ` · Progress ${Math.round(course.progress)}%` : ''}</p>
    </div>
    ${sections.map((s) => `
      <div class="section-block">
        <h4 class="section-title">${esc(s.name)}</h4>
        ${s.summary ? `<div class="section-summary">${s.summary}</div>` : ''}
        ${s.modules && s.modules.length ? s.modules.map((m) => moduleRow(m)).join('') : '<div class="empty-state" style="padding:12px;">No activities</div>'}
      </div>`).join('')}
  `;
  // Lazy-load section summaries with iframes are fine as-is (Moodle HTML).
}

function moduleRow(m) {
  const complete = m.completiondata ? m.completiondata.state === 1 : null;
  const flag = complete === null
    ? '<span class="chip dim">not tracked</span>'
    : complete
      ? '<span class="chip ok">&#10003; done</span>'
      : '<span class="chip todo">to do</span>';
  const href = m.url || '#';
  const sub = moduleType(m);
  return `
    <a class="module-row" href="${esc(href)}" target="_blank" rel="noopener">
      <div class="module-icon">${modIcon(m.modname)}</div>
      <div class="module-info">
        <div class="m-name">${esc(m.name)}</div>
        <div class="m-sub">${esc(m.modplural || m.modname)}${sub ? ' · ' + esc(sub) : ''}</div>
      </div>
      <div class="module-flag">${flag}</div>
    </a>`;
}

/* ---------- Grades ---------- */

async function renderGrades(content) {
  if (!state.courses.length) {
    state.courses = await api('/api/ws', { method: 'POST', body: { wsfunction: 'core_enrol_get_users_courses', params: { userid: 0 } } });
  }
  content.innerHTML = `
    <div class="toolbar">
      <select id="grade-course">${state.courses.map((c) => `<option value="${c.id}">${esc(c.displayname || c.fullname)}</option>`).join('')}</select>
      <button class="btn small" id="grade-load">Load grades</button>
    </div>
    <div id="grade-result"><div class="empty-state">Select a course to see its grades.</div></div>`;

  const load = async () => {
    const courseId = Number($('#grade-course').value);
    const box = $('#grade-result');
    box.innerHTML = '<div class="loader">Loading grades…</div>';
    try {
      const data = await api('/api/ws', { method: 'POST', body: {
        wsfunction: 'gradereport_user_get_grades_table',
        params: { userid: 0, courseid: courseId },
      } });
      box.innerHTML = gradeTableHTML(data.tables && data.tables[0]);
    } catch (e) {
      box.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    }
  };
  $('#grade-load').addEventListener('click', load);
  $('#grade-course').addEventListener('change', load);
  await load();
}

/** Parse the Moodle grades table (HTML cells) into a clean HTML table. */
function gradeTableHTML(table) {
  if (!table || !table.tabledata || !table.tabledata.length) {
    return '<div class="empty-state">No grades available for this course.</div>';
  }
  const rows = table.tabledata
    .map((row) => {
      const nameHtml = (row.itemname && row.itemname.content) || '';
      const gradeHtml = (row.grade && row.grade.content) || '';
      const feedbackHtml = (row.feedback && row.feedback.content) || '';

      const doc = new DOMParser().parseFromString(nameHtml, 'text/html');
      const body = doc.body;
      const link = body.querySelector('a.gradeitemheader');
      const rowTitle = body.querySelector('.rowtitle');
      const name = (link ? link.textContent : (rowTitle ? rowTitle.textContent : '')).trim();
      const rawName = body.textContent.trim();

      const grade = gradeHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ')[0] || '-';
      const feedback = feedbackHtml.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

      let kind = 'item';
      if (/courseitem/.test(nameHtml)) kind = 'course-total';
      else if (/categoryitem/.test(nameHtml)) kind = 'subtotal';
      else if (/category-content/.test(nameHtml)) kind = 'category';

      return { kind, name: name || rawName, grade, feedback };
    })
    .filter((r) => r.name || r.kind !== 'item');

  const rowClass = { category: 'category-row', 'course-total': 'total-row', subtotal: 'total-row' };
  return `
    <table class="grades-table">
      <thead><tr><th>Item</th><th style="width:120px">Grade</th><th>Feedback</th></tr></thead>
      <tbody>
        ${rows.map((r) => `<tr class="${rowClass[r.kind] || ''}">
          <td>${esc(r.name)}</td>
          <td class="grade-val">${esc(r.grade)}</td>
          <td>${esc(r.feedback)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

/* ---------- Calendar ---------- */

async function renderCalendar(content) {
  const data = await api('/api/ws', { method: 'POST', body: {
    wsfunction: 'core_calendar_get_action_events_by_timesort',
    params: { timesortfrom: Math.floor(Date.now() / 1000) - 86400, timesortto: Math.floor(Date.now() / 1000) + 180 * 86400, limitnum: 50 },
  } });
  const events = data.events || [];
  content.innerHTML = `
    <div class="panel">
      <h4 class="panel-title">Upcoming events (${events.length})</h4>
      ${events.length ? eventRows(events) : '<div class="empty-state">No upcoming events.</div>'}
    </div>`;
}

/* ---------- Messages ---------- */

async function renderMessages(content) {
  content.innerHTML = `<div class="loader">Loading conversations…</div>`;
  const [unread, priv, group] = await Promise.all([
    api('/api/ws', { method: 'POST', body: { wsfunction: 'core_message_get_unread_conversation_counts', params: {} } }).catch(() => null),
    api('/api/ws', { method: 'POST', body: { wsfunction: 'core_message_get_conversations', params: { userid: 0, type: 1, limitfrom: 0, limitnum: 50 } } }).catch(() => ({ conversations: [] })),
    api('/api/ws', { method: 'POST', body: { wsfunction: 'core_message_get_conversations', params: { userid: 0, type: 2, limitfrom: 0, limitnum: 50 } } }).catch(() => ({ conversations: [] })),
  ]);
  if (unread) updateMsgBadge((unread.types ? Object.values(unread.types).reduce((a, b) => a + (Number(b) || 0), 0) : 0) + (Number(unread.favourites) || 0));

  const byId = new Map();
  [...(priv.conversations || []), ...(group.conversations || [])].forEach((c) => byId.set(c.id, c));
  const conversations = [...byId.values()].sort((a, b) => (b.timemodified || 0) - (a.timemodified || 0));

  content.innerHTML = `
    <div class="panel" style="padding:0;">
      <h4 class="panel-title" style="padding:16px 18px 0;">Conversations (${conversations.length})</h4>
      ${conversations.length ? conversations.map((c) => {
        const names = (c.members || []).filter((m) => m.id !== state.user.id).map((m) => m.fullname);
        const label = c.name || names.join(', ') || 'Conversation';
        const initials = label.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
        const lastMsg = (c.messages && c.messages[c.messages.length - 1]);
        return `
        <div class="conv-row" onclick="openConversation(${c.id}, '${esc(label).replace(/'/g, "\\'")}')">
          <div class="conv-avatar">${esc(initials)}</div>
          <div class="conv-info">
            <div class="conv-name">${esc(label)}${c.isgroup ? ' <span class="chip info">group</span>' : ''}</div>
            <div class="conv-last">${lastMsg ? esc(lastMsg.text.replace(/<[^>]+>/g, ' ').slice(0, 90)) : ''}</div>
          </div>
          ${c.unreadcount ? `<div class="conv-unread">${c.unreadcount}</div>` : ''}
        </div>`;
      }).join('') : '<div class="empty-state">No conversations.</div>'}
    </div>`;
}

async function openConversation(conversationId, label) {
  const data = await api('/api/ws', { method: 'POST', body: {
    wsfunction: 'core_message_get_conversation_messages',
    params: { userid: 0, conversationid: conversationId, limitfrom: 0, limitnum: 60, newestfirst: false },
  } });
  const members = new Map((data.members || []).map((m) => [m.id, m.fullname]));
  const msgs = data.messages || [];
  state.conversation = { id: conversationId, label };

  const content = $('#content');
  content.innerHTML = `
    <a class="back-link" onclick="navigate('messages')">&#8592; All conversations</a>
    <div class="panel" style="display:flex;flex-direction:column;height:calc(100vh - 230px);">
      <h4 class="panel-title">${esc(label)}</h4>
      <div id="conv-msgs" style="flex:1;overflow-y:auto;padding:8px 4px;">
        ${msgs.map((m) => {
          const mine = m.useridfrom === state.user.id;
          return `<div class="msg-bubble ${mine ? 'me' : 'them'}">${esc(m.text)}<div class="msg-meta">${mine ? 'You' : esc(members.get(m.useridfrom) || 'Unknown')} · ${fmtDateTime(m.timecreated)}</div></div>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:8px;padding-top:10px;">
        <input type="text" id="conv-input" placeholder="Write a message…" style="flex:1;" />
        <button class="btn small" id="conv-send">Send</button>
      </div>
    </div>`;

  const scroll = () => { const box = $('#conv-msgs'); box.scrollTop = box.scrollHeight; };
  scroll();

  const send = async () => {
    const input = $('#conv-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const res = await api('/api/ws', { method: 'POST', body: {
      wsfunction: 'core_message_send_messages_to_conversation',
      params: { conversationid: conversationId, messages: [{ text, textformat: 1 }] },
    } });
    const sent = res && res[0] ? res[0] : { text };
    $('#conv-msgs').insertAdjacentHTML('beforeend', `<div class="msg-bubble me">${esc(sent.text)}<div class="msg-meta">You · just now</div></div>`);
    scroll();
  };
  $('#conv-send').addEventListener('click', send);
  $('#conv-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
}

/* ---------- AI Assistant ---------- */

const AI_SUGGESTIONS = [
  'Summarize my grades',
  'What is due soon in my courses?',
  'List my upcoming events',
  'Which activities are still pending?',
  'What are my unread messages?',
];

function renderAI(content) {
  content.innerHTML = `
    <div class="ai-layout">
      <div class="ai-chat">
        <div class="ai-provider-bar">
          <label for="ai-provider">Provider</label>
          <select id="ai-provider" title="Active AI provider">
            <option value="">No providers configured</option>
          </select>
          <button class="btn ghost small" id="ai-provider-add" title="Add a provider">＋ Add</button>
          <button class="btn ghost small" id="ai-provider-edit" title="Edit provider">✎</button>
          <button class="btn ghost small" id="ai-provider-del" title="Delete provider">🗑</button>
          <button class="btn ghost small" id="ai-clear" title="Clear chat history">🧹 Clear chat</button>
        </div>
        <div class="ai-history" id="ai-history"></div>
        <div class="error-box hidden" id="ai-no-provider" style="margin:0 12px 12px;">No AI provider configured. Click <b>＋ Add</b> above to add any OpenAI-compatible endpoint (e.g. NVIDIA NIM, OpenCode), or set <code>NVIDIA_API_KEY</code> on the server.</div>
        <div class="ai-suggestions">${AI_SUGGESTIONS.map((s) => `<span class="ai-suggestion">${esc(s)}</span>`).join('')}</div>
        <div class="ai-input-bar">
          <textarea id="ai-input" rows="2" placeholder="Ask anything about your Moodle account…"></textarea>
          <button class="btn" id="ai-send">Send</button>
        </div>
      </div>
    </div>
    <dialog class="provider-dialog" id="provider-dialog">
      <form id="provider-form" novalidate>
        <h3 id="provider-dialog-title">Add AI provider</h3>
        <label><span>Name</span><input type="text" id="prov-name" placeholder="e.g. OpenCode" /></label>
        <label><span>Base URL</span><input type="text" id="prov-url" placeholder="https://api.example.com/v1" /></label>
        <label><span>API key</span><input type="password" id="prov-key" placeholder="sk-..." /></label>
        <label><span>Model (optional)</span><input type="text" id="prov-model" placeholder="e.g. big-pickle, gpt-4o-mini" /></label>
        <div class="provider-dialog-actions">
          <button type="button" class="btn ghost" id="prov-cancel">Cancel</button>
          <button type="submit" class="btn" id="prov-save">Save</button>
        </div>
        <p class="login-error" id="prov-error"></p>
      </form>
    </dialog>`;

  const history = $('#ai-history');
  const renderMsg = (m) => {
    const div = document.createElement('div');
    div.className = `ai-msg ${m.role}`;
    div.innerHTML = `<div class="who">${m.role === 'user' ? 'You' : 'Assistant'}</div>`;
    const body = document.createElement('div');
    body.className = 'body';
    if (m.role === 'assistant') body.innerHTML = renderMarkdown(m.content);
    else body.textContent = m.content || '';
    div.appendChild(body);
    if (m.trace && m.trace.length) {
      const tools = document.createElement('div');
      tools.className = 'ai-tools';
      tools.innerHTML = m.trace.map((t) =>
        `<span class="ai-tool-chip ${t.ok ? '' : 'err'}" title="${esc(JSON.stringify(t.params || {}))}">&#128295; ${esc(t.function)}${t.ok ? ' ✓' : ` ✗ ${esc(t.error || '')}`}</span>`).join('');
      div.appendChild(tools);
    }
    history.appendChild(div);
    history.scrollTop = history.scrollHeight;
  };

  loadAIMessages();
  state.aiMessages.forEach(renderMsg);

  /* ---------- AI provider management ---------- */

  const providerSelect = $('#ai-provider');
  const noProvBox = $('#ai-no-provider');
  let providerDialogId = null;

  const renderProviders = (providers) => {
    providerSelect.innerHTML = '';
    if (!providers.length) {
      providerSelect.innerHTML = '<option value="">No providers configured</option>';
      return;
    }
    providers.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} — ${p.model || 'default model'}${p.builtin ? ' (built-in)' : ''}`;
      providerSelect.appendChild(opt);
    });
  };

  const refreshProviders = async () => {
    const data = await api('/api/ai/providers');
    state.providers = data.providers || [];
    state.activeProviderId = data.activeId || null;
    renderProviders(state.providers);
    const any = state.providers.length > 0;
    noProvBox.classList.toggle('hidden', any);
    $('#ai-send').disabled = !any || state.aiBusy;
    if (any) {
      if (!state.providers.some((p) => p.id === state.activeProviderId)) {
        const fallback = state.providers.find((p) => p.default) || state.providers[0];
        state.activeProviderId = fallback.id;
        await api('/api/ai/active', { method: 'POST', body: { id: fallback.id } });
      }
      providerSelect.value = state.activeProviderId;
    }
  };

  const openDialog = (provider) => {
    providerDialogId = provider ? provider.id : null;
    $('#provider-dialog-title').textContent = provider ? 'Edit AI provider' : 'Add AI provider';
    $('#prov-name').value = provider ? provider.name : '';
    $('#prov-url').value = provider ? provider.baseUrl : '';
    $('#prov-key').value = '';
    $('#prov-key').placeholder = provider ? 'Leave blank to keep the current key' : 'sk-...';
    $('#prov-key').required = !provider;
    $('#prov-model').value = provider ? (provider.model || '') : '';
    $('#prov-error').textContent = '';
    $('#provider-dialog').showModal();
  };

  $('#ai-provider-add').addEventListener('click', () => openDialog(null));
  $('#ai-provider-edit').addEventListener('click', () => {
    const p = state.providers.find((x) => x.id === providerSelect.value);
    if (p) openDialog(p);
  });
  $('#ai-provider-del').addEventListener('click', async () => {
    const p = state.providers.find((x) => x.id === providerSelect.value);
    if (!p) return;
    if (p.builtin) { alert('The built-in provider cannot be deleted.'); return; }
    if (!confirm(`Delete provider "${p.name}"?`)) return;
    try {
      const data = await api(`/api/ai/providers/${p.id}`, { method: 'DELETE' });
      state.providers = data.providers || [];
      state.activeProviderId = data.activeId || null;
      renderProviders(state.providers);
      noProvBox.classList.toggle('hidden', state.providers.length > 0);
      if (state.providers.length) providerSelect.value = state.activeProviderId || state.providers[0].id;
      $('#ai-send').disabled = !state.providers.length || state.aiBusy;
    } catch (e) { alert(e.message); }
  });
  $('#prov-cancel').addEventListener('click', () => $('#provider-dialog').close());
  $('#provider-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#prov-name').value.trim();
    const baseUrl = $('#prov-url').value.trim();
    const key = $('#prov-key').value.trim();
    const model = $('#prov-model').value.trim();
    const errEl = $('#prov-error');
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Name is required.'; return; }
    if (!/^https?:\/\//i.test(baseUrl)) { errEl.textContent = 'Base URL must start with http(s)://'; return; }
    if (!providerDialogId && !key) { errEl.textContent = 'API key is required for a new provider.'; return; }
    try {
      const body = { name, baseUrl, model };
      if (key) body.apiKey = key;
      await api(providerDialogId ? `/api/ai/providers/${providerDialogId}` : '/api/ai/providers',
        { method: providerDialogId ? 'PUT' : 'POST', body });
      $('#provider-dialog').close();
      await refreshProviders();
    } catch (err) { errEl.textContent = err.message; }
  });
  providerSelect.addEventListener('change', async () => {
    const id = providerSelect.value;
    if (!id) return;
    try {
      await api('/api/ai/active', { method: 'POST', body: { id } });
      state.activeProviderId = id;
    } catch (e) { alert(e.message); }
  });

  $('#ai-clear').addEventListener('click', () => {
    if (!state.aiMessages.length) return;
    if (!confirm('Clear this chat history?')) return;
    state.aiMessages = [];
    saveAIMessages();
    history.innerHTML = '';
  });

  refreshProviders().catch((e) => {
    noProvBox.classList.remove('hidden');
    noProvBox.textContent = `Could not load AI providers: ${e.message}`;
  });

  let abortCtrl = null;
  const setSendButton = () => {
    const btn = $('#ai-send');
    if (state.aiBusy) {
      btn.textContent = '⏹';
      btn.title = 'Stop generating';
      btn.classList.add('stop');
      btn.disabled = false;
    } else {
      btn.textContent = 'Send';
      btn.title = '';
      btn.classList.remove('stop');
      btn.disabled = !state.providers.length;
    }
  };

  const send = async () => {
    const input = $('#ai-input');
    const text = input.value.trim();
    if (!text || state.aiBusy) return;
    input.value = '';
    state.aiMessages.push({ role: 'user', content: text });
    renderMsg({ role: 'user', content: text });
    saveAIMessages();

    state.aiBusy = true;
    abortCtrl = new AbortController();
    setSendButton();

    let bubble = null;
    let bodyEl = null;
    let started = false;
    let streamText = '';
    let renderPending = false;

    const renderLive = () => {
      renderPending = false;
      const b = ensureBubble();
      b.innerHTML = renderMarkdown(streamText);
      history.scrollTop = history.scrollHeight;
    };

    const ensureBubble = () => {
      if (bubble) return bodyEl;
      bubble = document.createElement('div');
      bubble.className = 'ai-msg assistant';
      bubble.innerHTML = '<div class="who">Assistant</div>';
      bodyEl = document.createElement('div');
      bodyEl.className = 'body';
      bubble.appendChild(bodyEl);
      history.appendChild(bubble);
      history.scrollTop = history.scrollHeight;
      return bodyEl;
    };

    const addToolChip = (t) => {
      ensureBubble();
      let tools = bubble.querySelector('.ai-tools');
      if (!tools) {
        tools = document.createElement('div');
        tools.className = 'ai-tools';
        bubble.appendChild(tools);
      }
      const chip = document.createElement('span');
      chip.className = `ai-tool-chip ${t.ok ? '' : 'err'}`;
      chip.title = JSON.stringify(t.params || {});
      chip.textContent = `🔧 ${t.function}${t.ok ? ' ✓' : ` ✗ ${t.error || ''}`}`;
      tools.appendChild(chip);
      history.scrollTop = history.scrollHeight;
    };

    try {
      const outcome = await streamAI(state.aiMessages, {
        signal: abortCtrl.signal,
        onStatus: (status) => {
          if (status === 'thinking' && !started) {
            const b = ensureBubble();
            b.innerHTML = '<div class="typing">Thinking…</div>';
          }
        },
        onContent: (chunk) => {
          ensureBubble();
          started = true;
          streamText += chunk;
          if (!renderPending) {
            renderPending = true;
            requestAnimationFrame(renderLive);
          }
        },
        onTool: addToolChip,
      });
      if (bubble) bubble.remove();
      state.aiMessages.push({ role: 'assistant', content: outcome.reply || '', trace: outcome.trace });
      renderMsg({ role: 'assistant', content: outcome.reply || '', trace: outcome.trace });
      saveAIMessages();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // User pressed Stop — keep whatever was streamed so far.
        const partial = streamText || '';
        if (bubble) {
          bodyEl.innerHTML = (partial ? renderMarkdown(partial) : '') + '<div class="stopped-note">⏹ Stopped</div>';
          history.scrollTop = history.scrollHeight;
        } else {
          renderMsg({ role: 'assistant', content: partial ? `${partial}\n\n_⏹ Stopped._` : '_⏹ Stopped._' });
        }
        state.aiMessages.push({ role: 'assistant', content: partial + (partial ? '\n\n' : '') + '_⏹ Stopped._', trace: [] });
      } else {
        if (bubble) bubble.remove();
        renderMsg({ role: 'assistant', content: `⚠️ ${e.message}` });
      }
      saveAIMessages();
    } finally {
      state.aiBusy = false;
      abortCtrl = null;
      setSendButton();
      $('#ai-input').focus();
    }
  };

  $('#ai-send').addEventListener('click', () => {
    if (state.aiBusy) {
      if (abortCtrl) abortCtrl.abort();
    } else {
      send();
    }
  });
  $('#ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  document.querySelectorAll('.ai-suggestion').forEach((el) =>
    el.addEventListener('click', () => {
      $('#ai-input').value = el.textContent;
      send();
    }));
  $('#ai-input').focus();
}

/* ------------------------------------------------------------------ *
 * Boot & navigation wiring
 * ------------------------------------------------------------------ */

function updateMsgBadge(n) {
  const badge = $('#msg-badge');
  if (n > 0) {
    badge.textContent = n > 99 ? '99+' : n;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function showLogin() {
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#user-name').textContent = state.user.fullname;
  $('#user-site').textContent = state.user.sitename || state.siteUrl;
  const avatar = $('#user-avatar');
  if (state.user.picture) avatar.src = img(state.user.picture);
  else avatar.remove();
}

async function init() {
  // Wire global navigate used by inline onclick handlers.
  window.navigate = navigate;
  window.openConversation = openConversation;

  try {
    const cfg = await api('/api/config');
    window.aiConfigured = cfg.aiConfigured;
    if (cfg.defaultSite) $('#login-site').value = cfg.defaultSite;
    if (cfg.defaultUsername) $('#login-username').value = cfg.defaultUsername;
  } catch { /* server reachable? */ }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    $('#login-error').textContent = '';
    try {
      const res = await api('/api/login', {
        method: 'POST',
        body: {
          siteUrl: $('#login-site').value.trim(),
          username: $('#login-username').value.trim(),
          password: $('#login-password').value,
        },
      });
      state.user = res.user;
      state.siteUrl = new URL(res.user.sitename ? document.querySelector('#login-site').value.trim() : '').origin || $('#login-site').value.trim();
      state.siteUrl = $('#login-site').value.trim().replace(/\/+$/, '');
      showApp();
      navigate('dashboard');
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  $('#refresh-btn').addEventListener('click', () => {
    if (state.view === 'courses') state.courses = [];
    navigate(state.view, state.view === 'course' && state.courseDetail ? { course: state.courseDetail } : {});
  });

  document.querySelectorAll('.nav-item[data-view]').forEach((b) =>
    b.addEventListener('click', () => navigate(b.dataset.view)));

  // Try to restore an existing session.
  try {
    const me = await api('/api/me');
    state.user = me.user;
    state.siteUrl = me.siteUrl;
    showApp();
    navigate('dashboard');
  } catch {
    showLogin();
  }
}

document.addEventListener('DOMContentLoaded', init);
