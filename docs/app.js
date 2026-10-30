'use strict';
/* viuit web app: runs fully in the browser. No upload, no server. */
const $ = (s, el = document) => el.querySelector(s);
const RES = { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080] };
const BITRATE = { '480p': 3e6, '720p': 6e6, '1080p': 12e6 };
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

const state = {
  clips: [], audios: [], texts: [], captions: [],
  cap: { enabled: true, size: 54, color: '#ffffff', bottom: 24, x: 50, box: false, tpl: 'classic' },
  t: 0, playing: false, res: '1080p', aspect: 'auto',
};
let uid = 1;

/* ------------------------------------------------------------ helpers */
const fmt = t => { t = Math.max(0, t || 0); return Math.floor(t / 60) + ':' + (t % 60).toFixed(1).padStart(4, '0'); };
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cspeed = c => c.speed || 1;
const cdur = c => (c.end - c.start) / cspeed(c);
const total = () => state.clips.reduce((a, c) => a + cdur(c), 0);
const fadeAlpha = (c, local, d) => { const f = c.fade || 0; return f ? clamp(Math.min(local / f, (d - local) / f), 0, 1) : 1; };
const FILTERS = { none: '', vivid: 'saturate(1.45) contrast(1.1)', warm: 'sepia(.28) saturate(1.2) hue-rotate(-8deg)', cool: 'saturate(1.1) hue-rotate(12deg) brightness(1.03)', bw: 'grayscale(1)', fade: 'contrast(.85) brightness(1.1) saturate(.8)' };
const FILTER_NAMES = { none: 'None', vivid: 'Vivid', warm: 'Warm', cool: 'Cool', bw: 'B&W', fade: 'Faded' };
let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 3200);
}
const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3 };
function outSize() {
  const S = RES[state.res][1], c = state.clips[0];
  const r = state.aspect === 'auto' ? (c && c.h > c.w ? 9 / 16 : 16 / 9) : ASPECTS[state.aspect];
  const even = n => Math.round(n / 2) * 2;
  return r >= 1 ? [even(S * r), S] : [S, even(S / r)];
}
const curIdx = () => (state.clips.length ? locate(state.t).i : -1);
const currentClip = () => state.clips[curIdx()];
function releaseUrl() { /* keep object URLs alive so Undo can bring clips back */ }
function locate(t) {
  let acc = 0;
  for (let i = 0; i < state.clips.length; i++) {
    const d = cdur(state.clips[i]);
    if (t < acc + d || i === state.clips.length - 1) return { i, local: clamp(t - acc, 0, d), base: acc, d };
    acc += d;
  }
  return null;
}

/* ------------------------------------------------------------ media loading */
function loadMedia(file, tag) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    el.preload = 'auto';
    if (tag === 'video') { el.playsInline = true; el.setAttribute('playsinline', ''); }
    const url = URL.createObjectURL(file);
    el.onloadedmetadata = () => resolve({ el, url });
    el.onerror = () => reject(new Error('This file type is not supported by your browser.'));
    el.src = url;
  });
}
async function addVideos(files) {
  for (const f of files) {
    try {
      const { el, url } = await loadMedia(f, 'video');
      if (!isFinite(el.duration)) throw new Error('Cannot read the length of this video.');
      state.clips.push({ id: uid++, name: f.name, file: f, url, el, dur: el.duration, start: 0, end: +el.duration.toFixed(2), w: el.videoWidth, h: el.videoHeight, fit: 'fit', zoom: 1, px: 50, py: 50, volume: 100, speed: 1, rot: 0, mirror: false, filter: 'none', fade: 0 });
    } catch (e) { toast(f.name + ': ' + e.message); }
  }
  refresh(true);
}
async function addAudio(file) {
  try {
    const { el, url } = await loadMedia(file, 'audio');
    if (!isFinite(el.duration)) throw new Error('Cannot read the length of this sound.');
    state.audios.push({ id: uid++, name: file.name, url, el, dur: el.duration, offset: +state.t.toFixed(1), start: 0, end: +el.duration.toFixed(2), volume: 100 });
    refresh();
  } catch (e) { toast(e.message); }
}

/* ------------------------------------------------------------ audio graph */
let AC, recDest, monitor;
function ensureAudio() {
  if (AC) return;
  AC = new (window.AudioContext || window.webkitAudioContext)();
  recDest = AC.createMediaStreamDestination();
  monitor = AC.createGain();
  monitor.connect(AC.destination);
}
function wire(item, isMusic) {
  ensureAudio();
  if (!item.node) {
    item.node = AC.createMediaElementSource(item.el);
    item.gain = AC.createGain();
    item.node.connect(item.gain);
    item.gain.connect(monitor);
    item.gain.connect(recDest);
  }
  item.gain.gain.value = (item.volume == null ? 100 : item.volume) / 100;
}
function wireAll() { state.clips.forEach(c => wire(c, false)); state.audios.forEach(a => wire(a, true)); }

