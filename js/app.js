import { $, $$, uid, esc, html, raw, el, debounce, fmtDate, timeAgo, fmtNum, fmtPct, stripHtml, download, readFile, toast, STATUSES, statusOf, icon } from './util.js';
import { db, onChange, exportAll, importAll } from './db.js';
import { fetchCompanyData, applyAutoData, refreshAll, metrics, suggestTickers, loadTickerIndex } from './data.js';
import { search, highlight, snippet } from './search.js';
import { RichEditor, annotationsFromHtml } from './editor.js';
import { InkEditor, newPage, renderPage, pdfToImages, fileToScaledDataURL } from './ink.js';
import { barChart, lineChart, sparkline } from './charts.js';

const main = $('#main');
const state = { companies: [], notes: [], route: null, cleanup: [], view: '' };

// ---------------------------------------------------------------- bootstrap

async function loadAll() {
  [state.companies, state.notes] = await Promise.all([db.all('companies'), db.all('notes')]);
  state.companies.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

const LIVE_VIEWS = new Set(['dashboard', 'companies', 'notes', 'search']);
const rerender = debounce(async () => {
  await loadAll();
  renderSidebar();
  if (LIVE_VIEWS.has(state.view)) route(true);
}, 150);
onChange(() => rerender());

async function init() {
  renderChrome();
  await loadAll();
  // import the committed research library (data/research.json) once per version; your own later edits always win
  try {
    const r = await fetch('data/research.json', { cache: 'no-cache' });
    if (r.ok) {
      const seed = await r.json();
      const done = await db.getKV('seedIds', []);
      const sid = seed.seedId || 'seed';
      if (!done.includes(sid)) {
        const res = await importAll(seed);
        await db.setKV('seedIds', [...done, sid]);
        await loadAll();
        if (res.companies || res.notes) toast(`Imported ${res.companies} companies and ${res.notes} notes from your research library`, 'ok', 5000);
      }
    }
  } catch (e) { console.warn('seed import', e); }
  renderSidebar();
  window.addEventListener('hashchange', () => route());
  route();
  bindGlobalKeys();
  loadTickerIndex();
  // background auto-refresh (repo snapshots are cheap; live API calls are rate-limited inside refreshAll)
  const auto = await db.getKV('autoRefresh', true);
  const last = await db.getKV('lastRefresh', 0);
  if (auto && state.companies.length && Date.now() - last > 6 * 36e5) {
    refreshAll().then(n => { if (n) { toast(`Auto-updated data for ${n} compan${n === 1 ? 'y' : 'ies'}`, 'ok'); rerender(); } }).catch(console.warn);
  }
}

function renderChrome() {
  const labels = { dashboard: ['home', 'Dashboard'], companies: ['grid', 'Companies'], notes: ['note', 'Notebook'], settings: ['settings', 'Settings & Data'] };
  $$('.nav a').forEach(a => { const [ic, l] = labels[a.dataset.route]; a.innerHTML = `${icon(ic)}<span>${l}</span>`; });
  $('#addCompanyBtn').innerHTML = `${icon('plus')}<span>Company</span>`;
  $('#newNoteBtn').innerHTML = `${icon('pen')}<span>Note</span>`;
  $('#menuBtn').innerHTML = icon('menu');
  setThemeIcon();
  $('#addCompanyBtn').onclick = () => addCompanyModal();
  $('#newNoteBtn').onclick = () => newNoteMenu($('#newNoteBtn'));
  $('#themeBtn').onclick = toggleTheme;
  $('#menuBtn').onclick = () => document.body.classList.toggle('nav-open');
  $('#sidebar').addEventListener('click', e => { if (e.target.closest('a')) document.body.classList.remove('nav-open'); });
  bindGlobalSearch();
}

function setThemeIcon() {
  const dark = isDark();
  $('#themeBtn').innerHTML = icon(dark ? 'sun' : 'moon');
}
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}
function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
  setThemeIcon();
  route(true);
}

function renderSidebar() {
  const pinned = [...state.companies.filter(c => c.pinned).map(c => ({ href: `#/company/${encodeURIComponent(c.id)}`, label: c.ticker, sub: c.name })),
    ...state.notes.filter(n => n.pinned).map(n => ({ href: `#/note/${n.id}`, label: n.title || 'Untitled', sub: 'note' }))];
  $('#pinned').innerHTML = pinned.length ? pinned.map(p => `<a href="${p.href}" title="${esc(p.sub)}">${icon('pin', 14)}<span>${esc(p.label)}</span></a>`).join('') : '<div class="muted small pad-x">Pin companies or notes for quick access.</div>';
  const counts = {};
  [...state.companies, ...state.notes].forEach(x => (x.tags || []).forEach(t => (counts[t] = (counts[t] || 0) + 1)));
  const tags = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 30);
  $('#tagcloud').innerHTML = tags.length ? tags.map(([t, n]) => `<a class="tag" href="#/search?q=${encodeURIComponent('tag:' + quoteIfNeeded(t))}">${esc(t)} <small>${n}</small></a>`).join('') : '<div class="muted small pad-x">Tags appear here.</div>';
  $('#sideFoot').innerHTML = `<span>${state.companies.length} companies · ${state.notes.length} notes</span>`;
}
const quoteIfNeeded = t => (/\s/.test(t) ? `"${t}"` : t);

// ---------------------------------------------------------------- router

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { parts, params: new URLSearchParams(qs || '') };
}

async function route(soft = false) {
  const { parts, params } = parseHash();
  const name = parts[0] || 'dashboard';
  if (!soft) { state.cleanup.forEach(f => f()); state.cleanup = []; }
  else if (!LIVE_VIEWS.has(name)) return;
  state.view = name;
  if (!soft && name !== 'search') { $('#globalSearch').value = ''; $('#searchDrop').hidden = true; }
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === name || (name === 'company' && a.dataset.route === 'companies') || (name === 'note' && a.dataset.route === 'notes')));
  const scroll = soft ? main.scrollTop : 0;
  try {
    switch (name) {
      case 'companies': viewCompanies(params); break;
      case 'company': await viewCompany(parts[1], params); break;
      case 'notes': viewNotes(params); break;
      case 'note': await viewNote(parts[1]); break;
      case 'search': viewSearch(params.get('q') || ''); break;
      case 'settings': await viewSettings(); break;
      default: viewDashboard();
    }
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="page"><div class="empty">Something went wrong: ${esc(e.message)}</div></div>`;
  }
  if (soft) main.scrollTop = scroll; else { main.scrollTop = 0; main.focus({ preventScroll: true }); }
}

/** Keep the in-memory search index in step with silent autosaves. */
function syncState(store, obj) {
  const list = store === 'notes' ? state.notes : state.companies;
  const i = list.findIndex(x => x.id === obj.id);
  if (i >= 0) list[i] = obj; else list.push(obj);
}

const go = h => { if (location.hash === h) route(); else location.hash = h; };

// ---------------------------------------------------------------- shared bits

function statusPill(s) { const st = statusOf(s); return `<span class="pill" style="--pc:${st.color}">${esc(st.label)}</span>`; }
function stars(n, editable = false) {
  return `<span class="stars${editable ? ' editable' : ''}" role="${editable ? 'radiogroup' : 'img'}" aria-label="Conviction ${n || 0} of 5">${[1, 2, 3, 4, 5].map(i => `<button type="button" data-star="${i}" class="${i <= (n || 0) ? 'on' : ''}" ${editable ? '' : 'tabindex="-1" disabled'} aria-label="${i} star">${icon('star', 15)}</button>`).join('')}</span>`;
}
function tagChips(tags = [], removable = false) {
  return tags.map(t => `<span class="tag">${esc(t)}${removable ? `<button data-rmtag="${esc(t)}" aria-label="Remove tag">×</button>` : ''}</span>`).join('');
}
const CUR = { USD: '$', INR: '₹', EUR: '€', GBP: '£', JPY: '¥', KRW: '₩', TWD: 'NT$' };
const money = (v, cur = 'USD') => (v == null || isNaN(v) ? '—' : fmtNum(v, { digits: 2, prefix: CUR[cur] || (cur + ' ') }));
const latestVerdict = c => (c.reports || []).find(r => r.verdict)?.verdict || null;
const verdictPill = v => (v ? `<span class="pill verdict" style="--pc:${/UNDER/.test(v) ? 'var(--st-owned)' : /OVER/.test(v) ? 'var(--st-sold)' : 'var(--st-watch)'}">${esc(v.toLowerCase())}</span>` : '<span class="muted">—</span>');
const big = v => (v == null ? '—' : fmtNum(v, { compact: true, digits: 1, prefix: v < 0 ? '-$' : '$' }).replace('$-', ''));
const bigAbs = v => (v == null ? '—' : (v < 0 ? '-' : '') + fmtNum(Math.abs(v), { compact: true, digits: 1, prefix: '$' }));
const pct = v => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(1) + '%');
const upCls = v => (v == null ? '' : v >= 0 ? 'pos' : 'neg');

function tagsEditor(host, tags, onChange) {
  const render = () => {
    host.innerHTML = `<div class="tags-edit">${tagChips(tags, true)}<input placeholder="${tags.length ? '+ tag' : 'Add tags (Enter)…'}" list="tagList" aria-label="Add tag"></div>`;
    const inp = host.querySelector('input');
    inp.onkeydown = e => {
      if ((e.key === 'Enter' || e.key === ',') && inp.value.trim()) {
        e.preventDefault();
        inp.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(t => { if (!tags.includes(t)) tags.push(t); });
        onChange(tags); render(); host.querySelector('input').focus();
      } else if (e.key === 'Backspace' && !inp.value && tags.length) { tags.pop(); onChange(tags); render(); host.querySelector('input').focus(); }
    };
    inp.onblur = () => { if (inp.value.trim()) { inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); } };
    host.querySelectorAll('[data-rmtag]').forEach(b => (b.onclick = () => { tags.splice(tags.indexOf(b.dataset.rmtag), 1); onChange(tags); render(); }));
  };
  ensureTagDatalist();
  render();
}
function ensureTagDatalist() {
  let dl = $('#tagList');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'tagList'; document.body.appendChild(dl); }
  const all = new Set();
  [...state.companies, ...state.notes].forEach(x => (x.tags || []).forEach(t => all.add(t)));
  dl.innerHTML = [...all].sort().map(t => `<option value="${esc(t)}">`).join('');
}

function modal(title, bodyHtml, { wide = false, onClose } = {}) {
  const m = el(`<div class="modal-backdrop"><div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">${bodyHtml}</div></div></div>`);
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  m.addEventListener('mousedown', e => { if (e.target === m) close(); });
  m.querySelector('[data-close]').onclick = close;
  document.addEventListener('keydown', onKey);
  $('#modalRoot').appendChild(m);
  setTimeout(() => m.querySelector('input, textarea, select, button:not([data-close])')?.focus(), 30);
  return { el: m, close };
}

