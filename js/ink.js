// Handwriting / drawing surface with stylus pressure, highlighter, stroke eraser, undo/redo,
// paper backgrounds and image/PDF-page underlays for annotating screenshots, charts and filings.
// Strokes are stored as vectors in a fixed logical coordinate space, so they stay crisp at any zoom.

import { icon, el } from './util.js';

export const PAGE_W = 1000;
export const PAGE_H = 1400;

export function newPage(opts = {}) {
  return { id: 'pg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), paper: 'lined', strokes: [], bgImage: null, w: PAGE_W, h: PAGE_H, ...opts };
}

const COLORS = ['#111827', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];
const HL_COLORS = ['#facc15', '#4ade80', '#f472b6', '#60a5fa'];

export function drawStroke(ctx, s) {
  const pts = s.points;
  if (!pts.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineWidth = s.size;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], widthAt(s, pts[0]) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  // variable-width smoothed path: quadratic curves through midpoints
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 2] || pts[i - 1], p1 = pts[i - 1], p2 = pts[i];
    const m0 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const m1 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    ctx.lineWidth = widthAt(s, p2);
    ctx.beginPath();
    ctx.moveTo(i === 1 ? p1[0] : m0[0], i === 1 ? p1[1] : m0[1]);
    ctx.quadraticCurveTo(p1[0], p1[1], m1[0], m1[1]);
    ctx.stroke();
  }
  ctx.restore();
}

function widthAt(s, p) {
  const pr = p[2] ?? 0.5;
  return s.size * (0.35 + pr * 1.1);
}

