// Rich-text note editor with highlight + comment annotations.
//
// Annotations are <mark data-color="yellow" data-id="..." data-note="comment"> elements inside the note HTML,
// so they survive export/import and are searchable. The side panel lists every annotation in the note.

import { icon, el, esc, sanitize, uid } from './util.js';

const HL = [['yellow', 'Yellow'], ['green', 'Green'], ['pink', 'Pink'], ['blue', 'Blue']];

export class RichEditor {
  constructor(host, { html = '', placeholder = 'Start typing…', onChange, onAnnotations } = {}) {
    this.host = host;
    this.onChange = onChange;
    this.onAnnotations = onAnnotations;
    host.classList.add('rich-editor');
    host.innerHTML = '';
    this.toolbar = el(`<div class="rt-toolbar" role="toolbar" aria-label="Formatting">
      <div class="seg">
        <button data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <button data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
      </div>
      <div class="seg">
        <button data-block="H2" title="Heading">H1</button>
        <button data-block="H3" title="Subheading">H2</button>
        <button data-block="P" title="Paragraph">¶</button>
        <button data-block="BLOCKQUOTE" title="Quote">❝</button>
      </div>
      <div class="seg">
        <button data-cmd="insertUnorderedList" title="Bullet list">${icon('list')}</button>
        <button data-cmd="insertOrderedList" title="Numbered list">1.</button>
        <button data-act="check" title="Checklist">${icon('check')}</button>
      </div>
      <div class="seg hl-seg">
        ${HL.map(([c, n]) => `<button data-hl="${c}" class="hl-btn hl-${c}" title="Highlight ${n} (Ctrl+Shift+H)"></button>`).join('')}
        <button data-act="comment" title="Highlight + comment (Ctrl+Shift+M)">${icon('comment')}</button>
        <button data-act="unmark" title="Remove highlight">${icon('x', 14)}</button>
      </div>
      <div class="seg">
        <button data-act="link" title="Link (Ctrl+K)">${icon('link')}</button>
        <button data-act="stamp" title="Insert date stamp">${icon('calendar')}</button>
        <button data-act="hr" title="Divider">―</button>
        <button data-cmd="removeFormat" title="Clear formatting">T<sub>x</sub></button>
      </div>
    </div>`);
    this.area = el(`<div class="rt-area" contenteditable="true" spellcheck="true" data-placeholder="${esc(placeholder)}"></div>`);
    this.pop = el(`<div class="rt-pop" hidden></div>`);
    host.append(this.toolbar, this.area, this.pop);
    this.area.innerHTML = sanitize(html);
    this.ensureIds();
    this.bind();
  }

  get html() { return this.area.innerHTML; }
  get text() { return (this.area.innerText || '').replace(/\s+\n/g, '\n').trim(); }

