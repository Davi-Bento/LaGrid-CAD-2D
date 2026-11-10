/* ═══════════════════════════════════════════════════════
   LAGRID CAD 2D — geometry.js
   Geometria pura: medidas, interseções, arcos, offset e mirror.
   Depende apenas de cam (viewport) e das constantes de config.js.
═══════════════════════════════════════════════════════ */
'use strict';

// ── TRANSFORMS (mundo ↔ tela) ───────────────────────────────
// ── TRANSFORMS ───────────────────────────────────────────
// Primeiro quadrante: origem no canto inferior esquerdo, X para a direita
// e Y para cima. O mundo usa a mesma convenção do papel (Y cresce para cima);
// a tela inverte o Y porque no canvas ele cresce para baixo.
function w2s(wx, wy) {
  return { x: wx * PX_PER_CM * cam.scale + cam.x,
           y: cam.y - wy * PX_PER_CM * cam.scale };
}
function s2w(sx, sy) {
  return { x: (sx - cam.x) / (PX_PER_CM * cam.scale),
           y: (cam.y - sy) / (PX_PER_CM * cam.scale) };
}
function cm2px(cm) { return cm * PX_PER_CM * cam.scale; }

// ── UTILITÁRIOS DE SEGMENTO E QUADRANTES ────────────────────
// ── SEGMENT UTILS ─────────────────────────────────────────
// Tipos: line {points:[a,b]} · arc {points:[a,m,b]} (arco circular por 3 pontos)
//         polyline {points:[...]} · circle {points:[centro], radius}
function segEndpoints(seg) {
  if (seg.type === 'line') return [seg.points[0], seg.points[1]];
  if (seg.type === 'arc')  return [seg.points[0], seg.points[2]];
  if (seg.type === 'polyline') {
    if (seg.points.length < 2) return [];
    return [seg.points[0], seg.points[seg.points.length-1]];
  }
  return [];
}

// Vértices que podem ser exibidos/editados
function segSnapPoints(seg) {
  if (seg.type === 'line') return seg.points.slice(0,2);
  if (seg.type === 'arc')  return seg.points.slice(0,3);
  if (seg.type === 'polyline') return seg.points;
  if (seg.type === 'circle') return seg.points.slice(0,1);
  return [];
}

// Lista {idx, pt} dos vértices editáveis
function segVertices(seg) {
  return segSnapPoints(seg).map((pt, idx) => ({ idx, pt }));
}

// ── QUADRANTES DO CÍRCULO (N/L/S/O) ──────────────────────
const CIRCLE_SIDES = {
  E: { dx:  1, dy:  0, label: 'Leste', letter: 'L' },
  N: { dx:  0, dy:  1, label: 'Norte', letter: 'N' },
  W: { dx: -1, dy:  0, label: 'Oeste', letter: 'O' },
  S: { dx:  0, dy: -1, label: 'Sul',   letter: 'S' },
};
const CIRCLE_SIDE_ORDER = ['E', 'N', 'W', 'S'];

function circleQuadrantPoints(seg) {
  if (!seg || seg.type !== 'circle' || !seg.points || !seg.points[0]) return [];
  const c = seg.points[0], r = seg.radius || 0;
  if (r <= 0) return [];
  return CIRCLE_SIDE_ORDER.map(side => ({
    side,
    x: c.x + CIRCLE_SIDES[side].dx * r,
    y: c.y + CIRCLE_SIDES[side].dy * r,
  }));
}

// ── MEDIDAS E PONTOS SOBRE SEGMENTOS ────────────────────────
// Recebe um delta no mundo (Y para cima).
function circleSideFromDelta(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'E' : 'W';
  return dy >= 0 ? 'N' : 'S';
}

function pointOnCircleSide(center, radius, side) {
  const s = CIRCLE_SIDES[side] || CIRCLE_SIDES.E;
  return { x: center.x + s.dx * radius, y: center.y + s.dy * radius };
}