function newNoteMenu(anchor, companyId = null) {
  $$('.popmenu').forEach(x => x.remove());
  const menu = el(`<div class="popmenu" role="menu">
    <button data-k="text">${icon('type')}<span><b>Typed note</b><small>Rich text with highlights & comments</small></span></button>
    <button data-k="ink">${icon('pen')}<span><b>Handwritten note</b><small>Pen, stylus or touch</small></span></button>
    <button data-k="annotate">${icon('image')}<span><b>Annotate a file</b><small>Mark up a PDF, chart or screenshot</small></span></button>
  </div>`);
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + 6 + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + 'px';
  const off = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off));
  menu.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    menu.remove();
    if (b.dataset.k === 'annotate') return annotateFilePicker(companyId);
    const n = await createNote({ companyId, mode: b.dataset.k });
    go(`#/note/${n.id}`);
  };
}

async function createNote({ companyId = null, mode = 'text', title = '', html: h = '', pages = null } = {}) {
  const co = companyId && state.companies.find(c => c.id === companyId);
  const n = {
    id: uid('n'), companyId, title: title || (co ? `${co.ticker} – ${fmtDate(Date.now())}` : `Note – ${fmtDate(Date.now())}`),
    html: h, text: stripHtml(h), mode, ink: pages || (mode === 'ink' ? [newPage()] : []), tags: [], pinned: false,
    createdAt: Date.now(),
  };
  await db.put('notes', n);
  state.notes.push(n);
  return n;
}

function annotateFilePicker(companyId) {
  const inp = el('<input type="file" accept="image/*,application/pdf" hidden>');
  document.body.appendChild(inp);
  inp.onchange = async () => {
    const f = inp.files[0]; inp.remove(); if (!f) return;
    const n = await noteFromFile(f, companyId);
    if (n) go(`#/note/${n.id}`);
  };
  inp.click();
}

async function noteFromFile(file, companyId) {
  toast('Preparing pages…');
  let images = [];
  if (file.type === 'application/pdf') images = await pdfToImages(file);
  else images = [await fileToScaledDataURL(file)];
  if (!images.length) return null;
  const pages = [];
  for (const src of images) {
    const img = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    pages.push(newPage({ paper: 'blank', bgImage: src, h: Math.round(1000 * img.height / img.width) }));
  }
  return createNote({ companyId, mode: 'ink', title: file.name.replace(/\.[^.]+$/, ''), pages });
}

// ---------------------------------------------------------------- global search

function bindGlobalSearch() {
  const inp = $('#globalSearch'), drop = $('#searchDrop');
  let sel = -1, items = [];
  const renderDrop = () => {
    const q = inp.value.trim();
    if (!q) { drop.hidden = true; return; }
    const { results, tokens } = search(q, state);
    items = results.slice(0, 8);
    drop.innerHTML = (items.length ? items.map((r, i) => resultRow(r, tokens, i === sel)).join('') : `<div class="drop-empty">No matches. Press Enter to search everything.</div>`)
      + `<a class="drop-all" href="#/search?q=${encodeURIComponent(q)}">See all ${results.length} results · filters: <code>tag:</code> <code>status:</code> <code>sector:</code> <code>upside:&gt;20</code></a>`;
    drop.hidden = false;
  };
  inp.addEventListener('input', () => { sel = -1; renderDrop(); });
  inp.addEventListener('focus', renderDrop);
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); renderDrop(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(-1, sel - 1); renderDrop(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = items[sel];
      go(r ? hrefOf(r) : `#/search?q=${encodeURIComponent(inp.value.trim())}`);
      drop.hidden = true; inp.blur();
    } else if (e.key === 'Escape') { drop.hidden = true; inp.blur(); }
  });
  document.addEventListener('mousedown', e => { if (!e.target.closest('.search-wrap')) drop.hidden = true; });
  drop.addEventListener('click', e => { if (e.target.closest('a')) { drop.hidden = true; inp.blur(); } });
}

function hrefOf(r) { return r.kind === 'company' ? `#/company/${encodeURIComponent(r.item.id)}` : `#/note/${r.item.id}`; }

function resultRow(r, tokens, active = false) {
  if (r.kind === 'company') {
    const c = r.item;
    return `<a class="result${active ? ' active' : ''}" href="${hrefOf(r)}"><span class="r-ic">${icon('grid', 16)}</span><span class="r-main"><b>${highlight(esc(c.ticker), tokens)}</b> ${highlight(esc(c.name || ''), tokens)}<small>${esc([c.sector, statusOf(c.status).label].filter(Boolean).join(' · '))}</small></span></a>`;
  }
  const n = r.item;
  return `<a class="result${active ? ' active' : ''}" href="${hrefOf(r)}"><span class="r-ic">${icon(n.mode === 'ink' ? 'pen' : 'note', 16)}</span><span class="r-main"><b>${highlight(esc(n.title || 'Untitled'), tokens)}</b>${r.company ? ` <span class="muted">${esc(r.company.ticker)}</span>` : ''}<small>${highlight(esc(r.snippet || ''), tokens)}</small></span></a>`;
}

function bindGlobalKeys() {
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#globalSearch').focus(); $('#globalSearch').select(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || $('.modal')) return;
    if (e.key === '/') { e.preventDefault(); $('#globalSearch').focus(); }
    else if (e.key === 'c' && state.view !== 'note') { e.preventDefault(); addCompanyModal(); }
    else if (e.key === 'n' && state.view !== 'note') { e.preventDefault(); newNoteMenu($('#newNoteBtn'), state.view === 'company' ? parseHash().parts[1] : null); }
  });
}

// ---------------------------------------------------------------- dashboard

