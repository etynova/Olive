'use strict';
const view = document.getElementById('view');
const chats = { home: [], study: [] };
const events = [];
let current = 'home', busy = false, controller = null, ai = false;
const esc = (t) => String(t).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const inl = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
function md(text) {
  const blocks = [];
  const t = esc(text).replace(/```\w*\n?([\s\S]*?)```/g, (_, c) => { blocks.push(`<pre><code>${c}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  return t.split(/\n{2,}/).map((p) => {
    if (/^\u0000\d+\u0000$/.test(p.trim())) return p;
    if (/^\s*([-*]|\d+\.) /.test(p)) { const o = /^\s*\d+\./.test(p) ? 'ol' : 'ul'; return `<${o}>${p.split('\n').map((l) => `<li>${inl(l.replace(/^\s*([-*]|\d+\.) /, ''))}</li>`).join('')}</${o}>`; }
    return `<p>${inl(p).replace(/\n/g, '<br>')}</p>`;
  }).join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}
function log(action) { events.unshift({ time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), action }); }
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

const pages = {
  home: { mode: 'general', pills: ['Help me plan a lesson on photosynthesis', 'Draft a kind message to parents about a field trip', 'Explain fractions to a 9 year old', 'Suggest ways to make a quiet class speak up'], hero: true },
  study: { mode: 'study', pills: ['I am stuck on 5x + 6 = 21', 'Help me understand why the sky is blue', 'Quiz me on the water cycle', 'Help me plan an essay on a book I read'], hero: false },
};
function chatPage(key) {
  const p = pages[key], started = chats[key].length > 0;
  const head = key === 'home'
    ? `<section class="hero"><h1>${greeting()}. I am Olive, your school's own AI.</h1><p>I help staff plan lessons, write clearly and save time, and I help students learn by thinking things through. I am an AI, so I can be wrong. For anything about safety or health, a trusted adult comes first.</p></section>
       <div class="cards"><button class="card" style="--i:0" data-fill="Help me plan a lesson on "><div class="ico">✎</div><h3>Plan and write</h3><p>Lessons, letters, reports and feedback, drafted with you in minutes.</p></button><button class="card" data-c="violet" style="--i:1" data-go="study"><div class="ico">∿</div><h3>Learn by thinking</h3><p>Study buddy asks guiding questions instead of giving the answers away.</p></button><button class="card" data-c="coral" style="--i:2" data-go="desk"><div class="ico">⌂</div><h3>Find your way</h3><p>Rooms, hours and who to ask, from your school's own directory.</p></button></div>`
    : `<section class="head"><h1>Let the question do the work.</h1><p>Study buddy guides you one step at a time, so the learning stays yours. Your teacher can see that you used it, never what you typed.</p></section>`;
  return `<div class="${started ? 'chatting' : ''}" style="display:contents"><div class="aurora"><i></i><i></i><i></i><i></i></div><div class="page">${head}<div class="thread" id="thread" aria-live="polite">${chats[key].map(msgHTML).join('')}</div></div>
  <div class="composer-wrap"><div class="pills">${p.pills.map((q, i) => `<button class="pill" style="--i:${i}" data-fill="${esc(q)}">${esc(q)}</button>`).join('')}</div>
  <div class="composer"><label class="sr-only" for="box">Message Olive</label><textarea id="box" rows="1" maxlength="4000" placeholder="Ask Olive anything…"></textarea><button class="send" id="send" aria-label="Send message" disabled>↑</button></div>
  <div class="fine">Olive is an AI and can make mistakes. Do not share passwords or private health details.</div></div></div>`;
}
const msgHTML = (m, i, a) => m.role === 'user' ? `<div class="msg user"><div class="body">${esc(m.content)}</div></div>`
  : `<div class="msg ai${m.err ? ' err' : ''}${busy && i === a.length - 1 ? ' live' : ''}"><div class="av"></div><div class="body">${m.content ? md(m.content) : '<p>…</p>'}</div></div>`;

function bindChat(key) {
  const box = document.getElementById('box'), send = document.getElementById('send'), thread = document.getElementById('thread');
  const sync = () => { box.style.height = 'auto'; box.style.height = box.scrollHeight + 'px'; send.disabled = !busy && !box.value.trim(); send.textContent = busy ? '■' : '↑'; send.classList.toggle('stop', busy); send.setAttribute('aria-label', busy ? 'Stop' : 'Send message'); };
  const paint = () => { const last = thread.lastElementChild; if (last) { last.className = `msg ai${chats[key].at(-1).err ? ' err' : ''}${busy ? ' live' : ''}`; last.querySelector('.body').innerHTML = chats[key].at(-1).content ? md(chats[key].at(-1).content) : '<p>…</p>'; } scrollTo({ top: document.body.scrollHeight }); };
  async function ask(text) {
    const c = chats[key]; if (busy || !text.trim()) return;
    if (!c.length) log(key === 'study' ? 'Started a Study buddy chat' : 'Started a chat');
    c.push({ role: 'user', content: text }); const history = c.map(({ role, content }) => ({ role, content })); c.push({ role: 'assistant', content: '' });
    view.firstElementChild.classList.add('chatting'); thread.insertAdjacentHTML('beforeend', msgHTML(c.at(-2), c.length - 2, c) + msgHTML(c.at(-1), c.length - 1, c));
    box.value = ''; busy = true; controller = new AbortController(); sync(); scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: pages[key].mode, messages: history }), signal: controller.signal });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error?.message || 'Olive could not answer.'); }
      const rd = r.body.getReader(), dec = new TextDecoder();
      for (;;) { const { done, value } = await rd.read(); if (done) break; c.at(-1).content += dec.decode(value, { stream: true }); paint(); }
    } catch (e) { if (e.name !== 'AbortError') { c.at(-1).content = c.at(-1).content || e.message; c.at(-1).err = !c.at(-1).content || c.at(-1).content === e.message; } }
    busy = false; controller = null; if (!c.at(-1).content) c.at(-1).content = 'Stopped.'; paint(); sync(); box.focus();
  }
  box.addEventListener('input', sync);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(box.value); } });
  send.addEventListener('click', () => busy ? controller?.abort() : ask(box.value));
  view.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => { box.value = b.dataset.fill; sync(); box.focus(); if (b.classList.contains('pill')) ask(box.value); }));
  const examples = ['Ask Olive anything…', 'Help me plan a lesson…', 'Explain this idea simply…', 'Write a kind note to a parent…'];
  let n = 0; const t = setInterval(() => { if (!box.isConnected) return clearInterval(t); if (!box.value) box.placeholder = examples[++n % examples.length]; }, 3600);
  sync(); if (!matchMedia('(pointer: coarse)').matches) box.focus();
}