export function drawPaper(ctx, page, dark = false) {
  const { w, h } = page;
  ctx.fillStyle = dark ? '#1b1f27' : '#fffdf8';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = dark ? 'rgba(148,163,184,.18)' : 'rgba(59,130,246,.16)';
  ctx.lineWidth = 1;
  if (page.paper === 'lined') {
    for (let y = 90; y < h; y += 36) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.strokeStyle = dark ? 'rgba(248,113,113,.25)' : 'rgba(239,68,68,.25)';
    ctx.beginPath(); ctx.moveTo(80, 0); ctx.lineTo(80, h); ctx.stroke();
  } else if (page.paper === 'grid') {
    for (let x = 0; x < w; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  } else if (page.paper === 'dots') {
    ctx.fillStyle = dark ? 'rgba(148,163,184,.3)' : 'rgba(100,116,139,.35)';
    for (let x = 25; x < w; x += 30) for (let y = 25; y < h; y += 30) { ctx.beginPath(); ctx.arc(x, y, 1.4, 0, 7); ctx.fill(); }
  }
}

const imgCache = new Map();
function loadImage(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const p = new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  imgCache.set(src, p);
  return p;
}

/** Render a page to an offscreen canvas (used for thumbnails & PNG export). */
export async function renderPage(page, scale = 1, dark = false) {
  const c = document.createElement('canvas');
  c.width = page.w * scale; c.height = page.h * scale;
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  drawPaper(ctx, page, dark);
  if (page.bgImage) { try { const img = await loadImage(page.bgImage); ctx.drawImage(img, 0, 0, page.w, page.h); } catch {} }
  page.strokes.forEach(s => drawStroke(ctx, s));
  return c;
}

export class InkEditor {
  constructor(host, page, { onChange } = {}) {
    this.host = host;
    this.page = page;
    this.onChange = onChange;
    this.tool = 'pen';
    this.color = COLORS[0];
    this.hlColor = HL_COLORS[0];
    this.size = 3;
    this.hlSize = 22;
    this.eraserSize = 18;
    this.zoom = 1;
    this.undoStack = [];
    this.redoStack = [];
    this.stylusOnly = localStorage.getItem('ink.stylusOnly') === '1';
    this.dark = document.documentElement.dataset.theme === 'dark';
    this.build();
  }

  build() {
    this.host.innerHTML = '';
    this.host.classList.add('ink-editor');
    const tb = el(`<div class="ink-toolbar" role="toolbar" aria-label="Drawing tools">
      <div class="seg">
        <button data-tool="pen" title="Pen (P)">${icon('pen')}</button>
        <button data-tool="highlighter" title="Highlighter (H)">${icon('highlight')}</button>
        <button data-tool="eraser" title="Eraser (E)">${icon('eraser')}</button>
        <button data-tool="pan" title="Pan / scroll (Space)">${icon('hand')}</button>
      </div>
      <div class="swatches" data-role="colors"></div>
      <label class="size-ctl" title="Stroke size"><input type="range" min="1" max="40" step="1" data-role="size"></label>
      <div class="seg">
        <button data-act="undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
        <button data-act="redo" title="Redo (Ctrl+Shift+Z)">${icon('redo')}</button>
      </div>
      <div class="seg">
        <button data-act="zoomout" title="Zoom out">${icon('zoomout')}</button>
        <button data-act="zoomin" title="Zoom in">${icon('zoomin')}</button>
      </div>
      <select data-role="paper" title="Paper">
        <option value="blank">Blank</option><option value="lined">Lined</option><option value="grid">Grid</option><option value="dots">Dots</option>
      </select>
      <button data-act="image" class="btn-text" title="Annotate an image or PDF page">${icon('image')}<span>Underlay</span></button>
      <label class="chk" title="Only a stylus draws; fingers scroll (palm rejection)"><input type="checkbox" data-role="stylus"> Stylus only</label>
      <button data-act="clear" class="btn-text danger" title="Clear page">${icon('trash')}</button>
    </div>`);
    this.toolbar = tb;
    this.scroller = el(`<div class="ink-scroll"><div class="ink-stage"><canvas class="ink-bg"></canvas><canvas class="ink-fg"></canvas></div></div>`);
    this.host.append(tb, this.scroller);
    this.stage = this.scroller.querySelector('.ink-stage');
    this.bg = this.stage.querySelector('.ink-bg');
    this.fg = this.stage.querySelector('.ink-fg');
    this.fileInput = el(`<input type="file" accept="image/*,application/pdf" hidden>`);
    this.host.append(this.fileInput);

    tb.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) this.setTool(b.dataset.tool);
      if (b.dataset.color) { if (this.tool === 'highlighter') this.hlColor = b.dataset.color; else { this.color = b.dataset.color; if (this.tool !== 'pen') this.setTool('pen'); } this.syncToolbar(); }
      const a = b.dataset.act;
      if (a === 'undo') this.undo();
      if (a === 'redo') this.redo();
      if (a === 'zoomin') this.setZoom(this.zoom * 1.25);
      if (a === 'zoomout') this.setZoom(this.zoom / 1.25);
      if (a === 'clear' && this.page.strokes.length && confirm('Clear all ink on this page?')) { this.commit({ type: 'clear', prev: this.page.strokes }); this.page.strokes = []; this.redraw(); this.changed(); }
      if (a === 'image') this.fileInput.click();
      if (a === 'rmimage') { this.page.bgImage = null; this.redrawBg(); this.changed(); this.syncToolbar(); }
    });
    tb.querySelector('[data-role=size]').addEventListener('input', e => {
      const v = Number(e.target.value);
      if (this.tool === 'highlighter') this.hlSize = v; else if (this.tool === 'eraser') this.eraserSize = v; else this.size = v;
    });
    tb.querySelector('[data-role=paper]').addEventListener('change', e => { this.page.paper = e.target.value; this.redrawBg(); this.changed(); });
    tb.querySelector('[data-role=stylus]').addEventListener('change', e => {
      this.stylusOnly = e.target.checked; localStorage.setItem('ink.stylusOnly', this.stylusOnly ? '1' : '0'); this.applyTouchAction();
    });
    this.fileInput.addEventListener('change', () => { const f = this.fileInput.files[0]; this.fileInput.value = ''; if (f) this.setUnderlay(f); });

    this.bindPointer();
    this.keyHandler = e => this.onKey(e);
    document.addEventListener('keydown', this.keyHandler);
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.scroller);
    this.syncToolbar();
    this.layout();
  }

  destroy() { document.removeEventListener('keydown', this.keyHandler); this.ro?.disconnect(); }

  setPage(page) { this.page = page; this.undoStack = []; this.redoStack = []; this.syncToolbar(); this.layout(); }

  setTool(t) { this.tool = t; this.syncToolbar(); this.applyTouchAction(); }

  applyTouchAction() {
    this.fg.style.touchAction = this.tool === 'pan' ? 'auto' : this.stylusOnly ? 'pan-x pan-y pinch-zoom' : 'none';
    this.fg.style.cursor = this.tool === 'pan' ? 'grab' : this.tool === 'eraser' ? 'cell' : 'crosshair';
  }

  syncToolbar() {
    const tb = this.toolbar;
    tb.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === this.tool));
    const cols = this.tool === 'highlighter' ? HL_COLORS : COLORS;
    const cur = this.tool === 'highlighter' ? this.hlColor : this.color;
    tb.querySelector('[data-role=colors]').innerHTML = cols.map(c => `<button data-color="${c}" class="sw${c === cur ? ' active' : ''}" style="--c:${c}" title="${c}" aria-label="Color ${c}"></button>`).join('');
    tb.querySelector('[data-role=size]').value = this.tool === 'highlighter' ? this.hlSize : this.tool === 'eraser' ? this.eraserSize : this.size;
    tb.querySelector('[data-role=paper]').value = this.page.paper || 'blank';
    tb.querySelector('[data-role=stylus]').checked = this.stylusOnly;
    const imgBtn = tb.querySelector('[data-act=image], [data-act=rmimage]');
    if (this.page.bgImage) { imgBtn.dataset.act = 'rmimage'; imgBtn.querySelector('span').textContent = 'Remove underlay'; }
    else { imgBtn.dataset.act = 'image'; imgBtn.querySelector('span').textContent = 'Underlay'; }
    this.applyTouchAction();
  }

  setZoom(z) {
    this.zoom = Math.min(4, Math.max(0.4, z));
    this.layout();
  }

  layout() {
    const avail = Math.max(280, this.scroller.clientWidth - 24);
    const cssW = Math.round(Math.min(avail, 900) * this.zoom);
    const cssH = Math.round(cssW * this.page.h / this.page.w);
    this.scale = cssW / this.page.w;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.bg, this.fg]) {
      c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
    }
    this.stage.style.width = cssW + 'px'; this.stage.style.height = cssH + 'px';
    this.pxScale = this.scale * dpr;
    this.redrawBg();
    this.redraw();
  }

  async redrawBg() {
    const ctx = this.bg.getContext('2d');
    ctx.setTransform(this.pxScale, 0, 0, this.pxScale, 0, 0);
    drawPaper(ctx, this.page, this.dark && !this.page.bgImage);
    if (this.page.bgImage) {
      try {
        const img = await loadImage(this.page.bgImage);
        ctx.setTransform(this.pxScale, 0, 0, this.pxScale, 0, 0);
        ctx.drawImage(img, 0, 0, this.page.w, this.page.h);
      } catch {}
    }
  }

  redraw() {
    const ctx = this.fg.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.fg.width, this.fg.height);
    ctx.setTransform(this.pxScale, 0, 0, this.pxScale, 0, 0);
    const darkInk = this.dark && !this.page.bgImage;
    for (const s of this.page.strokes) drawStroke(ctx, darkInk && s.color === '#111827' ? { ...s, color: '#e5e7eb' } : s);
    if (this.current) drawStroke(ctx, this.current);
  }

  toPage(e) {
    const r = this.fg.getBoundingClientRect();
    return [(e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale];
  }

  bindPointer() {
    const fg = this.fg;
    let panning = null;
    fg.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (this.tool === 'pan' || (e.pointerType === 'mouse' && e.buttons === 4)) {
        panning = { x: e.clientX, y: e.clientY, sl: this.scroller.scrollLeft, st: this.scroller.scrollTop };
        fg.setPointerCapture(e.pointerId); return;
      }
      if (this.stylusOnly && e.pointerType === 'touch') return; // let fingers scroll
      e.preventDefault();
      fg.setPointerCapture(e.pointerId);
      const [x, y] = this.toPage(e);
      // pen "eraser end" (button 5) erases
      const tool = e.pointerType === 'pen' && (e.button === 5 || e.buttons === 32) ? 'eraser' : this.tool;
      if (tool === 'eraser') { this.erasing = { removed: [] }; this.eraseAt(x, y); return; }
      const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      this.current = tool === 'highlighter'
        ? { tool, color: this.hlColor, size: this.hlSize, points: [[r2(x), r2(y)]] }
        : { tool: 'pen', color: this.color, size: this.size, points: [[r2(x), r2(y), r2(p)]] };
      this.redraw();
    });
    fg.addEventListener('pointermove', e => {
      if (panning) { this.scroller.scrollLeft = panning.sl - (e.clientX - panning.x); this.scroller.scrollTop = panning.st - (e.clientY - panning.y); return; }
      if (this.erasing) { const [x, y] = this.toPage(e); this.eraseAt(x, y); return; }
      if (!this.current) return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) {
        const [x, y] = this.toPage(ev);
        const last = this.current.points[this.current.points.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) < 0.8) continue;
        if (this.current.tool === 'highlighter') this.current.points.push([r2(x), r2(y)]);
        else this.current.points.push([r2(x), r2(y), r2(ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5)]);
      }
      this.redraw();
    });
    const end = () => {
      if (panning) { panning = null; return; }
      if (this.erasing) {
        if (this.erasing.removed.length) { this.commit({ type: 'erase', strokes: this.erasing.removed }); this.changed(); }
        this.erasing = null; return;
      }
      if (!this.current) return;
      const s = this.current; this.current = null;
      if (s.tool === 'highlighter' && s.points.length > 2) s.points = straighten(s.points);
      this.page.strokes.push(s);
      this.commit({ type: 'add', stroke: s });
      this.redraw();
      this.changed();
    };
    fg.addEventListener('pointerup', end);
    fg.addEventListener('pointercancel', () => { this.current = null; this.erasing = null; panning = null; this.redraw(); });
    fg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !e.buttons) end(); });
    // ctrl + wheel zoom
    this.scroller.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
  }

  eraseAt(x, y) {
    const r = this.eraserSize / Math.max(this.scale, 0.3);
    const keep = [];
    for (const s of this.page.strokes) {
      const hit = s.points.some(p => Math.hypot(p[0] - x, p[1] - y) < r + s.size / 2);
      if (hit) this.erasing.removed.push(s); else keep.push(s);
    }
    if (keep.length !== this.page.strokes.length) { this.page.strokes = keep; this.redraw(); }
  }

  commit(action) { this.undoStack.push(action); if (this.undoStack.length > 200) this.undoStack.shift(); this.redoStack = []; }

  undo() {
    const a = this.undoStack.pop(); if (!a) return;
    if (a.type === 'add') this.page.strokes = this.page.strokes.filter(s => s !== a.stroke);
    if (a.type === 'erase') this.page.strokes.push(...a.strokes);
    if (a.type === 'clear') { a.cleared = this.page.strokes; this.page.strokes = a.prev; }
    this.redoStack.push(a); this.redraw(); this.changed();
  }

  redo() {
    const a = this.redoStack.pop(); if (!a) return;
    if (a.type === 'add') this.page.strokes.push(a.stroke);
    if (a.type === 'erase') this.page.strokes = this.page.strokes.filter(s => !a.strokes.includes(s));
    if (a.type === 'clear') this.page.strokes = [];
    this.undoStack.push(a); this.redraw(); this.changed();
  }

  onKey(e) {
    if (!this.host.isConnected || this.host.offsetParent === null) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod) return;
    const k = e.key.toLowerCase();
    if (k === 'p') this.setTool('pen');
    else if (k === 'h') this.setTool('highlighter');
    else if (k === 'e') this.setTool('eraser');
  }

  async setUnderlay(file) {
    let dataURL;
    if (file.type === 'application/pdf') {
      const pages = await pdfToImages(file);
      if (!pages.length) return;
      let n = 1;
      if (pages.length > 1) n = Math.min(pages.length, Math.max(1, parseInt(prompt(`PDF has ${pages.length} pages. Which page to annotate? (Additional pages can be added as new ink pages.)`, '1'), 10) || 1));
      dataURL = pages[n - 1];
    } else dataURL = await fileToScaledDataURL(file);
    const img = await loadImage(dataURL);
    this.page.bgImage = dataURL;
    this.page.h = Math.round(this.page.w * img.height / img.width);
    this.page.paper = 'blank';
    this.syncToolbar(); this.layout(); this.changed();
  }

  changed() { this.onChange?.(this.page); }
}

const r2 = n => Math.round(n * 100) / 100;

/** Highlighter strokes that are nearly straight snap to a clean line (great for underlining text in a screenshot). */
function straighten(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 40) return pts;
  let maxDev = 0;
  for (const p of pts) {
    const d = Math.abs((b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
    maxDev = Math.max(maxDev, d);
  }
  return maxDev < len * 0.06 ? [a, b] : pts;
}

export async function fileToScaledDataURL(file, maxW = 2000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, maxW / img.width);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  } finally { URL.revokeObjectURL(url); }
}

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

export async function pdfToImages(file, { maxPages = 40, width = 1600 } = {}) {
  const { loadScript, toast } = await import('./util.js');
  try { await loadScript(PDFJS); } catch { toast('Could not load PDF renderer (offline?)', 'error'); return []; }
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const buf = file instanceof Blob ? await file.arrayBuffer() : file;
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const out = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / vp0.width });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    out.push(c.toDataURL('image/jpeg', 0.85));
  }
  return out;
}
