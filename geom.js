/* Draftloom — เรขาคณิต
 * วัตถุทุกชนิดถูกแตกเป็น "ชิ้นพื้นฐาน" (primitive) 2 แบบ:
 *   { t:'seg', x1,y1,x2,y2 }  และ  { t:'arc', cx,cy,r,a1,a2, full? } (มุมเรเดียน วนทวนเข็มจาก a1 ไป a2)
 * ใช้ร่วมกันในการวาด เลือก ดูดจุด หาจุดตัด และตัดเส้น
 */
(function (G) {
  'use strict';
  const TAU = Math.PI * 2, EPS = 1e-9, DEG = Math.PI / 180;
  const norm = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };
  const sweepOf = (a) => (a.full ? TAU : (norm(a.a2 - a.a1) || TAU));
  const onArc = (ang, a) => a.full || norm(ang - a.a1) <= sweepOf(a) + 1e-7;
  const hyp = Math.hypot;

  // ---------- ข้อความ (ต้องวัดความกว้างด้วย canvas) ----------
  const FONT = '"Noto Sans Thai","Leelawadee UI",Tahoma,system-ui,sans-serif';
  const mctx = document.createElement('canvas').getContext('2d');
  mctx.font = '100px ' + FONT;
  const mcache = new Map();
  function measure(s) {
    let w = mcache.get(s);
    if (w === undefined) { w = mctx.measureText(s).width / 100; if (mcache.size > 5000) mcache.clear(); mcache.set(s, w); }
    return w;
  }
  function textLayout(t) {
    const lines = String(t.text).split('\n');
    const h = t.h;
    let w = 0;
    for (const l of lines) w = Math.max(w, measure(l) * h);
    const n = lines.length;
    const top = h, bottom = -(n - 1) * 1.5 * h - 0.25 * h;
    const fx = t.ha === 'center' ? 0.5 : t.ha === 'right' ? 1 : 0;
    let dy = 0;
    if (t.va === 'top') dy = -top;
    else if (t.va === 'middle') dy = -(top + bottom) / 2;
    else if (t.va === 'bottom') dy = -bottom;
    return { lines, w, x0: -w * fx, dy, top, bottom };
  }
  function textCorners(t) {
    const L = textLayout(t), c = Math.cos(t.rot || 0), s = Math.sin(t.rot || 0);
    return [[L.x0, L.bottom + L.dy], [L.x0 + L.w, L.bottom + L.dy], [L.x0 + L.w, L.top + L.dy], [L.x0, L.top + L.dy]]
      .map(([x, y]) => [t.x + x * c - y * s, t.y + x * s + y * c]);
  }
  function textDist(t, px, py) {
    const L = textLayout(t), c = Math.cos(-(t.rot || 0)), s = Math.sin(-(t.rot || 0));
    const dx = px - t.x, dy = py - t.y;
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    const x0 = L.x0, x1 = L.x0 + L.w, y0 = L.bottom + L.dy, y1 = L.top + L.dy;
    const ex = Math.max(x0 - lx, 0, lx - x1), ey = Math.max(y0 - ly, 0, ly - y1);
    return hyp(ex, ey);
  }

  // ---------- ตัวเลข ----------
  function fmt(v, prec = 2) {
    if (!isFinite(v)) return '—';
    let s = v.toFixed(prec);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }
  function niceRound(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (p * m >= v * 0.8) return p * m;
    return p * 10;
  }

  // ---------- ชิ้นพื้นฐาน ----------
  /** ส่วนโค้งจาก bulge ของเส้นต่อเนื่อง (b = tan(มุมรวม/4), บวก = ทวนเข็ม) */
  function bulgeArc(x1, y1, x2, y2, b) {
    const th = 4 * Math.atan(b);
    const d = hyp(x2 - x1, y2 - y1);
    if (d < EPS) return null;
    const r = d / (2 * Math.sin(th / 2));
    const al = Math.atan2(y2 - y1, x2 - x1);
    const ang = al + Math.PI / 2 - th / 2;
    const cx = x1 + r * Math.cos(ang), cy = y1 + r * Math.sin(ang);
    let a1 = Math.atan2(y1 - cy, x1 - cx), a2 = Math.atan2(y2 - cy, x2 - cx);
    if (b < 0) [a1, a2] = [a2, a1];
    return { t: 'arc', cx, cy, r: Math.abs(r), a1, a2 };
  }

  function dimGeom(e) {
    const h = e.h;
    const dx = e.x2 - e.x1, dy = e.y2 - e.y1, L = hyp(dx, dy) || 1e-9;
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const d = (e.ox - e.x1) * nx + (e.oy - e.y1) * ny;
    const sg = d >= 0 ? 1 : -1, gap = h * 0.4, ext = h * 0.6;
    const q1 = [e.x1 + nx * d, e.y1 + ny * d], q2 = [e.x2 + nx * d, e.y2 + ny * d];
    const seg = (x1, y1, x2, y2) => ({ t: 'seg', x1, y1, x2, y2 });
    const segs = [
      seg(e.x1 + nx * gap * sg, e.y1 + ny * gap * sg, q1[0] + nx * ext * sg, q1[1] + ny * ext * sg),
      seg(e.x2 + nx * gap * sg, e.y2 + ny * gap * sg, q2[0] + nx * ext * sg, q2[1] + ny * ext * sg),
      seg(q1[0], q1[1], q2[0], q2[1]),
    ];
    const a = h, w = h / 3;
    const arrows = [
      [q1, [q1[0] + ux * a + nx * w / 2, q1[1] + uy * a + ny * w / 2], [q1[0] + ux * a - nx * w / 2, q1[1] + uy * a - ny * w / 2]],
      [q2, [q2[0] - ux * a + nx * w / 2, q2[1] - uy * a + ny * w / 2], [q2[0] - ux * a - nx * w / 2, q2[1] - uy * a - ny * w / 2]],
    ];
    let rot = Math.atan2(uy, ux);
    if (rot > Math.PI / 2 + 1e-9) rot -= Math.PI;
    else if (rot <= -Math.PI / 2 + 1e-9) rot += Math.PI;
    const upx = -Math.sin(rot), upy = Math.cos(rot);
    const text = {
      x: (q1[0] + q2[0]) / 2 + upx * h * 0.3, y: (q1[1] + q2[1]) / 2 + upy * h * 0.3,
      h, rot, text: e.text || fmt(L, G.prec ?? 2), ha: 'center', va: 'baseline',
    };
    return { segs, arrows, text, value: L };
  }

  const primCache = new WeakMap(), boxCache = new WeakMap();
  function invalidate(e) { primCache.delete(e); boxCache.delete(e); }

  function prims(e) {
    let p = primCache.get(e);
    if (p) return p;
    p = [];
    switch (e.type) {
      case 'line': p.push({ t: 'seg', x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }); break;
      case 'poly': {
        const n = e.pts.length, m = e.closed ? n : n - 1;
        for (let i = 0; i < m; i++) {
          const a = e.pts[i], b = e.pts[(i + 1) % n];
          const bu = a[2] || 0;
          if (Math.abs(bu) > 1e-9) { const arc = bulgeArc(a[0], a[1], b[0], b[1], bu); if (arc) { arc.seg = i; p.push(arc); continue; } }
          p.push({ t: 'seg', x1: a[0], y1: a[1], x2: b[0], y2: b[1], seg: i });
        }
        break;
      }
      case 'circle': p.push({ t: 'arc', cx: e.cx, cy: e.cy, r: e.r, a1: 0, a2: TAU, full: true }); break;
      case 'arc': p.push({ t: 'arc', cx: e.cx, cy: e.cy, r: e.r, a1: e.a1, a2: e.a2 }); break;
      case 'dim': p = dimGeom(e).segs; break;
    }
    primCache.set(e, p);
    return p;
  }

  const arcEnds = (a) => [[a.cx + a.r * Math.cos(a.a1), a.cy + a.r * Math.sin(a.a1)], [a.cx + a.r * Math.cos(a.a2), a.cy + a.r * Math.sin(a.a2)]];
  function primMid(p) {
    if (p.t === 'seg') return [(p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2];
    const a = p.a1 + sweepOf(p) / 2;
    return [p.cx + p.r * Math.cos(a), p.cy + p.r * Math.sin(a)];
  }
  function grow(b, x, y) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
  function primBox(p) {
    if (p.t === 'seg') return [Math.min(p.x1, p.x2), Math.min(p.y1, p.y2), Math.max(p.x1, p.x2), Math.max(p.y1, p.y2)];
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    if (!p.full) for (const q of arcEnds(p)) grow(b, q[0], q[1]);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2;
      if (onArc(a, p)) grow(b, p.cx + p.r * Math.cos(a), p.cy + p.r * Math.sin(a));
    }
    return b;
  }
  function entBox(e) {
    let b = boxCache.get(e);
    if (b) return b;
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of prims(e)) { const q = primBox(p); grow(b, q[0], q[1]); grow(b, q[2], q[3]); }
    if (e.type === 'text') for (const c of textCorners(e)) grow(b, c[0], c[1]);
    if (e.type === 'dim') { for (const c of textCorners(dimGeom(e).text)) grow(b, c[0], c[1]); }
    if (!isFinite(b[0])) b = [0, 0, 0, 0];
    boxCache.set(e, b);
    return b;
  }

  function distSeg(px, py, s) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, L = dx * dx + dy * dy;
    let t = L ? ((px - s.x1) * dx + (py - s.y1) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return hyp(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
  }
  function distArc(px, py, a) {
    if (onArc(Math.atan2(py - a.cy, px - a.cx), a)) return Math.abs(hyp(px - a.cx, py - a.cy) - a.r);
    const e = arcEnds(a);
    return Math.min(hyp(px - e[0][0], py - e[0][1]), hyp(px - e[1][0], py - e[1][1]));
  }
  const primDist = (p, x, y) => (p.t === 'seg' ? distSeg(x, y, p) : distArc(x, y, p));
  function entDist(e, x, y) {
    let d = Infinity;
    for (const p of prims(e)) d = Math.min(d, primDist(p, x, y));
    if (e.type === 'text') d = Math.min(d, textDist(e, x, y));
    if (e.type === 'dim') d = Math.min(d, textDist(dimGeom(e).text, x, y));
    return d;
  }

  // ---------- จุดตัด ----------
  function segSeg(a, b) {
    const rx = a.x2 - a.x1, ry = a.y2 - a.y1, sx = b.x2 - b.x1, sy = b.y2 - b.y1;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < EPS) return [];
    const qx = b.x1 - a.x1, qy = b.y1 - a.y1;
    const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return [];
    return [[a.x1 + t * rx, a.y1 + t * ry]];
  }
  function lineCircleT(x1, y1, x2, y2, cx, cy, r) {
    const dx = x2 - x1, dy = y2 - y1, fx = x1 - cx, fy = y1 - cy;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
    const D = B * B - 4 * A * C;
    if (A < EPS || D < 0) return [];
    if (D < 1e-14) return [-B / (2 * A)];
    const sq = Math.sqrt(D);
    return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  }
  function segArc(s, a) {
    return lineCircleT(s.x1, s.y1, s.x2, s.y2, a.cx, a.cy, a.r)
      .filter((t) => t >= -1e-9 && t <= 1 + 1e-9)
      .map((t) => [s.x1 + t * (s.x2 - s.x1), s.y1 + t * (s.y2 - s.y1)])
      .filter((p) => onArc(Math.atan2(p[1] - a.cy, p[0] - a.cx), a));
  }
  function circleCircle(a, b) {
    const dx = b.cx - a.cx, dy = b.cy - a.cy, d = hyp(dx, dy);
    if (d < EPS || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
    const l = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, a.r * a.r - l * l));
    const mx = a.cx + dx * l / d, my = a.cy + dy * l / d;
    if (h < 1e-12) return [[mx, my]];
    return [[mx - dy * h / d, my + dx * h / d], [mx + dy * h / d, my - dx * h / d]];
  }
  function interPrims(a, b) {
    if (a.t === 'seg' && b.t === 'seg') return segSeg(a, b);
    if (a.t === 'seg') return segArc(a, b);
    if (b.t === 'seg') return segArc(b, a);
    return circleCircle(a, b).filter((p) => onArc(Math.atan2(p[1] - a.cy, p[0] - a.cx), a) && onArc(Math.atan2(p[1] - b.cy, p[0] - b.cx), b));
  }
  function primHitsRect(p, r) {
    const inside = (x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
    const edges = [
      { t: 'seg', x1: r[0], y1: r[1], x2: r[2], y2: r[1] }, { t: 'seg', x1: r[2], y1: r[1], x2: r[2], y2: r[3] },
      { t: 'seg', x1: r[2], y1: r[3], x2: r[0], y2: r[3] }, { t: 'seg', x1: r[0], y1: r[3], x2: r[0], y2: r[1] },
    ];
    if (p.t === 'seg') { if (inside(p.x1, p.y1) || inside(p.x2, p.y2)) return true; }
    else {
      if (!p.full) { const e = arcEnds(p); if (inside(...e[0]) || inside(...e[1])) return true; }
      const m = primMid(p); if (inside(m[0], m[1])) return true;
    }
    return edges.some((ed) => interPrims(p, ed).length > 0);
  }

  // ---------- เมทริกซ์ affine [a,b,c,d,e,f]: x' = a x + c y + e, y' = b x + d y + f ----------
  const Mt = (dx, dy) => [1, 0, 0, 1, dx, dy];
  function Mr(cx, cy, t) { const c = Math.cos(t), s = Math.sin(t); return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]; }
  const Ms = (cx, cy, k) => [k, 0, 0, k, cx - k * cx, cy - k * cy];
  function Mm(p1, p2) {
    const f = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]), c = Math.cos(2 * f), s = Math.sin(2 * f);
    return [c, s, s, -c, p1[0] - (c * p1[0] + s * p1[1]), p1[1] - (s * p1[0] - c * p1[1])];
  }
  /** M1 ∘ M2 (ทำ M2 ก่อน แล้วจึง M1) */
  function Mmul(A, B) {
    return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
      A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
  }
  const ap = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const isIdentity = (M) => M[0] === 1 && M[1] === 0 && M[2] === 0 && M[3] === 1 && M[4] === 0 && M[5] === 0;

  function transformEntity(e, M) {
    const det = M[0] * M[3] - M[1] * M[2], k = Math.sqrt(Math.abs(det));
    const n = { ...e };
    switch (e.type) {
      case 'line': [n.x1, n.y1] = ap(M, e.x1, e.y1); [n.x2, n.y2] = ap(M, e.x2, e.y2); break;
      case 'poly': n.pts = e.pts.map((p) => { const q = ap(M, p[0], p[1]); return [q[0], q[1], det < 0 ? -(p[2] || 0) : (p[2] || 0)]; }); break;
      case 'circle': [n.cx, n.cy] = ap(M, e.cx, e.cy); n.r = e.r * k; break;
      case 'arc': {
        const [c, d] = [ap(M, e.cx, e.cy), arcEnds(e).map((q) => ap(M, q[0], q[1]))];
        [n.cx, n.cy] = c; n.r = e.r * k;
        let a1 = Math.atan2(d[0][1] - c[1], d[0][0] - c[0]), a2 = Math.atan2(d[1][1] - c[1], d[1][0] - c[0]);
        if (det < 0) [a1, a2] = [a2, a1];
        n.a1 = a1; n.a2 = a2;
        break;
      }
      case 'text': {
        [n.x, n.y] = ap(M, e.x, e.y);
        const r = e.rot || 0, vx = M[0] * Math.cos(r) + M[2] * Math.sin(r), vy = M[1] * Math.cos(r) + M[3] * Math.sin(r);
        n.rot = Math.atan2(vy, vx); n.h = e.h * k;
        if (det < 0) {
          // สะท้อนแล้วยังอ่านได้: กลับทิศตัวอักษร และสลับการจัดซ้าย/ขวา
          n.rot += Math.PI;
          if (n.rot > Math.PI) n.rot -= TAU;
          n.ha = e.ha === 'left' || !e.ha ? 'right' : e.ha === 'right' ? 'left' : e.ha;
        }
        break;
      }
      case 'dim':
        [n.x1, n.y1] = ap(M, e.x1, e.y1); [n.x2, n.y2] = ap(M, e.x2, e.y2); [n.ox, n.oy] = ap(M, e.ox, e.oy); n.h = e.h * k; break;
    }
    return n;
  }

  // ---------- ส่วนโค้ง 3 จุด ----------
  function circum(a, b, c) {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
    return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
      (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
  }
  function arcFrom3(a, b, c) {
    const o = circum(a, b, c);
    if (!o) return null;
    const r = hyp(a[0] - o[0], a[1] - o[1]);
    const t1 = Math.atan2(a[1] - o[1], a[0] - o[0]), t2 = Math.atan2(b[1] - o[1], b[0] - o[0]), t3 = Math.atan2(c[1] - o[1], c[0] - o[0]);
    const ccw = norm(t2 - t1) < norm(t3 - t1);
    return ccw ? { type: 'arc', cx: o[0], cy: o[1], r, a1: t1, a2: t3 } : { type: 'arc', cx: o[0], cy: o[1], r, a1: t3, a2: t1 };
  }

  // ---------- เส้นขนาน ----------
  function lineIntersectInf(p1, p2, p3, p4) {
    const rx = p2[0] - p1[0], ry = p2[1] - p1[1], sx = p4[0] - p3[0], sy = p4[1] - p3[1];
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((p3[0] - p1[0]) * sy - (p3[1] - p1[1]) * sx) / den;
    return [p1[0] + t * rx, p1[1] + t * ry];
  }
  function offsetEntity(e, d, side) {
    switch (e.type) {
      case 'line': {
        const dx = e.x2 - e.x1, dy = e.y2 - e.y1, L = hyp(dx, dy);
        if (L < EPS) return null;
        const nx = -dy / L, ny = dx / L;
        const sg = ((side[0] - e.x1) * nx + (side[1] - e.y1) * ny) >= 0 ? 1 : -1;
        return { ...e, id: undefined, x1: e.x1 + nx * d * sg, y1: e.y1 + ny * d * sg, x2: e.x2 + nx * d * sg, y2: e.y2 + ny * d * sg };
      }
      case 'circle': case 'arc': {
        const inside = hyp(side[0] - e.cx, side[1] - e.cy) < e.r;
        const r = inside ? e.r - d : e.r + d;
        if (r <= EPS) return null;
        return { ...e, id: undefined, r };
      }
      case 'poly': {
        if (e.pts.some((p) => Math.abs(p[2] || 0) > 1e-9)) return 'bulge';
        const pts = e.pts.filter((p, i, a) => i === 0 || hyp(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > EPS);
        const n = pts.length, m = e.closed ? n : n - 1;
        if (m < 1) return null;
        // ด้านที่เลือก: ใช้ส่วนของเส้นที่ใกล้จุดคลิกที่สุด
        let best = 0, bd = Infinity;
        for (let i = 0; i < m; i++) {
          const a = pts[i], b = pts[(i + 1) % n];
          const dd = distSeg(side[0], side[1], { x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
          if (dd < bd) { bd = dd; best = i; }
        }
        const A = pts[best], B = pts[(best + 1) % n];
        const sg = ((B[0] - A[0]) * (side[1] - A[1]) - (B[1] - A[1]) * (side[0] - A[0])) >= 0 ? 1 : -1;
        const segs = [];
        for (let i = 0; i < m; i++) {
          const a = pts[i], b = pts[(i + 1) % n];
          const L = hyp(b[0] - a[0], b[1] - a[1]);
          const nx = -(b[1] - a[1]) / L * d * sg, ny = (b[0] - a[0]) / L * d * sg;
          segs.push([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny]]);
        }
        const out = [];
        for (let i = 0; i < n; i++) {
          if (!e.closed && i === 0) { out.push([...segs[0][0], 0]); continue; }
          if (!e.closed && i === n - 1) { out.push([...segs[m - 1][1], 0]); continue; }
          const s1 = segs[(i - 1 + m) % m], s2 = segs[i % m];
          const q = lineIntersectInf(s1[0], s1[1], s2[0], s2[1]) || s2[0];
          out.push([q[0], q[1], 0]);
        }
        return { ...e, id: undefined, pts: out };
      }
    }
    return null;
  }

  // ---------- พื้นที่และความยาว ----------
  function polyMetrics(e) {
    let len = 0, area = 0;
    for (const p of prims(e)) len += p.t === 'seg' ? hyp(p.x2 - p.x1, p.y2 - p.y1) : p.r * sweepOf(p);
    if (e.closed) {
      const n = e.pts.length;
      for (let i = 0; i < n; i++) {
        const a = e.pts[i], b = e.pts[(i + 1) % n];
        area += a[0] * b[1] - b[0] * a[1];
      }
      area /= 2;
      for (let i = 0; i < n; i++) {
        const a = e.pts[i], b = e.pts[(i + 1) % n], bu = a[2] || 0;
        if (Math.abs(bu) < 1e-9) continue;
        const th = Math.abs(4 * Math.atan(bu)), c = hyp(b[0] - a[0], b[1] - a[1]), r = c / (2 * Math.sin(th / 2));
        area += Math.sign(bu) * (r * r / 2) * (th - Math.sin(th));
      }
    }
    return { len, area: Math.abs(area) };
  }

  Object.assign(G, {
    TAU, EPS, DEG, FONT, norm, sweepOf, onArc, fmt, niceRound, measure, textLayout, textCorners, textDist,
    bulgeArc, dimGeom, prims, primMid, primBox, entBox, entDist, primDist, arcEnds, distSeg, distArc, invalidate,
    interPrims, primHitsRect, Mt, Mr, Ms, Mm, Mmul, ap, isIdentity, transformEntity, arcFrom3, offsetEntity,
    lineIntersectInf, polyMetrics, prec: 2,
  });
})(window.DL = window.DL || {});
