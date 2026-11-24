// Lightweight full-text search with field filters.
//
// Query syntax:  free text   tag:moat   status:owned   sector:tech   rating:>=4   upside:>20   is:pinned   type:note
// Multiple words are AND-ed. Quotes keep phrases together: "pricing power".

import { stripHtml } from './util.js';
import { metrics } from './data.js';

export function parseQuery(q) {
  const tokens = [];
  const re = /(\w+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/g;
  let m;
  const filters = [];
  while ((m = re.exec(q || ''))) {
    if (m[1]) filters.push({ field: m[1].toLowerCase(), value: m[2].replace(/^"|"$/g, '').toLowerCase() });
    else tokens.push((m[3] ?? m[4]).toLowerCase());
  }
  return { tokens: tokens.filter(Boolean), filters };
}

function cmp(actual, expr) {
  const m = /^(>=|<=|>|<|=)?(-?[\d.]+)%?$/.exec(expr);
  if (!m || actual == null || isNaN(actual)) return false;
  const v = Number(m[2]);
  switch (m[1]) {
    case '>': return actual > v; case '<': return actual < v;
    case '>=': return actual >= v; case '<=': return actual <= v;
    default: return actual === v;
  }
}

export function companyText(c, notes = []) {
  const t = c.thesis || {};
  return [c.ticker, c.name, c.sector, c.industry, c.exchange, c.country, (c.tags || []).join(' '), c.description,
    c.thesisText, t.summary, t.bull, t.bear, t.catalysts, t.risks, t.moat, t.valuation, (c.links || []).map(l => l.title).join(' '),
    notes.map(n => n.title + ' ' + (n.text || '')).join(' ')].filter(Boolean).join(' \n ').toLowerCase();
}

export function noteText(n, company) {
  return [n.title, n.text || stripHtml(n.html), (n.tags || []).join(' '), company?.ticker, company?.name,
    (n.inkText || '')].filter(Boolean).join(' \n ').toLowerCase();
}

function matchFilters(kind, item, filters, extra) {
  for (const { field, value } of filters) {
    switch (field) {
      case 'type': if (!kind.startsWith(value.replace(/s$/, ''))) return false; break;
      case 'tag': case 'tags': if (!(item.tags || []).some(t => t.toLowerCase().includes(value))) return false; break;
      case 'is':
        if (value === 'pinned' && !item.pinned) return false;
        if (value === 'handwritten' && !(item.ink && item.ink.some(p => p.strokes?.length))) return false;
        if (value === 'annotated' && !/<mark/i.test((item.html || '') + (item.thesisHtml || ''))) return false;
        break;
      case 'status': if (kind !== 'company' || !(item.status || '').startsWith(value)) return false; break;
      case 'sector': case 'industry': case 'exchange': case 'country':
        if (kind === 'company' && !(item[field] || '').toLowerCase().includes(value)) return false;
        if (kind === 'note' && !(extra?.[field] || '').toLowerCase().includes(value)) return false;
        break;
      case 'ticker': {
        const t = kind === 'company' ? item.ticker : extra?.ticker;
        if ((t || '').toLowerCase() !== value) return false; break;
      }
      case 'rating': if (kind !== 'company' || !cmp(item.rating || 0, value)) return false; break;
      case 'upside': case 'pe': case 'roe': case 'margin': case 'growth': {
        if (kind !== 'company') return false;
        const m = metrics(item);
        const map = { upside: m.upside != null ? m.upside * 100 : null, pe: m.pe, roe: m.roe != null ? m.roe * 100 : null,
          margin: m.netMargin != null ? m.netMargin * 100 : null, growth: m.revGrowth != null ? m.revGrowth * 100 : null };
        if (!cmp(map[field], value)) return false; break;
      }
      default: break;
    }
  }
  return true;
}

function score(text, tokens, primary = '') {
  if (!tokens.length) return 1;
  let s = 0;
  for (const tok of tokens) {
    const i = text.indexOf(tok);
    if (i < 0) return 0;
    s += 1;
    if (primary.startsWith(tok)) s += 6;
    else if (primary.includes(tok)) s += 3;
    // count occurrences (capped)
    let c = 0, p = i;
    while (p >= 0 && c < 5) { c++; p = text.indexOf(tok, p + tok.length); }
    s += c * 0.2;
  }
  return s;
}

export function snippet(text, tokens, len = 140) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of tokens) { pos = lower.indexOf(t); if (pos >= 0) break; }
  if (pos < 0) return text.slice(0, len) + (text.length > len ? '…' : '');
  const start = Math.max(0, pos - 40);
  return (start > 0 ? '…' : '') + text.slice(start, start + len) + (start + len < text.length ? '…' : '');
}

export function search(query, { companies, notes }) {
  const { tokens, filters } = parseQuery(query);
  const cById = new Map(companies.map(c => [c.id, c]));
  const notesByCo = new Map();
  notes.forEach(n => { if (n.companyId) (notesByCo.get(n.companyId) || notesByCo.set(n.companyId, []).get(n.companyId)).push(n); });
  const results = [];
  const typeF = filters.find(f => f.field === 'type')?.value;
  if (!typeF || typeF.startsWith('comp')) {
    for (const c of companies) {
      if (!matchFilters('company', c, filters)) continue;
      const s = score(companyText(c, notesByCo.get(c.id)), tokens, (c.ticker + ' ' + (c.name || '')).toLowerCase());
      if (s > 0) results.push({ kind: 'company', item: c, score: s + (c.pinned ? 0.5 : 0) });
    }
  }
  if (!typeF || typeF.startsWith('note')) {
    for (const n of notes) {
      const co = cById.get(n.companyId);
      if (!matchFilters('note', n, filters, co)) continue;
      const s = score(noteText(n, co), tokens, (n.title || '').toLowerCase());
      if (s > 0) results.push({ kind: 'note', item: n, company: co, score: s * 0.9, snippet: snippet(n.text || '', tokens) });
    }
  }
  results.sort((a, b) => b.score - a.score || (b.item.updatedAt || 0) - (a.item.updatedAt || 0));
  return { results, tokens, filters };
}

export function highlight(escapedText, tokens) {
  if (!tokens.length) return escapedText;
  const re = new RegExp('(' + tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('|') + ')', 'gi');
  return escapedText.replace(re, '<em class="hit">$1</em>');
}