function segLength(seg) {
  if (seg.type === 'line') {
    const p0 = seg.points[0], p1 = seg.points[1];
    return Math.hypot(p1.x - p0.x, p1.y - p0.y);
  }
  if (seg.type === 'arc') return arcLength(seg);
  if (seg.type === 'polyline') {
    let len = 0;
    for (let i = 1; i < seg.points.length; i++) {
      const a = seg.points[i-1], b = seg.points[i];
      len += Math.hypot(b.x-a.x, b.y-a.y);
    }
    return len;
  }
  if (seg.type === 'circle') return 2 * Math.PI * seg.radius;
  return 0;
}

// Arco circular real definido por 3 pontos (início, meio, fim)
function arcGeometry(seg) {
  if (!seg || seg.type !== 'arc' || !seg.points || seg.points.length < 3) return null;
  const [p0, pm, p1] = seg.points;
  const d = 2 * (p0.x*(pm.y-p1.y) + pm.x*(p1.y-p0.y) + p1.x*(p0.y-pm.y));
  if (Math.abs(d) < 1e-9) return null;
  const p0s = p0.x*p0.x + p0.y*p0.y;
  const pms = pm.x*pm.x + pm.y*pm.y;
  const p1s = p1.x*p1.x + p1.y*p1.y;
  const cx = (p0s*(pm.y-p1.y) + pms*(p1.y-p0.y) + p1s*(p0.y-pm.y)) / d;
  const cy = (p0s*(p1.x-pm.x) + pms*(p0.x-p1.x) + p1s*(pm.x-p0.x)) / d;
  const r  = Math.hypot(p0.x-cx, p0.y-cy);
  const a0 = Math.atan2(p0.y-cy, p0.x-cx);
  const am = Math.atan2(pm.y-cy, pm.x-cx);
  const a1 = Math.atan2(p1.y-cy, p1.x-cx);
  const TWO = Math.PI * 2;
  const dAM = ((am - a0) % TWO + TWO) % TWO;
  const dA1 = ((a1 - a0) % TWO + TWO) % TWO;
  let sweep;
  if (dAM <= dA1 + 1e-9) sweep = dA1;
  else                   sweep = dA1 - TWO;
  if (Math.abs(sweep) < 1e-9) sweep = TWO;
  return { cx, cy, r, a0, am, a1, sweep };
}

function arcPointAt(seg, t) {
  const g = arcGeometry(seg);
  if (!g) {
    const p0 = seg.points[0], p1 = seg.points[2];
    return { x: p0.x + (p1.x-p0.x)*t, y: p0.y + (p1.y-p0.y)*t };
  }
  const a = g.a0 + g.sweep * t;
  return { x: g.cx + g.r*Math.cos(a), y: g.cy + g.r*Math.sin(a) };
}

function arcLength(seg) {
  const g = arcGeometry(seg);
  if (g) return g.r * Math.abs(g.sweep);
  const [p0, , p1] = seg.points;
  return Math.hypot(p1.x-p0.x, p1.y-p0.y);
}