function viewDashboard() {
  const cs = state.companies;
  const counts = Object.fromEntries(STATUSES.map(s => [s.id, cs.filter(c => (c.status || 'idea') === s.id).length]));
  const withM = cs.map(c => ({ c, m: metrics(c) }));
  const opportunities = withM.filter(x => x.m.upside != null && ['watchlist', 'researching', 'owned'].includes(x.c.status)).sort((a, b) => b.m.upside - a.m.upside).slice(0, 6);
  const belowBuy = withM.filter(x => x.c.buyBelow && x.m.price && x.m.price <= Number(x.c.buyBelow));
  const recentCos = [...cs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6);
  const recentNotes = [...state.notes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6);
  const openAnn = [
    ...state.notes.map(n => ({ src: n, href: `#/note/${n.id}`, title: n.title, html: n.html })),
    ...cs.map(c => ({ src: c, href: `#/company/${encodeURIComponent(c.id)}?tab=thesis`, title: `${c.ticker} thesis`, html: c.thesisHtml })),
  ].sort((a, b) => (b.src.updatedAt || 0) - (a.src.updatedAt || 0))
    .flatMap(d => annotationsFromHtml(d.html).filter(a => a.note).map(a => ({ ...a, d }))).slice(0, 6);
  const cById = new Map(cs.map(c => [c.id, c]));

  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Dashboard</h1><p class="muted">Your research at a glance.</p></div></div>
    ${!cs.length ? `<div class="hero-empty card">
        <h2>Start your research library</h2>
        <p>Add a company by ticker — profile, financials and price fill in automatically when data is available. Then capture typed or handwritten notes, highlight and comment on them, and find everything with one search box.</p>
        <div class="row gap"><button class="btn primary" data-act="add">${icon('plus')} Add your first company</button><button class="btn" data-act="note">${icon('pen')} Write a note</button><a class="btn ghost" href="#/settings">${icon('upload')} Import a backup</a></div>
      </div>` : ''}
    <div class="tiles">
      ${STATUSES.map(s => `<a class="tile" href="#/companies?status=${s.id}" style="--pc:${s.color}"><span class="tile-label"><i class="dot"></i>${s.label}</span><span class="tile-num">${counts[s.id]}</span></a>`).join('')}
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>Quick capture</h2><span class="muted small">Saved as a typed note</span></div>
        <textarea id="qcText" rows="4" placeholder="Jot an idea, a quote from a call, a question to check…"></textarea>
        <div class="row gap wrap">
          <select id="qcCo" aria-label="Company"><option value="">No company</option>${cs.map(c => `<option value="${esc(c.id)}">${esc(c.ticker)} – ${esc(c.name || '')}</option>`).join('')}</select>
          <button class="btn primary" id="qcSave">Save note</button>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Biggest upside to fair value</h2><a class="small" href="#/companies?sort=upside">All</a></div>
        ${opportunities.length ? `<table class="mini"><tbody>${opportunities.map(({ c, m }) => `<tr data-href="#/company/${encodeURIComponent(c.id)}"><td><b>${esc(c.ticker)}</b></td><td class="muted ellipsis">${esc(c.name || '')}</td><td class="num">${money(m.price, c.currency)}</td><td class="num">${money(Number(c.fairValue), c.currency)}</td><td class="num ${upCls(m.upside)}">${fmtPct(m.upside)}</td></tr>`).join('')}</tbody></table>`
          : '<div class="empty small">Set a fair value on a company to rank opportunities here.</div>'}
        ${belowBuy.length ? `<div class="alert">${icon('check', 16)} Trading below your buy price: ${belowBuy.map(x => `<a href="#/company/${encodeURIComponent(x.c.id)}">${esc(x.c.ticker)}</a>`).join(', ')}</div>` : ''}
      </section>
      <section class="card">
        <div class="card-head"><h2>Recently updated companies</h2><a class="small" href="#/companies">All</a></div>
        ${recentCos.length ? `<div class="list">${recentCos.map(c => companyRow(c)).join('')}</div>` : '<div class="empty small">No companies yet.</div>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>Recent notes</h2><a class="small" href="#/notes">Notebook</a></div>
        ${recentNotes.length ? `<div class="list">${recentNotes.map(n => noteRow(n, cById.get(n.companyId))).join('')}</div>` : '<div class="empty small">No notes yet.</div>'}
      </section>
      ${openAnn.length ? `<section class="card span-2">
        <div class="card-head"><h2>Recent annotations</h2><a class="small" href="#/search?q=is:annotated">All annotated notes</a></div>
        <div class="ann-list">${openAnn.map(a => `<a class="ann" href="${a.d.href}${a.d.href.includes('?') ? '&' : '?'}a=${a.id}"><mark data-color="${esc(a.color)}">${esc(a.text.slice(0, 120))}</mark><span>${esc(a.note)}</span><small>${esc(a.d.title)}</small></a>`).join('')}</div>
      </section>` : ''}
    </div>
  </div>`;
  main.querySelector('[data-act=add]')?.addEventListener('click', () => addCompanyModal());
  main.querySelector('[data-act=note]')?.addEventListener('click', e => newNoteMenu(e.currentTarget));
  $('#qcSave').onclick = async () => {
    const t = $('#qcText').value.trim(); if (!t) return;
    const h = t.split(/\n+/).map(p => `<p>${esc(p)}</p>`).join('');
    await createNote({ companyId: $('#qcCo').value || null, html: h, title: t.split('\n')[0].slice(0, 60) });
    $('#qcText').value = ''; toast('Note saved', 'ok');
  };
  bindRowLinks(main);
}

function companyRow(c) {
  const m = metrics(c);
  return `<a class="row-link" href="#/company/${encodeURIComponent(c.id)}"><b class="tk">${esc(c.ticker)}</b><span class="ellipsis">${esc(c.name || '')}</span>${statusPill(c.status)}<span class="num">${money(m.price)}</span><small class="muted">${timeAgo(c.updatedAt)}</small></a>`;
}
function noteRow(n, co) {
  const ink = (n.ink || []).some(p => p.strokes?.length || p.bgImage);
  return `<a class="row-link" href="#/note/${n.id}">${icon(ink && !n.text ? 'pen' : 'note', 16)}<span class="ellipsis"><b>${esc(n.title || 'Untitled')}</b> <span class="muted">${esc((n.text || '').slice(0, 80))}</span></span>${co ? `<span class="tag">${esc(co.ticker)}</span>` : ''}<small class="muted">${timeAgo(n.updatedAt)}</small></a>`;
}
function bindRowLinks(root) {
  root.querySelectorAll('tr[data-href]').forEach(tr => { tr.tabIndex = 0; tr.onclick = () => go(tr.dataset.href); tr.onkeydown = e => { if (e.key === 'Enter') go(tr.dataset.href); }; });
}

// ---------------------------------------------------------------- companies list

const COLS = [
  ['ticker', 'Ticker'], ['name', 'Company'], ['status', 'Status'], ['rating', 'Conviction'], ['sector', 'Sector'],
  ['verdict', 'Verdict'], ['price', 'Price', 'num'], ['fair', 'Fair value', 'num'], ['upside', 'Upside', 'num'], ['mcap', 'Mkt cap', 'num'],
  ['pe', 'P/E', 'num'], ['growth', 'Rev growth', 'num'], ['margin', 'Net margin', 'num'], ['notes', 'Notes', 'num'], ['updated', 'Updated', 'num'],
];

function viewCompanies(params) {
  const pref = JSON.parse(localStorage.getItem('companies.view') || '{}');
  const f = {
    status: params.get('status') ?? pref.status ?? '', sector: params.get('sector') ?? pref.sector ?? '', tag: params.get('tag') ?? '',
    q: params.get('q') ?? '', sort: params.get('sort') ?? pref.sort ?? 'ticker', dir: params.get('dir') ?? pref.dir ?? 'asc', layout: pref.layout || 'table',
  };
  const save = () => localStorage.setItem('companies.view', JSON.stringify({ status: f.status, sector: f.sector, sort: f.sort, dir: f.dir, layout: f.layout }));
  const sectors = [...new Set(state.companies.map(c => c.sector).filter(Boolean))].sort();
  const tags = [...new Set(state.companies.flatMap(c => c.tags || []))].sort();
  const noteCount = {}; state.notes.forEach(n => n.companyId && (noteCount[n.companyId] = (noteCount[n.companyId] || 0) + 1));

  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Companies</h1><p class="muted">${state.companies.length} in your library</p></div>
      <div class="row gap"><button class="btn" id="exportCsv">${icon('download')} CSV</button><button class="btn primary" id="addCo">${icon('plus')} Add company</button></div></div>
    <div class="filters">
      <div class="chips" role="group" aria-label="Status">
        <button class="chip${!f.status ? ' active' : ''}" data-status="">All</button>
        ${STATUSES.map(s => `<button class="chip${f.status === s.id ? ' active' : ''}" data-status="${s.id}" style="--pc:${s.color}"><i class="dot"></i>${s.label}</button>`).join('')}
      </div>
      <div class="row gap wrap">
        <input id="coFilter" type="search" placeholder="Filter…" value="${esc(f.q)}" aria-label="Filter companies">
        <select id="coSector" aria-label="Sector"><option value="">All sectors</option>${sectors.map(s => `<option ${s === f.sector ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <select id="coTag" aria-label="Tag"><option value="">All tags</option>${tags.map(s => `<option ${s === f.tag ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <div class="seg-toggle"><button data-layout="table" class="${f.layout === 'table' ? 'active' : ''}" title="Table">${icon('list')}</button><button data-layout="cards" class="${f.layout === 'cards' ? 'active' : ''}" title="Cards">${icon('grid')}</button></div>
      </div>
    </div>
    <div id="coList"></div>
  </div>`;

  const renderList = () => {
    const q = f.q.toLowerCase();
    let rows = state.companies.filter(c =>
      (!f.status || (c.status || 'idea') === f.status) && (!f.sector || c.sector === f.sector) && (!f.tag || (c.tags || []).includes(f.tag)) &&
      (!q || [c.ticker, c.name, c.sector, c.industry, ...(c.tags || [])].join(' ').toLowerCase().includes(q)))
      .map(c => ({ c, m: metrics(c) }));
    const key = {
      ticker: x => x.c.ticker, name: x => x.c.name || '', status: x => STATUSES.findIndex(s => s.id === x.c.status), rating: x => x.c.rating || 0,
      sector: x => x.c.sector || '', verdict: x => latestVerdict(x.c) || '', price: x => x.m.price, fair: x => Number(x.c.fairValue) || null, upside: x => x.m.upside, mcap: x => x.m.marketCap,
      pe: x => x.m.pe, growth: x => x.m.revGrowth, margin: x => x.m.netMargin, notes: x => noteCount[x.c.id] || 0, updated: x => x.c.updatedAt,
    }[f.sort] || (x => x.c.ticker);
    rows.sort((a, b) => {
      const va = key(a), vb = key(b);
      if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
      const r = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return f.dir === 'asc' ? r : -r;
    });
    const host = $('#coList');
    if (!rows.length) { host.innerHTML = `<div class="empty">${state.companies.length ? 'No companies match these filters.' : 'No companies yet — add one to get started.'}</div>`; return; }
    if (f.layout === 'cards') {
      host.innerHTML = `<div class="cards">${rows.map(({ c, m }) => `<a class="co-card card" href="#/company/${encodeURIComponent(c.id)}">
        <div class="row between"><b class="tk-lg">${esc(c.ticker)}</b>${statusPill(c.status)}</div>
        <div class="ellipsis">${esc(c.name || '')}</div>
        <div class="muted small ellipsis">${esc([c.sector, c.industry].filter(Boolean).join(' · ') || '—')}</div>
        <div class="row between"><span class="num big">${money(m.price, c.currency)}</span>${sparkline((c.priceLog || []).map(p => p.price))}</div>
        <div class="row between small"><span>FV ${money(Number(c.fairValue) || null, c.currency)}</span>${verdictPill(latestVerdict(c))}<span class="${upCls(m.upside)}">${fmtPct(m.upside)}</span></div>
        <div class="row between">${stars(c.rating)}<span class="muted small">${noteCount[c.id] || 0} notes</span></div>
        ${c.tags?.length ? `<div class="tags">${tagChips(c.tags.slice(0, 4))}</div>` : ''}
      </a>`).join('')}</div>`;
    } else {
      host.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>${COLS.map(([k, l, cls]) => `<th class="${cls || ''}${f.sort === k ? ' sorted ' + f.dir : ''}" data-sort="${k}" tabindex="0" aria-sort="${f.sort === k ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${l}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(({ c, m }) => `<tr data-href="#/company/${encodeURIComponent(c.id)}">
          <td><b>${esc(c.ticker)}</b>${c.pinned ? ` <span class="muted">${icon('pin', 12)}</span>` : ''}</td><td class="ellipsis w-name">${esc(c.name || '')}</td><td>${statusPill(c.status)}</td><td>${stars(c.rating)}</td>
          <td class="ellipsis w-sector">${esc(c.sector || '—')}</td><td>${verdictPill(latestVerdict(c))}</td><td class="num">${money(m.price, c.currency)}</td><td class="num">${money(Number(c.fairValue) || null, c.currency)}</td>
          <td class="num ${upCls(m.upside)}">${fmtPct(m.upside)}</td><td class="num">${bigAbs(m.marketCap)}</td><td class="num">${m.pe ? m.pe.toFixed(1) : '—'}</td>
          <td class="num ${upCls(m.revGrowth)}">${fmtPct(m.revGrowth)}</td><td class="num">${pct(m.netMargin)}</td><td class="num">${noteCount[c.id] || 0}</td><td class="num muted">${timeAgo(c.updatedAt)}</td>
        </tr>`).join('')}</tbody></table></div>`;
      host.querySelectorAll('th[data-sort]').forEach(th => {
        const act = () => { if (f.sort === th.dataset.sort) f.dir = f.dir === 'asc' ? 'desc' : 'asc'; else { f.sort = th.dataset.sort; f.dir = ['ticker', 'name', 'sector', 'status'].includes(f.sort) ? 'asc' : 'desc'; } save(); renderList(); };
        th.onclick = act; th.onkeydown = e => { if (e.key === 'Enter') act(); };
      });
      bindRowLinks(host);
    }
    state.lastCompanyRows = rows;
  };
  renderList();
  main.querySelectorAll('[data-status]').forEach(b => (b.onclick = () => { f.status = b.dataset.status; save(); main.querySelectorAll('[data-status]').forEach(x => x.classList.toggle('active', x === b)); renderList(); }));
  $('#coFilter').oninput = e => { f.q = e.target.value; renderList(); };
  $('#coSector').onchange = e => { f.sector = e.target.value; save(); renderList(); };
  $('#coTag').onchange = e => { f.tag = e.target.value; renderList(); };
  main.querySelectorAll('[data-layout]').forEach(b => (b.onclick = () => { f.layout = b.dataset.layout; save(); main.querySelectorAll('[data-layout]').forEach(x => x.classList.toggle('active', x === b)); renderList(); }));
  $('#addCo').onclick = () => addCompanyModal();
  $('#exportCsv').onclick = () => {
    const rows = state.lastCompanyRows || [];
    const head = ['Ticker', 'Name', 'Status', 'Conviction', 'Sector', 'Industry', 'Price', 'Fair value', 'Buy below', 'Upside %', 'Market cap', 'P/E', 'Rev growth %', 'Net margin %', 'Tags'];
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map(({ c, m }) => [c.ticker, c.name, statusOf(c.status).label, c.rating || '', c.sector, c.industry, m.price, c.fairValue, c.buyBelow,
      m.upside != null ? (m.upside * 100).toFixed(1) : '', m.marketCap, m.pe?.toFixed(2), m.revGrowth != null ? (m.revGrowth * 100).toFixed(1) : '',
      m.netMargin != null ? (m.netMargin * 100).toFixed(1) : '', (c.tags || []).join('; ')].map(q).join(','));
    download(`companies-${new Date().toISOString().slice(0, 10)}.csv`, [head.map(q).join(','), ...lines].join('\n'), 'text/csv');
  };
}

// ---------------------------------------------------------------- add company

function addCompanyModal(prefill = '') {
  const m = modal('Add company', `
    <form id="addForm" class="form" autocomplete="off">
      <label>Ticker or company name
        <div class="ac-wrap"><input name="ticker" required placeholder="e.g. AAPL, Costco…" value="${esc(prefill)}"><div class="ac-drop" hidden></div></div>
      </label>
      <div class="grid-form">
        <label>Name <input name="name" placeholder="Filled in automatically if available"></label>
        <label>Status <select name="status">${STATUSES.map(s => `<option value="${s.id}" ${s.id === 'researching' ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
      </div>
      <label>Tags <input name="tags" placeholder="comma separated, e.g. compounder, moat, small-cap" list="tagList"></label>
      <label>Why it's interesting <textarea name="why" rows="3" placeholder="One-line thesis or what caught your eye (optional)"></textarea></label>
      <p class="muted small" id="acInfo">Profile, financials and price auto-populate from the repo's SEC data feed or your API key (Settings). You can always edit later.</p>
      <div class="row gap end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Add company</button></div>
    </form>`);
  ensureTagDatalist();
  const form = m.el.querySelector('form');
  form.querySelector('[data-close]').onclick = m.close;
  const tin = form.ticker, drop = form.querySelector('.ac-drop');
  let picked = null;
  tin.addEventListener('input', debounce(async () => {
    picked = null;
    const sug = await suggestTickers(tin.value);
    drop.innerHTML = sug.map(s => `<button type="button" data-t="${esc(s.ticker)}" data-n="${esc(s.name)}"><b>${esc(s.ticker)}</b> ${esc(s.name)} <small>${esc(s.exchange)}</small></button>`).join('');
    drop.hidden = !sug.length;
  }, 120));
  drop.onclick = e => { const b = e.target.closest('button'); if (!b) return; tin.value = b.dataset.t; form.name.value ||= b.dataset.n; picked = b.dataset.t; drop.hidden = true; };
  tin.addEventListener('blur', () => setTimeout(() => (drop.hidden = true), 150));
  form.onsubmit = async e => {
    e.preventDefault();
    let ticker = (picked || tin.value).trim().toUpperCase().replace(/\s+/g, '-');
    if (!ticker) return;
    const exists = state.companies.find(c => c.id === ticker);
    if (exists) { m.close(); go(`#/company/${encodeURIComponent(ticker)}`); toast(`${ticker} is already in your library`); return; }
    const btn = form.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = 'Fetching data…';
    const why = form.why.value.trim();
    const c = {
      id: ticker, ticker, name: form.name.value.trim(), status: form.status.value, rating: 0,
      tags: form.tags.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      thesisHtml: thesisTemplate(why), links: [], createdAt: Date.now(), autoUpdate: true,
    };
    try {
      const d = await fetchCompanyData(ticker);
      if (d) applyAutoData(c, d);
      else toast(`No auto data for ${ticker} yet — see Settings → Auto-populate to enable it.`, 'info', 5000);
    } catch (err) { toast('Data fetch failed: ' + err.message, 'error'); }
    c.thesisText = stripHtml(c.thesisHtml);
    await db.put('companies', c);
    state.companies.push(c);
    m.close();
    go(`#/company/${encodeURIComponent(ticker)}`);
  };
}

function thesisTemplate(why = '') {
  return `<h2>Thesis in one sentence</h2><p>${esc(why) || '<br>'}</p>
<h3>Business & moat</h3><p><br></p>
<h3>Bull case</h3><ul><li><br></li></ul>
<h3>Bear case</h3><ul><li><br></li></ul>
<h3>Catalysts</h3><ul><li><br></li></ul>
<h3>Key risks / what would make me wrong</h3><ul><li><br></li></ul>
<h3>Valuation</h3><p><br></p>
<h3>Questions to answer</h3><ul class="checklist"><li><input type="checkbox">&nbsp;</li></ul>`;
}

// ---------------------------------------------------------------- company detail

async function viewCompany(id, params) {
  let c = await db.get('companies', id);
  if (!c) { main.innerHTML = `<div class="page"><div class="empty">Company “${esc(id)}” not found. <a href="#/companies">Back to companies</a></div></div>`; return; }
  const tab = params.get('tab') || 'overview';
  const save = debounce(async () => { c.updatedAt = Date.now(); await db.put('companies', c, { silent: true }); syncState('companies', c); }, 500);
  state.cleanup.push(() => save.flush());
  const saveNow = async () => { await db.put('companies', c); };
  const notes = state.notes.filter(n => n.companyId === c.id).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const files = await db.byIndex('files', 'companyId', c.id);

  const renderHeader = () => {
    const m = metrics(c);
    return `<div class="co-head">
      <div class="co-title">
        <div class="row gap wrap baseline"><h1>${esc(c.ticker)}</h1><span class="co-name" contenteditable="true" spellcheck="false" data-field="name" aria-label="Company name">${esc(c.name || 'Company name')}</span></div>
        <div class="muted small">${esc([c.exchange, c.sector, c.industry, c.country].filter(Boolean).join(' · ') || 'Add sector & industry in Profile')}</div>
        <div class="row gap wrap mt">
          <select id="coStatus" class="status-select" aria-label="Status">${STATUSES.map(s => `<option value="${s.id}" ${s.id === (c.status || 'idea') ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
          ${stars(c.rating, true)}
          <div id="coTags"></div>
        </div>
      </div>
      <div class="co-price">
        <div class="price">${money(m.price, c.currency)}</div>
        ${c.auto?.price?.changePct != null ? `<div class="small ${upCls(c.auto.price.changePct)}">${c.auto.price.changePct >= 0 ? '+' : ''}${Number(c.auto.price.changePct).toFixed(2)}% today</div>` : ''}
        <div class="muted small">${c.auto?.price?.date ? 'as of ' + esc(c.auto.price.date) : c.manualPrice ? 'manual price' : 'no price yet'}</div>
        <div class="row gap mt">
          <button class="icon-btn${c.pinned ? ' on' : ''}" id="pinBtn" title="${c.pinned ? 'Unpin' : 'Pin to sidebar'}">${icon('pin')}</button>
          <button class="icon-btn" id="refreshBtn" title="Refresh data now">${icon('refresh')}</button>
          <button class="icon-btn" id="delBtn" title="Delete company">${icon('trash')}</button>
        </div>
      </div>
    </div>`;
  };

  const TABS = [['overview', 'Overview'], ['reports', `Reports (${(c.reports || []).length})`], ['thesis', 'Thesis'], ['financials', 'Financials'], ['notes', `Notes (${notes.length})`], ['files', `Files (${files.length})`]];
  main.innerHTML = `<div class="page company-page">
    <a class="back" href="#/companies">← Companies</a>
    <div id="coHead">${renderHeader()}</div>
    <nav class="tabs" role="tablist">${TABS.map(([k, l]) => `<a role="tab" href="#/company/${encodeURIComponent(c.id)}?tab=${k}" class="${k === tab ? 'active' : ''}" aria-selected="${k === tab}">${l}</a>`).join('')}</nav>
    <div id="tabBody"></div>
  </div>`;

  const bindHeader = () => {
    const head = $('#coHead');
    head.querySelector('[data-field=name]').onblur = e => { c.name = e.target.textContent.trim(); saveNow(); };
    head.querySelector('[data-field=name]').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
    $('#coStatus').onchange = e => { c.status = e.target.value; saveNow(); };
    head.querySelectorAll('.stars.editable [data-star]').forEach(b => (b.onclick = () => {
      c.rating = c.rating === +b.dataset.star ? 0 : +b.dataset.star;
      head.querySelectorAll('[data-star]').forEach(x => x.classList.toggle('on', +x.dataset.star <= c.rating)); saveNow();
    }));
    tagsEditor($('#coTags'), c.tags ||= [], () => saveNow());
    $('#pinBtn').onclick = async () => { c.pinned = !c.pinned; await saveNow(); $('#pinBtn').classList.toggle('on', c.pinned); };
    $('#delBtn').onclick = async () => {
      if (!confirm(`Delete ${c.ticker}? Its notes are kept but unlinked; attached files are deleted.`)) return;
      for (const n of notes) { n.companyId = null; await db.put('notes', n, { silent: true }); }
      for (const f of files) await db.del('files', f.id);
      await db.del('companies', c.id);
      toast(`${c.ticker} deleted`); go('#/companies');
    };
    $('#refreshBtn').onclick = async () => {
      const b = $('#refreshBtn'); b.classList.add('spin');
      try {
        const d = await fetchCompanyData(c.ticker, { preferLive: true });
        if (d) { applyAutoData(c, d); await saveNow(); toast('Data refreshed', 'ok'); route(); }
        else toast('No data source available for this ticker. See Settings → Auto-populate.', 'info', 5000);
      } catch (e) { toast(e.message, 'error'); } finally { b.classList.remove('spin'); }
    };
  };
  bindHeader();

  const body = $('#tabBody');
  if (tab === 'overview') renderOverview();
  else if (tab === 'reports') renderReports();
  else if (tab === 'thesis') renderThesis();
  else if (tab === 'financials') renderFinancials();
  else if (tab === 'notes') renderNotes();
  else if (tab === 'files') renderFiles();

  function renderOverview() {
    const m = metrics(c);
    const kv = [
      ['Market cap', bigAbs(m.marketCap)], ['P/E', m.pe ? m.pe.toFixed(1) + '×' : '—'], ['P/FCF', m.pfcf ? m.pfcf.toFixed(1) + '×' : '—'], ['P/S', m.ps ? m.ps.toFixed(1) + '×' : '—'],
      ['FCF yield', pct(m.fcfYield)], [`Revenue FY${m.fy || ''}`, bigAbs(m.revenue)], ['Revenue growth', fmtPct(m.revGrowth)], [`Revenue CAGR (${m.cagrYears || 0}y)`, fmtPct(m.revCagr)],
      ['Gross margin', pct(m.grossMargin)], ['Operating margin', pct(m.opMargin)], ['Net margin', pct(m.netMargin)], ['FCF margin', pct(m.fcfMargin)],
      ['ROE', pct(m.roe)], ['Debt / equity', m.debtToEquity != null ? m.debtToEquity.toFixed(2) : '—'], ['EPS (diluted)', money(m.eps)], ['Net income', bigAbs(m.netIncome)],
    ];
    const recentNotes = notes.slice(0, 4);
    const secUrl = c.cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(c.cik)}&type=10-K&dateb=&owner=include&count=40` : null;
    const lr = (c.reports || [])[0];
    const banner = lr ? `<section class="card report-banner span-2"><div class="row between wrap gap"><div><span class="muted small">Latest research · ${esc(lr.date || '')}</span><div><b>${esc(lr.title)}</b> ${lr.verdict ? verdictPill(lr.verdict) : ''}</div></div>
      <a class="btn small" href="#/company/${encodeURIComponent(c.id)}?tab=reports">All ${(c.reports || []).length} reports</a></div>${lr.summary ? `<p class="report-sum">${esc(lr.summary)}</p>` : ''}</section>` : '';
    body.innerHTML = `<div class="grid-2">${banner}
      <section class="card">
        <div class="card-head"><h2>Valuation</h2><span class="muted small">Your numbers</span></div>
        <div class="grid-form three">
          <label>Fair value / share (${esc(c.currency || 'USD')}) <input type="number" step="0.01" data-f="fairValue" value="${esc(c.fairValue ?? '')}" placeholder="—"></label>
          <label>Buy below <input type="number" step="0.01" data-f="buyBelow" value="${esc(c.buyBelow ?? '')}" placeholder="—"></label>
          <label>Manual price <input type="number" step="0.01" data-f="manualPrice" value="${esc(c.manualPrice ?? '')}" placeholder="auto"></label>
        </div>
        <div class="val-bar">${valuationBar(m.price, Number(c.buyBelow) || null, Number(c.fairValue) || null)}</div>
        <div class="row between"><span class="muted small">Upside to fair value</span><b id="upsideVal" class="${upCls(m.upside)}">${fmtPct(m.upside)}</b></div>
        <div class="chart-title mt">Price history${c.fairValue ? ' vs. fair value' : ''}</div>
        <div id="priceChart"></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Key metrics</h2><span class="muted small">${c.auto?.source ? `${esc(c.auto.source)} · ${timeAgo(Date.parse(c.auto.fetchedAt))}` : 'No auto data yet'}</span></div>
        <dl class="kv">${kv.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>
      </section>
      <section class="card">
        <div class="card-head"><h2>Profile</h2><label class="chk small"><input type="checkbox" id="autoUpd" ${c.autoUpdate !== false ? 'checked' : ''}> Auto-update</label></div>
        <div class="grid-form">
          ${['sector', 'industry', 'exchange', 'country', 'website', 'cik'].map(k => `<label>${k === 'cik' ? 'SEC CIK' : k[0].toUpperCase() + k.slice(1)} <input data-f="${k}" value="${esc(c[k] ?? '')}"></label>`).join('')}
        </div>
        <label class="mt">Description <textarea data-f="description" rows="5">${esc(c.description || '')}</textarea></label>
      </section>
      <section class="card">
        <div class="card-head"><h2>Links & sources</h2><button class="btn small" id="addLink">${icon('plus', 14)} Link</button></div>
        <div class="list" id="links">
          ${secUrl ? `<a class="row-link" href="${secUrl}" target="_blank" rel="noopener">${icon('external', 16)}<span>SEC filings (EDGAR)</span><small class="muted">auto</small></a>` : ''}
          ${c.website ? `<a class="row-link" href="${esc(/^https?:/.test(c.website) ? c.website : 'https://' + c.website)}" target="_blank" rel="noopener">${icon('external', 16)}<span>Company website</span><small class="muted">auto</small></a>` : ''}
          ${(c.auto?.filings || []).slice(0, 5).map(f => `<a class="row-link" href="${esc(f.url)}" target="_blank" rel="noopener">${icon('file', 16)}<span>${esc(f.form)} · ${esc(f.date)}</span><small class="muted">filing</small></a>`).join('')}
          ${(c.links || []).map((l, i) => `<div class="row-link"><a href="${esc(l.url)}" target="_blank" rel="noopener" class="grow">${icon('link', 16)} ${esc(l.title || l.url)}</a><button class="icon-btn sm" data-rmlink="${i}" aria-label="Remove link">${icon('x', 14)}</button></div>`).join('')}
        </div>
        <div class="card-head mt"><h2>Recent notes</h2><button class="btn small" id="newNoteCo">${icon('plus', 14)} Note</button></div>
        <div class="list">${recentNotes.length ? recentNotes.map(n => noteRow(n)).join('') : '<div class="empty small">No notes yet for this company.</div>'}</div>
      </section>
    </div>`;
    body.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.f; let v = inp.value;
        if (inp.type === 'number') v = v === '' ? null : Number(v);
        c[k] = v; save();
      });
      inp.addEventListener('change', () => { save.flush(); if (['fairValue', 'buyBelow', 'manualPrice'].includes(inp.dataset.f)) { $('#coHead').innerHTML = renderHeader(); bindHeader(); renderOverviewChartOnly(); } });
    });
    $('#autoUpd').onchange = e => { c.autoUpdate = e.target.checked; saveNow(); };
    $('#addLink').onclick = () => {
      const url = prompt('URL (earnings call, IR page, article, model…)'); if (!url) return;
      const title = prompt('Title', url.replace(/^https?:\/\//, '').slice(0, 60)) || url;
      (c.links ||= []).push({ url: /^https?:/.test(url) ? url : 'https://' + url, title, addedAt: Date.now() }); saveNow().then(() => route());
    };
    body.querySelectorAll('[data-rmlink]').forEach(b => (b.onclick = () => { c.links.splice(+b.dataset.rmlink, 1); saveNow().then(() => route()); }));
    $('#newNoteCo').onclick = e => newNoteMenu(e.currentTarget, c.id);
    renderOverviewChartOnly();
  }

  function renderOverviewChartOnly() {
    const hist = c.auto?.priceHistory?.length ? c.auto.priceHistory : (c.priceLog || []);
    const host = $('#priceChart'); if (!host) return;
    const m = metrics(c);
    const v = body.querySelector('.val-bar'); if (v) v.innerHTML = valuationBar(m.price, Number(c.buyBelow) || null, Number(c.fairValue) || null);
    const u = $('#upsideVal'); if (u) { u.textContent = fmtPct(m.upside); u.className = upCls(m.upside); }
    lineChart(host, hist.map(p => ({ label: p.date, value: p.price ?? p.close })), { format: v => '$' + fmtNum(v, { digits: 2 }), refLine: Number(c.fairValue) || null, refLabel: 'Fair value' });
  }

  function renderReports() {
    const reps = c.reports || [];
    body.innerHTML = reps.length ? `<div class="report-list">${reps.map(r => `<article class="card report">
        <div class="row between wrap gap"><div><span class="tag">${esc(r.kind || 'Report')}</span> <b>${esc(r.title)}</b></div><span class="muted small">${esc(r.date || '')}</span></div>
        ${r.verdict || r.iv ? `<div class="row gap wrap mt">${r.verdict ? verdictPill(r.verdict) : ''}${r.iv ? `<span>Intrinsic value <b>${money(r.iv, c.currency)}</b>${r.priceApprox ? ' <span class="muted small">(approx.)</span>' : ''}</span>` : ''}${r.price ? `<span class="muted">vs price ${money(r.price, c.currency)} at the time</span>` : ''}</div>` : ''}
        ${r.summary ? `<p class="report-sum">${esc(r.summary)}</p>` : ''}
        <div class="row gap wrap">${r.local ? `<a class="btn small primary" href="${esc(r.local)}" target="_blank" rel="noopener">${icon('file', 14)} Open full report</a>` : ''}<a class="btn small" href="${esc(r.url)}" target="_blank" rel="noopener">${icon('external', 14)} Open in Claude</a>
        ${r.verdict && r.iv ? `<button class="btn small" data-usefv="${r.iv}">Use as fair value</button>` : ''}</div>
      </article>`).join('')}</div>` : '<div class="empty">No reports linked yet. Add links on the Overview tab.</div>';
    body.querySelectorAll('[data-usefv]').forEach(b => (b.onclick = async () => { c.fairValue = Number(b.dataset.usefv); await saveNow(); toast('Fair value updated', 'ok'); route(); }));
  }

  function renderThesis() {
    body.innerHTML = `<div class="note-layout">
      <section class="card editor-card"><div id="thesisEd"></div><div class="muted small pad">Select text and press a highlight color, or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> to add a comment. Type <code>#</code>, <code>-</code>, <code>[]</code> + space for headings, bullets and checklists.</div></section>
      <aside class="card ann-side"><div class="card-head"><h2>Annotations</h2></div><div id="annList"></div></aside>
    </div>`;
    const ed = new RichEditor($('#thesisEd'), {
      html: c.thesisHtml || thesisTemplate(), placeholder: 'Write your investment thesis…',
      onChange: () => { c.thesisHtml = ed.html; c.thesisText = ed.text; save(); },
      onAnnotations: list => renderAnnList($('#annList'), list, ed),
    });
    renderAnnList($('#annList'), ed.annotations(), ed);
    if (params.get('a')) setTimeout(() => ed.focusAnnotation(params.get('a')), 100);
    state.cleanup.push(() => ed.destroy());
  }

  function renderFinancials() {
    const fin = c.auto?.financials?.annual || [];
    const METRICS = [
      ['revenue', 'Revenue', bigAbs], ['grossProfit', 'Gross profit', bigAbs], ['operatingIncome', 'Operating income', bigAbs], ['netIncome', 'Net income', bigAbs],
      ['epsDiluted', 'EPS (diluted)', v => money(v)], ['ocf', 'Operating cash flow', bigAbs], ['capex', 'Capex', bigAbs], ['fcf', 'Free cash flow', bigAbs],
      ['totalAssets', 'Total assets', bigAbs], ['totalLiabilities', 'Total liabilities', bigAbs], ['equity', "Shareholders' equity", bigAbs],
      ['cash', 'Cash', bigAbs], ['debt', 'Debt', bigAbs], ['shares', 'Diluted shares', v => fmtNum(v, { compact: true, digits: 2 })], ['dividendsPerShare', 'Dividends / share', v => money(v)],
    ].filter(([k]) => fin.some(r => r[k] != null));
    if (!fin.length) {
      body.innerHTML = `<div class="card empty-card"><h2>No financials yet</h2>
        <p class="muted">Financial statements populate automatically from SEC filings once <b>${esc(c.ticker)}</b> is in <code>data/watchlist.txt</code> and the “Update company data” GitHub Action has run, or instantly if you add a Financial Modeling Prep API key in <a href="#/settings">Settings</a>.</p>
        <div class="row gap"><button class="btn primary" id="refetch">${icon('refresh')} Try fetching now</button><a class="btn" href="#/settings">Open Settings</a></div></div>`;
      $('#refetch').onclick = () => $('#refreshBtn').click();
      return;
    }
    let cur = localStorage.getItem('fin.metric') || 'revenue';
    if (!METRICS.some(x => x[0] === cur)) cur = METRICS[0][0];
    body.innerHTML = `<section class="card">
      <div class="card-head wrap"><h2 id="finTitle"></h2><div class="chips">${METRICS.slice(0, 9).map(([k, l]) => `<button class="chip${k === cur ? ' active' : ''}" data-m="${k}">${l}</button>`).join('')}</div></div>
      <div id="finChart"></div>
    </section>
    <section class="card mt"><div class="card-head"><h2>Annual data</h2><span class="muted small">${esc(c.auto?.source || '')} · fiscal years</span></div>
      <div class="table-wrap"><table class="data fin"><thead><tr><th></th>${fin.map(r => `<th class="num">FY${r.fy}</th>`).join('')}</tr></thead>
      <tbody>${METRICS.map(([k, l, f]) => `<tr><th>${l}</th>${fin.map(r => `<td class="num">${r[k] != null ? f(r[k]) : '—'}</td>`).join('')}</tr>`).join('')}
        <tr class="derived"><th>Revenue growth</th>${fin.map((r, i) => `<td class="num">${i && r.revenue && fin[i - 1].revenue ? fmtPct(r.revenue / fin[i - 1].revenue - 1) : '—'}</td>`).join('')}</tr>
        <tr class="derived"><th>Net margin</th>${fin.map(r => `<td class="num">${r.revenue && r.netIncome != null ? pct(r.netIncome / r.revenue) : '—'}</td>`).join('')}</tr>
        <tr class="derived"><th>ROE</th>${fin.map(r => `<td class="num">${r.equity && r.netIncome != null ? pct(r.netIncome / r.equity) : '—'}</td>`).join('')}</tr>
      </tbody></table></div></section>`;
    const draw = () => {
      const [k, l, f] = METRICS.find(x => x[0] === cur);
      $('#finTitle').textContent = l;
      barChart($('#finChart'), fin.map(r => ({ label: 'FY' + String(r.fy).slice(-2), value: r[k] })), { format: (v, axis) => axis && f === bigAbs ? bigAbs(v).replace('.0', '') : f(v) });
    };
    body.querySelectorAll('[data-m]').forEach(b => (b.onclick = () => { cur = b.dataset.m; localStorage.setItem('fin.metric', cur); body.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('active', x === b)); draw(); }));
    draw();
    const ro = new ResizeObserver(debounce(draw, 100)); ro.observe($('#finChart').parentElement); state.cleanup.push(() => ro.disconnect());
  }

  function renderNotes() {
    body.innerHTML = `<div class="row gap mb"><button class="btn primary" id="nn">${icon('plus')} New note</button></div>
      <div class="note-grid" id="ng"></div>`;
    $('#nn').onclick = e => newNoteMenu(e.currentTarget, c.id);
    renderNoteCards($('#ng'), notes);
  }

  function renderFiles() {
    body.innerHTML = `<section class="card">
      <div class="drop-zone" id="dz" tabindex="0">${icon('upload', 28)}<div><b>Drop PDFs, images or spreadsheets here</b><div class="muted small">10-Ks, earnings decks, charts, models. Stored locally in your browser. PDFs and images can be opened for handwritten annotation.</div></div><input type="file" multiple hidden></div>
      <div class="list mt">${files.length ? files.sort((a, b) => b.addedAt - a.addedAt).map(f => `<div class="row-link">${icon(f.type.startsWith('image/') ? 'image' : 'file', 16)}<span class="grow ellipsis">${esc(f.name)}</span><small class="muted">${fmtNum(f.size / 1024, { digits: 0 })} KB · ${fmtDate(f.addedAt)}</small>
        <button class="btn small" data-open="${f.id}">Open</button>${/pdf|image/.test(f.type) ? `<button class="btn small" data-annot="${f.id}">${icon('pen', 14)} Annotate</button>` : ''}<button class="icon-btn sm" data-del="${f.id}" aria-label="Delete file">${icon('trash', 14)}</button></div>`).join('') : '<div class="empty small">No files yet.</div>'}</div>
    </section>`;
    const dz = $('#dz'), inp = dz.querySelector('input');
    const add = async list => {
      for (const f of list) {
        if (f.size > 50e6) { toast(`${f.name} is larger than 50 MB`, 'error'); continue; }
        await db.put('files', { id: uid('f'), companyId: c.id, name: f.name, type: f.type || 'application/octet-stream', size: f.size, blob: f, addedAt: Date.now() });
      }
      toast(`${list.length} file(s) added`, 'ok'); route();
    };
    dz.onclick = () => inp.click(); dz.onkeydown = e => { if (e.key === 'Enter') inp.click(); };
    inp.onchange = () => add(Array.from(inp.files));
    dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove('over'); add(Array.from(e.dataTransfer.files)); };
    body.querySelectorAll('[data-open]').forEach(b => (b.onclick = () => { const f = files.find(x => x.id === b.dataset.open); window.open(URL.createObjectURL(f.blob), '_blank'); }));
    body.querySelectorAll('[data-annot]').forEach(b => (b.onclick = async () => {
      const f = files.find(x => x.id === b.dataset.annot);
      const n = await noteFromFile(new File([f.blob], f.name, { type: f.type }), c.id);
      if (n) go(`#/note/${n.id}`);
    }));
    body.querySelectorAll('[data-del]').forEach(b => (b.onclick = async () => { if (confirm('Delete this file?')) { await db.del('files', b.dataset.del); route(); } }));
  }
}

function valuationBar(price, buy, fair) {
  const vals = [price, buy, fair].filter(v => v != null && v > 0);
  if (vals.length < 2) return '<div class="muted small">Enter a fair value and buy-below price to see where the stock sits.</div>';
  const lo = Math.min(...vals) * 0.85, hi = Math.max(...vals) * 1.1;
  const x = v => ((v - lo) / (hi - lo)) * 100;
  return `<div class="vbar">
    ${buy ? `<div class="vzone" style="left:0;width:${x(buy)}%"></div><span class="vmark buy" style="left:${x(buy)}%"><i></i><em>Buy ${money(buy)}</em></span>` : ''}
    ${fair ? `<span class="vmark fair" style="left:${x(fair)}%"><i></i><em>Fair ${money(fair)}</em></span>` : ''}
    ${price ? `<span class="vmark price" style="left:${x(price)}%"><i></i><em>Now ${money(price)}</em></span>` : ''}
  </div>`;
}

function renderAnnList(host, list, ed) {
  host.innerHTML = list.length ? list.map(a => `<button class="ann" data-id="${esc(a.id)}"><mark data-color="${esc(a.color)}">${esc(a.text.slice(0, 140))}</mark>${a.note ? `<span>${esc(a.note)}</span>` : ''}</button>`).join('')
    : '<div class="muted small">Highlights and comments you add will be listed here.</div>';
  host.querySelectorAll('[data-id]').forEach(b => (b.onclick = () => ed.focusAnnotation(b.dataset.id)));
}

// ---------------------------------------------------------------- notebook

function viewNotes(params) {
  const f = { q: params.get('q') || '', kind: params.get('kind') || '', co: params.get('co') || '', sort: localStorage.getItem('notes.sort') || 'updated' };
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Notebook</h1><p class="muted">${state.notes.length} notes — typed, handwritten and annotated documents</p></div>
      <button class="btn primary" id="nnBtn">${icon('plus')} New note</button></div>
    <div class="filters row gap wrap">
      <input type="search" id="nf" placeholder="Filter notes…" value="${esc(f.q)}" aria-label="Filter notes">
      <div class="chips">${[['', 'All'], ['text', 'Typed'], ['ink', 'Handwritten'], ['annotated', 'Annotated'], ['pinned', 'Pinned'], ['loose', 'No company']].map(([k, l]) => `<button class="chip${f.kind === k ? ' active' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
      <select id="nco" aria-label="Company"><option value="">All companies</option>${state.companies.map(c => `<option value="${esc(c.id)}" ${f.co === c.id ? 'selected' : ''}>${esc(c.ticker)}</option>`).join('')}</select>
      <select id="nsort" aria-label="Sort"><option value="updated">Recently edited</option><option value="created">Recently created</option><option value="title">Title</option></select>
    </div>
    <div class="note-grid" id="ng"></div>
  </div>`;
  $('#nsort').value = f.sort;
  const draw = () => {
    const q = f.q.toLowerCase();
    let list = state.notes.filter(n => {
      const hasInk = (n.ink || []).some(p => p.strokes?.length || p.bgImage);
      if (f.kind === 'text' && !n.text) return false;
      if (f.kind === 'ink' && !hasInk) return false;
      if (f.kind === 'annotated' && !/<mark/.test(n.html || '') && !(n.ink || []).some(p => p.bgImage && p.strokes?.length)) return false;
      if (f.kind === 'pinned' && !n.pinned) return false;
      if (f.kind === 'loose' && n.companyId) return false;
      if (f.co && n.companyId !== f.co) return false;
      if (q && !`${n.title} ${n.text} ${n.inkText || ''} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
    list.sort(f.sort === 'title' ? (a, b) => (a.title || '').localeCompare(b.title || '') : f.sort === 'created' ? (a, b) => b.createdAt - a.createdAt : (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    renderNoteCards($('#ng'), list);
  };
  $('#nf').oninput = e => { f.q = e.target.value; draw(); };
  main.querySelectorAll('[data-k]').forEach(b => (b.onclick = () => { f.kind = b.dataset.k; main.querySelectorAll('[data-k]').forEach(x => x.classList.toggle('active', x === b)); draw(); }));
  $('#nco').onchange = e => { f.co = e.target.value; draw(); };
  $('#nsort').onchange = e => { f.sort = e.target.value; localStorage.setItem('notes.sort', f.sort); draw(); };
  $('#nnBtn').onclick = e => newNoteMenu(e.currentTarget);
  draw();
}

function renderNoteCards(host, list) {
  const cById = new Map(state.companies.map(c => [c.id, c]));
  if (!list.length) { host.innerHTML = '<div class="empty">No notes here yet.</div>'; return; }
  host.innerHTML = list.map(n => {
    const co = cById.get(n.companyId);
    const pages = (n.ink || []).filter(p => p.strokes?.length || p.bgImage);
    const anns = (n.html || '').match(/<mark/g)?.length || 0;
    return `<a class="note-card card" href="#/note/${n.id}">
      ${pages.length ? `<canvas class="thumb" data-note="${n.id}" width="320" height="200"></canvas>` : ''}
      <div class="nc-body">
        <div class="row between"><b class="ellipsis">${n.pinned ? icon('pin', 13) + ' ' : ''}${esc(n.title || 'Untitled')}</b>${co ? `<span class="tag">${esc(co.ticker)}</span>` : ''}</div>
        ${n.text ? `<p class="nc-text">${esc(n.text.slice(0, 220))}</p>` : ''}
        <div class="row gap small muted">${pages.length ? `<span>${icon('pen', 12)} ${pages.length}p</span>` : ''}${anns ? `<span>${icon('highlight', 12)} ${anns}</span>` : ''}<span class="grow"></span><span>${timeAgo(n.updatedAt)}</span></div>
        ${n.tags?.length ? `<div class="tags">${tagChips(n.tags.slice(0, 4))}</div>` : ''}
      </div></a>`;
  }).join('');
  // draw ink thumbnails lazily
  const io = new IntersectionObserver(entries => entries.forEach(async en => {
    if (!en.isIntersecting) return; io.unobserve(en.target);
    const n = list.find(x => x.id === en.target.dataset.note);
    const p = (n.ink || []).find(p => p.strokes?.length || p.bgImage);
    const off = await renderPage(p, 0.32, isDark() && !p.bgImage);
    const cv = en.target, ctx = cv.getContext('2d');
    cv.height = Math.min(200, Math.round(320 * off.height / off.width));
    ctx.drawImage(off, 0, 0, 320, Math.round(320 * off.height / off.width));
  }));
  host.querySelectorAll('canvas.thumb').forEach(cv => io.observe(cv));
}

// ---------------------------------------------------------------- note editor

async function viewNote(id) {
  const n = await db.get('notes', id);
  if (!n) { main.innerHTML = `<div class="page"><div class="empty">Note not found. <a href="#/notes">Back to notebook</a></div></div>`; return; }
  n.ink ||= [];
  let mode = n.mode === 'ink' || (!n.text && n.ink.length) ? 'ink' : 'text';
  let pageIdx = 0;
  const savedEl = () => $('#saveState');
  const persist = async () => { n.updatedAt = Date.now(); await db.put('notes', n, { silent: true }); syncState('notes', n); const s = savedEl(); if (s) s.textContent = 'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  const save = debounce(persist, 600);
  const dirty = () => { const s = savedEl(); if (s) s.textContent = 'Saving…'; save(); };
  state.cleanup.push(() => { save.flush(); rerender(); });
  window.addEventListener('beforeunload', save.flush, { once: true });
  const co = state.companies.find(c => c.id === n.companyId);

  main.innerHTML = `<div class="page note-page">
    <div class="row between wrap gap">
      <a class="back" href="${co ? `#/company/${encodeURIComponent(co.id)}?tab=notes` : '#/notes'}">← ${co ? esc(co.ticker) + ' notes' : 'Notebook'}</a>
      <div class="row gap"><span class="muted small" id="saveState">Saved</span>
        <button class="icon-btn${n.pinned ? ' on' : ''}" id="npin" title="Pin">${icon('pin')}</button>
        <button class="btn small" id="nexport">${icon('download', 14)} Export</button>
        <button class="icon-btn" id="ndel" title="Delete note">${icon('trash')}</button></div>
    </div>
    <input class="note-title" id="ntitle" value="${esc(n.title || '')}" placeholder="Untitled note" aria-label="Note title">
    <div class="row gap wrap note-meta">
      <select id="nco" aria-label="Linked company"><option value="">No company</option>${state.companies.map(c => `<option value="${esc(c.id)}" ${c.id === n.companyId ? 'selected' : ''}>${esc(c.ticker)} – ${esc(c.name || '')}</option>`).join('')}</select>
      <div id="ntags"></div>
      <span class="muted small">Created ${fmtDate(n.createdAt)}</span>
      <div class="seg-toggle mode-toggle" role="tablist">
        <button data-mode="text" class="${mode === 'text' ? 'active' : ''}">${icon('type', 16)} Typed</button>
        <button data-mode="ink" class="${mode === 'ink' ? 'active' : ''}">${icon('pen', 16)} Handwritten${n.ink.length ? ` (${n.ink.length})` : ''}</button>
      </div>
    </div>
    <div id="nbody"></div>
  </div>`;

  $('#ntitle').oninput = e => { n.title = e.target.value; dirty(); };
  $('#nco').onchange = e => { n.companyId = e.target.value || null; dirty(); };
  tagsEditor($('#ntags'), n.tags ||= [], dirty);
  $('#npin').onclick = () => { n.pinned = !n.pinned; $('#npin').classList.toggle('on', n.pinned); persist().then(rerender); };
  $('#ndel').onclick = async () => { if (!confirm('Delete this note permanently?')) return; save.flush = () => {}; await db.del('notes', n.id); toast('Note deleted'); go(co ? `#/company/${encodeURIComponent(co.id)}?tab=notes` : '#/notes'); };
  $('#nexport').onclick = () => exportNote(n, mode, pageIdx);
  main.querySelectorAll('[data-mode]').forEach(b => (b.onclick = () => {
    mode = b.dataset.mode; main.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('active', x === b));
    n.mode = mode; dirty(); draw();
  }));

  let cleanupBody = () => {};
  state.cleanup.push(() => cleanupBody());
  function draw() {
    cleanupBody();
    const host = $('#nbody');
    if (mode === 'text') {
      host.innerHTML = `<div class="note-layout">
        <section class="card editor-card"><div id="ned"></div></section>
        <aside class="card ann-side"><div class="card-head"><h2>Annotations</h2></div><div id="annList"></div>
          <div class="muted small mt">Select text → pick a highlight colour, or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> to highlight with a comment. Click a highlight to edit it.</div></aside>
      </div>`;
      const ed = new RichEditor($('#ned'), {
        html: n.html, placeholder: 'Start typing… (# heading, - bullet, [] checklist)',
        onChange: () => { n.html = ed.html; n.text = ed.text; dirty(); },
        onAnnotations: list => renderAnnList($('#annList'), list, ed),
      });
      renderAnnList($('#annList'), ed.annotations(), ed);
      const a = parseHash().params.get('a'); if (a) setTimeout(() => ed.focusAnnotation(a), 100);
      if (!n.html) ed.area.focus();
      cleanupBody = () => ed.destroy();
    } else {
      if (!n.ink.length) n.ink.push(newPage());
      pageIdx = Math.min(pageIdx, n.ink.length - 1);
      host.innerHTML = `<div class="ink-layout">
        <div class="ink-pages" id="pages"></div>
        <section class="card ink-card"><div id="inkHost"></div>
          <label class="ink-caption">Searchable summary / transcription <textarea id="inkText" rows="2" placeholder="Type key words from your handwriting so search can find this note">${esc(n.inkText || '')}</textarea></label>
        </section>
      </div>`;
      const ink = new InkEditor($('#inkHost'), n.ink[pageIdx], { onChange: () => { dirty(); thumbs(true); } });
      $('#inkText').oninput = e => { n.inkText = e.target.value; dirty(); };
      const thumbs = debounce(async (onlyCurrent = false) => {
        const ph = $('#pages'); if (!ph) return;
        if (!onlyCurrent || ph.children.length !== n.ink.length + 1) {
          ph.innerHTML = n.ink.map((p, i) => `<button class="pg${i === pageIdx ? ' active' : ''}" data-i="${i}" title="Page ${i + 1}"><canvas width="90" height="126"></canvas><span>${i + 1}</span>${n.ink.length > 1 ? `<i data-rm="${i}" title="Delete page">×</i>` : ''}</button>`).join('')
            + `<button class="pg add" id="addPg" title="Add page">${icon('plus')}<span>Page</span></button>`;
          ph.querySelectorAll('[data-i]').forEach(b => (b.onclick = e => {
            const i = +b.dataset.i;
            if (e.target.dataset.rm != null) {
              if (!confirm(`Delete page ${i + 1}?`)) return;
              n.ink.splice(i, 1); pageIdx = Math.min(pageIdx, n.ink.length - 1); ink.setPage(n.ink[pageIdx]); dirty(); thumbs(); return;
            }
            pageIdx = i; ink.setPage(n.ink[i]); ph.querySelectorAll('.pg').forEach(x => x.classList.toggle('active', x === b));
          }));
          $('#addPg').onclick = () => { n.ink.push(newPage({ paper: n.ink[pageIdx]?.bgImage ? 'lined' : n.ink[pageIdx]?.paper || 'lined' })); pageIdx = n.ink.length - 1; ink.setPage(n.ink[pageIdx]); dirty(); thumbs(); };
        }
        const cvs = ph.querySelectorAll('.pg canvas');
        const idxs = onlyCurrent ? [pageIdx] : n.ink.map((_, i) => i);
        for (const i of idxs) {
          const off = await renderPage(n.ink[i], 0.09, isDark() && !n.ink[i].bgImage);
          const cv = cvs[i]; if (!cv) continue;
          cv.height = Math.round(90 * n.ink[i].h / n.ink[i].w);
          cv.getContext('2d').drawImage(off, 0, 0, cv.width, cv.height);
        }
      }, 250);
      thumbs();
      cleanupBody = () => ink.destroy();
    }
  }
  draw();
}

async function exportNote(n, mode, pageIdx) {
  const safe = (n.title || 'note').replace(/[^\w\- ]+/g, '').trim() || 'note';
  if (mode === 'ink' && n.ink.length) {
    const c = await renderPage(n.ink[pageIdx], 2);
    c.toBlob(b => download(`${safe}-p${pageIdx + 1}.png`, b));
    return;
  }
  const doc = `<!doctype html><meta charset="utf-8"><title>${esc(n.title)}</title><style>body{font:16px/1.6 system-ui;max-width:760px;margin:40px auto;padding:0 16px}mark{background:#fde68a}mark[data-note]::after{content:" [" attr(data-note) "]";color:#92400e;font-size:.85em}</style><h1>${esc(n.title)}</h1>${n.html}`;
  download(`${safe}.html`, doc, 'text/html');
}

// ---------------------------------------------------------------- search page

function viewSearch(q) {
  $('#globalSearch').value = q;
  const { results, tokens, filters } = search(q, state);
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Search</h1><p class="muted">${results.length} result${results.length === 1 ? '' : 's'} for <b>${esc(q)}</b></p></div></div>
    <div class="card help-card small">
      <b>Search tips:</b> words are AND-ed · <code>"exact phrase"</code> · <code>tag:moat</code> · <code>status:owned</code> · <code>sector:software</code> · <code>ticker:aapl</code> ·
      <code>rating:&gt;=4</code> · <code>upside:&gt;25</code> · <code>pe:&lt;15</code> · <code>roe:&gt;20</code> · <code>growth:&gt;10</code> · <code>is:pinned</code> · <code>is:annotated</code> · <code>is:handwritten</code> · <code>type:note</code>
      ${filters.length ? `<div class="mt">Active filters: ${filters.map(f => `<span class="tag">${esc(f.field)}:${esc(f.value)}</span>`).join(' ')}</div>` : ''}
    </div>
    <div class="results">${results.length ? results.map(r => resultRow(r, tokens)).join('') : '<div class="empty">Nothing found. Try fewer words or remove a filter.</div>'}</div>
  </div>`;
}

// ---------------------------------------------------------------- settings

async function viewSettings() {
  const key = await db.getKV('fmpKey', '');
  const auto = await db.getKV('autoRefresh', true);
  const last = await db.getKV('lastRefresh', 0);
  const idx = await loadTickerIndex();
  const watch = state.companies.filter(c => c.autoUpdate !== false).map(c => c.ticker).join('\n');
  main.innerHTML = `<div class="page settings">
    <div class="page-head"><div><h1>Settings & data</h1><p class="muted">Auto-population, backups and preferences.</p></div></div>
    <div class="grid-2">
    <section class="card">
      <div class="card-head"><h2>Auto-populate company data</h2></div>
      <p class="small">Two ways data fills in — use either or both:</p>
      <ol class="small steps">
        <li><b>Free, automatic (SEC EDGAR):</b> the repo's GitHub Action <code>Update company data</code> runs every weekday, reads <code>data/watchlist.txt</code> and writes profile, 10 years of financials, recent filings and daily price to <code>data/companies/</code>. This app picks it up on every load. Ticker autocomplete: ${idx.length ? `<span class="pos">${idx.length.toLocaleString()} tickers loaded</span>` : '<span class="neg">not generated yet — run the Action once</span>'}.</li>
        <li><b>Instant (optional):</b> a free <a href="https://site.financialmodelingprep.com/developer/docs" target="_blank" rel="noopener">Financial Modeling Prep</a> API key fetches data the moment you add a company. Stored only in this browser.</li>
      </ol>
      <label>FMP API key <input id="fmpKey" type="password" value="${esc(key)}" placeholder="optional" autocomplete="off"></label>
      <label class="chk mt"><input type="checkbox" id="autoRef" ${auto ? 'checked' : ''}> Refresh data automatically when the app opens (every 6 hours at most)</label>
      <div class="row gap mt wrap"><button class="btn primary" id="refreshAllBtn">${icon('refresh')} Refresh all now</button><span class="muted small">Last refresh: ${last ? timeAgo(last) : 'never'}</span></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Watchlist for the data Action</h2><button class="btn small" id="copyWatch">Copy</button></div>
      <p class="small muted">Paste this into <code>data/watchlist.txt</code> in the repo (or run the Action manually with tickers as input) so every company in your library is refreshed automatically.</p>
      <textarea id="watchTxt" rows="8" readonly>${esc(watch)}</textarea>
    </section>
    <section class="card">
      <div class="card-head"><h2>Backup & sync</h2></div>
      <p class="small muted">Your research lives in this browser (IndexedDB). Export regularly. Commit the file as <code>data/research.json</code> to have it load automatically on a new device.</p>
      <div class="row gap wrap">
        <button class="btn primary" id="expBtn">${icon('download')} Export everything</button>
        <button class="btn" id="expLite">${icon('download')} Export without files</button>
        <button class="btn" id="impBtn">${icon('upload')} Import backup</button>
        <input type="file" id="impFile" accept="application/json,.json" hidden>
      </div>
      <label class="chk mt"><input type="checkbox" id="impReplace"> Replace instead of merge when importing</label>
    </section>
    <section class="card">
      <div class="card-head"><h2>Keyboard shortcuts</h2></div>
      <dl class="kv shortcuts">
        <div><dt><kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>K</kbd></dt><dd>Search</dd></div>
        <div><dt><kbd>c</kbd></dt><dd>Add company</dd></div>
        <div><dt><kbd>n</kbd></dt><dd>New note</dd></div>
        <div><dt><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd></dt><dd>Highlight selection</dd></div>
        <div><dt><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd></dt><dd>Highlight + comment</dd></div>
        <div><dt><kbd>P</kbd> / <kbd>H</kbd> / <kbd>E</kbd></dt><dd>Pen / highlighter / eraser</dd></div>
        <div><dt><kbd>Ctrl</kbd>+<kbd>Z</kbd></dt><dd>Undo ink</dd></div>
      </dl>
    </section>
    <section class="card danger-card span-2">
      <div class="card-head"><h2>Danger zone</h2></div>
      <button class="btn danger" id="wipe">${icon('trash')} Delete all local data</button>
    </section>
    </div>
  </div>`;
  $('#fmpKey').onchange = async e => { await db.setKV('fmpKey', e.target.value.trim()); toast('API key saved', 'ok'); };
  $('#autoRef').onchange = e => db.setKV('autoRefresh', e.target.checked);
  $('#refreshAllBtn').onclick = async () => {
    const b = $('#refreshAllBtn'); b.disabled = true; let i = 0;
    const n = await refreshAll({ onProgress: () => { b.textContent = `Refreshing… ${++i}/${state.companies.length}`; } });
    toast(`Updated ${n} compan${n === 1 ? 'y' : 'ies'}`, 'ok'); rerender(); viewSettings();
  };
  $('#copyWatch').onclick = () => { navigator.clipboard.writeText($('#watchTxt').value).then(() => toast('Copied', 'ok')); };
  $('#expBtn').onclick = async () => download(`research-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await exportAll()));
  $('#expLite').onclick = async () => download(`research.json`, JSON.stringify(await exportAll({ includeFiles: false }), null, 1));
  $('#impBtn').onclick = () => $('#impFile').click();
  $('#impFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const res = await importAll(JSON.parse(await readFile(f)), { mode: $('#impReplace').checked ? 'replace' : 'merge' });
      toast(`Imported ${res.companies} companies, ${res.notes} notes, ${res.files} files`, 'ok');
      await loadAll(); renderSidebar();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#wipe').onclick = async () => {
    if (prompt('Type DELETE to erase all companies, notes and files stored in this browser.') !== 'DELETE') return;
    await db.clear('companies'); await db.clear('notes'); await db.clear('files');
    toast('All local data deleted'); go('#/');
  };
}

init();
