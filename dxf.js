/* Draftloom — อ่านและเขียนไฟล์ DXF (ASCII)
 * เขียนจากโครงสร้าง DXF ที่เผยแพร่สาธารณะ: ไฟล์เป็นคู่บรรทัด "รหัสกลุ่ม / ค่า"
 * ตัวอ่าน: รองรับ UTF-8 และ codepage เก่า, แตกบล็อก (INSERT/DIMENSION) เป็นวัตถุเดี่ยว
 * ตัวเขียน: รุ่น R12 (AC1009) ข้อความที่ไม่ใช่ ASCII เขียนเป็น \U+XXXX
 */
(function (G) {
  'use strict';
  const { TAU, DEG } = G;

  // ---------- ถอดรหัสไบต์ ----------
  const CODEPAGES = { ANSI_874: 'windows-874', ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252',
    ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256',
    ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5' };
  function decodeBytes(buf) {
    const bytes = new Uint8Array(buf);
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 22));
    if (head.startsWith('AutoCAD Binary DXF')) throw new Error('binary');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { /* ไม่ใช่ UTF-8 */ }
    const sniff = new TextDecoder('latin1').decode(bytes.subarray(0, 20000));
    const m = sniff.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/i);
    const enc = (m && CODEPAGES[m[1].toUpperCase()]) || 'windows-1252';
    try { return new TextDecoder(enc).decode(bytes); } catch (_) { return new TextDecoder('windows-1252').decode(bytes); }
  }

  const decodeStr = (s) => s
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoOkK]/g, '').replace(/%%%/g, '%');
  const cleanMtext = (s) => decodeStr(s)
    .replace(/\\P/g, '\n').replace(/\\[ACcFfHhQqTtWwp][^;\\]*;/g, '').replace(/\\[LlOoKkNX]/g, '')
    .replace(/\\S([^;]*);/g, (_, a) => a.replace(/[\^#]/, '/')).replace(/\\~/g, ' ').replace(/[{}]/g, '').replace(/\\\\/g, '\\');

  // ---------- อ่าน ----------
  function parse(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const t = lines[i].trim();
      if (t === '' && i === lines.length - 2) break;
      const c = parseInt(t, 10);
      if (Number.isNaN(c)) throw new Error('รูปแบบผิดที่บรรทัด ' + (i + 1));
      pairs.push([c, lines[i + 1]]);
    }
    let i = 0;
    const layers = new Map(), blocks = new Map();
    let ents = [];
    const isZero = (k, v) => pairs[k] && pairs[k][0] === 0 && pairs[k][1].trim() === v;

    // อ่านวัตถุตั้งแต่ตำแหน่ง k จนเจอเครื่องหมายจบ
    function readEntities(k, ends) {
      const list = [];
      let poly = null;
      while (k < pairs.length) {
        const [c, v0] = pairs[k];
        const v = v0.trim();
        if (c === 0 && ends.includes(v)) break;
        if (c !== 0) { k++; continue; }
        const raw = { type: v, codes: [] };
        k++;
        while (k < pairs.length && pairs[k][0] !== 0) { raw.codes.push(pairs[k]); k++; }
        if (v === 'VERTEX' && poly) { poly.verts.push(raw); continue; }
        if (v === 'SEQEND') { poly = null; continue; }
        if (v === 'POLYLINE') { raw.verts = []; poly = raw; }
        list.push(raw);
      }
      return { list, k };
    }
    function skipTo(k, v) { while (k < pairs.length && !isZero(k, v)) k++; return k + 1; }

    while (i < pairs.length) {
      if (isZero(i, 'SECTION')) {
        const name = (pairs[i + 1] || [0, ''])[1].trim();
        i += 2;
        if (name === 'TABLES') {
          while (i < pairs.length && !isZero(i, 'ENDSEC')) {
            if (isZero(i, 'LAYER')) {
              i++;
              const L = {};
              while (i < pairs.length && pairs[i][0] !== 0) { const [c, v] = pairs[i]; if (c === 2) L.name = decodeStr(v.trim()); if (c === 62) L.color = parseInt(v, 10); if (c === 70) L.flags = parseInt(v, 10); i++; }
              if (L.name) {
                const col = L.color ?? 7;
                layers.set(L.name, { name: L.name, color: Math.abs(col) || 7, visible: col >= 0 && !(L.flags & 1), locked: !!(L.flags & 4) });
              }
            } else i++;
          }
          i++;
        } else if (name === 'BLOCKS') {
          while (i < pairs.length && !isZero(i, 'ENDSEC')) {
            if (isZero(i, 'BLOCK')) {
              i++;
              const B = { name: '', bx: 0, by: 0 };
              while (i < pairs.length && pairs[i][0] !== 0) { const [c, v] = pairs[i]; if (c === 2) B.name = v.trim(); if (c === 10) B.bx = +v; if (c === 20) B.by = +v; i++; }
              const r = readEntities(i, ['ENDBLK', 'ENDSEC']);
              B.ents = r.list; i = r.k;
              blocks.set(B.name, B);
              if (isZero(i, 'ENDBLK')) { i++; while (i < pairs.length && pairs[i][0] !== 0) i++; }
            } else i++;
          }
          i++;
        } else if (name === 'ENTITIES') {
          const r = readEntities(i, ['ENDSEC']);
          ents = r.list; i = r.k + 1;
        } else i = skipTo(i, 'ENDSEC');
      } else i++;
    }

    const out = [], skipped = {};
    const skip = (t) => { skipped[t] = (skipped[t] || 0) + 1; };
    const ID = [1, 0, 0, 1, 0, 0];

    function conv(raw, M, inh, depth) {
      const C = raw.codes;
      const g = (c) => { for (const p of C) if (p[0] === c) return p[1]; return undefined; };
      const n = (c, d = 0) => { const v = g(c); return v === undefined ? d : parseFloat(v); };
      const all = (c) => C.filter((p) => p[0] === c).map((p) => parseFloat(p[1]));
      if (n(67) === 1) return; // พื้นที่กระดาษ
      let layer = decodeStr((g(8) ?? '0').trim());
      if (inh && layer === '0') layer = inh.layer;
      let color = g(62) === undefined ? 256 : parseInt(g(62), 10);
      if (color === 0) color = inh ? inh.color : null;
      else if (color === 256 || color < 0 || color > 255) color = null;
      const flip = n(230, 1) < 0; // ระบบพิกัดวัตถุกลับด้าน (มักเกิดจากการสะท้อน)
      const push = (e) => {
        e.layer = layer; e.color = color;
        out.push(G.isIdentity(M) ? e : G.transformEntity(e, M));
      };
      const fx = (x) => (flip ? -x : x);
      switch (raw.type) {
        case 'LINE': push({ type: 'line', x1: n(10), y1: n(20), x2: n(11), y2: n(21) }); break;
        case 'CIRCLE': push({ type: 'circle', cx: fx(n(10)), cy: n(20), r: n(40) }); break;
        case 'ARC': {
          let a1 = n(50) * DEG, a2 = n(51) * DEG;
          if (flip) [a1, a2] = [Math.PI - a2, Math.PI - a1];
          push({ type: 'arc', cx: fx(n(10)), cy: n(20), r: n(40), a1, a2 });
          break;
        }
        case 'LWPOLYLINE': {
          const pts = [];
          for (const [c, v] of C) {
            if (c === 10) pts.push([fx(parseFloat(v)), 0, 0]);
            else if (c === 20 && pts.length) pts[pts.length - 1][1] = parseFloat(v);
            else if (c === 42 && pts.length) pts[pts.length - 1][2] = flip ? -parseFloat(v) : parseFloat(v);
          }
          if (pts.length >= 2) push({ type: 'poly', pts, closed: !!(n(70) & 1) });
          break;
        }
        case 'POLYLINE': {
          const fl = n(70);
          if (fl & (16 | 64)) { skip('POLYLINE (ตาข่าย 3 มิติ)'); break; }
          const pts = raw.verts.filter((v) => !(parseInt((v.codes.find((p) => p[0] === 70) || [0, '0'])[1], 10) & 16)).map((v) => {
            const q = (c) => { const p = v.codes.find((x) => x[0] === c); return p ? parseFloat(p[1]) : 0; };
            return [fx(q(10)), q(20), flip ? -q(42) : q(42)];
          });
          if (pts.length >= 2) push({ type: 'poly', pts, closed: !!(fl & 1) });
          break;
        }
        case 'TEXT': case 'ATTRIB': {
          if (raw.type === 'ATTRIB' && (n(70) & 1)) break; // ซ่อน
          const h72 = n(72), v73 = n(raw.type === 'ATTRIB' ? 74 : 73);
          const aligned = (h72 || v73) && g(11) !== undefined;
          const ha = [null, 'center', 'right', null, 'center', null][h72] || 'left';
          const va = h72 === 4 ? 'middle' : (['baseline', 'bottom', 'middle', 'top'][v73] || 'baseline');
          const txt = decodeStr(g(1) ?? '');
          if (!txt) break;
          push({ type: 'text', x: aligned ? n(11) : n(10), y: aligned ? n(21) : n(20), h: n(40, 1) || 1, rot: n(50) * DEG, text: txt, ha: aligned ? ha : 'left', va: aligned ? va : 'baseline' });
          break;
        }
        case 'MTEXT': {
          const txt = cleanMtext(C.filter((p) => p[0] === 3).map((p) => p[1]).join('') + (g(1) ?? ''));
          if (!txt.trim()) break;
          const ap = n(71, 1) || 1;
          let rot = n(50) * DEG;
          if (g(11) !== undefined && g(50) === undefined) rot = Math.atan2(n(21), n(11));
          push({ type: 'text', x: n(10), y: n(20), h: n(40, 1) || 1, rot, text: txt,
            ha: ['left', 'center', 'right'][(ap - 1) % 3], va: ['top', 'middle', 'bottom'][Math.floor((ap - 1) / 3)] });
          break;
        }
        case 'ELLIPSE': {
          const cx = n(10), cy = n(20), mx = n(11), my = n(21), ratio = n(40, 1);
          let s = n(41, 0), e = n(42, TAU);
          if (e <= s) e += TAU;
          const full = Math.abs(e - s - TAU) < 1e-6;
          const steps = Math.max(16, Math.ceil((e - s) / TAU * 72));
          const pts = [];
          for (let k = 0; k <= (full ? steps - 1 : steps); k++) {
            const t = s + (e - s) * k / steps;
            const px = Math.cos(t), py = Math.sin(t) * ratio;
            pts.push([fx(cx + mx * px - my * py), cy + my * px + mx * py, 0]);
          }
          push({ type: 'poly', pts, closed: full });
          break;
        }
        case 'SPLINE': {
          const deg = n(71, 3), knots = all(40), weights = all(41);
          const ctrl = [], fit = [];
          for (let k = 0; k < C.length; k++) {
            const [c, v] = C[k];
            if (c === 10) ctrl.push([parseFloat(v), 0]); else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = parseFloat(v);
            if (c === 11) fit.push([parseFloat(v), 0]); else if (c === 21 && fit.length) fit[fit.length - 1][1] = parseFloat(v);
          }
          let pts = ctrl.length >= 2 ? splinePoints(deg, knots, ctrl, weights.length === ctrl.length ? weights : null, Math.max(24, ctrl.length * 8)) : fit;
          if (pts.length >= 2) push({ type: 'poly', pts: pts.map((p) => [p[0], p[1], 0]), closed: false });
          break;
        }
        case 'SOLID': case 'TRACE': case '3DFACE': {
          const q = [[n(10), n(20)], [n(11), n(21)], [n(12), n(22)], [n(13, n(12)), n(23, n(22))]];
          const order = raw.type === '3DFACE' ? [0, 1, 2, 3] : [0, 1, 3, 2];
          push({ type: 'poly', pts: order.map((k) => [q[k][0], q[k][1], 0]), closed: true });
          break;
        }
        case 'LEADER': {
          const xs = all(10), ys = all(20);
          if (xs.length >= 2) push({ type: 'poly', pts: xs.map((x, k) => [x, ys[k] || 0, 0]), closed: false });
          break;
        }
        case 'INSERT': case 'DIMENSION': {
          const B = blocks.get((g(2) || '').trim());
          if (!B) { if (raw.type === 'INSERT') skip('INSERT (ไม่พบบล็อก)'); else skip('DIMENSION'); break; }
          if (depth > 8) { skip('บล็อกซ้อนลึกเกินไป'); break; }
          const sub = { layer, color };
          if (raw.type === 'DIMENSION') { for (const r of B.ents) conv(r, M, sub, depth + 1); break; }
          const sx = n(41, 1) || 1, sy = n(42, 1) || 1, rot = n(50) * DEG;
          const cols = Math.max(1, n(70, 1)), rows = Math.max(1, n(71, 1)), cs = n(44), rs = n(45);
          for (let rr = 0; rr < rows; rr++) for (let cc = 0; cc < cols; cc++) {
            let L = [sx, 0, 0, sy, 0, 0];
            L = G.Mmul(L, [1, 0, 0, 1, -B.bx, -B.by]);
            L = G.Mmul([1, 0, 0, 1, cc * cs, rr * rs], L);
            L = G.Mmul(G.Mr(0, 0, rot), L);
            L = G.Mmul([1, 0, 0, 1, n(10), n(20)], L);
            if (flip) L = G.Mmul([-1, 0, 0, 1, 0, 0], L); // บล็อกที่ถูกสะท้อน (แกน Z กลับด้าน)
            for (const r of B.ents) conv(r, G.Mmul(M, L), sub, depth + 1);
          }
          break;
        }
        case 'ATTDEF': case 'POINT': case 'VIEWPORT': case 'SEQEND': break;
        default: skip(raw.type);
      }
    }
    for (const r of ents) conv(r, ID, null, 0);

    const layerList = [...layers.values()];
    if (!layerList.some((l) => l.name === '0')) layerList.unshift({ name: '0', color: 7, visible: true, locked: false });
    for (const e of out) if (!layerList.some((l) => l.name === e.layer)) layerList.push({ name: e.layer, color: 7, visible: true, locked: false });
    return { layers: layerList, entities: out, skipped };
  }

  /** จุดบนเส้นโค้ง B-spline (de Boor) */
  function splinePoints(deg, knots, ctrl, weights, count) {
    const m = ctrl.length, k = Math.min(deg, m - 1);
    if (knots.length !== m + k + 1) return ctrl;
    const lo = knots[k], hi = knots[m];
    const out = [];
    for (let i = 0; i <= count; i++) {
      let u = lo + (hi - lo) * i / count;
      if (i === count) u = hi - (hi - lo) * 1e-9;
      let s = k;
      while (s < m - 1 && u >= knots[s + 1]) s++;
      const d = [];
      for (let j = 0; j <= k; j++) { const P = ctrl[s - k + j], w = weights ? weights[s - k + j] : 1; d.push([P[0] * w, P[1] * w, w]); }
      for (let r = 1; r <= k; r++) {
        for (let j = k; j >= r; j--) {
          const idx = s - k + j, den = knots[idx + k - r + 1] - knots[idx], a = den ? (u - knots[idx]) / den : 0;
          d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
        }
      }
      out.push([d[k][0] / d[k][2], d[k][1] / d[k][2]]);
    }
    return out;
  }

  // ---------- เขียน ----------
  const num = (v) => { const r = Math.abs(v) < 1e-10 ? 0 : +v.toFixed(8); return String(r); };
  const esc = (s) => {
    let o = '';
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c < 128) o += ch;
      else if (c <= 0xffff) o += '\\U+' + c.toString(16).toUpperCase().padStart(4, '0');
      else o += '?';
    }
    return o;
  };
  function write(doc) {
    const o = [];
    const P = (c, v) => { o.push(String(c), String(v)); };
    P(0, 'SECTION'); P(2, 'HEADER'); P(9, '$ACADVER'); P(1, 'AC1009'); P(0, 'ENDSEC');
    P(0, 'SECTION'); P(2, 'TABLES');
    P(0, 'TABLE'); P(2, 'LTYPE'); P(70, 1);
    P(0, 'LTYPE'); P(2, 'CONTINUOUS'); P(70, 0); P(3, 'Solid line'); P(72, 65); P(73, 0); P(40, '0.0');
    P(0, 'ENDTAB');
    P(0, 'TABLE'); P(2, 'LAYER'); P(70, doc.layers.length);
    for (const l of doc.layers) { P(0, 'LAYER'); P(2, esc(l.name)); P(70, l.locked ? 4 : 0); P(62, l.visible ? l.color : -l.color); P(6, 'CONTINUOUS'); }
    P(0, 'ENDTAB');
    P(0, 'ENDSEC');
    P(0, 'SECTION'); P(2, 'ENTITIES');
    const head = (type, e) => { P(0, type); P(8, esc(e.layer)); if (e.color != null) P(62, e.color); };
    const line = (e, x1, y1, x2, y2) => { head('LINE', e); P(10, num(x1)); P(20, num(y1)); P(30, 0); P(11, num(x2)); P(21, num(y2)); P(31, 0); };
    const text = (e, t) => {
      const lines = String(t.text).split('\n');
      const c = Math.cos(t.rot || 0), s = Math.sin(t.rot || 0);
      const hc = { left: 0, center: 1, right: 2 }[t.ha || 'left'];
      const vc = { baseline: 0, bottom: 1, middle: 2, top: 3 }[t.va || 'baseline'];
      lines.forEach((ln, i) => {
        if (!ln) return;
        const off = -i * 1.5 * t.h, x = t.x - off * s, y = t.y + off * c;
        head('TEXT', e); P(10, num(x)); P(20, num(y)); P(30, 0); P(40, num(t.h)); P(1, esc(ln));
        if (t.rot) P(50, num(t.rot / DEG));
        if (hc || vc) { P(72, hc); P(11, num(x)); P(21, num(y)); P(31, 0); P(73, vc); }
      });
    };
    for (const e of doc.entities) {
      switch (e.type) {
        case 'line': line(e, e.x1, e.y1, e.x2, e.y2); break;
        case 'circle': head('CIRCLE', e); P(10, num(e.cx)); P(20, num(e.cy)); P(30, 0); P(40, num(e.r)); break;
        case 'arc': head('ARC', e); P(10, num(e.cx)); P(20, num(e.cy)); P(30, 0); P(40, num(e.r)); P(50, num(G.norm(e.a1) / DEG)); P(51, num(G.norm(e.a2) / DEG)); break;
        case 'poly':
          head('POLYLINE', e); P(66, 1); P(10, 0); P(20, 0); P(30, 0); P(70, e.closed ? 1 : 0);
          for (const p of e.pts) { P(0, 'VERTEX'); P(8, esc(e.layer)); P(10, num(p[0])); P(20, num(p[1])); P(30, 0); if (p[2]) P(42, num(p[2])); }
          P(0, 'SEQEND'); P(8, esc(e.layer));
          break;
        case 'text': text(e, e); break;
        case 'dim': {
          // R12 ต้องใช้บล็อกสำหรับเส้นบอกขนาด จึงส่งออกเป็นเส้น + หัวลูกศร + ข้อความ
          const d = G.dimGeom(e);
          for (const s of d.segs) line(e, s.x1, s.y1, s.x2, s.y2);
          for (const a of d.arrows) { head('SOLID', e); P(10, num(a[0][0])); P(20, num(a[0][1])); P(30, 0); P(11, num(a[1][0])); P(21, num(a[1][1])); P(31, 0); P(12, num(a[2][0])); P(22, num(a[2][1])); P(32, 0); P(13, num(a[2][0])); P(23, num(a[2][1])); P(33, 0); }
          text(e, d.text);
          break;
        }
      }
    }
    P(0, 'ENDSEC'); P(0, 'EOF');
    return o.join('\r\n') + '\r\n';
  }

  G.dxf = { decodeBytes, parse, write, decodeStr, cleanMtext };
})(window.DL);