// Ponto mais próximo em um segmento, retorna {pt, t, dist}
function closestPointOnSeg(seg, wx, wy) {
  if (seg.type === 'line') {
    const p0 = seg.points[0], p1 = seg.points[1];
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len2 = dx*dx + dy*dy;
    if (len2 < 1e-10) return { pt: { ...p0 }, t: 0, dist: Math.hypot(wx-p0.x, wy-p0.y) };
    let t = ((wx-p0.x)*dx + (wy-p0.y)*dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const pt = { x: p0.x + t*dx, y: p0.y + t*dy };
    return { pt, t, dist: Math.hypot(wx-pt.x, wy-pt.y) };
  }
  if (seg.type === 'arc') {
    let best = { t: 0, dist: Infinity, pt: seg.points[0] };
    for (let i = 0; i <= 80; i++) {
      const t  = i / 80;
      const pt = arcPointAt(seg, t);
      const d  = Math.hypot(wx-pt.x, wy-pt.y);
      if (d < best.dist) best = { t, dist: d, pt };
    }
    return best;
  }
  if (seg.type === 'polyline') {
    let best = { t: 0, dist: Infinity, pt: seg.points[0] };
    let acc = 0;
    const total = segLength(seg);
    for (let i = 1; i < seg.points.length; i++) {
      const a = seg.points[i-1], b = seg.points[i];
      const dx = b.x-a.x, dy = b.y-a.y;
      const len2 = dx*dx + dy*dy;
      const len  = Math.sqrt(len2);
      let u = len2 > 1e-12 ? ((wx-a.x)*dx + (wy-a.y)*dy)/len2 : 0;
      u = Math.max(0, Math.min(1, u));
      const pt = { x: a.x+u*dx, y: a.y+u*dy };
      const d  = Math.hypot(wx-pt.x, wy-pt.y);
      if (d < best.dist) {
        best = { pt, dist: d, t: total > 1e-9 ? (acc + u*len)/total : 0 };
      }
      acc += len;
    }
    return best;
  }
  if (seg.type === 'circle') {
    const c = seg.points[0];
    const dx = wx-c.x, dy = wy-c.y;
    const d  = Math.hypot(dx,dy);
    if (d < 1e-9) return { pt: { x: c.x+seg.radius, y: c.y }, t: 0, dist: seg.radius };
    const pt = { x: c.x + dx/d*seg.radius, y: c.y + dy/d*seg.radius };
    const ang = ((Math.atan2(dy,dx) + Math.PI*2) % (Math.PI*2)) / (Math.PI*2);
    return { pt, t: ang, dist: Math.abs(d - seg.radius) };
  }
  return { pt: { x: wx, y: wy }, t: 0, dist: Infinity };
}

// Distância de ponto de tela a segmento (px)
function screenDistToSeg(seg, sx, sy) {
  const STEPS = 40;
  if (seg.type === 'line') {
    const sp0 = w2s(seg.points[0].x, seg.points[0].y);
    const sp1 = w2s(seg.points[1].x, seg.points[1].y);
    return distPtToSegPx(sx, sy, sp0.x, sp0.y, sp1.x, sp1.y);
  }
  if (seg.type === 'arc') {
    let best = Infinity;
    for (let i = 0; i <= STEPS; i++) {
      const wp = arcPointAt(seg, i/STEPS);
      const sp = w2s(wp.x, wp.y);
      best = Math.min(best, Math.hypot(sp.x-sx, sp.y-sy));
    }
    return best;
  }
  if (seg.type === 'polyline') {
    let best = Infinity;
    for (let i = 1; i < seg.points.length; i++) {
      const a = w2s(seg.points[i-1].x, seg.points[i-1].y);
      const b = w2s(seg.points[i].x,   seg.points[i].y);
      best = Math.min(best, distPtToSegPx(sx, sy, a.x, a.y, b.x, b.y));
    }
    return best;
  }
  if (seg.type === 'circle') {
    const c = w2s(seg.points[0].x, seg.points[0].y);
    const r = cm2px(seg.radius);
    return Math.abs(Math.hypot(sx-c.x, sy-c.y) - r);
  }
  return Infinity;
}

// ── GRAFO E DISTÂNCIA EM PIXELS ─────────────────────────────
// Arestas de um segmento para o grafo (permite polilinha)
function segEdgeList(seg) {
  if (seg.type === 'line') {
    return [{ a: seg.points[0], b: seg.points[1], w: segLength(seg) }];
  }
  if (seg.type === 'arc') {
    return [{ a: seg.points[0], b: seg.points[2], w: segLength(seg) }];
  }
  if (seg.type === 'polyline') {
    const out = [];
    for (let i = 1; i < seg.points.length; i++) {
      const a = seg.points[i-1], b = seg.points[i];
      out.push({ a, b, w: Math.hypot(b.x-a.x, b.y-a.y) });
    }
    return out;
  }
  return [];
}

function distPtToSegPx(px,py,ax,ay,bx,by) {
  const dx=bx-ax, dy=by-ay, len2=dx*dx+dy*dy;
  if (len2===0) return Math.hypot(px-ax,py-ay);
  let t=((px-ax)*dx+(py-ay)*dy)/len2;
  t=Math.max(0,Math.min(1,t));
  return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
}

// ── INTERSEÇÕES DE RETA ─────────────────────────────────────
function distPts(a, b) { return Math.hypot(a.x-b.x, a.y-b.y); }

function lineLineIntersection(a, b, c, d) {
  const r = { x: b.x-a.x, y: b.y-a.y };
  const s = { x: d.x-c.x, y: d.y-c.y };
  const den = r.x*s.y - r.y*s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x-a.x)*s.y - (c.y-a.y)*s.x) / den;
  const u = ((c.x-a.x)*r.y - (c.y-a.y)*r.x) / den;
  return { pt: { x: a.x + t*r.x, y: a.y + t*r.y }, t, u };
}

