/* Draftloom — ส่วนติดต่อผู้ใช้ เครื่องมือวาด/แก้ไข เลเยอร์ คุณสมบัติ ไฟล์
 * เขียนใหม่ทั้งหมด ไม่มีไลบรารีภายนอก
 */
(() => {
  'use strict';
  const G = window.DL;
  const { TAU, EPS, DEG, FONT, fmt } = G;
  const $ = (id) => document.getElementById(id);
  const hyp = Math.hypot;
  const isNum = (s) => /^-?(\d+\.?\d*|\.\d+)$/.test(s.trim());
  const same = (a, b) => hyp(a[0] - b[0], a[1] - b[1]) < 1e-9;

  const canvas = $('cv'), ctx = canvas.getContext('2d');
  const cmd = $('cmd'), promptEl = $('prompt'), msgEl = $('msg');

  // ================= สี =================
  const ACI_FIX = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 8: '#808080', 9: '#c0c0c0',
    250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe', 255: '#ffffff' };
  function hsv(h, s, v) {
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    const hx = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return '#' + hx(f(5)) + hx(f(3)) + hx(f(1));
  }
  /** สีดัชนี ACI (มาตรฐานไฟล์ DXF) → hex; 7 = สีหมึกตามพื้นหลัง */
  function aciHex(i) {
    if (ACI_FIX[i]) return ACI_FIX[i];
    if (i >= 10 && i <= 249) { const k = (i - 10) % 10; return hsv(Math.floor((i - 10) / 10) * 15, k % 2 ? 0.5 : 1, [1, 1, .8, .8, .6, .6, .5, .5, .3, .3][k]); }
    return null;
  }
  const COLOR_NAMES = { 1: 'แดง', 2: 'เหลือง', 3: 'เขียว', 4: 'ฟ้า', 5: 'น้ำเงิน', 6: 'ม่วงชมพู', 7: 'หมึก (ดำ/ขาว)', 8: 'เทาเข้ม', 9: 'เทาอ่อน' };
  let theme = {};
  const shadeCache = new Map();
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    theme = { bg: v('--canvas'), ink: v('--draw-ink'), grid: v('--grid'), gridMajor: v('--grid-major'), sel: v('--sel'), ghost: v('--ghost'),
      snap: v('--snap'), win: v('--win'), cross: v('--cross'), dark: matchMedia('(prefers-color-scheme: dark)').matches };
    shadeCache.clear();
  }
  /** ปรับสีให้มองเห็นบนพื้นปัจจุบัน (เช่น เหลืองบนพื้นสว่าง) */
  function displayColor(aci, light, ink) {
    const key = aci + (light ? 'L' : 'D');
    if (shadeCache.has(key)) return shadeCache.get(key) || ink;
    let hex = aciHex(aci);
    if (hex) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const mix = (k, t) => '#' + [r, g, b].map((c) => Math.round(c * k + t * (1 - k)).toString(16).padStart(2, '0')).join('');
      if (light && lum > 0.55) hex = mix(0.6, 0);
      if (!light && lum < 0.3) hex = mix(0.5, 255);
    }
    shadeCache.set(key, hex);
    return hex || ink;
  }

  // ================= เอกสาร =================
  const newDoc = () => ({ v: 1, layers: [{ name: '0', color: 7, visible: true, locked: false }], current: '0', entities: [], nextId: 1, textH: 0 });
  let doc = newDoc(), docName = 'แบบร่าง', dirty = false;
  const layerOf = (name) => doc.layers.find((l) => l.name === name) || doc.layers[0];
  const visible = (e) => layerOf(e.layer).visible;
  const selectable = (e) => { const l = layerOf(e.layer); return l.visible && !l.locked; };
  function addEnt(e) {
    e.id = doc.nextId++;
    if (!e.layer) e.layer = doc.current;
    if (e.color === undefined) e.color = null;
    doc.entities.push(e);
    return e;
  }
  const byId = (id) => doc.entities.find((e) => e.id === id);
  function replaceEnt(old, n) { const i = doc.entities.indexOf(old); if (i >= 0) { n.id = old.id; doc.entities[i] = n; } }
  function removeEnts(ids) { const s = new Set(ids); doc.entities = doc.entities.filter((e) => !s.has(e.id)); for (const id of ids) state.sel.delete(id); }

  // ---------- ย้อนกลับ ----------
  const undoStack = [], redoStack = [];
  function edit(fn) {
    undoStack.push(JSON.stringify(doc));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    fn();
    changed();
  }
  function changed() {
    dirty = true;
    for (const id of [...state.sel]) if (!byId(id)) state.sel.delete(id);
    G.prec = doc.prec ?? 2;
    scheduleSave(); refreshPanels(); render();
  }
  function undo() {
    if (!undoStack.length) return msg('ไม่มีขั้นให้ย้อนกลับ');
    redoStack.push(JSON.stringify(doc)); doc = JSON.parse(undoStack.pop()); changed(); msg('ย้อนกลับแล้ว');
  }
  function redo() {
    if (!redoStack.length) return msg('ไม่มีขั้นให้ทำซ้ำ');
    undoStack.push(JSON.stringify(doc)); doc = JSON.parse(redoStack.pop()); changed(); msg('ทำซ้ำแล้ว');
  }

  // ---------- บันทึกอัตโนมัติ ----------
  let saveTimer = 0, saveWarned = false;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem('draftloom.autosave', JSON.stringify({ name: docName, doc })); }
      catch (_) { if (!saveWarned) { saveWarned = true; msg('แบบนี้ใหญ่เกินกว่าจะบันทึกอัตโนมัติในเบราว์เซอร์ได้ — อย่าลืมกด "บันทึก DXF" หรือ "บันทึกงาน"', 'err'); } }
    }, 700);
  }

  // ================= มุมมอง =================
  const view = { x: 0, y: 0, s: 4 };
  let W = 0, H = 0, dpr = 1;
  const w2s = (x, y) => [(x - view.x) * view.s + W / 2, H / 2 - (y - view.y) * view.s];
  const s2w = (px, py) => [(px - W / 2) / view.s + view.x, (H / 2 - py) / view.s + view.y];
  function extents(list) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const e of list) { const q = G.entBox(e); b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[2]); b[3] = Math.max(b[3], q[3]); }
    return isFinite(b[0]) ? b : null;
  }
  function zoomFit() {
    const b = extents(doc.entities.filter(visible));
    if (!b) { view.x = 100; view.y = 60; view.s = Math.min(W / 240, H / 150) || 4; render(); return; }
    const w = Math.max(b[2] - b[0], 1e-6), h = Math.max(b[3] - b[1], 1e-6);
    view.x = (b[0] + b[2]) / 2; view.y = (b[1] + b[3]) / 2;
    view.s = Math.min((W - 40) / w, (H - 40) / h);
    if (!isFinite(view.s) || view.s <= 0) view.s = 1;
    render();
  }
  function zoomAt(px, py, f) {
    const [wx, wy] = s2w(px, py);
    view.s = Math.min(Math.max(view.s * f, 1e-9), 1e9);
    view.x = wx - (px - W / 2) / view.s; view.y = wy - (H / 2 - py) / view.s;
    render();
  }
  function gridStep(s) {
    const target = 18 / s, p = Math.pow(10, Math.floor(Math.log10(target)));
    for (const m of [1, 2, 5, 10]) if (p * m >= target) return p * m;
    return p * 10;
  }
  const autoTextH = () => G.niceRound(H / view.s / 45);
  const textH = () => (doc.textH > 0 ? doc.textH : autoTextH());

  // ================= สถานะ =================
  const state = { sel: new Set(), hover: null, snapOn: true, gridOn: false, orthoOn: false, cursor: [0, 0], snap: null, screen: [0, 0], win: null };
  let tool = null, lastCmd = null, lastOffset = null, lastFillet = 0;

  // ================= การวาด =================
  function traceFor(g, X, Y, s) {
    return (ps) => {
      for (const p of ps) {
        if (p.t === 'seg') { g.moveTo(X(p.x1), Y(p.y1)); g.lineTo(X(p.x2), Y(p.y2)); }
        else {
          const sx = X(p.cx), sy = Y(p.cy), R = p.r * s;
          if (p.full) { g.moveTo(sx + R, sy); g.arc(sx, sy, R, 0, TAU); }
          else { g.moveTo(sx + R * Math.cos(p.a1), sy - R * Math.sin(p.a1)); g.arc(sx, sy, R, -p.a1, -p.a2, true); }
        }
      }
    };
  }
  function drawTextOn(g, t, X, Y, s, col) {
    const px = t.h * s;
    if (px < 1.5) {
      const c = G.textCorners(t);
      g.beginPath(); g.moveTo(X(c[0][0]), Y(c[0][1])); g.lineTo(X(c[1][0]), Y(c[1][1])); g.stroke();
      return;
    }
    const L = G.textLayout(t);
    g.save(); g.translate(X(t.x), Y(t.y)); g.rotate(-(t.rot || 0));
    g.fillStyle = col; g.font = `${px}px ${FONT}`; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    L.lines.forEach((ln, i) => g.fillText(ln, L.x0 * s, -(L.dy - i * 1.5 * t.h) * s));
    g.restore();
  }
  function drawEnt(g, e, X, Y, s, col, style) {
    g.strokeStyle = col; g.fillStyle = col;
    g.lineWidth = style === 'hover' ? 2.4 : style === 'sel' ? 1.6 : 1;
    g.setLineDash(style === 'sel' ? [6, 4] : []);
    const tr = traceFor(g, X, Y, s);
    if (e.type === 'text') { drawTextOn(g, e, X, Y, s, col); return; }
    g.beginPath(); tr(G.prims(e)); g.stroke();
    if (e.type === 'dim') {
      const d = G.dimGeom(e);
      g.setLineDash([]);
      g.beginPath();
      for (const a of d.arrows) { g.moveTo(X(a[0][0]), Y(a[0][1])); g.lineTo(X(a[1][0]), Y(a[1][1])); g.lineTo(X(a[2][0]), Y(a[2][1])); g.closePath(); }
      g.fill();
      drawTextOn(g, d.text, X, Y, s, col);
    }
  }
  /** วาดทั้งแบบลงบน context ใดก็ได้ (ใช้กับจอ และส่งออก PNG) */
  function drawScene(g, w, h, v, opt) {
    g.fillStyle = opt.bg; g.fillRect(0, 0, w, h);
    const s = v.s, X = (x) => (x - v.x) * s + w / 2, Y = (y) => h / 2 - (y - v.y) * s;
    if (opt.grid) {
      const st = gridStep(s), x0 = v.x - w / 2 / s, x1 = v.x + w / 2 / s, y0 = v.y - h / 2 / s, y1 = v.y + h / 2 / s;
      for (const major of [false, true]) {
        const step = major ? st * 5 : st;
        g.strokeStyle = major ? theme.gridMajor : theme.grid; g.lineWidth = 1; g.beginPath();
        for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { const sx = Math.round(X(x)) + 0.5; g.moveTo(sx, 0); g.lineTo(sx, h); }
        for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) { const sy = Math.round(Y(y)) + 0.5; g.moveTo(0, sy); g.lineTo(w, sy); }
        g.stroke();
      }
    }
    const wx0 = v.x - w / 2 / s, wx1 = v.x + w / 2 / s, wy0 = v.y - h / 2 / s, wy1 = v.y + h / 2 / s;
    const light = opt.light;
    for (const e of doc.entities) {
      if (!visible(e)) continue;
      const b = G.entBox(e);
      if (b[2] < wx0 || b[0] > wx1 || b[3] < wy0 || b[1] > wy1) continue;
      const sel = opt.sel && opt.sel.has(e.id);
      const col = sel ? theme.sel : displayColor(e.color ?? layerOf(e.layer).color, light, opt.ink);
      drawEnt(g, e, X, Y, s, col, sel ? 'sel' : opt.hover === e.id ? 'hover' : '');
    }
    g.setLineDash([]);
  }

  let raf = 0;
  const render = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };
  function paint() {
    drawScene(ctx, W, H, view, { bg: theme.bg, ink: theme.ink, light: !theme.dark, grid: state.gridOn, sel: state.sel, hover: state.hover });
    const X = (x) => w2s(x, 0)[0], Y = (y) => w2s(0, y)[1];
    // แกนจุดกำเนิด
    const [ox, oy] = w2s(0, 0);
    ctx.strokeStyle = theme.gridMajor; ctx.lineWidth = 1.5; ctx.beginPath();
    ctx.moveTo(ox, oy); ctx.lineTo(ox + 26, oy); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - 26); ctx.stroke();
    // จุดจับของสิ่งที่เลือก
    if (state.sel.size && state.sel.size < 300) {
      ctx.fillStyle = theme.sel;
      for (const id of state.sel) { const e = byId(id); if (!e) continue; for (const p of gripPoints(e)) { const [x, y] = w2s(p[0], p[1]); ctx.fillRect(x - 3, y - 3, 6, 6); } }
    }
    // ภาพตัวอย่างของเครื่องมือ
    if (tool && tool.preview && !tool.picking) {
      ctx.strokeStyle = theme.ghost; ctx.fillStyle = theme.ghost; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]);
      tool.preview(ghost, state.cursor);
      ctx.setLineDash([]);
    }
    // กรอบเลือก
    if (state.win) {
      const { sx, sy, ex, ey } = state.win, crossing = ex < sx;
      ctx.fillStyle = crossing ? theme.cross : theme.win; ctx.strokeStyle = crossing ? theme.sel : theme.snap;
      ctx.setLineDash(crossing ? [6, 4] : []); ctx.lineWidth = 1;
      ctx.fillRect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy));
      ctx.strokeRect(Math.min(sx, ex) + .5, Math.min(sy, ey) + .5, Math.abs(ex - sx), Math.abs(ey - sy));
      ctx.setLineDash([]);
    }
    // สัญลักษณ์ดูดจุด
    if (state.snap && tool && !tool.picking && !tool.noSnap) {
      const [x, y] = w2s(state.snap.x, state.snap.y), r = 6;
      ctx.strokeStyle = theme.snap; ctx.lineWidth = 2; ctx.beginPath();
      switch (state.snap.type) {
        case 'end': ctx.rect(x - r, y - r, 2 * r, 2 * r); break;
        case 'mid': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); break;
        case 'cen': ctx.arc(x, y, r, 0, TAU); break;
        case 'quad': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); break;
        case 'int': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); break;
      }
      ctx.stroke();
    }
    void X; void Y;
  }
  // ตัวช่วยวาดภาพตัวอย่าง (พิกัดโลก)
  const ghost = {
    line(a, b) { const p = w2s(a[0], a[1]), q = w2s(b[0], b[1]); ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); },
    poly(pts, closed) { if (pts.length < 2) return; ctx.beginPath(); pts.forEach((p, i) => { const q = w2s(p[0], p[1]); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); if (closed) ctx.closePath(); ctx.stroke(); },
    circle(c, r) { const p = w2s(c[0], c[1]); ctx.beginPath(); ctx.arc(p[0], p[1], r * view.s, 0, TAU); ctx.stroke(); },
    ents(list) {
      const X = (x) => (x - view.x) * view.s + W / 2, Y = (y) => H / 2 - (y - view.y) * view.s;
      for (const e of list) { drawEnt(ctx, e, X, Y, view.s, theme.ghost, ''); ctx.setLineDash([5, 4]); }
    },
  };
  function gripPoints(e) {
    switch (e.type) {
      case 'line': return [[e.x1, e.y1], [e.x2, e.y2], [(e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2]];
      case 'poly': return e.pts.length > 200 ? [] : e.pts;
      case 'circle': return [[e.cx, e.cy], [e.cx + e.r, e.cy], [e.cx - e.r, e.cy], [e.cx, e.cy + e.r], [e.cx, e.cy - e.r]];
      case 'arc': return [[e.cx, e.cy], ...G.arcEnds(e)];
      case 'text': return [[e.x, e.y]];
      case 'dim': return [[e.x1, e.y1], [e.x2, e.y2], [e.ox, e.oy]];
    }
    return [];
  }

  // ================= ดูดจุดและเลือก =================
  function snapAt(x, y, tol) {
    let best = null;
    const consider = (px, py, type, d0) => {
      const d = d0 ?? hyp(px - x, py - y);
      if (d <= tol && (!best || d < best.d)) best = { x: px, y: py, type, d };
    };
    const nearPrims = [];
    for (const e of doc.entities) {
      if (!visible(e)) continue;
      const b = G.entBox(e);
      if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) continue;
      switch (e.type) {
        case 'line': consider(e.x1, e.y1, 'end'); consider(e.x2, e.y2, 'end'); consider((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, 'mid'); break;
        case 'poly':
          for (const p of e.pts) if (Math.abs(p[0] - x) <= tol && Math.abs(p[1] - y) <= tol) consider(p[0], p[1], 'end');
          break;
        case 'circle':
          consider(e.cx, e.cy, 'cen');
          for (let k = 0; k < 4; k++) consider(e.cx + e.r * Math.cos(k * Math.PI / 2), e.cy + e.r * Math.sin(k * Math.PI / 2), 'quad');
          if (Math.abs(hyp(x - e.cx, y - e.cy) - e.r) < tol) consider(e.cx, e.cy, 'cen', tol * 0.95);
          break;
        case 'arc': {
          const p = G.prims(e)[0], en = G.arcEnds(p), m = G.primMid(p);
          consider(en[0][0], en[0][1], 'end'); consider(en[1][0], en[1][1], 'end'); consider(m[0], m[1], 'mid'); consider(e.cx, e.cy, 'cen');
          if (G.distArc(x, y, p) < tol) consider(e.cx, e.cy, 'cen', tol * 0.95);
          break;
        }
        case 'text': consider(e.x, e.y, 'end'); break;
        case 'dim': consider(e.x1, e.y1, 'end'); consider(e.x2, e.y2, 'end'); break;
      }
      if (e.type === 'text' || e.type === 'dim') continue;
      for (const p of G.prims(e)) {
        const b2 = G.primBox(p);
        if (x < b2[0] - tol || x > b2[2] + tol || y < b2[1] - tol || y > b2[3] + tol) continue;
        if (G.primDist(p, x, y) > tol) continue;
        nearPrims.push(p);
        if (e.type === 'poly') { const m = G.primMid(p); consider(m[0], m[1], 'mid'); }
      }
    }
    const n = Math.min(nearPrims.length, 80);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (const p of G.interPrims(nearPrims[i], nearPrims[j])) consider(p[0], p[1], 'int');
    return best;
  }
  function pointFrom(sp, useSnap = true) {
    let [x, y] = s2w(sp[0], sp[1]);
    state.snap = null;
    if (useSnap && state.snapOn && !(tool && tool.noSnap)) {
      const sn = snapAt(x, y, 10 / view.s);
      if (sn) { state.snap = sn; return [sn.x, sn.y]; }
    }
    if (state.gridOn) { const st = gridStep(view.s); x = Math.round(x / st) * st; y = Math.round(y / st) * st; }
    const r = tool && tool.ref && tool.ref();
    if (state.orthoOn && r) { if (Math.abs(x - r[0]) > Math.abs(y - r[1])) y = r[1]; else x = r[0]; }
    return [x, y];
  }
  function pickAt(sp) {
    const [x, y] = s2w(sp[0], sp[1]), tol = 6 / view.s;
    let best = null, bd = tol;
    for (const e of doc.entities) {
      if (!selectable(e)) continue;
      const b = G.entBox(e);
      if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) continue;
      const d = G.entDist(e, x, y);
      if (d <= bd) { bd = d; best = e; }
    }
    return best;
  }
  function windowSelect(a, b, remove) {
    const p = s2w(a[0], a[1]), q = s2w(b[0], b[1]);
    const r = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
    const crossing = b[0] < a[0];
    let n = 0;
    for (const e of doc.entities) {
      if (!selectable(e)) continue;
      const bb = G.entBox(e);
      const inside = bb[0] >= r[0] && bb[2] <= r[2] && bb[1] >= r[1] && bb[3] <= r[3];
      let hit = inside;
      if (!hit && crossing && !(bb[2] < r[0] || bb[0] > r[2] || bb[3] < r[1] || bb[1] > r[3])) {
        hit = (e.type === 'text') || G.prims(e).some((pr) => G.primHitsRect(pr, r));
        if (!hit && e.type === 'dim') {
          const tb = G.textCorners(G.dimGeom(e).text);
          const xs = tb.map((q) => q[0]), ys = tb.map((q) => q[1]);
          hit = !(Math.max(...xs) < r[0] || Math.min(...xs) > r[2] || Math.max(...ys) < r[1] || Math.min(...ys) > r[3]);
        }
      }
      if (hit) { remove ? state.sel.delete(e.id) : state.sel.add(e.id); n++; }
    }
    return n;
  }
  const selected = () => doc.entities.filter((e) => state.sel.has(e.id));

  // ================= ป้อนพิกัด =================
  function parsePoint(s, ref) {
    s = s.replace(/\s+/g, '');
    let rel = false, m;
    if (s[0] === '@') { rel = true; s = s.slice(1); if (!ref) return null; }
    const N = '(-?(?:\\d+\\.?\\d*|\\.\\d+))';
    if ((m = s.match(new RegExp(`^${N}<${N}$`)))) {
      const d = +m[1], a = +m[2] * DEG, o = rel ? ref : [0, 0];
      return [o[0] + d * Math.cos(a), o[1] + d * Math.sin(a)];
    }
    if ((m = s.match(new RegExp(`^${N},${N}$`)))) return rel ? [ref[0] + +m[1], ref[1] + +m[2]] : [+m[1], +m[2]];
    if (!rel && ref && isNum(s)) {
      const d = +s, c = state.cursor;
      let dx = c[0] - ref[0], dy = c[1] - ref[1];
      const L = hyp(dx, dy);
      if (L < EPS) { dx = 1; dy = 0; } else { dx /= L; dy /= L; }
      return [ref[0] + dx * d, ref[1] + dy * d];
    }
    return null;
  }

  // ================= เครื่องมือ =================
  const poly = (pts, closed) => ({ type: 'poly', pts: pts.map((p) => [p[0], p[1], 0]), closed });
  const TOOLS = {
    select: () => null,
    pan: () => ({ noSnap: true, prompt: () => 'ลากเพื่อเลื่อนมุมมอง (Esc = ออก)', click() {}, enter() { endTool(); } }),

    line: () => ({
      pts: [], ref() { return this.pts[this.pts.length - 1]; },
      prompt() { return this.pts.length ? 'คลิกจุดถัดไป หรือพิมพ์ระยะ/พิกัด (Enter = จบ, C = ปิดรูป)' : 'คลิกจุดเริ่ม หรือพิมพ์พิกัด x,y'; },
      click(p) { const r = this.ref(); if (r) { if (same(r, p)) return; edit(() => addEnt({ type: 'line', x1: r[0], y1: r[1], x2: p[0], y2: p[1] })); } this.pts.push(p); },
      input(s) {
        if (/^c$/i.test(s) && this.pts.length >= 3) { this.click(this.pts[0]); endTool(); return true; }
        const p = parsePoint(s, this.ref()); if (p) { this.click(p); return true; } return false;
      },
      enter() { endTool(); },
      preview(g, c) { const r = this.ref(); if (r) g.line(r, c); },
    }),

    polyline: () => ({
      pts: [], ref() { return this.pts[this.pts.length - 1]; },
      prompt() { return this.pts.length ? 'คลิกจุดถัดไป (Enter = จบ, C = ปิดรูป, U = ถอยจุด)' : 'คลิกจุดเริ่มของเส้นต่อเนื่อง'; },
      click(p) { const r = this.ref(); if (r && same(r, p)) return; this.pts.push(p); },
      commit(closed) { if (this.pts.length >= 2) edit(() => addEnt(poly(this.pts, closed))); endTool(); },
      input(s) {
        if (/^c$/i.test(s) && this.pts.length >= 3) { this.commit(true); return true; }
        if (/^u$/i.test(s)) { this.pts.pop(); return true; }
        const p = parsePoint(s, this.ref()); if (p) { this.click(p); return true; } return false;
      },
      enter() { this.commit(false); },
      preview(g, c) { g.poly([...this.pts, c]); },
    }),

    rect: () => ({
      a: null, ref() { return this.a; },
      prompt() { return this.a ? 'คลิกมุมตรงข้าม หรือพิมพ์ @กว้าง,สูง' : 'คลิกมุมแรกของสี่เหลี่ยม'; },
      corners(a, b) { return [a, [b[0], a[1]], b, [a[0], b[1]]]; },
      click(p) {
        if (!this.a) { this.a = p; return; }
        if (Math.abs(p[0] - this.a[0]) < EPS || Math.abs(p[1] - this.a[1]) < EPS) return msg('สี่เหลี่ยมต้องมีความกว้างและความสูง', 'err');
        edit(() => addEnt(poly(this.corners(this.a, p), true))); endTool();
      },
      input(s) { const p = parsePoint(s, this.a); if (p) { this.click(p); return true; } return false; },
      enter() { endTool(); },
      preview(g, c) { if (this.a) g.poly(this.corners(this.a, c), true); },
    }),

    circle: () => ({
      c: null, ref() { return this.c; },
      prompt() { return this.c ? 'คลิกระยะรัศมี หรือพิมพ์ค่ารัศมี (D ตามด้วยตัวเลข = เส้นผ่านศูนย์กลาง เช่น D20)' : 'คลิกจุดศูนย์กลางวงกลม'; },
      make(r) { if (!(r > EPS)) return msg('รัศมีต้องมากกว่า 0', 'err'); edit(() => addEnt({ type: 'circle', cx: this.c[0], cy: this.c[1], r })); endTool(); },
      click(p) { if (!this.c) { this.c = p; return; } this.make(hyp(p[0] - this.c[0], p[1] - this.c[1])); },
      input(s) {
        if (this.c && isNum(s)) { this.make(+s); return true; }
        const m = s.match(/^d\s*(\d+\.?\d*)$/i); if (this.c && m) { this.make(+m[1] / 2); return true; }
        const p = parsePoint(s, this.c); if (p) { this.click(p); return true; } return false;
      },
      enter() { endTool(); },
      preview(g, c) { if (this.c) { g.line(this.c, c); g.circle(this.c, hyp(c[0] - this.c[0], c[1] - this.c[1])); } },
    }),

    arc: () => ({
      pts: [], ref() { return this.pts[this.pts.length - 1]; },
      prompt() { return ['คลิกจุดเริ่มของส่วนโค้ง', 'คลิกจุดที่ส่วนโค้งผ่าน', 'คลิกจุดปลายของส่วนโค้ง'][this.pts.length]; },
      click(p) {
        if (this.pts.some((q) => same(q, p))) return;
        this.pts.push(p);
        if (this.pts.length === 3) {
          const a = G.arcFrom3(...this.pts);
          if (!a) { this.pts.pop(); return msg('สามจุดอยู่ในแนวเดียวกัน สร้างส่วนโค้งไม่ได้', 'err'); }
          edit(() => addEnt(a)); endTool();
        }
      },
      input(s) { const p = parsePoint(s, this.ref()); if (p) { this.click(p); return true; } return false; },
      enter() { endTool(); },
      preview(g, c) {
        if (this.pts.length === 1) g.line(this.pts[0], c);
        if (this.pts.length === 2) { const a = G.arcFrom3(this.pts[0], this.pts[1], c); if (a) g.ents([a]); }
      },
    }),

    text: () => ({
      p: null, get textMode() { return !!this.p; },
      prompt() { return this.p ? `พิมพ์ข้อความแล้วกด Enter (สูง ${fmt(textH())} — แก้ได้ในแผงคุณสมบัติ)` : 'คลิกตำแหน่งวางข้อความ'; },
      click(p) { this.p = p; cmd.focus(); },
      input(s) {
        if (!this.p) { const p = parsePoint(s, null); if (p) { this.click(p); return true; } return false; }
        const h = textH();
        edit(() => { if (!doc.textH) doc.textH = h; addEnt({ type: 'text', x: this.p[0], y: this.p[1], h, rot: 0, text: s, ha: 'left', va: 'baseline' }); });
        endTool(); return true;
      },
      enter() { endTool(); },
      preview(g, c) { const p = this.p || c; g.line([p[0], p[1]], [p[0] + textH() * 3, p[1]]); },
    }),

    dim: () => ({
      pts: [], ref() { return this.pts[this.pts.length - 1]; },
      prompt() { return ['คลิกจุดแรกที่จะวัด', 'คลิกจุดที่สองที่จะวัด', 'คลิกตำแหน่งวางเส้นบอกขนาด'][this.pts.length]; },
      make(o) { const [a, b] = this.pts; return { type: 'dim', x1: a[0], y1: a[1], x2: b[0], y2: b[1], ox: o[0], oy: o[1], h: textH(), text: '' }; },
      click(p) {
        if (this.pts.length === 1 && same(this.pts[0], p)) return;
        if (this.pts.length < 2) { this.pts.push(p); return; }
        const d = this.make(p);
        edit(() => { if (!doc.textH) doc.textH = d.h; addEnt(d); }); endTool();
      },
      input(s) { const p = parsePoint(s, this.ref()); if (p) { this.click(p); return true; } return false; },
      enter() { endTool(); },
      preview(g, c) { if (this.pts.length === 1) g.line(this.pts[0], c); if (this.pts.length === 2) g.ents([this.make(c)]); },
    }),

    measure: () => ({
      a: null, ref() { return this.a; },
      prompt() { return this.a ? 'คลิกจุดที่สอง' : 'คลิกจุดแรกที่จะวัดระยะ (Enter = จบ)'; },
      click(p) {
        if (!this.a) { this.a = p; return; }
        const dx = p[0] - this.a[0], dy = p[1] - this.a[1];
        msg(`ระยะ ${fmt(hyp(dx, dy), 4)} · มุม ${fmt(G.norm(Math.atan2(dy, dx)) / DEG, 2)}° · ΔX ${fmt(dx, 4)} · ΔY ${fmt(dy, 4)}`, 'ok', 20000);
        this.a = null;
      },
      input(s) { const p = parsePoint(s, this.a); if (p) { this.click(p); return true; } return false; },
      enter() { endTool(); },
      preview(g, c) { if (this.a) g.line(this.a, c); },
    }),

    move: () => xform('move'), copy: () => xform('copy'), rotate: () => xform('rotate'), scale: () => xform('scale'), mirror: () => xform('mirror'),

    offset: () => ({
      noSnap: true, dist: lastOffset, target: null,
      prompt() {
        if (this.dist == null) return 'พิมพ์ระยะห่างของเส้นขนานแล้วกด Enter';
        return this.target ? 'คลิกด้านที่จะวางเส้นใหม่' : `ระยะ ${fmt(this.dist)} — คลิกวัตถุต้นแบบ (พิมพ์ตัวเลขเพื่อเปลี่ยนระยะ, Enter = จบ)`;
      },
      input(s) { if (isNum(s)) { if (+s <= 0) msg('ระยะต้องมากกว่า 0', 'err'); else this.dist = lastOffset = +s; return true; } return false; },
      click(p, sp) {
        if (this.dist == null) return msg('พิมพ์ระยะก่อน', 'err');
        if (!this.target) {
          const e = pickAt(sp);
          if (!e) return msg('ไม่พบวัตถุตรงนั้น', 'err');
          if (!['line', 'circle', 'arc', 'poly'].includes(e.type)) return msg('ทำเส้นขนานได้กับเส้นตรง วงกลม ส่วนโค้ง และเส้นต่อเนื่อง', 'err');
          this.target = e; state.sel = new Set([e.id]); return;
        }
        const n = G.offsetEntity(this.target, this.dist, p);
        if (n === 'bulge') msg('เส้นต่อเนื่องที่มีส่วนโค้ง ให้ใช้ "แตก" ก่อนแล้วทำทีละชิ้น', 'err');
        else if (!n) msg('ทำเส้นขนานระยะนี้ไม่ได้ (เช่น รัศมีจะติดลบ)', 'err');
        else edit(() => addEnt(n));
        this.target = null; state.sel.clear();
      },
      enter() { endTool(); },
      preview(g, c) { if (this.target) { const n = G.offsetEntity(this.target, this.dist, c); if (n && n !== 'bulge') g.ents([n]); } },
    }),

    trim: () => ({
      noSnap: true,
      prompt: () => 'คลิกส่วนของเส้นที่จะตัดทิ้ง — ขอบตัดคือวัตถุอื่นทั้งหมด (Enter = จบ)',
      click(p, sp) {
        const e = pickAt(sp);
        if (!e) return msg('ไม่พบวัตถุตรงนั้น', 'err');
        const r = trimEntity(e, s2w(sp[0], sp[1]));
        if (!r) return;
        edit(() => { removeEnts([e.id]); for (const piece of r) addEnt({ ...piece, id: undefined }); });
      },
      enter() { endTool(); },
    }),

    fillet: () => ({
      noSnap: true, r: lastFillet, first: null,
      prompt() { return this.first ? 'คลิกเส้นตรงเส้นที่สอง' : `รัศมี ${fmt(this.r)} — คลิกเส้นตรงเส้นแรก (พิมพ์ตัวเลขเพื่อเปลี่ยนรัศมี, 0 = มุมแหลม)`; },
      input(s) { if (isNum(s) && +s >= 0) { this.r = lastFillet = +s; return true; } return false; },
      click(p, sp) {
        const e = pickAt(sp), c = s2w(sp[0], sp[1]);
        if (!e || e.type !== 'line') return msg('มนมุมได้เฉพาะเส้นตรง (เส้นต่อเนื่องให้ใช้ "แตก" ก่อน)', 'err');
        if (!this.first) { this.first = { e, c }; state.sel = new Set([e.id]); return; }
        if (e === this.first.e) return msg('เลือกเส้นอื่นที่ไม่ใช่เส้นเดิม', 'err');
        const res = filletLines(this.first.e, this.first.c, e, c, this.r);
        if (!res) return;
        const l1 = this.first.e;
        edit(() => { replaceEnt(l1, res.l1); replaceEnt(e, res.l2); if (res.arc) addEnt(res.arc); });
        state.sel.clear(); endTool();
      },
      enter() { endTool(); },
    }),
  };

  function xform(kind) {
    return {
      needsSel: true, base: null, del: false,
      ref() { return this.base; },
      prompt() {
        if (!this.base) return kind === 'mirror' ? `คลิกจุดแรกของแกนสะท้อน (พิมพ์ D = สลับ ${this.del ? 'ลบ' : 'เก็บ'}ต้นฉบับ)` : 'คลิกจุดฐาน';
        return { move: 'คลิกจุดปลายทาง หรือพิมพ์ระยะ/พิกัด', copy: 'คลิกจุดวางสำเนา (วางได้หลายครั้ง, Enter = จบ)',
          rotate: 'คลิกเพื่อกำหนดมุม หรือพิมพ์มุมเป็นองศา (ทวนเข็ม = บวก)', scale: 'พิมพ์ตัวคูณ เช่น 2 หรือ 0.5 แล้วกด Enter',
          mirror: 'คลิกจุดที่สองของแกนสะท้อน' }[kind];
      },
      matrix(p) {
        const b = this.base;
        switch (kind) {
          case 'move': case 'copy': return G.Mt(p[0] - b[0], p[1] - b[1]);
          case 'rotate': return same(b, p) ? null : G.Mr(b[0], b[1], Math.atan2(p[1] - b[1], p[0] - b[0]));
          case 'mirror': return same(b, p) ? null : G.Mm(b, p);
        }
        return null;
      },
      apply(M) {
        if (!M) return;
        const ents = selected();
        edit(() => {
          if (kind === 'copy' || (kind === 'mirror' && !this.del)) for (const e of ents) addEnt({ ...G.transformEntity(e, M), id: undefined });
          else for (const e of ents) replaceEnt(e, G.transformEntity(e, M));
        });
      },
      click(p) {
        if (!this.base) { this.base = p; return; }
        if (kind === 'scale') return msg('พิมพ์ตัวคูณแล้วกด Enter', 'err');
        this.apply(this.matrix(p));
        if (kind !== 'copy') endTool();
      },
      input(s) {
        if (!this.base) {
          if (kind === 'mirror' && /^d$/i.test(s)) { this.del = !this.del; return true; }
          const p = parsePoint(s, null); if (p) { this.click(p); return true; } return false;
        }
        if (kind === 'rotate' && isNum(s)) { this.apply(G.Mr(this.base[0], this.base[1], +s * DEG)); endTool(); return true; }
        if (kind === 'scale' && isNum(s)) {
          if (+s <= 0) { msg('ตัวคูณต้องมากกว่า 0', 'err'); return true; }
          this.apply(G.Ms(this.base[0], this.base[1], +s)); endTool(); return true;
        }
        const p = parsePoint(s, this.base); if (p) { this.click(p); return true; } return false;
      },
      enter() { endTool(); },
      preview(g, c) {
        if (!this.base) return;
        g.line(this.base, c);
        const M = this.matrix(c);
        if (M) g.ents(selected().slice(0, 300).map((e) => G.transformEntity(e, M)));
      },
    };
  }

  // ---------- ตัดเส้น ----------
  function cutPoints(e) {
    const tp = G.prims(e)[0], b = G.entBox(e), pts = [];
    for (const o of doc.entities) {
      if (o === e || !visible(o) || o.type === 'text') continue;
      const ob = G.entBox(o);
      if (ob[2] < b[0] || ob[0] > b[2] || ob[3] < b[1] || ob[1] > b[3]) continue;
      for (const q of G.prims(o)) for (const x of G.interPrims(tp, q)) pts.push(x);
    }
    return pts;
  }
  function trimEntity(e, p) {
    if (e.type === 'poly') { msg('ตัดเส้นต่อเนื่องโดยตรงไม่ได้ ให้ใช้ "แตก" ก่อน', 'err'); return null; }
    if (!['line', 'arc', 'circle'].includes(e.type)) { msg('ตัดได้เฉพาะเส้นตรง ส่วนโค้ง และวงกลม', 'err'); return null; }
    const pts = cutPoints(e);
    const pick = (ts, tp, span) => {
      const lo = ts.filter((t) => t < tp), hi = ts.filter((t) => t > tp);
      return { lo: lo.length ? Math.max(...lo) : null, hi: hi.length ? Math.min(...hi) : null, span };
    };
    if (e.type === 'line') {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1, L2 = dx * dx + dy * dy;
      const par = (q) => ((q[0] - e.x1) * dx + (q[1] - e.y1) * dy) / L2;
      const ts = pts.map(par).filter((t) => t > 1e-7 && t < 1 - 1e-7);
      if (!ts.length) { msg('เส้นนี้ไม่ตัดกับวัตถุอื่น จึงตัดไม่ได้ (ใช้ลบแทน)', 'err'); return null; }
      const { lo, hi } = pick(ts, par(p));
      const P = (t) => [e.x1 + dx * t, e.y1 + dy * t], out = [];
      if (lo !== null) { const a = P(lo); out.push({ ...e, x2: a[0], y2: a[1] }); }
      if (hi !== null) { const a = P(hi); out.push({ ...e, x1: a[0], y1: a[1] }); }
      return out;
    }
    if (e.type === 'arc') {
      const sw = G.sweepOf(e), ang = (q) => G.norm(Math.atan2(q[1] - e.cy, q[0] - e.cx) - e.a1);
      const ts = pts.map(ang).filter((t) => t > 1e-7 && t < sw - 1e-7);
      if (!ts.length) { msg('ส่วนโค้งนี้ไม่ตัดกับวัตถุอื่น จึงตัดไม่ได้', 'err'); return null; }
      const { lo, hi } = pick(ts, ang(p)), out = [];
      if (lo !== null) out.push({ ...e, a2: e.a1 + lo });
      if (hi !== null) out.push({ ...e, a1: e.a1 + hi });
      return out;
    }
    const ts = [];
    for (const q of pts) { const t = G.norm(Math.atan2(q[1] - e.cy, q[0] - e.cx)); if (!ts.some((u) => Math.abs(u - t) < 1e-7)) ts.push(t); }
    if (ts.length < 2) { msg('วงกลมต้องตัดกับวัตถุอื่นอย่างน้อย 2 จุดจึงจะตัดได้', 'err'); return null; }
    ts.sort((a, b) => a - b);
    const tp = G.norm(Math.atan2(p[1] - e.cy, p[0] - e.cx));
    const prev = ts.filter((t) => t < tp).pop() ?? ts[ts.length - 1];
    const next = ts.find((t) => t > tp) ?? ts[0];
    return [{ type: 'arc', cx: e.cx, cy: e.cy, r: e.r, a1: next, a2: prev, layer: e.layer, color: e.color }];
  }

  // ---------- มนมุม ----------
  function filletLines(l1, c1, l2, c2, r) {
    const P = G.lineIntersectInf([l1.x1, l1.y1], [l1.x2, l1.y2], [l2.x1, l2.y1], [l2.x2, l2.y2]);
    if (!P) { msg('เส้นทั้งสองขนานกัน มนมุมไม่ได้', 'err'); return null; }
    const keep = (l, c) => {
      const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
      const tc = (c[0] - P[0]) * dx + (c[1] - P[1]) * dy;
      const e1 = [l.x1, l.y1, (l.x1 - P[0]) * dx + (l.y1 - P[1]) * dy], e2 = [l.x2, l.y2, (l.x2 - P[0]) * dx + (l.y2 - P[1]) * dy];
      const k = [e1, e2].filter((q) => Math.sign(q[2]) === Math.sign(tc)).sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]))[0]
        || (Math.abs(e1[2]) > Math.abs(e2[2]) ? e1 : e2);
      return [k[0], k[1]];
    };
    const k1 = keep(l1, c1), k2 = keep(l2, c2);
    const L1 = hyp(k1[0] - P[0], k1[1] - P[1]), L2 = hyp(k2[0] - P[0], k2[1] - P[1]);
    if (L1 < EPS || L2 < EPS) { msg('มนมุมไม่ได้: ปลายเส้นอยู่ที่จุดตัดพอดี', 'err'); return null; }
    if (r <= EPS) return { l1: { ...l1, x1: P[0], y1: P[1], x2: k1[0], y2: k1[1] }, l2: { ...l2, x1: P[0], y1: P[1], x2: k2[0], y2: k2[1] }, arc: null };
    const u1 = [(k1[0] - P[0]) / L1, (k1[1] - P[1]) / L1], u2 = [(k2[0] - P[0]) / L2, (k2[1] - P[1]) / L2];
    const th = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (th < 1e-6 || Math.PI - th < 1e-6) { msg('มุมระหว่างเส้นแคบหรือกว้างเกินไป', 'err'); return null; }
    const t = r / Math.tan(th / 2);
    if (t > L1 + 1e-9 || t > L2 + 1e-9) { msg('รัศมีใหญ่เกินความยาวเส้น', 'err'); return null; }
    const T1 = [P[0] + u1[0] * t, P[1] + u1[1] * t], T2 = [P[0] + u2[0] * t, P[1] + u2[1] * t];
    const bx = u1[0] + u2[0], by = u1[1] + u2[1], bl = hyp(bx, by), dc = r / Math.sin(th / 2);
    const C = [P[0] + bx / bl * dc, P[1] + by / bl * dc];
    let a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]), a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
    if (G.norm(a2 - a1) > Math.PI) [a1, a2] = [a2, a1];
    return {
      l1: { ...l1, x1: T1[0], y1: T1[1], x2: k1[0], y2: k1[1] },
      l2: { ...l2, x1: T2[0], y1: T2[1], x2: k2[0], y2: k2[1] },
      arc: { type: 'arc', cx: C[0], cy: C[1], r, a1, a2, layer: l1.layer, color: l1.color },
    };
  }

  // ---------- คำสั่งที่ทำทันที ----------
  function explodeSel() {
    const ents = selected().filter((e) => e.type === 'poly' || e.type === 'dim');
    if (!ents.length) return msg('ในสิ่งที่เลือกไม่มีเส้นต่อเนื่องหรือเส้นบอกขนาดให้แตก', 'err');
    edit(() => {
      for (const e of ents) {
        const base = { layer: e.layer, color: e.color };
        removeEnts([e.id]);
        if (e.type === 'poly') {
          for (const p of G.prims(e)) addEnt(p.t === 'seg' ? { ...base, type: 'line', x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 } : { ...base, type: 'arc', cx: p.cx, cy: p.cy, r: p.r, a1: p.a1, a2: p.a2 });
        } else {
          const d = G.dimGeom(e);
          for (const s of d.segs) addEnt({ ...base, type: 'line', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 });
          for (const a of d.arrows) addEnt({ ...base, type: 'poly', pts: a.map((q) => [q[0], q[1], 0]), closed: true });
          addEnt({ ...base, type: 'text', ...d.text });
        }
      }
    });
    msg(`แตกแล้ว ${ents.length} ชิ้น`, 'ok');
  }
  function eraseSel() {
    const ids = [...state.sel];
    if (!ids.length) return;
    edit(() => removeEnts(ids));
    msg(`ลบแล้ว ${ids.length} ชิ้น`, 'ok');
  }

  // ================= ตารางคำสั่ง =================
  const ICONS = {
    select: 'M5 3l13 8-6 1.5-2.5 6z', pan: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
    line: 'M5 19L19 5M3.5 17.5h3v3h-3zM17.5 3.5h3v3h-3z', polyline: 'M3 18l5-9 6 6 7-11', rect: 'M4 6h16v12H4z',
    circle: 'M20 12a8 8 0 1 1-16 0a8 8 0 1 1 16 0M12 12h.01', arc: 'M4 18A9 9 0 0 1 20 18M4 18h.01M12 9h.01M20 18h.01',
    text: 'M5 5h14M12 5v14M9 19h6', dim: 'M4 7v11M20 7v11M4 13h16M4 13l3-2M4 13l3 2M20 13l-3-2M20 13l-3 2',
    measure: 'M3 16L16 3l5 5L8 21zM7 12l2 2M10 9l2 2M13 6l2 2',
    move: 'M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5', copy: 'M8 8h12v12H8zM4 16V4h12',
    rotate: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5', scale: 'M4 20h7v-7H4zM11 13l9-9M14 4h6v6',
    mirror: 'M12 3v18M9 7L4 17h5zM15 7l5 10h-5z', offset: 'M4 15L15 4M9 20L20 9',
    trim: 'M6 9a3 3 0 1 0 0-6a3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6a3 3 0 0 0 0 6zM8.5 7.5L20 18M8.5 16.5L20 6',
    fillet: 'M4 20v-8a8 8 0 0 1 8-8h8', explode: 'M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3',
    erase: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  };
  const COMMANDS = [
    { id: 'select', label: 'เลือก', names: ['select', 'เลือก'], group: 'มุมมอง' },
    { id: 'pan', label: 'เลื่อนมุมมอง', names: ['pan', 'เลื่อน'], group: 'มุมมอง' },
    { id: 'line', label: 'เส้นตรง', names: ['line', 'l', 'เส้น', 'เส้นตรง'], group: 'วาด' },
    { id: 'polyline', label: 'เส้นต่อเนื่อง', names: ['pline', 'polyline', 'pl', 'เส้นต่อ', 'เส้นต่อเนื่อง'], group: 'วาด' },
    { id: 'rect', label: 'สี่เหลี่ยม', names: ['rect', 'rectangle', 'rec', 'สี่เหลี่ยม'], group: 'วาด' },
    { id: 'circle', label: 'วงกลม', names: ['circle', 'c', 'วงกลม'], group: 'วาด' },
    { id: 'arc', label: 'ส่วนโค้ง', names: ['arc', 'a', 'โค้ง', 'ส่วนโค้ง'], group: 'วาด' },
    { id: 'text', label: 'ข้อความ', names: ['text', 't', 'ข้อความ'], group: 'วาด' },
    { id: 'dim', label: 'บอกขนาด', names: ['dim', 'dimension', 'บอกขนาด', 'ขนาด'], group: 'วาด' },
    { id: 'measure', label: 'วัดระยะ', names: ['dist', 'measure', 'วัด', 'วัดระยะ'], group: 'วาด' },
    { id: 'move', label: 'ย้าย', names: ['move', 'm', 'ย้าย'], group: 'แก้ไข' },
    { id: 'copy', label: 'คัดลอก', names: ['copy', 'co', 'cp', 'คัดลอก'], group: 'แก้ไข' },
    { id: 'rotate', label: 'หมุน', names: ['rotate', 'ro', 'หมุน'], group: 'แก้ไข' },
    { id: 'scale', label: 'ย่อ/ขยาย', names: ['scale', 'sc', 'ย่อขยาย', 'ขยาย', 'ย่อ'], group: 'แก้ไข' },
    { id: 'mirror', label: 'สะท้อน', names: ['mirror', 'mi', 'สะท้อน'], group: 'แก้ไข' },
    { id: 'offset', label: 'เส้นขนาน', names: ['offset', 'o', 'ขนาน', 'เส้นขนาน'], group: 'แก้ไข' },
    { id: 'trim', label: 'ตัดเส้น', names: ['trim', 'tr', 'ตัด', 'ตัดเส้น'], group: 'แก้ไข' },
    { id: 'fillet', label: 'มนมุม', names: ['fillet', 'f', 'มน', 'มนมุม'], group: 'แก้ไข' },
    { id: 'explode', label: 'แตก', names: ['explode', 'x', 'แตก'], group: 'แก้ไข', act: () => needSel(explodeSel, 'แตก') },
    { id: 'erase', label: 'ลบ', names: ['erase', 'e', 'del', 'delete', 'ลบ'], group: 'แก้ไข', act: () => needSel(eraseSel, 'ลบ') },
  ];
  const EXTRA = { undo: ['u', 'undo', 'ย้อน'], redo: ['redo', 'ทำซ้ำ'], fit: ['z', 'zoom', 'fit', 'ze', 'ดูทั้งหมด'] };
  function lookup(s) {
    const k = s.trim().toLowerCase();
    const c = COMMANDS.find((c) => c.names.includes(k));
    if (c) return c.id;
    for (const [id, names] of Object.entries(EXTRA)) if (names.includes(k)) return id;
    return null;
  }
  /** คำสั่งที่ต้องมีสิ่งที่เลือก: ถ้ายังไม่เลือกให้เข้าโหมดเลือกก่อน แล้ว Enter */
  function needSel(fn, label) {
    if (state.sel.size) { fn(); return; }
    cancel(true);
    tool = { picking: true, label, onPicked: fn };
    highlight(); updatePrompt();
  }

  function runCommand(id) {
    if (id === 'undo') return undo();
    if (id === 'redo') return redo();
    if (id === 'fit') return zoomFit();
    const c = COMMANDS.find((c) => c.id === id);
    if (!c) return;
    lastCmd = id;
    if (c.act) { c.act(); return; }
    cancel(true);
    if (id === 'select') { highlight(); updatePrompt(); return; }
    const t = TOOLS[id]();
    t.id = id; t.label = c.label;
    tool = t;
    if (t.needsSel && !state.sel.size) t.picking = true;
    canvas.classList.toggle('pan', id === 'pan');
    highlight(); updatePrompt(); render();
  }
  function endTool() { tool = null; canvas.classList.remove('pan'); highlight(); updatePrompt(); refreshPanels(); render(); }
  function cancel(keepSel) {
    if (tool) endTool();
    else if (!keepSel && state.sel.size) { state.sel.clear(); refreshPanels(); }
    state.win = null; render();
  }
  function submit() {
    const s = cmd.value.trim();
    cmd.value = '';
    if (tool && tool.picking) {
      if (s === '') {
        if (!state.sel.size) { endTool(); return; }
        const t = tool;
        t.picking = false;
        if (t.onPicked) { endTool(); t.onPicked(); }
      } else { const c = lookup(s); c ? runCommand(c) : msg(`ไม่รู้จักคำสั่ง "${s}"`, 'err'); }
    } else if (tool) {
      if (s === '') tool.enter();
      else if (!(tool.input && tool.input(s))) { const c = lookup(s); c ? runCommand(c) : msg(`ไม่เข้าใจ "${s}" — ${tool.prompt()}`, 'err'); }
    } else if (s === '') { if (lastCmd) runCommand(lastCmd); }
    else { const c = lookup(s); c ? runCommand(c) : msg(`ไม่รู้จักคำสั่ง "${s}" — ลอง เส้น, วงกลม, ย้าย, ตัด หรือกดปุ่มด้านซ้าย`, 'err'); }
    updatePrompt(); render();
  }
  function updatePrompt() {
    if (tool && tool.picking) promptEl.textContent = `${tool.label}: เลือกวัตถุ (คลิกหรือลากกรอบ) แล้วกด Enter`;
    else if (tool) promptEl.textContent = `${tool.label}: ${tool.prompt()}`;
    else promptEl.textContent = state.sel.size ? `เลือกอยู่ ${state.sel.size} ชิ้น — เลือกคำสั่งแก้ไข หรือกด Delete เพื่อลบ, Esc เพื่อยกเลิก` : 'พร้อม — เลือกเครื่องมือด้านซ้าย หรือพิมพ์คำสั่ง เช่น เส้น / line';
  }
  let msgTimer = 0;
  function msg(text, kind = '', ms = 6000) {
    msgEl.textContent = text; msgEl.className = 'msg' + (kind ? ' ' + kind : '');
    clearTimeout(msgTimer); msgTimer = setTimeout(() => { msgEl.textContent = ''; }, ms);
  }

  // ---------- ปุ่มเครื่องมือ ----------
  const toolsEl = $('tools');
  let group = '';
  for (const c of COMMANDS) {
    if (c.group !== group) { group = c.group; const h = document.createElement('h2'); h.textContent = group; toolsEl.append(h); }
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.cmd = c.id; b.setAttribute('aria-pressed', 'false');
    b.title = `${c.label} (พิมพ์: ${c.names[0]})`;
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[c.id]}"/></svg>`;
    const sp = document.createElement('span'); sp.textContent = c.label; b.append(sp);
    b.addEventListener('click', () => { runCommand(c.id); if (!tool || !tool.textMode) canvas.focus({ preventScroll: true }); });
    toolsEl.append(b);
  }
  function highlight() {
    const id = tool ? tool.id || (tool.picking ? null : null) : 'select';
    toolsEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cmd === (tool ? tool.id : 'select'))));
    void id;
  }

  // ================= เมาส์และสัมผัส =================
  const ptrs = new Map();
  let drag = null;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const sp = pos(e);
    ptrs.set(e.pointerId, sp);
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      drag = { mode: 'pinch', d: hyp(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      state.win = null; return;
    }
    if (e.button === 1 || (e.button === 0 && tool && tool.id === 'pan')) {
      e.preventDefault(); drag = { mode: 'pan', sx: sp[0], sy: sp[1], vx: view.x, vy: view.y }; canvas.classList.add('pan'); return;
    }
    if (e.button !== 0) return;
    if (!tool || tool.picking) { drag = { mode: 'pick', sx: sp[0], sy: sp[1], shift: e.shiftKey, moved: false }; return; }
    const p = pointFrom(sp);
    state.cursor = p;
    tool.click(p, sp);
    updatePrompt(); render();
  });
  canvas.addEventListener('pointermove', (e) => {
    const sp = pos(e);
    state.screen = sp;
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, sp);
    if (drag && drag.mode === 'pinch' && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = hyp(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      view.x -= (m[0] - drag.m[0]) / view.s; view.y += (m[1] - drag.m[1]) / view.s;
      if (drag.d > 0) zoomAt(m[0], m[1], d / drag.d);
      drag.d = d; drag.m = m; render(); return;
    }
    if (drag && drag.mode === 'pan') {
      view.x = drag.vx - (sp[0] - drag.sx) / view.s; view.y = drag.vy + (sp[1] - drag.sy) / view.s; render(); return;
    }
    if (drag && drag.mode === 'pick') {
      if (hyp(sp[0] - drag.sx, sp[1] - drag.sy) > 5) drag.moved = true;
      if (drag.moved) state.win = { sx: drag.sx, sy: drag.sy, ex: sp[0], ey: sp[1] };
      render(); return;
    }
    if (tool && !tool.picking) { state.cursor = pointFrom(sp); state.hover = null; }
    else { const h = e.pointerType === 'mouse' ? pickAt(sp) : null; state.hover = h ? h.id : null; state.cursor = s2w(sp[0], sp[1]); }
    $('coords').textContent = `${fmt(state.cursor[0], 3)}, ${fmt(state.cursor[1], 3)}`;
    render();
  });
  function pointerEnd(e) {
    ptrs.delete(e.pointerId);
    if (!drag) return;
    if (drag.mode === 'pick') {
      const sp = pos(e);
      if (drag.moved) {
        const n = windowSelect([drag.sx, drag.sy], sp, drag.shift);
        if (!n && !drag.shift) msg('ไม่มีวัตถุในกรอบ');
      } else {
        const hit = pickAt(sp);
        if (hit) { if (drag.shift) state.sel.delete(hit.id); else state.sel.add(hit.id); }
        else if (!drag.shift) state.sel.clear();
      }
      state.win = null; refreshPanels(); updatePrompt();
    }
    if (drag.mode === 'pan' && !(tool && tool.id === 'pan')) canvas.classList.remove('pan');
    if (drag.mode !== 'pinch' || ptrs.size === 0) drag = null;
    render();
  }
  canvas.addEventListener('pointerup', pointerEnd);
  canvas.addEventListener('pointercancel', pointerEnd);
  canvas.addEventListener('pointerleave', () => { if (!drag) { state.hover = null; render(); } });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const sp = pos(e); zoomAt(sp[0], sp[1], Math.pow(1.0015, -e.deltaY)); }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); submit(); });
  canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

  // ================= คีย์บอร์ด =================
  document.addEventListener('keydown', (e) => {
    const t = e.target, inCmd = t === cmd;
    if (!inCmd && t.matches && t.matches('input, textarea, select')) { if (e.key === 'Escape') t.blur(); return; }
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); cmd.value = ''; cancel(false); updatePrompt(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'S')) { e.preventDefault(); saveDxf(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 'a' || k === 'A') && !inCmd) { e.preventDefault(); for (const x of doc.entities) if (selectable(x)) state.sel.add(x.id); refreshPanels(); updatePrompt(); render(); return; }
    if (k === 'F3') { e.preventDefault(); toggle('snap'); return; }
    if (k === 'F7') { e.preventDefault(); toggle('grid'); return; }
    if (k === 'F8') { e.preventDefault(); toggle('ortho'); return; }
    if (k === 'Delete' && !cmd.value) { e.preventDefault(); if (!tool) eraseSel(); return; }
    const onBlank = inCmd || t === canvas || t === document.body;
    if (onBlank && (k === 'Enter' || (k === ' ' && !(tool && tool.textMode)))) { e.preventDefault(); submit(); return; }
    if (!inCmd && onBlank && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) cmd.focus();
  });
  function toggle(which) {
    const key = which + 'On';
    state[key] = !state[key];
    $('t-' + which).setAttribute('aria-pressed', String(state[key]));
    msg({ snap: 'ดูดจุด', grid: 'กริด', ortho: 'ตั้งฉาก' }[which] + (state[key] ? ' เปิด' : ' ปิด'));
    render();
  }
  $('t-snap').addEventListener('click', () => toggle('snap'));
  $('t-grid').addEventListener('click', () => toggle('grid'));
  $('t-ortho').addEventListener('click', () => toggle('ortho'));

  // ================= แผงคุณสมบัติ =================
  const propsEl = $('props'), layersEl = $('layers');
  function el(tag, attrs = {}, text) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'on') for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f); else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v); }
    if (text !== undefined) n.textContent = text;
    return n;
  }
  let uid = 0;
  function kvRow(box, label, input) { const id = 'f' + (++uid); input.id = id; box.append(el('label', { for: id }, label), input); }
  function kvRead(box, label, value) { box.append(el('span', { class: 'k' }, label), el('span', { class: 'v' }, value)); }
  function colorSelect(value, withByLayer, onChange) {
    const s = el('select');
    if (withByLayer) s.append(el('option', { value: '' }, 'ตามเลเยอร์'));
    for (let i = 1; i <= 9; i++) s.append(el('option', { value: i }, `${i} · ${COLOR_NAMES[i]}`));
    if (value != null && value > 9) s.append(el('option', { value }, `ACI ${value}`));
    s.value = value == null ? '' : String(value);
    s.addEventListener('change', () => onChange(s.value === '' ? null : +s.value));
    return s;
  }
  function layerSelect(value, onChange) {
    const s = el('select');
    for (const l of doc.layers) s.append(el('option', { value: l.name }, l.name));
    s.value = value; s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function numInput(value, onChange) {
    const i = el('input', { type: 'text', inputmode: 'decimal', value: fmt(value, 6) });
    i.addEventListener('change', () => { const v = parseFloat(i.value); if (isFinite(v)) onChange(v); else { i.value = fmt(value, 6); msg('กรุณาพิมพ์ตัวเลข', 'err'); } });
    return i;
  }
  /** แก้คุณสมบัติของวัตถุแบบย้อนกลับได้ */
  function setProp(e, fn) { edit(() => { fn(e); G.invalidate(e); }); }

  const TYPE_NAMES = { line: 'เส้นตรง', poly: 'เส้นต่อเนื่อง', circle: 'วงกลม', arc: 'ส่วนโค้ง', text: 'ข้อความ', dim: 'เส้นบอกขนาด' };
  function refreshPanels() { renderProps(); renderLayers(); }
  function renderProps() {
    propsEl.replaceChildren();
    const sel = selected();
    if (!sel.length) {
      propsEl.append(el('h3', {}, 'แบบนี้'));
      const box = el('div', { class: 'kv' });
      kvRead(box, 'ชื่อ', docName);
      kvRead(box, 'วัตถุ', String(doc.entities.length));
      kvRead(box, 'เลเยอร์', String(doc.layers.length));
      kvRow(box, 'ตัวอักษรสูง', numInput(textH(), (v) => { if (v > 0) edit(() => { doc.textH = v; }); }));
      kvRow(box, 'ทศนิยม', (() => { const s = el('select'); for (let i = 0; i <= 6; i++) s.append(el('option', { value: i }, String(i))); s.value = String(doc.prec ?? 2); s.addEventListener('change', () => edit(() => { doc.prec = +s.value; doc.entities.forEach(G.invalidate); })); return s; })());
      propsEl.append(box);
      propsEl.append(el('p', { class: 'note' }, 'คลิกวัตถุเพื่อดูและแก้คุณสมบัติ · ลากซ้ายไปขวา = เลือกเฉพาะที่อยู่ในกรอบทั้งชิ้น · ลากขวาไปซ้าย = แตะกรอบก็เลือก · Shift+คลิก = เอาออกจากที่เลือก'));
      propsEl.append(el('p', { class: 'note' }, 'พิมพ์พิกัด: 10,20 (สัมบูรณ์) · @5,0 (สัมพัทธ์) · @10<45 (ระยะ<มุม) · ตัวเลขเดียว = ระยะตามทิศเมาส์'));
      return;
    }
    if (sel.length > 1) {
      propsEl.append(el('h3', {}, `เลือก ${sel.length} ชิ้น`));
      const box = el('div', { class: 'kv' });
      const layersUsed = [...new Set(sel.map((e) => e.layer))];
      kvRow(box, 'เลเยอร์', layerSelect(layersUsed.length === 1 ? layersUsed[0] : '', (v) => edit(() => sel.forEach((e) => { e.layer = v; }))));
      const colors = [...new Set(sel.map((e) => e.color))];
      kvRow(box, 'สี', colorSelect(colors.length === 1 ? colors[0] : null, true, (v) => edit(() => sel.forEach((e) => { e.color = v; }))));
      const counts = {};
      sel.forEach((e) => { counts[e.type] = (counts[e.type] || 0) + 1; });
      kvRead(box, 'ประกอบด้วย', Object.entries(counts).map(([t, n]) => `${TYPE_NAMES[t]} ${n}`).join(', '));
      propsEl.append(box);
      return;
    }
    const e = sel[0];
    propsEl.append(el('h3', {}, TYPE_NAMES[e.type]));
    const box = el('div', { class: 'kv' });
    kvRow(box, 'เลเยอร์', layerSelect(e.layer, (v) => setProp(e, (x) => { x.layer = v; })));
    kvRow(box, 'สี', colorSelect(e.color, true, (v) => setProp(e, (x) => { x.color = v; })));
    const N = (label, key, check) => kvRow(box, label, numInput(e[key], (v) => { if (check && !check(v)) return msg('ค่าไม่ถูกต้อง', 'err'); setProp(e, (x) => { x[key] = v; }); }));
    const A = (label, key) => kvRow(box, label, numInput(G.norm(e[key]) / DEG, (v) => setProp(e, (x) => { x[key] = v * DEG; })));
    switch (e.type) {
      case 'line': {
        N('X1', 'x1'); N('Y1', 'y1'); N('X2', 'x2'); N('Y2', 'y2');
        kvRead(box, 'ความยาว', fmt(hyp(e.x2 - e.x1, e.y2 - e.y1), 4));
        kvRead(box, 'มุม', fmt(G.norm(Math.atan2(e.y2 - e.y1, e.x2 - e.x1)) / DEG, 3) + '°');
        break;
      }
      case 'circle': N('ศูนย์กลาง X', 'cx'); N('ศูนย์กลาง Y', 'cy'); N('รัศมี', 'r', (v) => v > 0);
        kvRead(box, 'เส้นผ่านศูนย์กลาง', fmt(e.r * 2, 4)); kvRead(box, 'เส้นรอบวง', fmt(TAU * e.r, 4)); kvRead(box, 'พื้นที่', fmt(Math.PI * e.r * e.r, 4)); break;
      case 'arc': N('ศูนย์กลาง X', 'cx'); N('ศูนย์กลาง Y', 'cy'); N('รัศมี', 'r', (v) => v > 0); A('มุมเริ่ม °', 'a1'); A('มุมจบ °', 'a2');
        kvRead(box, 'ความยาวโค้ง', fmt(e.r * G.sweepOf(e), 4)); break;
      case 'poly': {
        const m = G.polyMetrics(e);
        kvRead(box, 'จำนวนจุด', String(e.pts.length));
        const cb = el('input', { type: 'checkbox' }); cb.checked = !!e.closed;
        cb.addEventListener('change', () => setProp(e, (x) => { x.closed = cb.checked; }));
        kvRow(box, 'ปิดรูป', cb);
        kvRead(box, 'ความยาวรวม', fmt(m.len, 4));
        if (e.closed) kvRead(box, 'พื้นที่', fmt(m.area, 4));
        break;
      }
      case 'text': {
        const ta = el('textarea'); ta.value = e.text;
        ta.addEventListener('change', () => { if (ta.value.trim()) setProp(e, (x) => { x.text = ta.value; }); });
        kvRow(box, 'ข้อความ', ta);
        N('X', 'x'); N('Y', 'y'); N('ความสูง', 'h', (v) => v > 0);
        kvRow(box, 'มุม °', numInput((e.rot || 0) / DEG, (v) => setProp(e, (x) => { x.rot = v * DEG; })));
        break;
      }
      case 'dim': {
        const d = G.dimGeom(e);
        kvRead(box, 'ค่าที่วัดได้', fmt(d.value, 6));
        const t = el('input', { type: 'text', value: e.text || '', placeholder: 'อัตโนมัติ' });
        t.addEventListener('change', () => setProp(e, (x) => { x.text = t.value; }));
        kvRow(box, 'ข้อความแทน', t);
        N('ความสูงอักษร', 'h', (v) => v > 0);
        break;
      }
    }
    propsEl.append(box);
  }

  function renderLayers() {
    layersEl.replaceChildren();
    const used = new Map();
    for (const e of doc.entities) used.set(e.layer, (used.get(e.layer) || 0) + 1);
    layersEl.append(el('h3', {}, 'เลเยอร์'));
    for (const l of doc.layers) {
      const row = el('div', { class: 'layer' });
      const rb = el('input', { type: 'radio', name: 'curlayer', 'aria-label': `ใช้เลเยอร์ ${l.name} เป็นเลเยอร์ปัจจุบัน`, title: 'เลเยอร์ปัจจุบัน' });
      rb.checked = doc.current === l.name;
      rb.addEventListener('change', () => { doc.current = l.name; scheduleSave(); msg(`เลเยอร์ปัจจุบัน: ${l.name}`); });
      const name = el('input', { type: 'text', value: l.name, 'aria-label': 'ชื่อเลเยอร์' });
      if (l.name === '0') name.disabled = true;
      name.addEventListener('change', () => {
        const nv = name.value.trim();
        if (!nv || doc.layers.some((x) => x.name === nv)) { name.value = l.name; return msg('ชื่อเลเยอร์ว่างหรือซ้ำ', 'err'); }
        const old = l.name;
        edit(() => { const L = doc.layers.find((x) => x.name === old); L.name = nv; doc.entities.forEach((e) => { if (e.layer === old) e.layer = nv; }); if (doc.current === old) doc.current = nv; });
      });
      const col = colorSelect(l.color, false, (v) => edit(() => { doc.layers.find((x) => x.name === l.name).color = v; }));
      col.setAttribute('aria-label', `สีเลเยอร์ ${l.name}`);
      const row2 = el('div', { class: 'row2' });
      const L = () => doc.layers.find((x) => x.name === l.name);
      row2.append(
        el('button', { type: 'button', 'aria-pressed': String(l.visible), on: { click: () => { if (doc.current === l.name && l.visible) return msg('ซ่อนเลเยอร์ปัจจุบันไม่ได้', 'err'); edit(() => { L().visible = !l.visible; }); } } }, 'แสดง'),
        el('button', { type: 'button', 'aria-pressed': String(!l.locked), on: { click: () => edit(() => { L().locked = !l.locked; }) } }, l.locked ? 'ล็อกอยู่' : 'แก้ได้'),
        el('button', { type: 'button', disabled: l.name === '0' || used.get(l.name) > 0 || doc.current === l.name, title: 'ลบได้เมื่อเลเยอร์ว่าง',
          on: { click: () => edit(() => { doc.layers = doc.layers.filter((x) => x.name !== l.name); }) } }, `ลบ (${used.get(l.name) || 0})`),
      );
      row.append(rb, name, col, row2);
      layersEl.append(row);
    }
    const br = el('div', { class: 'btnrow' });
    br.append(el('button', { type: 'button', on: { click: () => {
      let k = doc.layers.length, n;
      do n = 'เลเยอร์ ' + k++; while (doc.layers.some((l) => l.name === n));
      edit(() => { doc.layers.push({ name: n, color: (doc.layers.length % 6) + 1, visible: true, locked: false }); doc.current = n; });
    } } }, '+ เพิ่มเลเยอร์'));
    if (state.sel.size) br.append(el('button', { type: 'button', on: { click: () => { const ids = state.sel; edit(() => doc.entities.forEach((e) => { if (ids.has(e.id)) e.layer = doc.current; })); } } }, 'ย้ายที่เลือกมาเลเยอร์ปัจจุบัน'));
    layersEl.append(br);
  }
  // แท็บแผงขวา
  const sideTabs = [$('st-props'), $('st-layers')];
  sideTabs.forEach((b) => b.addEventListener('click', () => {
    sideTabs.forEach((x) => { const on = x === b; x.setAttribute('aria-selected', String(on)); $(x.getAttribute('aria-controls')).hidden = !on; });
  }));

  // ================= ไฟล์ =================
  function download(data, name, type) {
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const base = () => docName.replace(/\.(dxf|json)$/i, '') || 'แบบร่าง';
  function setName(n) { docName = n; $('docname').textContent = n; document.title = `${n} — Draftloom`; }
  function saveDxf() { download(G.dxf.write(doc), base() + '.dxf', 'application/dxf'); dirty = false; msg('บันทึก DXF แล้ว', 'ok'); }
  function saveJson() { download(JSON.stringify({ app: 'draftloom', ...doc }), base() + '.draftloom.json', 'application/json'); dirty = false; msg('บันทึกงานแล้ว', 'ok'); }
  function loadDoc(d, name) {
    undoStack.length = 0; redoStack.length = 0;
    doc = d; state.sel.clear(); tool = null; setName(name);
    G.prec = doc.prec ?? 2; changed(); dirty = false; zoomFit(); highlight(); updatePrompt();
  }
  async function openFile(file) {
    const name = file.name;
    try {
      if (/\.dwg$/i.test(name)) return msg('ไฟล์ DWG เป็นรูปแบบปิด เปิดตรง ๆ ไม่ได้ — ให้บันทึกเป็น DXF จากโปรแกรมเขียนแบบที่ใช้อยู่ หรือแปลงด้วยโปรแกรมแปลงไฟล์ฟรี แล้วเปิดไฟล์ DXF แทน', 'err', 15000);
      if (dirty && doc.entities.length && !confirm('งานปัจจุบันยังไม่ได้บันทึก เปิดไฟล์ใหม่ทับเลยไหม?')) return;
      const buf = await file.arrayBuffer();
      if (/\.json$/i.test(name)) {
        const d = JSON.parse(new TextDecoder().decode(buf));
        if (!Array.isArray(d.entities) || !Array.isArray(d.layers)) throw new Error('ไม่ใช่ไฟล์งานของ Draftloom');
        delete d.app;
        d.nextId = Math.max(d.nextId || 1, ...d.entities.map((e) => (e.id || 0) + 1));
        loadDoc(d, name.replace(/\.draftloom\.json$|\.json$/i, ''));
        return msg(`เปิดงาน ${d.entities.length} ชิ้น`, 'ok');
      }
      msg('กำลังอ่านไฟล์…');
      let text;
      try { text = G.dxf.decodeBytes(buf); } catch (er) { if (er.message === 'binary') return msg('ไฟล์นี้เป็น DXF แบบไบนารี ยังไม่รองรับ — บันทึกเป็น DXF แบบ ASCII แล้วลองใหม่', 'err', 12000); throw er; }
      const r = G.dxf.parse(text);
      const d = newDoc();
      d.layers = r.layers;
      d.entities = r.entities;
      d.entities.forEach((e, i) => { e.id = i + 1; });
      d.nextId = d.entities.length + 1;
      const hs = d.entities.filter((e) => e.type === 'text').map((e) => e.h);
      d.textH = hs.length ? hs.sort((a, b) => a - b)[Math.floor(hs.length / 2)] : 0;
      loadDoc(d, name);
      const sk = Object.entries(r.skipped);
      msg(`เปิดแล้ว ${d.entities.length} วัตถุ, ${d.layers.length} เลเยอร์` + (sk.length ? ` · ข้าม: ${sk.map(([t, n]) => `${t} ${n}`).join(', ')}` : ''), 'ok', 15000);
    } catch (er) {
      console.error(er);
      msg('เปิดไฟล์ไม่ได้: ' + (er.message || er), 'err', 12000);
    }
  }
  $('f-new').addEventListener('click', () => { if (dirty && doc.entities.length && !confirm('เริ่มแบบใหม่? งานที่ยังไม่บันทึกจะหาย (ย้อนกลับไม่ได้)')) return; loadDoc(newDoc(), 'แบบร่าง'); });
  $('f-open').addEventListener('click', () => $('f-input').click());
  $('f-input').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); });
  $('f-dxf').addEventListener('click', saveDxf);
  $('f-json').addEventListener('click', saveJson);
  $('b-undo').addEventListener('click', undo);
  $('b-redo').addEventListener('click', redo);
  $('b-fit').addEventListener('click', zoomFit);
  $('b-zin').addEventListener('click', () => zoomAt(W / 2, H / 2, 1.4));
  $('b-zout').addEventListener('click', () => zoomAt(W / 2, H / 2, 1 / 1.4));

  function exportView() {
    const b = extents(doc.entities.filter(visible));
    if (!b) { msg('ยังไม่มีอะไรให้ส่งออก', 'err'); return null; }
    const w = Math.max(b[2] - b[0], 1e-6), h = Math.max(b[3] - b[1], 1e-6);
    return { b, w, h };
  }
  $('f-png').addEventListener('click', () => {
    const ex = exportView(); if (!ex) return;
    const maxPx = 2400, s = Math.min(maxPx / ex.w, maxPx / ex.h), pad = 24;
    const cw = Math.ceil(ex.w * s + pad * 2), ch = Math.ceil(ex.h * s + pad * 2);
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const saved = theme; theme = { ...theme, sel: '#000' };
    drawScene(c.getContext('2d'), cw, ch, { x: (ex.b[0] + ex.b[2]) / 2, y: (ex.b[1] + ex.b[3]) / 2, s }, { bg: '#ffffff', ink: '#000000', light: true, grid: false });
    theme = saved;
    c.toBlob((bl) => { download(bl, base() + '.png'); msg('ส่งออก PNG แล้ว', 'ok'); });
  });
  $('f-svg').addEventListener('click', () => {
    const ex = exportView(); if (!ex) return;
    const pad = Math.max(ex.w, ex.h) * 0.02, sw = Math.max(ex.w, ex.h) / 1200;
    const vb = [ex.b[0] - pad, -(ex.b[3] + pad), ex.w + pad * 2, ex.h + pad * 2];
    const n = (v) => +v.toFixed(6);
    const escX = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(n).join(' ')}" width="${n(vb[2])}" height="${n(vb[3])}">`,
      `<rect x="${n(vb[0])}" y="${n(vb[1])}" width="${n(vb[2])}" height="${n(vb[3])}" fill="#fff"/>`];
    const pathOf = (ps) => ps.map((p) => {
      if (p.t === 'seg') return `M${n(p.x1)} ${n(-p.y1)}L${n(p.x2)} ${n(-p.y2)}`;
      if (p.full) return `M${n(p.cx + p.r)} ${n(-p.cy)}A${n(p.r)} ${n(p.r)} 0 1 0 ${n(p.cx - p.r)} ${n(-p.cy)}A${n(p.r)} ${n(p.r)} 0 1 0 ${n(p.cx + p.r)} ${n(-p.cy)}`;
      const [a, b] = G.arcEnds(p), large = G.sweepOf(p) > Math.PI ? 1 : 0;
      return `M${n(a[0])} ${n(-a[1])}A${n(p.r)} ${n(p.r)} 0 ${large} 0 ${n(b[0])} ${n(-b[1])}`;
    }).join('');
    const textSvg = (t, col) => {
      const L = G.textLayout(t);
      return L.lines.map((ln, i) => {
        const lx = L.x0, ly = L.dy - i * 1.5 * t.h, c = Math.cos(t.rot || 0), s = Math.sin(t.rot || 0);
        const x = t.x + lx * c - ly * s, y = t.y + lx * s + ly * c;
        return `<text x="${n(x)}" y="${n(-y)}" font-size="${n(t.h)}" font-family='${FONT}' fill="${col}" transform="rotate(${n(-(t.rot || 0) / DEG)} ${n(x)} ${n(-y)})">${escX(ln)}</text>`;
      }).join('');
    };
    for (const e of doc.entities) {
      if (!visible(e)) continue;
      const col = displayColor(e.color ?? layerOf(e.layer).color, true, '#000000');
      if (e.type === 'text') { out.push(textSvg(e, col)); continue; }
      out.push(`<path d="${pathOf(G.prims(e))}" fill="none" stroke="${col}" stroke-width="${n(sw)}" stroke-linecap="round"/>`);
      if (e.type === 'dim') {
        const d = G.dimGeom(e);
        for (const a of d.arrows) out.push(`<path d="M${a.map((q) => `${n(q[0])} ${n(-q[1])}`).join('L')}Z" fill="${col}"/>`);
        out.push(textSvg(d.text, col));
      }
    }
    out.push('</svg>');
    download(out.join('\n'), base() + '.svg', 'image/svg+xml');
    msg('ส่งออก SVG แล้ว', 'ok');
  });

  // ลากไฟล์มาวาง
  const stage = $('stage'), dropmsg = $('dropmsg');
  stage.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dropmsg.hidden = false; } });
  stage.addEventListener('dragleave', (e) => { if (e.target === stage || e.target === canvas) dropmsg.hidden = true; });
  stage.addEventListener('drop', (e) => { e.preventDefault(); dropmsg.hidden = true; const f = e.dataTransfer.files[0]; if (f) openFile(f); });

  // ================= เริ่มต้น =================
  function resize() {
    const r = stage.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }
  readTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); render(); });
  new ResizeObserver(resize).observe(stage);
  resize();
  try {
    const saved = JSON.parse(localStorage.getItem('draftloom.autosave') || 'null');
    if (saved && saved.doc && Array.isArray(saved.doc.entities)) { doc = saved.doc; setName(saved.name || 'แบบร่าง'); G.prec = doc.prec ?? 2; }
  } catch (_) { /* ไม่มีงานเดิม */ }
  zoomFit();
  refreshPanels(); highlight(); updatePrompt();
  if (doc.entities.length) msg(`เปิดงานล่าสุดที่บันทึกอัตโนมัติไว้ (${doc.entities.length} วัตถุ)`, 'ok');

  // สำหรับทดสอบ
  window.Draftloom = { get doc() { return doc; }, runCommand, submit, paint, openFile, view, state, cmd, parsePoint, trimEntity, filletLines, w2s, s2w };
})();