/* ------------------------------------------------------------ drawing */
const cv = $('#cv'), ctx = cv.getContext('2d');
function wrapLines(text, maxW, g = ctx) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (line && g.measureText(test).width > maxW) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}
const FONT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Sinhala", Arial, sans-serif';
const TPL = {
  classic: { name: 'Classic', font: FONT_SANS, w: 700, color: '#ffffff', stroke: '#000000', sw: 0.14 },
  bold: { name: 'Bold', font: 'Impact, "Arial Black", "Roboto Condensed", ' + FONT_SANS, w: 900, upper: true, color: '#ffd400', stroke: '#000000', sw: 0.2 },
  serif: { name: 'Serif', font: 'Georgia, "Noto Serif", serif', w: 700, color: '#ffffff', stroke: '#000000', sw: 0.07, shadow: true },
  box: { name: 'Box', font: FONT_SANS, w: 700, color: '#ffffff', bg: 'rgba(0,0,0,.65)' },
  neon: { name: 'Neon', font: FONT_SANS, w: 800, color: '#5df2ff', stroke: '#0a3cff', sw: 0.1, glow: '#2de2ff' },
  comic: { name: 'Comic', font: '"Comic Sans MS", "Chalkboard SE", "Marker Felt", ' + FONT_SANS, w: 800, upper: true, color: '#ffffff', stroke: '#e11d48', sw: 0.2 },
  pop: { name: 'Pop', font: FONT_SANS, w: 900, upper: true, color: '#ffffff', bg: '#e5334b' },
  soft: { name: 'Soft', font: FONT_SANS, w: 600, color: '#ffffff', shadow: true, k: 0.85 },
  karaoke: { name: 'Karaoke', font: 'Impact, "Arial Black", "Roboto Condensed", ' + FONT_SANS, w: 900, upper: true, color: '#ffffff', stroke: '#000000', sw: 0.18, anim: 'karaoke', hl: '#39ff6a', pop: true },
  highlight: { name: 'Highlight', font: FONT_SANS, w: 900, upper: true, color: '#ffffff', stroke: '#000000', sw: 0.16, anim: 'karaoke', hl: '#ffd400', pop: true },
  typer: { name: 'Typewriter', font: '"Courier New", ui-monospace, monospace', w: 700, color: '#ffffff', stroke: '#000000', sw: 0.12, anim: 'type' },
  wordpop: { name: 'Word pop', font: FONT_SANS, w: 900, upper: true, color: '#ffffff', stroke: '#000000', sw: 0.16, anim: 'word', pop: true },
  one: { name: 'One word', font: 'Impact, "Arial Black", "Roboto Condensed", ' + FONT_SANS, w: 900, upper: true, color: '#ffd400', stroke: '#000000', sw: 0.2, anim: 'one', pop: true, k: 1.25 },
  boxword: { name: 'Box word', font: FONT_SANS, w: 800, upper: true, color: '#ffffff', stroke: '#000000', sw: 0.14, anim: 'karaoke', hl: '#ffffff', hlbg: '#7c3aed' },
};
function evenWords(text, s, e) {
  const ws = String(text).trim().split(/\s+/).filter(Boolean), tot = ws.reduce((a, w) => a + w.length + 1, 0) || 1; let t = s;
  return ws.map(w => { const d = (e - s) * (w.length + 1) / tot, r = { t: w, s: +t.toFixed(2), e: +(t + d).toFixed(2) }; t += d; return r; });
}
const CAP_FONTS = [
  { id: '', name: 'Template', css: '' },
  { id: 'poppins', name: 'Poppins', css: '"Poppins", sans-serif' },
  { id: 'mont', name: 'Montserrat', css: '"Montserrat", sans-serif' },
  { id: 'bebas', name: 'Bebas Neue', css: '"Bebas Neue", Impact, sans-serif' },
  { id: 'anton', name: 'Anton', css: '"Anton", Impact, sans-serif' },
  { id: 'bangers', name: 'Bangers', css: '"Bangers", Impact, sans-serif' },
  { id: 'marker', name: 'Marker', css: '"Permanent Marker", cursive' },
  { id: 'lobster', name: 'Lobster', css: '"Lobster", cursive' },
  { id: 'pacifico', name: 'Pacifico', css: '"Pacifico", cursive' },
  { id: 'sinhala', name: 'සිංහල Sans', css: '"Noto Sans Sinhala", sans-serif' },
  { id: 'abhaya', name: 'සිංහල Serif', css: '"Abhaya Libre", "Noto Serif Sinhala", serif' },
];
let fontOver = '';
const fontOf = tp => fontOver ? fontOver + ', ' + FONT_SANS : tp.font;
/* caption with word-by-word animation (karaoke highlight, typewriter, word pop, one word at a time) */
function drawCaptionAnim(g, c, t, x, y, W, id, color, px, forceBox) {
  const tp = TPL[id] || TPL.classic;
  if (!tp.anim) return drawStyled(g, c.text, x, y, W, id, color, px, 'bottom', 0.88, forceBox);
  px *= tp.k || 1;
  const words = c.words && c.words.length ? c.words : evenWords(c.text, c.start, c.end);
  g.save(); g.textBaseline = 'middle'; g.lineJoin = 'round'; g.textAlign = 'left'; g.font = tp.w + ' ' + px + 'px ' + fontOf(tp);
  const toks = words.map(w => { const tx = tp.upper ? w.t.toUpperCase() : w.t; return { ...w, tx, w: g.measureText(tx).width }; });
  let act = 0; toks.forEach((w, i) => { if (t >= w.s) act = i; });
  const stroke = (txt, ox, oy) => { if (tp.stroke) { g.lineWidth = Math.max(2, px * tp.sw); g.strokeStyle = tp.stroke; g.strokeText(txt, ox, oy); } };
  const pop = w => (tp.pop ? 0.7 + 0.3 * clamp((t - w.s) / 0.14, 0, 1) : 1);
  if (tp.anim === 'one') {
    const w = toks[act], sc = pop(w); g.save(); g.translate(x, y - px * 0.7); g.scale(sc, sc); g.textAlign = 'center';
    stroke(w.tx, 0, 0); g.fillStyle = color; g.fillText(w.tx, 0, 0); g.restore(); g.restore();
    return { x: x - w.w / 2, y: y - px * 0.7 - px * 0.62, w: w.w, h: px * 1.25 };
  }
  const space = g.measureText(' ').width, maxW = W * 0.88, lines = []; let cur = { items: [], w: 0 };
  toks.forEach((w, i) => { const add = (cur.items.length ? space : 0) + w.w; if (cur.items.length && cur.w + add > maxW) { lines.push(cur); cur = { items: [], w: 0 }; } cur.w += (cur.items.length ? space : 0) + w.w; cur.items.push(i); });
  lines.push(cur);
  const lh = px * 1.25, bh = lines.length * lh, top = y - bh, bw = Math.max(...lines.map(l => l.w));
  if (forceBox) { g.fillStyle = 'rgba(0,0,0,.6)'; rr(g, x - bw / 2 - px * 0.45, top - px * 0.1, bw + px * 0.9, bh + px * 0.2, px * 0.28); g.fill(); }
  lines.forEach((ln, li) => {
    let xx = x - ln.w / 2; const cy = top + (li + 0.5) * lh;
    ln.items.forEach(i => {
      const w = toks[i], isAct = i === act; let txt = w.tx, vis = true;
      if (tp.anim === 'word' && i > act) vis = false;
      if (tp.anim === 'type') { if (i > act) vis = false; else if (isAct) txt = w.tx.slice(0, Math.max(1, Math.ceil(clamp((t - w.s) / Math.max(0.05, w.e - w.s), 0, 1) * w.tx.length))); }
      if (vis) {
        const sc = isAct ? pop(w) : 1;
        g.save(); g.translate(xx + w.w / 2, cy); g.scale(sc, sc); g.translate(-w.w / 2, 0);
        if (tp.hlbg && isAct) { g.fillStyle = tp.hlbg; rr(g, -px * 0.2, -lh * 0.46, w.w + px * 0.4, lh * 0.92, px * 0.22); g.fill(); }
        else stroke(txt, 0, 0);
        g.fillStyle = tp.hl && isAct && !tp.hlbg ? tp.hl : tp.hlbg && isAct ? tp.hl : color; g.fillText(txt, 0, 0); g.restore();
      }
      xx += w.w + space;
    });
  });
  g.restore();
  return { x: x - bw / 2, y: top, w: bw, h: bh };
}
/* draws text with a template. anchor: 'bottom' (y is the bottom edge) or 'center'. returns its box. */
function drawStyled(g, text, x, y, W, id, color, px, anchor, maxFrac, forceBox) {
  const t = TPL[id] || TPL.classic; px *= t.k || 1;
  g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  g.font = t.w + ' ' + px + 'px ' + fontOf(t);
  const lines = wrapLines(t.upper ? String(text).toUpperCase() : String(text), W * maxFrac, g), lh = px * 1.22, bh = lines.length * lh;
  const top = anchor === 'bottom' ? y - bh : y - bh / 2, bw = Math.max(...lines.map(l => g.measureText(l).width));
  const bg = t.bg || (forceBox ? 'rgba(0,0,0,.6)' : null);
  if (bg) { g.fillStyle = bg; rr(g, x - bw / 2 - px * 0.45, top - px * 0.12, bw + px * 0.9, bh + px * 0.24, px * 0.28); g.fill(); }
  if (t.shadow) { g.shadowColor = 'rgba(0,0,0,.75)'; g.shadowBlur = px * 0.18; g.shadowOffsetY = px * 0.05; }
  if (t.glow) { g.shadowColor = t.glow; g.shadowBlur = px * 0.5; }
  lines.forEach((ln, i) => {
    const cy = top + (i + 0.5) * lh;
    if (t.stroke && !bg) { g.lineWidth = Math.max(2, px * t.sw); g.strokeStyle = t.stroke; g.strokeText(ln, x, cy); }
    g.fillStyle = color; g.fillText(ln, x, cy);
  });
  g.restore();
  return { x: x - bw / 2, y: top, w: bw, h: bh };
}
let textBoxes = [], capBox = null, sel = null, dragIt = null, guides = { v: false, h: false };
function drawOverlays(t, W, H) {
  const k = Math.min(W, H) / 1080; textBoxes = []; capBox = null;
  state.texts.forEach((x, i) => {
    if (t < x.start || t >= x.end || !x.text.trim()) return;
    const b = drawStyled(ctx, x.text, W * x.x / 100, H * x.y / 100, W, x.tpl || 'classic', x.color, Math.max(8, x.size * k), 'center', 0.92, false);
    textBoxes.push({ i, ...b });
  });
  const cs = state.cap;
  if (cs.enabled) {
    const fo = CAP_FONTS.find(f => f.id === cs.font); fontOver = fo ? fo.css : '';
    const c = state.captions.find(c => t >= c.start && t < c.end);
    if (c && c.text.trim()) capBox = drawCaptionAnim(ctx, c, t, W * (cs.x == null ? 50 : cs.x) / 100, H - H * cs.bottom / 100, W, cs.tpl || 'classic', cs.color, Math.max(8, cs.size * k), cs.box);
    fontOver = '';
  }
}
function clipRect(c, W, H) {
  const vw0 = c.el.videoWidth || c.w, vh0 = c.el.videoHeight || c.h, sw = ((c.rot || 0) % 180) !== 0, vw = sw ? vh0 : vw0, vh = sw ? vw0 : vh0;
  const s = (c.fit === 'fill' ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh)) * c.zoom, w = vw * s, h = vh * s;
  return { x: w > W ? (W - w) * c.px / 100 : (W - w) / 2, y: h > H ? (H - h) * c.py / 100 : (H - h) / 2, w, h };
}
function layoutCanvas(W, H) {
  const box = cv.parentElement, bw = box.clientWidth, bh = box.clientHeight;
  if (!bw || !bh) return;
  const s = Math.min(bw / W, bh / H), w = Math.round(W * s) + 'px', h = Math.round(H * s) + 'px';
  if (cv.style.width !== w) cv.style.width = w;
  if (cv.style.height !== h) cv.style.height = h;
  if (ov.style.width !== w) ov.style.width = w;
  if (ov.style.height !== h) ov.style.height = h;
}
const ov = $('#ov'), og = ov.getContext('2d');
function drawUI() {
  const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!w) return;
  if (ov.width !== Math.round(w * dpr) || ov.height !== Math.round(h * dpr)) { ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr); }
  og.setTransform(dpr, 0, 0, dpr, 0, 0); og.clearRect(0, 0, w, h);
  const k = w / cv.width;
  if (sel && (!state.playing || dragIt)) {
    const b = sel.type === 'cap' ? capBox : textBoxes.find(x => x.i === sel.i);
    if (b) {
      const pad = 8, x = b.x * k - pad, y = b.y * k - pad, bw = b.w * k + pad * 2, bh = b.h * k + pad * 2;
      og.strokeStyle = '#fff'; og.lineWidth = 1.5; og.strokeRect(x, y, bw, bh); og.fillStyle = '#fff';
      [[x, y], [x + bw, y], [x, y + bh], [x + bw, y + bh]].forEach(([cx, cy]) => { og.beginPath(); og.arc(cx, cy, 4, 0, 7); og.fill(); });
    }
  }
  og.strokeStyle = '#ff4fa3'; og.lineWidth = 1.5; og.setLineDash([6, 5]);
  if (guides.v) { og.beginPath(); og.moveTo(w / 2, 0); og.lineTo(w / 2, h); og.stroke(); }
  if (guides.h) { og.beginPath(); og.moveTo(0, h / 2); og.lineTo(w, h / 2); og.stroke(); }
  og.setLineDash([]);
}
let exporting = false, layoutDirty = true, lastLay = '';
function previewSize() {
  let [W, H] = outSize();
  if (!exporting) { const s = Math.min(1, 960 / Math.max(W, H)); W = Math.round(W * s / 2) * 2; H = Math.round(H * s / 2) * 2; }
  return [W, H];
}
function draw(t) {
  const [W, H] = previewSize();
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  if (layoutDirty || lastLay !== W + 'x' + H) { layoutDirty = false; lastLay = W + 'x' + H; layoutCanvas(W, H); }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const loc = locate(t);
  if (loc) {
    const el = state.clips[loc.i].el;
    const c = state.clips[loc.i];
    if (el.videoWidth) {
      const r = clipRect(c, W, H), rot = (c.rot || 0) % 360, sw = rot % 180 !== 0;
      ctx.save(); ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      if (c.mirror) ctx.scale(-1, 1);
      if (rot) ctx.rotate(rot * Math.PI / 180);
      if (FILTERS[c.filter]) ctx.filter = FILTERS[c.filter];
      ctx.drawImage(el, -(sw ? r.h : r.w) / 2, -(sw ? r.w : r.h) / 2, sw ? r.h : r.w, sw ? r.w : r.h);
      ctx.restore();
      const al = fadeAlpha(c, loc.local, loc.d);
      if (al < 1) { ctx.fillStyle = 'rgba(0,0,0,' + (1 - al) + ')'; ctx.fillRect(0, 0, W, H); }
    }
  }
  drawOverlays(t, W, H);
  drawUI();
}