function raySegmentIntersection(origin, dir, a, b) {
  const s = { x: b.x-a.x, y: b.y-a.y };
  const den = dir.x*s.y - dir.y*s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.x-origin.x)*s.y - (a.y-origin.y)*s.x) / den;
  const u = ((a.x-origin.x)*dir.y - (a.y-origin.y)*dir.x) / den;
  if (t > 1e-6 && u > -1e-6 && u < 1 + 1e-6) {
    return { pt: { x: origin.x + t*dir.x, y: origin.y + t*dir.y }, t, u };
  }
  return null;
}

// ── GEOMETRIA AUXILIAR (peças e interseções) ────────────────
const TWO_PI = Math.PI * 2;

function normAngle(a) { return ((a % TWO_PI) + TWO_PI) % TWO_PI; }

function segPieces(seg) {
  if (seg.type === 'line') {
    return [{ kind:'line', a: seg.points[0], b: seg.points[1] }];
  }
  if (seg.type === 'polyline') {
    const out = [];
    for (let i = 1; i < seg.points.length; i++)
      out.push({ kind:'line', a: seg.points[i-1], b: seg.points[i] });
    return out;
  }
  if (seg.type === 'arc') {
    const g = arcGeometry(seg);
    if (!g) return [];
    return [{ kind:'circle', c:{ x:g.cx, y:g.cy }, r:g.r, a0:g.a0, sweep:g.sweep, full:false }];
  }
  if (seg.type === 'circle') {
    return [{ kind:'circle', c: seg.points[0], r: seg.radius, a0:0, sweep:TWO_PI, full:true }];
  }
  return [];
}

function circlePieceParam(piece, ang) {
  if (piece.full) return normAngle(ang) / TWO_PI;
  const absS = Math.abs(piece.sweep);
  const d = piece.sweep > 0 ? normAngle(ang - piece.a0) : normAngle(piece.a0 - ang);
  if (d > absS + 1e-6) return null;
  return d / absS;
}

function lineCircleHits(a, b, c, r) {
  const dx = b.x-a.x, dy = b.y-a.y;
  const fx = a.x-c.x, fy = a.y-c.y;
  const A = dx*dx + dy*dy;
  if (A < 1e-12) return [];
  const B = 2*(fx*dx + fy*dy);
  const C = fx*fx + fy*fy - r*r;
  const disc = B*B - 4*A*C;
  if (disc < -1e-9) return [];
  const sq = Math.sqrt(Math.max(0, disc));
  const ts = Math.abs(sq) < 1e-9 ? [-B/(2*A)] : [(-B-sq)/(2*A), (-B+sq)/(2*A)];
  return ts.map(t => ({ t, pt:{ x:a.x+t*dx, y:a.y+t*dy } }));
}

function circleCircleHits(c1, r1, c2, r2) {
  const dx = c2.x-c1.x, dy = c2.y-c1.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9 || d > r1+r2+1e-9 || d < Math.abs(r1-r2)-1e-9) return [];
  const a = (r1*r1 - r2*r2 + d*d) / (2*d);
  const h = Math.sqrt(Math.max(0, r1*r1 - a*a));
  const px = c1.x + a*dx/d, py = c1.y + a*dy/d;
  const rx = -dy*h/d, ry = dx*h/d;
  if (h < 1e-9) return [{ pt:{ x:px, y:py } }];
  return [{ pt:{ x:px+rx, y:py+ry } }, { pt:{ x:px-rx, y:py-ry } }];
}