  bind() {
    const tb = this.toolbar;
    tb.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); }); // keep selection
    tb.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      this.area.focus();
      if (b.dataset.cmd) document.execCommand(b.dataset.cmd, false, null);
      if (b.dataset.block) document.execCommand('formatBlock', false, b.dataset.block);
      if (b.dataset.hl) this.mark(b.dataset.hl);
      const a = b.dataset.act;
      if (a === 'comment') this.mark('yellow', true);
      if (a === 'unmark') this.unmarkSelection();
      if (a === 'link') this.link();
      if (a === 'check') this.insertChecklist();
      if (a === 'hr') document.execCommand('insertHTML', false, '<hr><p><br></p>');
      if (a === 'stamp') document.execCommand('insertHTML', false, `<b>${esc(new Date().toLocaleString())}</b>&nbsp;`);
      this.changed();
    });
    this.area.addEventListener('input', () => this.changed());
    this.area.addEventListener('paste', e => {
      const h = e.clipboardData.getData('text/html');
      if (h) { e.preventDefault(); document.execCommand('insertHTML', false, sanitize(h)); }
      else {
        const t = e.clipboardData.getData('text/plain');
        e.preventDefault();
        document.execCommand('insertText', false, t);
      }
      // pasted images
      const imgs = Array.from(e.clipboardData.files || []).filter(f => f.type.startsWith('image/'));
      imgs.forEach(f => { const r = new FileReader(); r.onload = () => document.execCommand('insertHTML', false, `<img src="${r.result}" alt="">`); r.readAsDataURL(f); });
    });
    this.area.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'h') { e.preventDefault(); this.mark('yellow'); this.changed(); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); this.mark('yellow', true); this.changed(); }
      else if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); this.link(); }
      // markdown-ish shortcuts at line start
      else if (e.key === ' ') this.autoformat(e);
    });
    this.area.addEventListener('click', e => {
      const cb = e.target.closest('input[type=checkbox]');
      if (cb) { cb.toggleAttribute('checked', cb.checked); cb.closest('li')?.classList.toggle('done', cb.checked); this.changed(); return; }
      const m = e.target.closest('mark');
      if (m) this.showPop(m); else this.hidePop();
      const a = e.target.closest('a');
      if (a && (e.ctrlKey || e.metaKey)) window.open(a.href, '_blank', 'noopener');
    });
    document.addEventListener('selectionchange', this.selHandler = () => this.onSelection());
  }

  destroy() { document.removeEventListener('selectionchange', this.selHandler); }

  autoformat(e) {
    const sel = window.getSelection(); if (!sel.rangeCount) return;
    const node = sel.anchorNode; if (!node || node.nodeType !== 3) return;
    const before = node.textContent.slice(0, sel.anchorOffset);
    const map = { '#': 'H2', '##': 'H3', '>': 'BLOCKQUOTE', '-': 'ul', '*': 'ul', '1.': 'ol', '[]': 'check' };
    const k = before.trim();
    if (!(k in map) || before !== k) return;
    e.preventDefault();
    node.textContent = node.textContent.slice(sel.anchorOffset);
    const t = map[k];
    if (t === 'ul') document.execCommand('insertUnorderedList');
    else if (t === 'ol') document.execCommand('insertOrderedList');
    else if (t === 'check') this.insertChecklist();
    else document.execCommand('formatBlock', false, t);
    this.changed();
  }

  insertChecklist() {
    document.execCommand('insertHTML', false, '<ul class="checklist"><li><input type="checkbox">&nbsp;</li></ul>');
  }

  link() {
    const sel = window.getSelection();
    const url = prompt('Link URL', 'https://');
    if (!url || url === 'https://') return;
    if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`);
    else document.execCommand('createLink', false, url);
    this.changed();
  }

  mark(color, withComment = false) {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !this.area.contains(sel.anchorNode)) return;
    let comment = '';
    if (withComment) { comment = prompt('Annotation comment'); if (comment == null) return; }
    const range = sel.getRangeAt(0);
    // wrap each text node fragment in the range individually so block structure is preserved
    const texts = [];
    const walker = document.createTreeWalker(range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) { const n = walker.currentNode; if (range.intersectsNode(n) && n.textContent.trim()) texts.push(n); }
    const id = uid('a');
    let first = null;
    for (let n of texts) {
      let start = n === range.startContainer ? range.startOffset : 0;
      let end = n === range.endContainer ? range.endOffset : n.textContent.length;
      if (start >= end) continue;
      if (end < n.textContent.length) n.splitText(end);
      if (start > 0) n = n.splitText(start);
      const existing = n.parentElement.closest('mark');
      if (existing && existing.textContent === n.textContent) { existing.dataset.color = color; if (comment) existing.dataset.note = comment; first ||= existing; continue; }
      const m = document.createElement('mark');
      m.dataset.color = color; m.dataset.id = id;
      if (comment) m.dataset.note = comment;
      n.replaceWith(m); m.appendChild(n);
      first ||= m;
    }
    sel.removeAllRanges();
    if (first && comment) this.showPop(first);
    this.emitAnnotations();
  }

  unmarkSelection() {
    const sel = window.getSelection(); if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const marks = Array.from(this.area.querySelectorAll('mark')).filter(m => range.intersectsNode(m));
    const m = sel.anchorNode?.parentElement?.closest('mark'); if (m && !marks.includes(m)) marks.push(m);
    marks.forEach(unwrap);
    this.emitAnnotations();
  }

  showPop(m) {
    this.activeMark = m;
    const r = m.getBoundingClientRect(), hr = this.host.getBoundingClientRect();
    this.pop.innerHTML = `<div class="rt-pop-row">${HL.map(([c]) => `<button class="hl-btn hl-${c}" data-c="${c}"></button>`).join('')}
      <button data-a="del" title="Remove highlight">${icon('trash', 14)}</button></div>
      <textarea placeholder="Add a comment…" rows="2">${esc(m.dataset.note || '')}</textarea>`;
    this.pop.hidden = false;
    this.pop.style.left = Math.max(0, Math.min(r.left - hr.left, hr.width - 260)) + 'px';
    this.pop.style.top = (r.bottom - hr.top + 6) + 'px';
    const ta = this.pop.querySelector('textarea');
    ta.oninput = () => { const g = this.group(m); g.forEach(x => ta.value ? (x.dataset.note = ta.value) : delete x.dataset.note); this.changed(); this.emitAnnotations(); };
    this.pop.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.c) this.group(m).forEach(x => (x.dataset.color = b.dataset.c));
      if (b.dataset.a === 'del') { this.group(m).forEach(unwrap); this.hidePop(); }
      this.changed(); this.emitAnnotations();
    };
  }

  group(m) { return m.dataset.id ? Array.from(this.area.querySelectorAll(`mark[data-id="${m.dataset.id}"]`)) : [m]; }
  hidePop() { this.pop.hidden = true; this.activeMark = null; }

  onSelection() {
    // keep popover tied to the editor
    if (!this.host.isConnected) this.destroy();
  }

  focusAnnotation(id) {
    const m = this.area.querySelector(`mark[data-id="${CSS.escape(id)}"]`);
    if (!m) return;
    m.scrollIntoView({ block: 'center', behavior: 'smooth' });
    m.classList.add('flash'); setTimeout(() => m.classList.remove('flash'), 1200);
    this.showPop(m);
  }

  ensureIds() { this.area.querySelectorAll('mark:not([data-id])').forEach(m => (m.dataset.id = uid('a'))); }

  annotations() {
    const seen = new Map();
    for (const m of this.area.querySelectorAll('mark')) {
      const id = m.dataset.id;
      if (seen.has(id)) { seen.get(id).text += ' ' + m.textContent; continue; }
      seen.set(id, { id, color: m.dataset.color || 'yellow', note: m.dataset.note || '', text: m.textContent });
    }
    return Array.from(seen.values());
  }

  emitAnnotations() { this.onAnnotations?.(this.annotations()); }
  changed() { this.onChange?.(); }
}

function unwrap(m) { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); m.remove(); p.normalize(); }

/** Extract annotations from stored HTML (without an editor instance). */
export function annotationsFromHtml(h) {
  const d = document.createElement('div'); d.innerHTML = h || '';
  const seen = new Map();
  for (const m of d.querySelectorAll('mark')) {
    const id = m.dataset.id || uid('a');
    if (seen.has(id)) { seen.get(id).text += ' ' + m.textContent; continue; }
    seen.set(id, { id, color: m.dataset.color || 'yellow', note: m.dataset.note || '', text: m.textContent });
  }
  return Array.from(seen.values());
}