/* ------------------------------------------------------------ playback */
let raf = 0, playStart = 0, tStart = 0, curClip = -1, prepared = -1, onEnd = null, seekToken = 0;
async function seekTo(t) {
  const my = ++seekToken;
  state.t = clamp(t, 0, total());
  const loc = locate(state.t);
  if (loc) {
    const c = state.clips[loc.i], want = c.start + loc.local * cspeed(c);
    if (Math.abs(c.el.currentTime - want) > 0.03) {
      await new Promise(res => {
        const done = () => { c.el.removeEventListener('seeked', done); res(); };
        c.el.addEventListener('seeked', done); c.el.currentTime = want; setTimeout(done, 700);
      });
    }
  }
  if (my === seekToken) { draw(state.t); updateTransport(); }
}
function sync(t) {
  const loc = locate(t), c = state.clips[loc.i], want = c.start + loc.local * cspeed(c);
  if (loc.i !== curClip) {
    if (state.clips[curClip]) state.clips[curClip].el.pause();
    curClip = loc.i; c.el.playbackRate = cspeed(c);
    if (prepared !== loc.i) c.el.currentTime = want;
    c.el.play().catch(() => {});
  } else if (Math.abs(c.el.currentTime - want) > 0.4 * cspeed(c)) c.el.currentTime = want;
  if (c.gain) c.gain.gain.value = (c.volume == null ? 100 : c.volume) / 100 * fadeAlpha(c, loc.local, loc.d);
  const nxt = state.clips[loc.i + 1];
  if (nxt && loc.d - loc.local < 0.7 && prepared !== loc.i + 1) { nxt.el.currentTime = nxt.start; prepared = loc.i + 1; }
  for (const a of state.audios) {
    const rel = t - a.offset, inside = rel >= 0 && rel < a.end - a.start;
    if (inside && a.el.paused) { a.el.currentTime = a.start + rel; a.el.play().catch(() => {}); }
    else if (!inside && !a.el.paused) a.el.pause();
  }
}
function play(endCb) {
  if (!state.clips.length) return toast('Add a video first.');
  ensureAudio(); AC.resume(); wireAll();
  if (state.t >= total() - 0.05) state.t = 0;
  state.playing = true; tStart = state.t; playStart = performance.now(); curClip = -1; prepared = -1; onEnd = endCb || null;
  setPlayIcon(); loop();
}
function pause() {
  state.playing = false; cancelAnimationFrame(raf);
  state.clips.forEach(c => c.el.pause()); state.audios.forEach(a => a.el.pause());
  setPlayIcon();
}
let frameN = 0;
function loop() {
  if (!state.playing) return;
  const t = tStart + (performance.now() - playStart) / 1000;
  if (t >= total()) {
    state.t = total(); draw(state.t); updateTransport();
    const cb = onEnd; onEnd = null; pause(); if (cb) cb(); return;
  }
  sync(t); state.t = t; draw(t);
  $('#tlabel').textContent = fmtS(t) + ' / ' + fmtS(total());
  if ((++frameN & 1) === 0 || exporting) drawTimeline();
  raf = requestAnimationFrame(loop);
}
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
function setPlayIcon() { const b = $('#playBtn'); b.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY; b.setAttribute('aria-label', state.playing ? 'Pause' : 'Play'); }
const fmtS = t => { t = Math.max(0, t || 0); return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0'); };
function updateTransport() {
  $('#tlabel').textContent = fmtS(state.t) + ' / ' + fmtS(total());
  const c = currentClip(); $('#fitBtn').textContent = c && c.fit === 'fill' ? 'Fill' : 'Fit'; $('#fitBtn').disabled = !c;
  syncClipControls();
  $('#undoBtn').disabled = hi <= 0; $('#redoBtn').disabled = hi >= hist.length - 1;
  drawTimeline();
}

/* ------------------------------------------------------------ timeline (fixed white line in the middle, drag to move) */
const tl = $('#tl'), tctx = tl.getContext('2d');
let pps = 70, viewT = null, tlGeom = [];
const ROWS = [{ h: 46, c: '#2f6fe0' }, { h: 28, c: '#2c9a69' }, { h: 28, c: '#bf922c' }, { h: 28, c: '#8f5bc9' }];
function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function drawTimeline() {
  const dpr = window.devicePixelRatio || 1, w = tl.clientWidth, h = tl.clientHeight;
  if (!w) return;
  if (tl.width !== Math.round(w * dpr) || tl.height !== Math.round(h * dpr)) { tl.width = Math.round(w * dpr); tl.height = Math.round(h * dpr); }
  const c = tctx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const cx = w / 2, vt = viewT == null ? state.t : viewT, X = t => cx + (t - vt) * pps;
  c.textBaseline = 'middle'; c.font = '11px system-ui, sans-serif';
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600], step = steps.find(s => s * pps >= 64) || 600;
  const tMin = vt - cx / pps, tMax = vt + (w - cx) / pps;
  for (let t = Math.max(0, Math.floor(tMin / step) * step); t <= tMax; t += step) {
    const x = X(t); c.fillStyle = '#3a3b45'; c.fillRect(x, 8, 1, 6);
    c.fillStyle = '#8b8d98'; c.textAlign = 'left'; c.fillText(fmtS(t) + (step < 1 && t % 1 ? '.5' : ''), x + 4, 11);
  }
  let acc = 0, y = 24; tlGeom = [];
  const blocks = [
    state.clips.map(k => { const s0 = acc; acc += cdur(k); tlGeom.push({ xa: X(s0), xb: X(acc), s: s0 }); return [s0, acc, k.name]; }),
    state.audios.map(a => [a.offset, a.offset + a.end - a.start, a.name]),
    state.texts.map(x => [x.start, x.end, x.text.replace(/\n/g, ' ')]),
    state.captions.map(x => [x.start, x.end, x.text]),
  ];
  ROWS.forEach((row, i) => {
    blocks[i].forEach(([s0, e0, label]) => {
      const xa = X(s0) + 1, xb = Math.max(X(e0) - 1, xa + 3);
      if (xb < 0 || xa > w) return;
      c.fillStyle = row.c; rr(c, xa, y, xb - xa, row.h, 6); c.fill();
      if (xb - xa > 30) { c.save(); rr(c, xa, y, xb - xa, row.h, 6); c.clip(); c.fillStyle = 'rgba(255,255,255,.92)'; c.textAlign = 'left'; c.font = '11px system-ui, sans-serif'; c.fillText(label, Math.max(xa, 0) + 8, y + row.h / 2); c.restore(); }
    });
    if (!blocks[i].length && i === 0) { c.fillStyle = '#6f717c'; c.textAlign = 'center'; c.font = '14px system-ui, sans-serif'; c.fillText('Add media to timeline to start creating video!', cx, y + row.h / 2); }
    y += row.h + 6;
  });
  const g = tlGeom[curIdx()];
  if (g) {
    const v = ROWS[0]; c.strokeStyle = '#fff'; c.lineWidth = 2; rr(c, g.xa + 1, 24, Math.max(g.xb - g.xa - 2, 4), v.h, 6); c.stroke();
    c.fillStyle = '#fff'; rr(c, g.xa - 4, 20, 9, v.h + 8, 4); c.fill(); rr(c, g.xb - 5, 20, 9, v.h + 8, 4); c.fill();
    c.fillStyle = '#15161a'; c.fillRect(g.xa - 0.5, 36, 1.5, 22); c.fillRect(g.xb - 0.5, 36, 1.5, 22);
  }
  c.fillStyle = '#fff'; c.fillRect(cx - 1, 0, 2, h); c.beginPath(); c.arc(cx, 4, 4, 0, 7); c.fill();
}
let tlDrag = null, trim = null;
const tlX = e => e.clientX - tl.getBoundingClientRect().left;
tl.addEventListener('pointerdown', e => {
  const x = tlX(e), y = e.clientY - tl.getBoundingClientRect().top;
  tl.setPointerCapture(e.pointerId);
  const ci = curIdx(), g = tlGeom[ci];
  if (g && y >= 14 && y <= 80) {
    const c = state.clips[ci], base = { c, x, pps, start: c.start, end: c.end, base: g.s, vt0: state.t, edge: 0 };
    if (Math.abs(x - g.xa) <= 20) trim = { ...base, mode: 's', edge: g.xa };
    else if (Math.abs(x - g.xb) <= 20) trim = { ...base, mode: 'e', edge: g.xb };
  }
  if (trim) { if (state.playing) pause(); viewT = trim.vt0; return; }
  tlDrag = { x0: e.clientX, t0: state.t, moved: false };
});
tl.addEventListener('pointermove', e => {
  if (trim) {
    const x = tlX(e), dt = (x - trim.x) / pps, c = trim.c, cx = tl.clientWidth / 2;
    if (trim.mode === 's') {
      c.start = +clamp(trim.start + dt * cspeed(c), 0, trim.end - 0.2).toFixed(2); state.t = trim.base;
      viewT = trim.base - (trim.edge + (x - trim.x) - cx) / pps;
    } else {
      c.end = +clamp(trim.end + dt * cspeed(c), trim.start + 0.2, c.dur).toFixed(2); state.t = Math.max(trim.base, trim.base + cdur(c) - 0.05);
    }
    seekTo(state.t); return;
  }
  if (tlDrag) {
    const dx = e.clientX - tlDrag.x0;
    if (Math.abs(dx) > 4) tlDrag.moved = true;
    if (tlDrag.moved) { if (state.playing) pause(); seekTo(clamp(tlDrag.t0 - dx / pps, 0, total())); }
  }
});
const tlUp = e => {
  if (tlDrag && !tlDrag.moved && e.type === 'pointerup') {
    if (state.playing) pause();
    const y = e.clientY - tl.getBoundingClientRect().top, tt = state.t + (tlX(e) - tl.clientWidth / 2) / pps;
    const row = y < 76 ? 0 : y < 110 ? 1 : y < 144 ? 2 : 3;
    const hit = row === 1 ? state.audios.findIndex(a => tt >= a.offset && tt < a.offset + a.end - a.start)
      : row === 2 ? state.texts.findIndex(x => tt >= x.start && tt < x.end) : row === 3 ? state.captions.findIndex(x => tt >= x.start && tt < x.end) : -1;
    if (hit >= 0) { (row === 1 ? editAudio : row === 2 ? editText : editCaption)(hit); tlDrag = null; return; }
    seekTo(clamp(tt, 0, total()));
  }
  tlDrag = null;
  if (trim) { trim = null; viewT = null; refresh(true); }
};
tl.addEventListener('pointerup', tlUp); tl.addEventListener('pointercancel', tlUp);
$('#zIn').onclick = () => { pps = Math.min(400, pps * 1.4); drawTimeline(); };
$('#zOut').onclick = () => { pps = Math.max(5, pps / 1.4); drawTimeline(); };
$('#zFit').onclick = () => { pps = clamp((tl.clientWidth / 2 - 16) / Math.max(total(), 1), 5, 400); seekTo(0); };