function intersectPieces(A, B) {
  const out = [];
  if (A.kind === 'line' && B.kind === 'line') {
    const r = lineLineIntersection(A.a, A.b, B.a, B.b);
    if (r && r.t >= -1e-6 && r.t <= 1+1e-6 && r.u >= -1e-6 && r.u <= 1+1e-6)
      out.push({ pt:r.pt, tA:r.t, tB:r.u });
    return out;
  }
  if (A.kind === 'line' && B.kind === 'circle') {
    for (const it of lineCircleHits(A.a, A.b, B.c, B.r)) {
      if (it.t < -1e-6 || it.t > 1+1e-6) continue;
      const ang = Math.atan2(it.pt.y-B.c.y, it.pt.x-B.c.x);
      const tB = circlePieceParam(B, ang);
      if (tB !== null) out.push({ pt:it.pt, tA:it.t, tB });
    }
    return out;
  }
  if (A.kind === 'circle' && B.kind === 'line') {
    for (const it of intersectPieces(B, A))
      out.push({ pt:it.pt, tA:it.tB, tB:it.tA });
    return out;
  }
  if (A.kind === 'circle' && B.kind === 'circle') {
    for (const it of circleCircleHits(A.c, A.r, B.c, B.r)) {
      const angA = Math.atan2(it.pt.y-A.c.y, it.pt.x-A.c.x);
      const angB = Math.atan2(it.pt.y-B.c.y, it.pt.x-B.c.x);
      const tA = circlePieceParam(A, angA);
      const tB = circlePieceParam(B, angB);
      if (tA !== null && tB !== null) out.push({ pt:it.pt, tA, tB });
    }
    return out;
  }
  return out;
}

function targetPieces(seg) {
  if (seg.type === 'line') {
    return [{ piece:{ kind:'line', a:seg.points[0], b:seg.points[1] }, t0:0, t1:1 }];
  }
  if (seg.type === 'polyline') {
    const total = segLength(seg);
    const out = [];
    let acc = 0;
    for (let i = 1; i < seg.points.length; i++) {
      const a = seg.points[i-1], b = seg.points[i];
      const len = Math.hypot(b.x-a.x, b.y-a.y);
      const t0 = total > 1e-9 ? acc/total : 0;
      acc += len;
      const t1 = total > 1e-9 ? acc/total : 1;
      out.push({ piece:{ kind:'line', a, b }, t0, t1 });
    }
    return out;
  }
  if (seg.type === 'arc') {
    const g = arcGeometry(seg);
    if (!g) return [];
    return [{ piece:{ kind:'circle', c:{ x:g.cx, y:g.cy }, r:g.r, a0:g.a0, sweep:g.sweep, full:false }, t0:0, t1:1 }];
  }
  if (seg.type === 'circle') {
    return [{ piece:{ kind:'circle', c:seg.points[0], r:seg.radius, a0:0, sweep:TWO_PI, full:true }, t0:0, t1:1 }];
  }
  return [];
}

// ── PONTOS E SUBDIVISÃO DE SEGMENTO ─────────────────────────
function pointOnPolyline(seg, t) {
  const total = segLength(seg);
  if (total <= 1e-9) return { ...seg.points[0] };
  let target = Math.max(0, Math.min(1, t)) * total;
  let acc = 0;
  for (let i = 1; i < seg.points.length; i++) {
    const a = seg.points[i-1], b = seg.points[i];
    const len = Math.hypot(b.x-a.x, b.y-a.y);
    if (acc + len >= target || i === seg.points.length-1) {
      const u = len > 1e-12 ? (target-acc)/len : 0;
      return { x: a.x + (b.x-a.x)*u, y: a.y + (b.y-a.y)*u };
    }
    acc += len;
  }
  return { ...seg.points[seg.points.length-1] };
}