function deskPage() {
  return `<div class="aurora"><i></i><i></i><i></i><i></i></div><div class="page"><section class="head"><h1>Find it fast, ask a person.</h1><p>Search your school's directory for rooms, hours and contacts. If you need a human, Olive passes your request to the front desk once you confirm.</p></section>
  <div class="panel"><label class="sr-only" for="q">Search the directory</label><input id="q" maxlength="240" placeholder="Where is the library?" autocomplete="off" /><p class="note">Do not enter student records or health details.</p><button class="btn" id="go" style="margin-top:12px">Search the directory</button><div id="out" aria-live="polite"></div></div></div>`;
}
function bindDesk() {
  const q = document.getElementById('q'), out = document.getElementById('out');
  async function run() {
    const text = q.value.trim(); if (!text) return; out.innerHTML = '<p class="note">Searching…</p>';
    try {
      const r = await fetch('/api/integration/search?q=' + encodeURIComponent(text)), j = await r.json(); log('Searched the directory');
      if (!r.ok) throw new Error(j.error?.message || 'Search failed.');
      out.innerHTML = j.results.length ? j.results.map((h, i) => `<div class="hit"><b>${esc(h.title)}</b><p>${esc(h.detail)}</p><button class="btn" data-i="${i}">Ask the front desk to follow up</button></div>`).join('') : '<p class="note">No match found. Try different words, or ask at reception.</p>';
      out.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', async () => {
        const h = j.results[b.dataset.i]; if (!confirm(`Send "${text}" and "${h.title}" to ${j.systemName}?`)) return;
        const res = await fetch('/api/integration/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, query: text, resultTitle: h.title }) }), r2 = await res.json();
        b.replaceWith(Object.assign(document.createElement('p'), { className: 'note', textContent: res.ok ? 'Sent. Someone from the front desk will follow up.' : (r2.error?.message || 'Could not send.') })); if (res.ok) log('Sent a front desk handoff');
      }));
    } catch (e) { out.innerHTML = `<p class="note">${esc(e.message)}</p>`; }
  }
  document.getElementById('go').addEventListener('click', run); q.addEventListener('keydown', (e) => e.key === 'Enter' && run());
}
const logPage = () => `<div class="aurora"><i></i><i></i><i></i><i></i></div><div class="page"><section class="head"><h1>What Olive did today.</h1><p>A plain list of actions in this session. It records what happened, never what anyone typed.</p></section><div class="panel">${events.length ? events.map((e, i) => `<div class="row" style="--i:${i}"><time>${e.time}</time><span>${esc(e.action)}</span></div>`).join('') : '<p class="note">Nothing yet. Start a chat to see activity here.</p>'}</div></div>`;

function show(name) {
  if (busy) controller?.abort();
  current = name; busy = false;
  document.querySelectorAll('#nav button').forEach((b) => { b.classList.toggle('on', b.dataset.view === name); b.toggleAttribute('aria-current', b.dataset.view === name); });
  view.dataset.view = name; view.innerHTML = name === 'desk' ? deskPage() : name === 'log' ? logPage() : chatPage(name);
  if (name === 'desk') bindDesk(); else if (name !== 'log') bindChat(name);
  view.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));
}
document.getElementById('nav').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) show(b.dataset.view); });
fetch('/api/status').then((r) => r.json()).then((s) => { ai = s.ai; document.getElementById('statusDot').classList.toggle('ok', s.ai); document.getElementById('statusText').textContent = s.ai ? 'Olive is online' : 'AI key not set'; }).catch(() => { document.getElementById('statusText').textContent = 'Server unreachable'; });
show('home');