/* ------------------------------------------------------------ clip tools */
async function splitClip() {
  const i = curIdx(); if (i < 0) return toast('Add a video first.');
  pause();
  const c = state.clips[i], loc = locate(state.t), at = c.start + loc.local * cspeed(c);
  if (at - c.start < 0.15 || c.end - at < 0.15) return toast('Move the playhead inside the clip to split it.');
  try {
    const { el } = await loadMedia(c.file, 'video');
    const b = { ...c, id: uid++, el, node: null, gain: null, start: +at.toFixed(2) };
    c.end = +at.toFixed(2);
    state.clips.splice(i + 1, 0, b);
    refresh(true); toast('Split. Drag the white handles on the timeline to trim.');
  } catch (e) { toast('Could not split this clip.'); }
}
function deleteClip() {
  const i = curIdx(); if (i < 0) return;
  pause(); const c = state.clips[i]; c.el.pause(); state.clips.splice(i, 1); releaseUrl(c.url); refresh(true);
}
function moveClip(d) {
  const i = curIdx(), j = i + d; if (i < 0 || j < 0 || j >= state.clips.length) return;
  pause(); const t0 = state.clips.slice(0, j).reduce((a, c) => a + cdur(c), 0);
  [state.clips[i], state.clips[j]] = [state.clips[j], state.clips[i]];
  state.t = t0 + 0.01; refresh(true);
}
let cropMode = false; const ptrs = new Map(); let pinch = null;
function setCrop(on) {
  cropMode = on; $('#cropBtn').classList.toggle('on', on); cv.classList.toggle('crop', on);
  if (on) { closeDrawer(); toast('Drag the video to move it. Pinch to zoom. Tap Crop again when done.'); }
}
const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
cv.addEventListener('pointerdown', e => {
  if (!cropMode || !state.clips.length) return;
  if (state.playing) pause();
  cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) pinch = { d: dist(), zoom: currentClip().zoom };
});
cv.addEventListener('pointermove', e => {
  const prev = ptrs.get(e.pointerId); if (!cropMode || !prev) return;
  const c = currentClip(), [W, H] = outSize(), rc = cv.getBoundingClientRect(), k = 1 / Math.min(rc.width / W, rc.height / H);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2 && pinch) { c.zoom = clamp(pinch.zoom * dist() / pinch.d, 1, 5); }
  else if (ptrs.size === 1) {
    const r = clipRect(c, W, H), dx = (e.clientX - prev.x) * k, dy = (e.clientY - prev.y) * k;
    if (r.w > W + 0.5) c.px = clamp(c.px + dx * 100 / (W - r.w), 0, 100);
    if (r.h > H + 0.5) c.py = clamp(c.py + dy * 100 / (H - r.h), 0, 100);
  }
  draw(state.t);
});
const cropUp = e => { ptrs.delete(e.pointerId); pinch = null; commit(); updateTransport(); };
cv.addEventListener('pointerup', cropUp); cv.addEventListener('pointercancel', cropUp);

