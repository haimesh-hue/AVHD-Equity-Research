// Minimal dependency-free SVG charts: single-series bar chart (annual metric) and line chart (price history).
// One series per chart, so no legend box – the chart title names the metric. Hover tooltips on every mark.

import { esc } from './util.js';

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || mag * 10;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

function attachTooltip(host, svg) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip'; tip.hidden = true;
  host.appendChild(tip);
  return {
    show(htmlStr, x, y) {
      tip.innerHTML = htmlStr; tip.hidden = false;
      const hr = host.getBoundingClientRect();
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(0, x - tw / 2), hr.width - tw) + 'px';
      tip.style.top = Math.max(0, y - tip.offsetHeight - 10) + 'px';
    },
    hide() { tip.hidden = true; },
  };
}

export function barChart(host, data, { format = v => v, height = 220 } = {}) {
  host.innerHTML = '';
  host.classList.add('chart');
  const pts = data.filter(d => d.value != null && !isNaN(d.value));
  if (!pts.length) { host.innerHTML = '<div class="empty small">No data for this metric yet.</div>'; return; }
  const W = Math.max(300, host.clientWidth || 600), H = height;
  const m = { t: 12, r: 8, b: 26, l: 56 };
  const vals = pts.map(d => d.value);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const y = v => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
  const band = (W - m.l - m.r) / pts.length;
  const bw = Math.max(4, Math.min(48, band - 2 - band * 0.25));
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Bar chart">`;
  for (const t of ticks) s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(format(t, true))}</text>`;
  pts.forEach((d, i) => {
    const cx = m.l + band * i + band / 2;
    const y0 = y(0), y1 = y(d.value);
    const top = Math.min(y0, y1), h = Math.max(1, Math.abs(y1 - y0));
    const r = Math.min(4, bw / 2, h);
    // rounded data-end, square at the baseline
    const path = d.value >= 0
      ? `M${cx - bw / 2},${y0} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${y0} Z`
      : `M${cx - bw / 2},${y0} V${top + h - r} Q${cx - bw / 2},${top + h} ${cx - bw / 2 + r},${top + h} H${cx + bw / 2 - r} Q${cx + bw / 2},${top + h} ${cx + bw / 2},${top + h - r} V${y0} Z`;
    s += `<path class="bar${d.value < 0 ? ' neg' : ''}" d="${path}"/>`;
    s += `<rect class="hit" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${H - m.t - m.b}" data-i="${i}" fill="transparent"/>`;
    if (pts.length <= 14 || i % 2 === pts.length % 2) s += `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  s += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/></svg>`;
  host.insertAdjacentHTML('beforeend', s);
  const tip = attachTooltip(host);
  const svg = host.querySelector('svg');
  svg.addEventListener('pointermove', e => {
    const h = e.target.closest('.hit'); if (!h) return tip.hide();
    const d = pts[+h.dataset.i];
    svg.querySelectorAll('.bar').forEach((b, i) => b.classList.toggle('dim', i !== +h.dataset.i));
    const r = h.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const prev = pts[+h.dataset.i - 1];
    const chg = prev && prev.value ? (d.value / prev.value - 1) : null;
    tip.show(`<b>${esc(d.label)}</b><span>${esc(format(d.value))}</span>${chg != null && isFinite(chg) ? `<small>${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(1)}% y/y</small>` : ''}`,
      r.left - hr.left + r.width / 2, y(Math.max(0, d.value)) * (hr.height / H));
  });
  svg.addEventListener('pointerleave', () => { tip.hide(); svg.querySelectorAll('.bar').forEach(b => b.classList.remove('dim')); });
}

export function lineChart(host, data, { format = v => v, height = 200, refLine = null, refLabel = '' } = {}) {
  host.innerHTML = '';
  host.classList.add('chart');
  const pts = data.filter(d => d.value != null);
  if (pts.length < 2) { host.innerHTML = '<div class="empty small">Price history builds up automatically as data refreshes.</div>'; return; }
  const W = Math.max(300, host.clientWidth || 600), H = height;
  const m = { t: 12, r: 12, b: 26, l: 56 };
  const vals = pts.map(d => d.value).concat(refLine != null ? [refLine] : []);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const x = i => m.l + (W - m.l - m.r) * (i / (pts.length - 1));
  const y = v => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Line chart">`;
  for (const t of ticks) s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(format(t))}</text>`;
  if (refLine != null) s += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(refLine)}" y2="${y(refLine)}"/><text class="axis ref-label" x="${W - m.r}" y="${y(refLine) - 5}" text-anchor="end">${esc(refLabel)}</text>`;
  const lbls = [0, Math.floor(pts.length / 2), pts.length - 1];
  lbls.forEach((i, k) => { s += `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}">${esc(pts[i].label)}</text>`; });
  s += `<path class="line" d="${pts.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ')}"/>`;
  s += `<line class="cross" y1="${m.t}" y2="${H - m.b}" x1="0" x2="0" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/>`;
  s += `<rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg>`;
  host.insertAdjacentHTML('beforeend', s);
  const svg = host.querySelector('svg');
  const tip = attachTooltip(host);
  const cross = svg.querySelector('.cross'), dot = svg.querySelector('.dot');
  svg.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) * (W / r.width);
    const i = Math.max(0, Math.min(pts.length - 1, Math.round((px - m.l) / (W - m.l - m.r) * (pts.length - 1))));
    const d = pts[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(d.value)); dot.setAttribute('visibility', 'visible');
    tip.show(`<b>${esc(d.label)}</b><span>${esc(format(d.value))}</span>`, x(i) * (r.width / W), y(d.value) * (r.height / H));
  });
  svg.addEventListener('pointerleave', () => { tip.hide(); cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
}

export function sparkline(values, w = 80, h = 22) {
  const v = values.filter(x => x != null && !isNaN(x));
  if (v.length < 2) return '';
  const lo = Math.min(...v), hi = Math.max(...v);
  const pts = v.map((val, i) => `${(i / (v.length - 1) * (w - 2) + 1).toFixed(1)},${(h - 2 - (hi === lo ? 0.5 : (val - lo) / (hi - lo)) * (h - 4)).toFixed(1)}`);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.join(' ')}"/></svg>`;
}