function subSegmentPoints(seg, t0, t1) {
  if (seg.type === 'line') {
    const p0 = seg.points[0], p1 = seg.points[1];
    return [
      { x: p0.x + (p1.x-p0.x)*t0, y: p0.y + (p1.y-p0.y)*t0 },
      { x: p0.x + (p1.x-p0.x)*t1, y: p0.y + (p1.y-p0.y)*t1 },
    ];
  }
  if (seg.type === 'arc') {
    return [
      arcPointAt(seg, t0),
      arcPointAt(seg, (t0+t1)/2),
      arcPointAt(seg, t1),
    ];
  }
  if (seg.type === 'polyline') {
    const total = segLength(seg);
    const pts = [pointOnPolyline(seg, t0)];
    let acc = 0;
    const aT = Math.min(t0,t1)*total, bT = Math.max(t0,t1)*total;
    for (let i = 1; i < seg.points.length-1; i++) {
      const a = seg.points[i-1], b = seg.points[i];
      acc += Math.hypot(b.x-a.x, b.y-a.y);
      if (acc > aT+1e-9 && acc < bT-1e-9) pts.push({ ...seg.points[i] });
    }
    pts.push(pointOnPolyline(seg, t1));
    return pts;
  }
  return [];
}

// ── ATRIBUIÇÃO DE PEÇA ──────────────────────────────────────
function assignPiece(seg, pts) {
  if (pts.length <= 1) return false;
  if (pts.length === 2) {
    seg.type = 'line';
    seg.points = pts.map(p => ({ ...p }));
    delete seg.radius;
    return true;
  }
  if (seg.type === 'arc' && pts.length === 3) {
    seg.points = pts.map(p => ({ ...p }));
    delete seg.radius;
    return true;
  }
  seg.type = 'polyline';
  seg.points = pts.map(p => ({ ...p }));
  delete seg.radius;
  return true;
}

// ── INTERSEÇÃO RAIO-CÍRCULO ─────────────────────────────────
function rayCircleHits(origin, dir, c, r) {
  const fx = origin.x-c.x, fy = origin.y-c.y;
  const B = 2*(fx*dir.x + fy*dir.y);
  const C = fx*fx + fy*fy - r*r;
  const disc = B*B - 4*C;
  if (disc < -1e-9) return [];
  const sq = Math.sqrt(Math.max(0, disc));
  const ts = Math.abs(sq) < 1e-9 ? [-B/2] : [(-B-sq)/2, (-B+sq)/2];
  return ts.map(t => ({ t, pt:{ x:origin.x+dir.x*t, y:origin.y+dir.y*t } }));
}

// ── OFFSET (lado da aresta) ─────────────────────────────────
function sideOfEdge(a, b, px, py) {
  const cross = (b.x-a.x)*(py-a.y) - (b.y-a.y)*(px-a.x);
  if (Math.abs(cross) < 1e-12) return 1;
  return cross > 0 ? 1 : -1;
}

// ── MIRROR (reflexão) ───────────────────────────────────────
function reflectPoint(p, a, b) {
  const dx = b.x-a.x, dy = b.y-a.y, len2 = dx*dx+dy*dy;
  if (len2 < 1e-12) return { ...p };
  const t = ((p.x-a.x)*dx + (p.y-a.y)*dy) / len2;
  const proj = { x: a.x + t*dx, y: a.y + t*dy };
  return { x: 2*proj.x - p.x, y: 2*proj.y - p.y };
}

function polylineEdgeAt(seg, wx, wy) {
  let best = null, bestD = Infinity;
  for (let i = 1; i < seg.points.length; i++) {
    const a = seg.points[i-1], b = seg.points[i];
    const dx = b.x-a.x, dy = b.y-a.y, len2 = dx*dx+dy*dy;
    let u = len2 > 1e-12 ? ((wx-a.x)*dx + (wy-a.y)*dy)/len2 : 0;
    u = Math.max(0, Math.min(1, u));
    const pt = { x: a.x+u*dx, y: a.y+u*dy };
    const d = Math.hypot(wx-pt.x, wy-pt.y);
    if (d < bestD) { bestD = d; best = { a, b, pt, d }; }
  }
  return best;
}

function mirrorAxisFromSegment(seg, wx, wy) {
  if (!seg) return null;
  if (seg.type === 'line') return [seg.points[0], seg.points[1]];
  if (seg.type === 'polyline') {
    const e = polylineEdgeAt(seg, wx, wy);
    return e ? [e.a, e.b] : null;
  }
  return null;
}