/* ------------------------------------------------------------ bottom sheet */
function openSheet({ title, fields, extra = [], onSave, onDelete }) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = fields.map(f => {
    const id = 'f_' + f.k, v = esc(f.v);
    const input = f.type === 'select' ? `<select id="${id}">${f.opts.map(o => `<option value="${o[0]}"${o[0] === f.v ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>` : f.type === 'area' ? `<textarea id="${id}" rows="2">${v}</textarea>`
      : `<input id="${id}" type="${f.type || 'text'}" value="${v}" ${f.type === 'number' ? 'step="any" inputmode="decimal"' : ''}>`;
    return `<label class="field">${esc(f.label)}${input}</label>`;
  }).join('');
  const ex = $('#sheetExtra'); ex.innerHTML = '';
  extra.forEach(a => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = a.label; b.onclick = () => { a.run(); close(); }; ex.appendChild(b); });
  const wrap = $('#sheetWrap'); wrap.hidden = false;
  const close = () => { wrap.hidden = true; };
  $('#sheetCancel').onclick = close; $('#sheetBack').onclick = close;
  $('#sheetDel').hidden = !onDelete; $('#sheetDel').onclick = () => { onDelete(); close(); };
  $('#sheet').onsubmit = e => {
    e.preventDefault();
    const vals = {}; fields.forEach(f => (vals[f.k] = $('#f_' + f.k).value));
    onSave(vals); close();
  };
  const first = $('#sheetBody input, #sheetBody textarea'); if (first) first.focus();
}

/* ------------------------------------------------------------ lists */
function refresh(seek) {
  const li = (t, n, onclick) => { const e = document.createElement('li'); e.innerHTML = `<span class="t">${esc(t)}</span><span class="n">${esc(n)}</span>`; e.onclick = onclick; return e; };
  const fill = (id, items) => { const ul = $(id); ul.innerHTML = ''; items.forEach(i => ul.appendChild(i)); };
  fill('#list-videos', state.clips.map((c, i) => li(fmt(cdur(c)) + (cspeed(c) !== 1 ? ' · ' + cspeed(c) + 'x' : ''), c.name, () => { pause(); state.t = state.clips.slice(0, i).reduce((a, k) => a + cdur(k), 0) + 0.01; editClip(i); seekTo(state.t); })));
  fill('#list-sound', state.audios.map((a, i) => li('at ' + fmt(a.offset) + ' · ' + Math.round(a.volume) + '%', a.name, () => editAudio(i))));
  fill('#list-text', state.texts.map((x, i) => li(fmt(x.start) + '–' + fmt(x.end), x.text.replace(/\n/g, ' '), () => editText(i))));
  fill('#list-captions', state.captions.map((x, i) => li(fmt(x.start), x.text, () => editCaption(i))));
  $('#empty').hidden = state.clips.length > 0;
  state.t = clamp(state.t, 0, total());
  if (state.playing) { tStart = state.t; playStart = performance.now(); }
  commit();
  updateTransport();
  if (seek || !state.playing) seekTo(state.t);
}
function editClip(i) {
  const c = state.clips[i];
  openSheet({
    title: 'Clip: trim, crop, volume', fields: [
      { k: 's', label: 'Start (seconds)', type: 'number', v: c.start }, { k: 'e', label: 'End (seconds, max ' + c.dur.toFixed(1) + ')', type: 'number', v: c.end },
      { k: 'fit', label: 'Frame', type: 'select', v: c.fit, opts: [['fit', 'Fit (show whole video)'], ['fill', 'Fill (crop to fill the frame)']] },
      { k: 'z', label: 'Zoom (1 to 5)', type: 'number', v: c.zoom }, { k: 'px', label: 'Move left/right % (0 to 100)', type: 'number', v: Math.round(c.px) },
      { k: 'py', label: 'Move up/down % (0 to 100)', type: 'number', v: Math.round(c.py) }, { k: 'v', label: 'Volume %', type: 'number', v: c.volume }],
    extra: [
      { label: 'Move earlier', run: () => { if (i > 0) { [state.clips[i - 1], state.clips[i]] = [state.clips[i], state.clips[i - 1]]; refresh(true); } } },
      { label: 'Move later', run: () => { if (i < state.clips.length - 1) { [state.clips[i + 1], state.clips[i]] = [state.clips[i], state.clips[i + 1]]; refresh(true); } } }],
    onSave: v => {
      const s = clamp(num(v.s), 0, c.dur), e = clamp(num(v.e, c.dur), 0, c.dur);
      if (e - s < 0.1) return toast('End must be after start.');
      c.start = +s.toFixed(2); c.end = +e.toFixed(2); c.fit = v.fit; c.zoom = clamp(num(v.z, 1), 1, 5);
      c.px = clamp(num(v.px, 50), 0, 100); c.py = clamp(num(v.py, 50), 0, 100); c.volume = clamp(num(v.v, 100), 0, 300);
      if (c.gain) c.gain.gain.value = c.volume / 100;
      refresh(true);
    },
    onDelete: () => { c.el.pause(); state.clips.splice(i, 1); releaseUrl(c.url); refresh(true); },
  });
}
function editAudio(i) {
  const a = state.audios[i];
  openSheet({
    title: 'Sound settings', fields: [
      { k: 'o', label: 'Starts on timeline (seconds)', type: 'number', v: a.offset }, { k: 's', label: 'Use from (seconds)', type: 'number', v: a.start },
      { k: 'e', label: 'Use until (seconds, max ' + a.dur.toFixed(1) + ')', type: 'number', v: a.end }, { k: 'v', label: 'Volume %', type: 'number', v: a.volume }],
    onSave: v => {
      a.offset = Math.max(0, num(v.o)); a.start = clamp(num(v.s), 0, a.dur);
      a.end = clamp(num(v.e, a.dur), a.start + 0.1, a.dur); a.volume = clamp(num(v.v, 100), 0, 300); refresh();
    },
    onDelete: () => { a.el.pause(); state.audios.splice(i, 1); refresh(); },
  });
}
function textFields(x) {
  return [
    { k: 'text', label: 'Text', type: 'area', v: x.text }, { k: 's', label: 'Start (seconds)', type: 'number', v: x.start }, { k: 'e', label: 'End (seconds)', type: 'number', v: x.end },
    { k: 'x', label: 'Left %', type: 'number', v: x.x }, { k: 'y', label: 'Top %', type: 'number', v: x.y }, { k: 'size', label: 'Size', type: 'number', v: x.size }, { k: 'color', label: 'Color', type: 'color', v: x.color },
    { k: 'tpl', label: 'Style', type: 'select', v: x.tpl || 'classic', opts: Object.entries(TPL).map(([k, t]) => [k, t.name]) }];
}
function readText(v) {
  return { text: v.text, start: Math.max(0, num(v.s)), end: Math.max(0, num(v.e, 3)), x: clamp(num(v.x, 50), 0, 100), y: clamp(num(v.y, 50), 0, 100), size: clamp(num(v.size, 90), 10, 400), color: v.color || '#ffffff', tpl: v.tpl || 'classic' };
}
function editText(i) {
  openSheet({ title: 'Text', fields: textFields(state.texts[i]), onSave: v => { if (v.text.trim()) { state.texts[i] = readText(v); refresh(); } }, onDelete: () => { state.texts.splice(i, 1); refresh(); } });
}
function addText() {
  const s = +state.t.toFixed(1);
  openSheet({ title: 'Add text', fields: textFields({ text: 'Your text', start: s, end: +(s + 3).toFixed(1), x: 50, y: 50, size: 90, color: '#ffffff', tpl: 'bold' }), onSave: v => { if (v.text.trim()) { state.texts.push(readText(v)); refresh(); } } });
}
function capFields(c) { return [{ k: 'text', label: 'Caption', type: 'area', v: c.text }, { k: 's', label: 'Start (seconds)', type: 'number', v: c.start }, { k: 'e', label: 'End (seconds)', type: 'number', v: c.end }]; }
function readCap(v, old) {
  const text = v.text.trim(), start = Math.max(0, num(v.s)), end = Math.max(0, num(v.e)), ws = text.split(/\s+/).filter(Boolean);
  const keep = old && old.words && old.words.length === ws.length && Math.abs(old.start - start) < 0.01 && Math.abs(old.end - end) < 0.01;
  return { text, start, end, words: keep ? old.words.map((w, i) => ({ ...w, t: ws[i] })) : evenWords(text, start, Math.max(end, start + 0.2)) };
}
const sortCaps = () => state.captions.sort((a, b) => a.start - b.start);
function editCaption(i) {
  seekTo(state.captions[i].start);
  openSheet({ title: 'Caption', fields: capFields(state.captions[i]), onSave: v => { if (v.text.trim()) { state.captions[i] = readCap(v, state.captions[i]); sortCaps(); refresh(); } }, onDelete: () => { state.captions.splice(i, 1); refresh(); } });
}
function addCaption() {
  const s = +state.t.toFixed(1);
  openSheet({ title: 'Add caption', fields: capFields({ text: '', start: s, end: +(s + 2).toFixed(1) }), onSave: v => { if (v.text.trim()) { state.captions.push(readCap(v)); sortCaps(); refresh(); } } });
}

/* ------------------------------------------------------------ auto captions (Whisper in the browser) */
async function decodeTimeline16k() {
  const SR = 16000, AC16 = window.AudioContext || window.webkitAudioContext;
  const ac = new AC16({ sampleRate: SR });
  const parts = [];
  for (const c of state.clips) {
    const len = Math.round(cdur(c) * SR), out = new Float32Array(len);
    try {
      const ab = await ac.decodeAudioData(await (await fetch(c.url)).arrayBuffer());
      const chans = []; for (let k = 0; k < ab.numberOfChannels; k++) chans.push(ab.getChannelData(k));
      const ratio = ab.sampleRate / SR, from = Math.round(c.start * ab.sampleRate);
      for (let i = 0; i < len; i++) {
        const idx = from + Math.round(i * ratio * cspeed(c)); let s = 0;
        for (const ch of chans) s += ch[idx] || 0;
        out[i] = s / chans.length;
      }
    } catch (e) { /* no audio track: keep silence */ }
    parts.push(out);
  }
  ac.close && ac.close();
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}
function splitChunk(text, s, e) {
  const words = text.trim().split(/\s+/).filter(Boolean), groups = []; let cur = [];
  for (const w of words) {
    if (cur.length && (cur.length >= 7 || (cur.join(' ') + ' ' + w).length > 34)) { groups.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  const lens = groups.map(g => g.join(' ').length), sum = lens.reduce((a, b) => a + b, 0) || 1;
  let t = s;
  return groups.map((g, i) => { const d = (e - s) * lens[i] / sum, r = { start: +t.toFixed(2), end: +(t + d).toFixed(2), text: g.join(' ') }; r.words = evenWords(r.text, r.start, r.end); t += d; return r; });
}
async function genCaptions() {
  if (!state.clips.length) return toast('Add a video first.');
  if (state.captions.length && !confirm('Replace the existing captions?')) return;
  const btn = $('#genCaps'), box = $('#capStatus'), msg = $('#capMsg'), barWrap = box.querySelector('.bar'), bar = $('#capBar');
  btn.disabled = true; box.hidden = false;
  const say = (m, p) => { msg.textContent = m; if (p == null) barWrap.classList.add('indet'); else { barWrap.classList.remove('indet'); bar.style.width = (p * 100) + '%'; } };
  try {
    say('Reading the audio…');
    const audio = await decodeTimeline16k();
    say('Loading the AI model. The first time this downloads it.', 0);
    const tf = await import(TRANSFORMERS_URL);
    const asr = await tf.pipeline('automatic-speech-recognition', $('#model').value, {
      progress_callback: p => { if (p.status === 'progress' && p.total) say('Downloading AI model… ' + Math.round(p.progress) + '%', p.progress / 100); },
    });
    say('Listening. This can take a few minutes on a phone.');
    const lang = $('#lang').value, opts = { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe', ...(lang ? { language: lang } : {}) };
    const tot = total(); let caps = [], out;
    try { out = await asr(audio, { ...opts, return_timestamps: 'word' }); } catch (err) { console.warn('word timestamps not available, using phrase timing', err); out = null; }
    const wordChunks = out && (out.chunks || []).filter(ch => ch.text && ch.text.trim() && ch.timestamp && ch.timestamp[0] != null);
    if (wordChunks && wordChunks.length > 1 && wordChunks.every(ch => ch.text.trim().split(/\s+/).length === 1)) {
      let cur = [];
      const flush = () => { if (cur.length) { caps.push({ start: cur[0].s, end: cur[cur.length - 1].e, text: cur.map(w => w.t).join(' '), words: cur }); cur = []; } };
      wordChunks.forEach(ch => {
        const w = { t: ch.text.trim(), s: +ch.timestamp[0].toFixed(2), e: +(ch.timestamp[1] ?? ch.timestamp[0] + 0.3).toFixed(2) };
        if (cur.length && (cur.length >= 6 || (cur.map(x => x.t).join(' ') + ' ' + w.t).length > 32 || w.s - cur[cur.length - 1].e > 0.7)) flush();
        cur.push(w); if (/[.!?]$/.test(w.t) && cur.length >= 2) flush();
      });
      flush();
    } else {
      out = await asr(audio, { ...opts, return_timestamps: true });
      for (const ch of out.chunks || []) {
        if (!ch.text || !ch.text.trim()) continue;
        const s0 = ch.timestamp[0] ?? 0, e0 = ch.timestamp[1] ?? Math.min(tot, s0 + 3);
        caps.push(...splitChunk(ch.text, s0, Math.max(e0, s0 + 0.4)));
      }
    }
    state.captions = caps; sortCaps();
    say(caps.length + ' captions added. Tap one to fix a word.', 1);
    refresh();
  } catch (e) {
    console.error(e);
    say('Captions failed: ' + (e.message || e) + '. Check your internet connection and try again.', 0);
  } finally { btn.disabled = false; box.querySelector('.bar').classList.remove('indet'); }
}

/* ------------------------------------------------------------ export */
let recorder = null, exportCancelled = false, wakeLock = null;
function pickMime() {
  const list = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
async function exportVideo() {
  if (!state.clips.length) return toast('Add a video first.');
  if (!window.MediaRecorder) return toast('This browser cannot export video. Try Chrome or Safari.');
  pause(); ensureAudio(); await AC.resume(); wireAll(); monitor.gain.value = 0;
  const mime = pickMime(), ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const wrap = $('#exportWrap'); wrap.hidden = false;
  $('#exportTitle').textContent = 'Exporting ' + state.res; $('#exportMsg').textContent = 'Keep this screen open. The video is recorded in real time.';
  $('#exportVideo').hidden = true; $('#exportActions').hidden = true; $('#exportCancel').hidden = false; $('#exportBar').style.width = '0';
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { wakeLock = null; }
  exportCancelled = false;
  exporting = true; layoutDirty = true;
  const [W, H] = outSize(); cv.width = W; cv.height = H;
  await seekTo(0);
  const stream = cv.captureStream(30);
  recDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const chunks = [];
  recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: BITRATE[state.res], audioBitsPerSecond: 192000 });
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    exporting = false; layoutDirty = true; draw(state.t);
    monitor.gain.value = 1; wakeLock && wakeLock.release && wakeLock.release().catch(() => {});
    if (exportCancelled) { wrap.hidden = true; return; }
    const blob = new Blob(chunks, { type: mime || 'video/webm' }), url = URL.createObjectURL(blob);
    const v = $('#exportVideo'); v.src = url; v.hidden = false;
    const a = $('#saveLink'); a.href = url; a.download = 'viuit.' + ext;
    $('#exportTitle').textContent = 'Done'; $('#exportMsg').textContent = (blob.size / 1048576).toFixed(1) + ' MB · ' + ext.toUpperCase() + ' · ' + W + '×' + H;
    $('#exportBar').style.width = '100%'; $('#exportActions').hidden = false; $('#exportCancel').hidden = true;
    const setMsg = m => { $('#exportMsg').textContent = m; };
    const info = $('#exportMsg').textContent;
    $('#shareBtn').onclick = async () => {
      try {
        if (isNative()) await nativeShare(blob, ext);
        else { const f = new File([blob], 'viuit.' + ext, { type: blob.type }); if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f] }); else toast('Use Save video instead.'); }
      } catch (e) { if (e && e.name !== 'AbortError') setMsg('Share failed: ' + (e.message || e)); }
    };
    if (isNative()) {
      a.textContent = 'Save to gallery';
      const save = async () => {
        $('#exportTitle').textContent = 'Saving…';
        try { await saveToGallery(blob, ext, p => setMsg('Saving to your gallery… ' + p + '%')); $('#exportTitle').textContent = 'Saved'; setMsg('Saved in your Gallery, in the Movies / viuit folder. ' + info); }
        catch (e) { $('#exportTitle').textContent = 'Done'; setMsg((e && e.message === 'OLD_ANDROID' ? 'Tap Share, then choose where to save it.' : 'Could not save to the gallery: ' + (e.message || e) + '. Tap Share instead.') + ' ' + info); }
      };
      a.onclick = ev => { ev.preventDefault(); save(); };
      save();
    } else { setTimeout(() => { try { a.click(); toast('Saved to your Downloads.'); } catch (e) {} }, 300); }
  };
  recorder.start(1000);
  const tick = setInterval(() => { $('#exportBar').style.width = (100 * state.t / Math.max(total(), 0.1)) + '%'; }, 250);
  play(() => setTimeout(() => { clearInterval(tick); if (recorder.state !== 'inactive') recorder.stop(); }, 400));
  recorder.addEventListener('stop', () => clearInterval(tick));
}
const isNative = () => !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
const b64Of = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(new Error('Could not read the video')); r.readAsDataURL(blob); });
let SaveVideo = null;
async function saveToGallery(blob, ext, onProgress) {
  SaveVideo = SaveVideo || (Capacitor.Plugins && Capacitor.Plugins.SaveVideo) || (typeof Capacitor.registerPlugin === 'function' ? Capacitor.registerPlugin('SaveVideo') : null);
  if (!SaveVideo) throw new Error('Save plugin is missing from this app build');
  const name = 'viuit-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.' + ext, CH = 2 * 1024 * 1024;
  let id;
  try {
    ({ id } = await SaveVideo.begin({ name, mime: blob.type || 'video/' + ext }));
    for (let o = 0; o < blob.size; o += CH) { await SaveVideo.chunk({ id, data: await b64Of(blob.slice(o, o + CH)) }); onProgress && onProgress(Math.min(100, Math.round((o + CH) / blob.size * 100))); }
    await SaveVideo.finish({ id });
  } catch (e) { if (id) SaveVideo.abort({ id }).catch(() => {}); throw e; }
}
async function nativeShare(blob, ext) {
  const { Filesystem, Share } = Capacitor.Plugins;
  const f = await Filesystem.writeFile({ path: 'viuit-' + Date.now() + '.' + ext, data: await b64Of(blob), directory: 'CACHE' });
  await Share.share({ title: 'viuit video', files: [f.uri] });
}
function cancelExport() {
  exportCancelled = true; pause(); exporting = false;
  if (recorder && recorder.state !== 'inactive') recorder.stop(); else $('#exportWrap').hidden = true;
}

/* ------------------------------------------------------------ wiring */
$('#fileVideo').addEventListener('change', e => { addVideos([...e.target.files]); e.target.value = ''; });
$('#fileAudio').addEventListener('change', e => { if (e.target.files[0]) addAudio(e.target.files[0]); e.target.value = ''; });
$('#addText').onclick = addText; $('#addCap').onclick = addCaption; $('#genCaps').onclick = genCaptions;
$('#playBtn').onclick = () => (state.playing ? pause() : play());
$('#aspect').addEventListener('change', e => { state.aspect = e.target.value; draw(state.t); commit(); updateTransport(); syncChips(); });
$('#fitBtn').onclick = () => { const c = currentClip(); if (c) { c.fit = c.fit === 'fill' ? 'fit' : 'fill'; c.zoom = 1; c.px = c.py = 50; draw(state.t); commit(); updateTransport(); } };
$('#cropBtn').onclick = () => setCrop(!cropMode);
$('#splitBtn').onclick = splitClip; $('#delClipBtn').onclick = deleteClip; $('#trimBtn').onclick = () => { const i = curIdx(); if (i >= 0) editClip(i); };
$('#leftBtn').onclick = () => moveClip(-1); $('#rightBtn').onclick = () => moveClip(1);
$('#res').addEventListener('change', e => { state.res = e.target.value; draw(state.t); syncChips(); });
$('#exportBtn').onclick = exportVideo; $('#exportCancel').onclick = cancelExport;
$('#exportClose').onclick = () => { $('#exportWrap').hidden = true; $('#exportVideo').pause(); };
const capInputs = () => {
  const c = state.cap;
  c.enabled = $('#capOn').checked; c.box = $('#capBox').checked; c.size = clamp(num($('#capSize').value, 54), 10, 300);
  c.bottom = clamp(num($('#capBottom').value, 24), 0, 90); c.color = $('#capColor').value;
  if (!state.playing) draw(state.t);
};
['#capOn', '#capBox', '#capSize', '#capBottom', '#capColor'].forEach(s => { $(s).addEventListener('input', capInputs); $(s).addEventListener('change', () => { commit(); updateTransport(); }); });
window.addEventListener('resize', () => { layoutDirty = true; drawTimeline(); draw(state.t); });
if (window.ResizeObserver) new ResizeObserver(() => drawTimeline()).observe(tl);
if (window.ResizeObserver) new ResizeObserver(() => { layoutDirty = true; draw(state.t); }).observe(cv.parentElement);
document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing && !(recorder && recorder.state === 'recording')) pause(); });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
/* ------------------------------------------------------------ undo / redo */
const hist = []; let hi = -1, lastSig = '';
const snap = () => ({ clips: state.clips.map(c => ({ ...c })), audios: state.audios.map(a => ({ ...a })), texts: state.texts.map(x => ({ ...x })), captions: state.captions.map(x => ({ ...x })), cap: { ...state.cap }, aspect: state.aspect });
const sig = () => JSON.stringify([state.clips.map(c => [c.id, c.start, c.end, c.fit, c.zoom, c.px, c.py, c.volume, c.speed, c.rot, c.mirror, c.filter, c.fade]), state.audios.map(a => [a.id, a.offset, a.start, a.end, a.volume]), state.texts, state.captions, state.cap, state.aspect]);
function commit() {
  const g = sig(); if (g === lastSig) return;
  lastSig = g; hist.length = hi + 1; hist.push(snap()); hi = hist.length - 1;
  if (hist.length > 60) { hist.shift(); hi--; }
}
function restore(sn) {
  pause();
  state.clips = sn.clips.map(c => ({ ...c })); state.audios = sn.audios.map(a => ({ ...a })); state.texts = sn.texts.map(x => ({ ...x }));
  state.captions = sn.captions.map(x => ({ ...x })); state.cap = { ...sn.cap }; state.aspect = sn.aspect;
  $('#aspect').value = state.aspect; $('#capOn').checked = state.cap.enabled; $('#capBox').checked = state.cap.box;
  $('#capSize').value = state.cap.size; $('#capBottom').value = state.cap.bottom; $('#capColor').value = state.cap.color;
  lastSig = sig(); syncChips(); renderTemplateTiles(); renderFontChips(); refresh(true);
}
$('#undoBtn').onclick = () => { if (hi > 0) { hi--; restore(hist[hi]); } };
$('#redoBtn').onclick = () => { if (hi < hist.length - 1) { hi++; restore(hist[hi]); } };

/* ------------------------------------------------------------ drawer, add menu, chips */
const TITLES = { videos: 'Video', sound: 'Sound', text: 'Text', captions: 'Captions', size: 'Size and quality' };
let openName = null;
function setActiveTool(n) { document.querySelectorAll('.ti[data-open]').forEach(b => b.classList.toggle('on', b.dataset.open === n)); }
function openDrawer(n) {
  $('#addMenu').hidden = true; if (cropMode) setCrop(false);
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + n));
  $('#drTitle').textContent = TITLES[n]; $('#drawer').hidden = false; openName = n; setActiveTool(n);
}
function closeDrawer() { $('#drawer').hidden = true; openName = null; setActiveTool(null); }
document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => (openName === b.dataset.open ? closeDrawer() : openDrawer(b.dataset.open))));
$('#setBtn').onclick = () => (openName === 'size' ? closeDrawer() : openDrawer('size'));
$('#drClose').onclick = closeDrawer;
$('#plusBtn').onclick = e => { e.stopPropagation(); $('#addMenu').hidden = !$('#addMenu').hidden; };
document.addEventListener('click', e => { if (!e.target.closest('#addMenu') && !e.target.closest('#plusBtn')) $('#addMenu').hidden = true; });
['#fileVideo', '#fileAudio'].forEach(s => $(s).addEventListener('change', () => { $('#addMenu').hidden = true; openDrawer(s === '#fileVideo' ? 'videos' : 'sound'); }));
$('#miText').onclick = () => { $('#addMenu').hidden = true; addText(); };
$('#miCaps').onclick = () => openDrawer('captions');
$('#fsBtn').onclick = () => {
  const el = $('.screen');
  if (document.fullscreenElement) document.exitFullscreen();
  else { const f = el.requestFullscreen || el.webkitRequestFullscreen; if (f) Promise.resolve(f.call(el)).catch(() => toast('Full screen is not available here.')); else toast('Full screen is not available here.'); }
};
function chipGroup(sel, box) {
  box.innerHTML = '';
  [...sel.options].forEach(o => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.v = o.value; b.textContent = o.textContent; b.onclick = () => { sel.value = o.value; sel.dispatchEvent(new Event('change')); }; box.appendChild(b); });
}
function syncChips() {
  document.querySelectorAll('#aspChips .chip').forEach(b => b.classList.toggle('on', b.dataset.v === $('#aspect').value));
  document.querySelectorAll('#resChips .chip').forEach(b => b.classList.toggle('on', b.dataset.v === $('#res').value));
}
chipGroup($('#aspect'), $('#aspChips')); chipGroup($('#res'), $('#resChips')); syncChips();

/* ------------------------------------------------------------ clip controls (speed, filter, rotate...) */
function clipEdit(fn, msg) {
  const i = curIdx(); if (i < 0) return toast('Add a video first.');
  pause(); const c = state.clips[i], base = state.clips.slice(0, i).reduce((a, k) => a + cdur(k), 0), local = state.t - base;
  const srcLocal = local * cspeed(c); fn(c);
  state.t = base + clamp(srcLocal / cspeed(c), 0, Math.max(0, cdur(c) - 0.01)); refresh(true); if (msg) toast(msg);
}
function buildChips(box, items, onPick) {
  box.innerHTML = '';
  items.forEach(([v, label]) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.v = v; b.textContent = label; b.onclick = () => onPick(v); box.appendChild(b); });
}
buildChips($('#spdChips'), [0.25, 0.5, 1, 1.5, 2, 3].map(v => [v, v + 'x']), v => clipEdit(c => { c.speed = +v; c.el.playbackRate = +v; }));
buildChips($('#fltChips'), Object.entries(FILTER_NAMES), v => clipEdit(c => { c.filter = v; }));
let ccKey = '';
function syncClipControls() {
  const c = currentClip(), key = c ? [curIdx(), c.speed, c.filter, c.rot, c.mirror, c.fade, c.volume].join('|') : 'none';
  if (key === ccKey) return; ccKey = key;
  document.querySelectorAll('#spdChips .chip').forEach(b => b.classList.toggle('on', !!c && +b.dataset.v === cspeed(c)));
  document.querySelectorAll('#fltChips .chip').forEach(b => b.classList.toggle('on', !!c && b.dataset.v === (c.filter || 'none')));
  $('#mirBtn').classList.toggle('on', !!c && !!c.mirror); $('#fadeBtn').classList.toggle('on', !!c && !!c.fade);
  $('#rotBtn').textContent = c && c.rot ? 'Rotate ' + c.rot + '°' : 'Rotate';
  if (document.activeElement !== $('#volRange')) $('#volRange').value = c ? (c.volume == null ? 100 : c.volume) : 100;
}
$('#rotBtn').onclick = () => clipEdit(c => { c.rot = ((c.rot || 0) + 90) % 360; });
$('#mirBtn').onclick = () => clipEdit(c => { c.mirror = !c.mirror; });
$('#fadeBtn').onclick = () => clipEdit(c => { c.fade = c.fade ? 0 : 0.5; });
$('#dupBtn').onclick = async () => {
  const i = curIdx(); if (i < 0) return toast('Add a video first.'); pause();
  try { const c = state.clips[i], { el } = await loadMedia(c.file, 'video'); el.playbackRate = cspeed(c); state.clips.splice(i + 1, 0, { ...c, id: uid++, el, node: null, gain: null }); refresh(true); toast('Duplicated.'); }
  catch (e) { toast('Could not duplicate this clip.'); }
};
$('#volRange').addEventListener('input', e => { const c = currentClip(); if (c) { c.volume = +e.target.value; if (c.gain) c.gain.gain.value = c.volume / 100; } });
$('#volRange').addEventListener('change', () => { commit(); ccKey = ''; updateTransport(); });

/* caption templates */
function renderFontChips() {
  const box = $('#fontChips'); box.innerHTML = '';
  CAP_FONTS.forEach(f => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + ((state.cap.font || '') === f.id ? ' on' : ''); b.textContent = f.name;
    if (f.css) b.style.fontFamily = f.css;
    b.onclick = async () => {
      state.cap.font = f.id; renderFontChips(); draw(state.t);
      if (f.css && document.fonts) { try { await document.fonts.load('700 40px ' + f.css, 'Aa අ'); } catch (e) {} draw(state.t); }
      commit(); updateTransport();
    };
    box.appendChild(b);
  });
}
function renderTemplateTiles() {
  const box = $('#tplTiles'); box.innerHTML = '';
  Object.entries(TPL).forEach(([id, t]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tile' + ((state.cap.tpl || 'classic') === id ? ' on' : ''); b.setAttribute('aria-label', t.name + ' template');
    const cvs = document.createElement('canvas'); cvs.width = 208; cvs.height = 128; const g = cvs.getContext('2d');
    g.fillStyle = '#2b2d35'; g.fillRect(0, 0, 208, 128);
    const smp = { start: 0, end: 2, text: 'The quick fox', words: [{ t: 'The', s: 0, e: 0.5 }, { t: 'quick', s: 0.5, e: 1.1 }, { t: 'fox', s: 1.1, e: 1.8 }] };
    drawCaptionAnim(g, smp, 0.8, 104, 78, 208, id, t.color, 34, false);
    const sp = document.createElement('span'); sp.textContent = t.name; b.append(cvs, sp);
    b.onclick = () => { state.cap.tpl = id; state.cap.color = t.color; $('#capColor').value = t.color; renderTemplateTiles(); draw(state.t); commit(); updateTransport(); };
    box.appendChild(b);
  });
}
renderTemplateTiles(); renderFontChips();

/* drag captions / text on the preview: shows a selection box and pink centre guides that snap */
const curCapIdx = () => state.captions.findIndex(c => state.t >= c.start && state.t < c.end);
cv.addEventListener('pointerdown', e => {
  if (cropMode) return;
  const r = cv.getBoundingClientRect(), k = cv.width / r.width, px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k, m = 28 * k;
  const inBox = b => b && px >= b.x - m && px <= b.x + b.w + m && py >= b.y - m && py <= b.y + b.h + m;
  const tb = [...textBoxes].reverse().find(inBox);
  const hit = tb ? { type: 'text', i: tb.i, b: tb } : inBox(capBox) ? { type: 'cap', b: capBox } : null;
  if (!hit) { if (sel) { sel = null; draw(state.t); } return; }
  if (state.playing) pause();
  const was = !!sel && sel.type === hit.type && sel.i === hit.i;
  sel = { type: hit.type, i: hit.i };
  dragIt = { hit, was, moved: false, ox: px - (hit.b.x + hit.b.w / 2), oy: py - (hit.b.y + hit.b.h / 2), x0: e.clientX, y0: e.clientY };
  cv.setPointerCapture(e.pointerId); draw(state.t);
});
cv.addEventListener('pointermove', e => {
  if (!dragIt) return;
  if (!dragIt.moved && Math.hypot(e.clientX - dragIt.x0, e.clientY - dragIt.y0) < 6) return;
  dragIt.moved = true;
  const r = cv.getBoundingClientRect(), k = cv.width / r.width, W = cv.width, H = cv.height, b = dragIt.hit.b;
  let cx = (e.clientX - r.left) * k - dragIt.ox, cy = (e.clientY - r.top) * k - dragIt.oy;
  guides.v = Math.abs(cx - W / 2) < W * 0.018; if (guides.v) cx = W / 2;
  guides.h = Math.abs(cy - H / 2) < H * 0.018; if (guides.h) cy = H / 2;
  cx = clamp(cx, 0, W); cy = clamp(cy, b.h / 2, H - b.h / 2 + 0);
  if (dragIt.hit.type === 'text') { const t = state.texts[dragIt.hit.i]; t.x = +(cx / W * 100).toFixed(1); t.y = +(cy / H * 100).toFixed(1); }
  else { const c = state.cap; c.x = +(cx / W * 100).toFixed(1); c.bottom = +clamp((H - (cy + b.h / 2)) / H * 100, 0, 95).toFixed(1); $('#capBottom').value = Math.round(c.bottom); }
  draw(state.t);
});
const dragUp = e => {
  if (!dragIt) return;
  const d = dragIt; dragIt = null; guides = { v: false, h: false };
  if (d.moved) { commit(); refresh(); }
  else if (d.was && e.type === 'pointerup') { if (d.hit.type === 'text') editText(d.hit.i); else { const i = curCapIdx(); if (i >= 0) editCaption(i); } }
  draw(state.t);
};
cv.addEventListener('pointerup', dragUp); cv.addEventListener('pointercancel', dragUp);
$('#capReset').onclick = () => { Object.assign(state.cap, { x: 50, bottom: 24 }); $('#capBottom').value = 24; draw(state.t); commit(); updateTransport(); toast('Captions moved back to the default place.'); };

setPlayIcon(); refresh();
window.__sc = { state, seekTo, play, pause, exportVideo, addVideos };
