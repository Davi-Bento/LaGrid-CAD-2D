/* ═══════════════════════════════════════════════════════
   LINETRACK CAD — app.js v2
   Unidade base: CM. 1 cm = PX_PER_CM px na escala 1:1
═══════════════════════════════════════════════════════ */
'use strict';

// ── CONSTANTES ────────────────────────────────────────────
const PX_PER_CM     = 37.795;   // 96dpi → 1cm = 37.795px
const SNAP_MAG_PX   = 14;       // raio magnético em pixels de tela
const CRIT_ANGLE    = 90;       // alerta raio crítico (graus)
const MIN_COTA_CM   = 1.5;      // mínimo para desenhar cota automática
const DEFAULT_LINE_W = 1.9;     // cm — largura padrão de faixa
const ANGLE_STEP_DEFAULT = 15;  // graus — snap angular configurável
const DIST_STEP_DEFAULT  = 1;   // cm — snap de distância configurável
const DEFAULT_WORKSPACE_W = 285; // cm
const DEFAULT_WORKSPACE_H = 180; // cm
const DEFAULT_DEADZONE = 30;     // cm — margem de alerta até a borda
const GRAPH_NODE_MERGE_EPS = 0.5; // cm — tolerância para agrupar endpoints em nós do grafo

// ── ESTADO ────────────────────────────────────────────────
const state = {
  segments:      [],   // {id, type, points[], selected}
  nodes:         { start: null, end: null }, // {x,y,segId,t} — ligados a segmento
  dijkstraPath:  [],   // ids de segmentos no caminho
  undoStack:     [],
  redoStack:     [],
  nextId:        1,
  workspace:     { w: DEFAULT_WORKSPACE_W, h: DEFAULT_WORKSPACE_H }, // cm
  deadzone:      DEFAULT_DEADZONE,    // cm — margem de alerta até a borda
  lineWidth:     DEFAULT_LINE_W,      // cm
  showGrid:      true,
  snapEnabled:   true,
  showCritical:  true,
  angleSnap:     false,               // snap angular ligado/desligado
  angleStep:     ANGLE_STEP_DEFAULT,  // passo do snap angular (graus)
  distSnap:      false,               // snap de distância ligado/desligado
  distStep:      DIST_STEP_DEFAULT,   // passo do snap de distância (cm)
  dijkstraMode:  'shortest_path',    // 'shortest_path' | 'perimeter_loop'
  orthoLock:     false,              // ortho lock estilo AutoCAD (F8)
  showVertexCoords: true,            // mostrar coordenadas dos vértices no editor
  showCircleQuads:  true,            // mostrar pontos N/L/S/O dos círculos
};

const cam = { x: 0, y: 0, scale: 1 };

const ui = {
  tool:         'select',
  lineStart:    null,
  arcPoints:    [],
  polyPoints:   [],   // pontos da polilinha em construção
  rectStart:    null, // 1º canto do retângulo
  circleCenter: null, // centro do círculo em construção
  mouseWorld:   { x: 0, y: 0 },
  mouseScreen:  { x: 0, y: 0 },
  selection:    new Set(),
  boxSelStart:  null,
  isPanning:    false,
  panStart:     { x: 0, y: 0 },
  camStart:     { x: 0, y: 0 },
  snapTarget:   null,   // ponto magnético atual {x,y}
  shiftKey:     false,  // ortho (Shift) durante o desenho
  dragVertex:   null,   // {segId, idx} — vértice sendo arrastado
  mirrorPts:    [],     // eixo do espelho em construção
  offsetTargetId: null, // objeto escolhido para offset
  coordMode:    'abs',  // 'abs' | 'rel'
  circleMode:   'center', // 'center' | 'side' (Tab alterna)
  circleSide:   'E',      // lado do centro em relação ao início: E/N/W/S
  spiralCenter: null,     // centro da espiral em construção
  polarInputMode: 'polar', // 'polar' | 'absolute' — modo de entrada do HUD polar
  prevMouseScreen:  null,
  dragMove:     null,   // arrasto de objetos selecionados { ids, originals, nodeOriginals, start, moved }
  pasteMode:    null,   // colocação de colagem estilo AutoCAD { segs, anchor, offset }
  clipboard:    null,   // { segs, anchor } — cópia em memória
};

// ── CANVAS ───────────────────────────────────────────────
const canvas = document.getElementById('main-canvas');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width  = r.width;
  canvas.height = r.height;
  render();
}
window.addEventListener('resize', resizeCanvas);

// ── TRANSFORMS ───────────────────────────────────────────
function w2s(wx, wy) {
  return { x: wx * PX_PER_CM * cam.scale + cam.x,
           y: wy * PX_PER_CM * cam.scale + cam.y };
}
function s2w(sx, sy) {
  return { x: (sx - cam.x) / (PX_PER_CM * cam.scale),
           y: (sy - cam.y) / (PX_PER_CM * cam.scale) };
}
function cm2px(cm) { return cm * PX_PER_CM * cam.scale; }

// ── PONTOS MAGNÉTICOS ─────────────────────────────────────
// Coleta todos os pontos magnéticos (endpoints e vértices internos)
function getAllEndpoints() {
  const pts = [];
  for (const seg of state.segments) {
    const verts = segSnapPoints(seg);
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      pts.push({ x: v.x, y: v.y, segId: seg.id, idx: i });
    }
    // Centro do círculo/arco-aparado (referência para coordenadas/snap)
    if (seg.type === 'circle' || seg.originalCircle) {
      const center = seg.type === 'circle' ? seg.points[0] : seg.originalCircle.c;
      pts.push({ x: center.x, y: center.y, segId: seg.id, idx: -1, isCenter: true });
    }
    // Pontos N/L/S/O dos círculos (ímãs para iniciar linhas, arcos, cortes etc.)
    if (seg.type === 'circle' && state.showCircleQuads) {
      circleQuadrantPoints(seg).forEach((q, i) => {
        pts.push({ x: q.x, y: q.y, segId: seg.id, idx: 100 + i, quad: q.side });
      });
    }
  }
  return pts;
}

// Retorna ponto magnético mais próximo (em px de tela) ou null
function getMagneticSnap(sx, sy, exclude, excludeIds) {
  if (!state.snapEnabled) return null;
  const pts = getAllEndpoints();
  let best = null, bestD = Infinity;
  for (const pt of pts) {
    if (exclude && pt.segId === exclude.segId && pt.idx === exclude.idx) continue;
    if (excludeIds && excludeIds.has(pt.segId)) continue;
    const sp = w2s(pt.x, pt.y);
    const d  = Math.hypot(sp.x - sx, sp.y - sy);
    if (d < SNAP_MAG_PX && d < bestD) {
      bestD = d;
      best  = { x: pt.x, y: pt.y };
    }
  }
  return best;
}

// Ponto final para uso: magnético se disponível, senão world puro
function resolvePoint(sx, sy) {
  const mag = getMagneticSnap(sx, sy);
  if (mag) return mag;
  return s2w(sx, sy);
}

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
  N: { dx:  0, dy: -1, label: 'Norte', letter: 'N' },
  W: { dx: -1, dy:  0, label: 'Oeste', letter: 'O' },
  S: { dx:  0, dy:  1, label: 'Sul',   letter: 'S' },
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

function circleQuadrantAtScreen(sx, sy, maxPx = 12) {
  if (!state.showCircleQuads) return null;
  let best = null, bestD = maxPx;
  for (const seg of state.segments) {
    if (seg.type !== 'circle') continue;
    for (const q of circleQuadrantPoints(seg)) {
      const sp = w2s(q.x, q.y);
      const d  = Math.hypot(sp.x - sx, sp.y - sy);
      if (d < bestD) { bestD = d; best = { ...q, seg }; }
    }
  }
  return best;
}

function circleSideFromDelta(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'E' : 'W';
  return dy >= 0 ? 'S' : 'N';
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

// Aplica ortho (Shift) ou snap angular ao ponto em relação a uma origem
function pointFromConstraint(origin, pt) {
  if (!origin) return pt;
  const dx = pt.x - origin.x, dy = pt.y - origin.y;
  let dist = Math.hypot(dx, dy);
  if (dist < 1e-9) return pt;
  let ang = Math.atan2(dy, dx);
  let constrained = false;
  if (ui.shiftKey) {
    const q = Math.PI / 2;
    ang = Math.round(ang / q) * q;
    constrained = true;
  } else if (state.angleSnap) {
    const stepRad = (state.angleStep || ANGLE_STEP_DEFAULT) * Math.PI / 180;
    ang = Math.round(ang / stepRad) * stepRad;
    constrained = true;
  }
  // Snap de distância: arredonda o comprimento para múltiplos do passo (cm)
  if (state.distSnap) {
    const ds = state.distStep || DIST_STEP_DEFAULT;
    dist = Math.round(dist / ds) * ds;
    constrained = true;
  }
  if (!constrained) return pt;
  return { x: origin.x + dist*Math.cos(ang), y: origin.y + dist*Math.sin(ang) };
}

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

// ── DEADZONE (margem de alerta até a borda) ────────────────
function effectiveDeadzone() {
  const half = Math.min(state.workspace.w, state.workspace.h) / 2;
  return Math.max(0, Math.min(state.deadzone || 0, half));
}

function deadzoneRect() {
  const dz = effectiveDeadzone();
  return {
    x0: dz,
    y0: dz,
    x1: state.workspace.w - dz,
    y1: state.workspace.h - dz,
    dz,
  };
}

function pointOutsideRect(pt, r) {
  const EPS = 1e-6;
  return pt.x < r.x0 - EPS || pt.x > r.x1 + EPS ||
         pt.y < r.y0 - EPS || pt.y > r.y1 + EPS;
}

function segInDeadzone(seg, r) {
  if (seg.type === 'line') {
    return pointOutsideRect(seg.points[0], r) || pointOutsideRect(seg.points[1], r);
  }
  if (seg.type === 'polyline') {
    return seg.points.some(p => pointOutsideRect(p, r));
  }
  if (seg.type === 'circle') {
    const c = seg.points[0];
    return c.x - seg.radius < r.x0 - 1e-6 ||
           c.x + seg.radius > r.x1 + 1e-6 ||
           c.y - seg.radius < r.y0 - 1e-6 ||
           c.y + seg.radius > r.y1 + 1e-6;
  }
  if (seg.type === 'arc') {
    const g = arcGeometry(seg);
    const N = g ? Math.max(32, Math.min(160, Math.ceil(Math.abs(g.sweep) * 24))) : 32;
    for (let i = 0; i <= N; i++) {
      if (pointOutsideRect(arcPointAt(seg, i / N), r)) return true;
    }
    return false;
  }
  return false;
}

function findDeadzoneViolations() {
  const r = deadzoneRect();
  if (r.dz <= 0) return [];
  return state.segments.filter(seg => segInDeadzone(seg, r));
}

// ── UNDO / REDO ───────────────────────────────────────────
function snapshot() {
  return JSON.stringify({
    segments: state.segments,
    nodes:    state.nodes,
    nextId:   state.nextId,
  });
}

function saveUndo() {
  state.undoStack.push(snapshot());
  if (state.undoStack.length > 80) state.undoStack.shift();
  state.redoStack = [];
}

function applySnap(snap) {
  const d = JSON.parse(snap);
  state.segments = d.segments;
  state.nodes    = d.nodes;
  state.nextId   = d.nextId;
  state.dijkstraPath = [];
  ui.selection.clear();
  updatePanelInfo();
  updateDijkstraPanel();
  updateSelectionPanel();
  render();
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(snapshot());
  applySnap(state.undoStack.pop());
  toast('Desfeito');
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(snapshot());
  applySnap(state.redoStack.pop());
  toast('Refeito');
}

// ── SET TOOL ─────────────────────────────────────────────
function setTool(tool) {
  if (ui.dragMove) finishMoveDrag();
  if (ui.pasteMode) ui.pasteMode = null;
  if (tool === 'circle' && ui.tool !== 'circle') {
    ui.circleMode = 'center';
    ui.circleSide = 'E';
  }
  ui.tool         = tool;
  ui.lineStart    = null;
  ui.arcPoints    = [];
  ui.polyPoints   = [];
  ui.rectStart    = null;
  ui.circleCenter = null;
  ui.spiralCenter = null;
  ui.dragVertex   = null;
  ui.mirrorPts    = [];
  ui.offsetTargetId = null;
  hidePolarHud();
  hideFilletHud();
  hideMoveHud();
  hideCoordHud();
  hideOffsetHud();
  hideRotateHud();
  hideScaleHud();
  hideArrayHud();
  hideCircleHud();
  hideSpiralHud();

  canvas.className = '';
  if (tool === 'select')     canvas.classList.add('cursor-select');
  if (tool === 'move')       canvas.classList.add('cursor-select');
  if (tool === 'vertex-edit') canvas.classList.add('cursor-vertex');
  if (tool === 'start-node' || tool === 'end-node') canvas.classList.add('cursor-node');

  document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));

  if (tool === 'fillet') showFilletHud();
  if (tool === 'offset') showOffsetHud();
  if (tool === 'rotate') showRotateHud();
  if (tool === 'scale')  showScaleHud();
  if (tool === 'array')  showArrayHud();
  if (tool === 'circle') showCircleHud();
  if (tool === 'spiral') showSpiralHud();
  if (tool === 'line')   showPolarHud(null);  // Abre HUD com posição do mouse como sugestão

  const labels = {
    select:       'SELECIONAR',
    line:         'LINHA',
    arc:          'ARCO 3PTS',
    circle:       'CÍRCULO',
    rect:         'RETÂNGULO',
    polyline:     'POLILINHA',
    spiral:       'ESPIRAL',
    fillet:       'ROUND/FILLET',
    'start-node': 'NÓ INÍCIO',
    'end-node':   'NÓ CHEGADA',
    move:         'MOVER PRECISÃO',
    'vertex-edit':'EDITAR VÉRTICE',
    trim:         'TRIM (APARAR)',
    extend:       'EXTEND (ESTENDER)',
    join:         'JOIN (UNIR)',
    break:        'BREAK (QUEBRAR)',
    offset:       'OFFSET',
    mirror:       'MIRROR (ESPELHAR)',
    rotate:       'ROTATE (GIRAR)',
    scale:        'SCALE (ESCALAR)',
    array:        'ARRAY (COPIAR)',
  };
  document.getElementById('status-tool').textContent = labels[tool] || tool.toUpperCase();
  setStatus('Pronto');
  if (tool === 'mirror') setStatus('Selecione os objetos e clique numa linha existente como eixo');
  if (tool === 'offset') setStatus('Clique no objeto e depois no lado do offset');
  if (tool === 'trim')   setStatus('Clique no trecho que deseja remover');
  if (tool === 'extend') setStatus('Clique perto da extremidade que deseja estender');
  if (tool === 'vertex-edit') setStatus('Clique no selo "E" (ou Ctrl+clique) para marcar/desmarcar coordenada · Alt+clique remove');
  if (tool === 'circle') setStatus(circleStatusText());
  if (tool === 'spiral') setStatus('Clique para definir o centro · ajuste R1, A, F e N · Enter aplica');
  render();
}

// ── LINHA ─────────────────────────────────────────────────
function lineClick(wx, wy) {
  let pt = ui.snapTarget ? { ...ui.snapTarget } : { x: wx, y: wy };
  if (!ui.lineStart) {
    ui.lineStart = { ...pt };
    showPolarHud(pt);
    setStatus('Ponto inicial definido · clique para ponto final ou use o HUD polar');
    return;
  }
  if (!ui.snapTarget) pt = pointFromConstraint(ui.lineStart, pt);
  commitLine(ui.lineStart, pt);
  ui.lineStart = { ...pt };
  updatePolarHud();
}

function commitLine(p0, p1) {
  if (Math.hypot(p1.x-p0.x, p1.y-p0.y) < 0.01) return;
  saveUndo();
  state.segments.push({ id: state.nextId++, type: 'line',
    points: [{ ...p0 }, { ...p1 }], selected: false, isConstruction: false });
  state.dijkstraPath = [];
  updatePanelInfo();
  render();
}

// ── CÍRCULO ───────────────────────────────────────────────
function circleStatusText() {
  if (ui.circleMode === 'center') {
    return 'Círculo: clique no centro · Tab inicia pela borda (4 lados)';
  }
  const s = CIRCLE_SIDES[ui.circleSide];
  if (!ui.circleCenter) {
    return `Círculo pela borda · mova o mouse para escolher o lado (centro para ${s.label}) · clique no início · Tab volta ao centro`;
  }
  return `Início definido · centro para ${s.label} · clique no lado oposto (diâmetro) · Tab volta ao centro`;
}

function circleClick(wx, wy, e) {
  const pt = ui.snapTarget ? { ...ui.snapTarget } : { x: wx, y: wy };
  const ctrl = !!(e && (e.ctrlKey || e.metaKey));

  // Ctrl+clique: sobre um ponto N/L/S/O de círculo existente, começa ali.
  if (ctrl) {
    const q = circleQuadrantAtScreen(ui.mouseScreen.x, ui.mouseScreen.y);
    if (q) {
      ui.circleMode = 'side';
      ui.circleCenter = { x: q.x, y: q.y };
      ui.circleSide = q.side;
      setStatus(`Início no ponto ${CIRCLE_SIDES[q.side].label} · mova para escolher o lado e o diâmetro`);
      render();
      updateCircleHud();
      return;
    }
  }

  if (ui.circleMode === 'center') {
    if (!ui.circleCenter) {
      ui.circleCenter = { ...pt };
      setStatus('Centro definido · clique para definir o raio · Tab inicia pela borda');
      updateCircleHud();
      return;
    }
    const r = Math.hypot(pt.x-ui.circleCenter.x, pt.y-ui.circleCenter.y);
    if (r < 0.01) { setStatus('Raio muito pequeno'); return; }
    saveUndo();
    state.segments.push({ id: state.nextId++, type: 'circle',
      points: [{ ...ui.circleCenter }], radius: r, selected: false });
    ui.circleCenter = null;
    state.dijkstraPath = [];
    updatePanelInfo();
    render();
    setStatus(`Círculo R${r.toFixed(2)} cm`);
    updateCircleHud();
    return;
  }

  // Modo "pela borda": 1º clique = início na borda; 2º = lado oposto (diâmetro).
  if (!ui.circleCenter) {
    ui.circleCenter = { ...pt };
    setStatus(circleStatusText());
    render();
    updateCircleHud();
    return;
  }
  const start = ui.circleCenter;
  const dxs = pt.x - start.x, dys = pt.y - start.y;
  if (Math.hypot(dxs, dys) > 0.5) ui.circleSide = circleSideFromDelta(dxs, dys);
  const s = CIRCLE_SIDES[ui.circleSide];
  const diameter = Math.abs(dxs * s.dx + dys * s.dy);
  if (diameter < 0.02) { setStatus('Diâmetro muito pequeno'); return; }
  const r = diameter / 2;
  const center = pointOnCircleSide(start, r, ui.circleSide);
  saveUndo();
  state.segments.push({ id: state.nextId++, type: 'circle',
    points: [{ ...center }], radius: r, selected: false,
    startSide: ui.circleSide, startPoint: { ...start } });
  ui.circleCenter = null;
  state.dijkstraPath = [];
  updatePanelInfo();
  render();
  setStatus(`Círculo Ø${diameter.toFixed(2)} cm (R${r.toFixed(2)} cm) · centro para ${s.label}`);
  updateCircleHud();
}

function toggleCircleMode() {
  ui.circleMode = ui.circleMode === 'center' ? 'side' : 'center';
  ui.circleCenter = null;
  ui.circleSide = 'E';
  setStatus(circleStatusText());
  render();
  updateCircleHud();
}

// ── RETÂNGULO ─────────────────────────────────────────────
function rectClick(wx, wy) {
  let pt = ui.snapTarget ? { ...ui.snapTarget } : { x: wx, y: wy };
  if (!ui.rectStart) {
    ui.rectStart = { ...pt };
    setStatus('1º canto definido · clique no canto oposto');
    return;
  }
  if (!ui.snapTarget) pt = pointFromConstraint(ui.rectStart, pt);
  commitRect(ui.rectStart, pt);
  ui.rectStart = null;
}

function commitRect(a, b) {
  if (Math.abs(b.x-a.x) < 0.01 || Math.abs(b.y-a.y) < 0.01) return;
  saveUndo();
  const corners = [
    { x: a.x, y: a.y }, { x: b.x, y: a.y },
    { x: b.x, y: b.y }, { x: a.x, y: b.y },
  ];
  for (let i = 0; i < 4; i++) {
    const p0 = corners[i], p1 = corners[(i+1) % 4];
    state.segments.push({ id: state.nextId++, type: 'line',
      points: [{ ...p0 }, { ...p1 }], selected: false });
  }
  state.dijkstraPath = [];
  updatePanelInfo();
  render();
  setStatus(`Retângulo ${Math.abs(b.x-a.x).toFixed(1)}×${Math.abs(b.y-a.y).toFixed(1)} cm`);
}

// ── POLILINHA ─────────────────────────────────────────────
function polyClick(wx, wy) {
  let pt = ui.snapTarget ? { ...ui.snapTarget } : { x: wx, y: wy };
  if (ui.polyPoints.length) {
    const last = ui.polyPoints[ui.polyPoints.length-1];
    if (!ui.snapTarget) pt = pointFromConstraint(last, pt);
    if (Math.hypot(pt.x-last.x, pt.y-last.y) < 0.01) return;
  }
  ui.polyPoints.push({ ...pt });
  setStatus(`Polilinha · ${ui.polyPoints.length} ponto(s) · Enter/dblclick finaliza`);
  render();
}

function finalizePolyline() {
  const pts = ui.polyPoints.filter((p, i, arr) =>
    i === 0 || Math.hypot(p.x-arr[i-1].x, p.y-arr[i-1].y) > 0.01);
  ui.polyPoints = [];
  if (pts.length < 2) { render(); return; }
  saveUndo();
  if (pts.length === 2) {
    state.segments.push({ id: state.nextId++, type: 'line',
      points: [{ ...pts[0] }, { ...pts[1] }], selected: false });
  } else {
    state.segments.push({ id: state.nextId++, type: 'polyline',
      points: pts.map(p => ({ ...p })), selected: false });
  }
  state.dijkstraPath = [];
  updatePanelInfo();
  render();
  setStatus('Polilinha criada');
}

// ── ARCO 3PTS ────────────────────────────────────────────
function arcClick(wx, wy) {
  const pt = ui.snapTarget ? { ...ui.snapTarget } : { x: wx, y: wy };
  ui.arcPoints.push({ ...pt });
  if (ui.arcPoints.length === 3) {
    const probe = { type: 'arc', points: ui.arcPoints };
    if (!arcGeometry(probe)) {
      ui.arcPoints.pop();
      setStatus('Pontos colineares · o arco precisa de 3 pontos não alinhados');
      render();
      return;
    }
    saveUndo();
    state.segments.push({ id: state.nextId++, type: 'arc',
      points: ui.arcPoints.map(p => ({ ...p })), selected: false });
    ui.arcPoints = [];
    state.dijkstraPath = [];
    updatePanelInfo();
    render();
    setStatus('Arco adicionado');
  } else {
    setStatus(`Ponto ${ui.arcPoints.length}/3 · clique mais ${3-ui.arcPoints.length}`);
  }
}

// ── ESPIRAL ───────────────────────────────────────────────
// Espiral logarítmica discreta: r(i) = R1 · F^i; θ(i) = θ0 + dir·i·A.
// O resultado é uma polilinha comum (não paramétrica), queimada no desenho.
function spiralInput(id, def) {
  const el = document.getElementById(id);
  if (!el) return def;
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : def;
}

function readSpiralParams() {
  const dirEl = document.getElementById('spiral-dir');
  const count = Math.round(spiralInput('spiral-count', 60));
  return {
    center:     ui.spiralCenter ? { ...ui.spiralCenter } : { ...ui.mouseWorld },
    r1:         spiralInput('spiral-r1', 2.5),
    stepAngle:  spiralInput('spiral-angle', ANGLE_STEP_DEFAULT),
    factor:     spiralInput('spiral-factor', 1.017),
    count:      Math.max(1, Math.min(2000, count)),
    startAngle: spiralInput('spiral-start', 90),
    dir:        dirEl && dirEl.value === '-1' ? -1 : 1,
    tail:       Math.max(0, spiralInput('spiral-tail', 0)),
  };
}

function buildSpiralPoints(center, p) {
  const pts = [];
  const startRad = p.startAngle * Math.PI / 180;
  const stepRad  = p.stepAngle  * Math.PI / 180;
  // Cauda: prolonga a ponta interna (raio R1) no mesmo raio
  if (p.tail > 0) {
    const r = p.r1 + p.tail;
    pts.push({ x: center.x + r * Math.cos(startRad),
               y: center.y + r * Math.sin(startRad) });
  }
  for (let i = 0; i <= p.count; i++) {
    const r = p.r1 * Math.pow(p.factor, i);
    const a = startRad + p.dir * i * stepRad;
    pts.push({ x: center.x + r * Math.cos(a),
               y: center.y + r * Math.sin(a) });
  }
  return pts;
}

function syncSpiralCenterInputs() {
  if (!ui.spiralCenter) return;
  const cx = document.getElementById('spiral-cx');
  const cy = document.getElementById('spiral-cy');
  if (cx) cx.value = ui.spiralCenter.x.toFixed(2);
  if (cy) cy.value = ui.spiralCenter.y.toFixed(2);
}

function showSpiralHud() {
  if (!ui.spiralCenter) ui.spiralCenter = { ...ui.mouseWorld };
  syncSpiralCenterInputs();
  const hud = document.getElementById('spiral-hud');
  if (hud) hud.classList.remove('hidden');
  updateSpiralInfo();
}

function hideSpiralHud() {
  const hud = document.getElementById('spiral-hud');
  if (hud) hud.classList.add('hidden');
}

function updateSpiralInfo() {
  const p = readSpiralParams();
  const turns = (p.count * p.stepAngle) / 360;
  const rEnd  = p.r1 * Math.pow(p.factor, p.count);
  const info  = document.getElementById('spiral-info');
  if (!info) return;
  info.textContent =
    `${turns.toFixed(2)} volta(s) · raio final ${Number.isFinite(rEnd) ? rEnd.toFixed(2) : '—'} cm · ${p.count + 1} pontos`;
}

function spiralClick(wx, wy) {
  ui.spiralCenter = ui.snapTarget ? { ...ui.snapTarget } : { x: wx, y: wy };
  syncSpiralCenterInputs();
  updateSpiralInfo();
  setStatus('Centro definido · ajuste os parâmetros e clique em Aplicar (ou Enter)');
  render();
}

function applySpiral() {
  const p = readSpiralParams();
  if (!(p.r1 > 0)) {
    toast('Raio inicial deve ser maior que zero', 'warn'); return;
  }
  if (!(p.stepAngle > 0 && p.stepAngle <= 180)) {
    toast('Passo angular deve ficar entre 1° e 180°', 'warn'); return;
  }
  if (!(p.factor > 0)) {
    toast('Fator de expansão deve ser maior que zero', 'warn'); return;
  }

  const pts = buildSpiralPoints(p.center, p);
  if (pts.length < 2) { toast('Espiral sem pontos', 'warn'); return; }

  saveUndo();
  const id = state.nextId++;
  state.segments.push({ id, type: 'polyline', points: pts, selected: false });
  state.dijkstraPath = [];

  // Seleciona a espiral recém-criada para facilitar mover/apagar
  ui.selection.clear();
  ui.selection.add(id);
  updatePanelInfo();
  updateSelectionPanel();
  render();

  const turns = (p.count * p.stepAngle) / 360;
  toast(`Espiral criada · ${turns.toFixed(2)} volta(s) · ${p.count + 1} pontos`, 'success');
  setStatus(`Espiral: R1=${p.r1} cm · A=${p.stepAngle}° · F=${p.factor} · N=${p.count}`);
}

// ── ROUND / FILLET ────────────────────────────────────────
// Aplica arco de concordância circular real entre dois segmentos no vértice
function filletClick(wx, wy) {
  const radiusCm = parseFloat(document.getElementById('fillet-radius').value) || 2;
  const EPS_PX   = 20;

  // encontrar vértice mais próximo (endpoint compartilhado)
  let bestVtx = null, bestDist = Infinity;
  const EPS_W = 0.5;

  // mapa: chave → lista de {seg, epIdx}
  const vertexMap = new Map();
  for (const seg of state.segments) {
    const eps = segEndpoints(seg);
    eps.forEach((ep, idx) => {
      const key = `${Math.round(ep.x/EPS_W)},${Math.round(ep.y/EPS_W)}`;
      if (!vertexMap.has(key)) vertexMap.set(key, []);
      vertexMap.get(key).push({ seg, ep, idx });
    });
  }

  for (const [, list] of vertexMap) {
    if (list.length < 2) continue;
    const ep = list[0].ep;
    const sp = w2s(ep.x, ep.y);
    const d  = Math.hypot(sp.x - ui.mouseScreen.x, sp.y - ui.mouseScreen.y);
    if (d < EPS_PX && d < bestDist) {
      bestDist = d;
      bestVtx  = { pt: ep, list };
    }
  }

  // vértice interno de polilinha (ex.: após join)
  let internal = null;
  for (const seg of state.segments) {
    if (seg.type !== 'polyline') continue;
    for (let i = 1; i < seg.points.length-1; i++) {
      const p = seg.points[i];
      const sp = w2s(p.x, p.y);
      const d = Math.hypot(sp.x - ui.mouseScreen.x, sp.y - ui.mouseScreen.y);
      if (d < EPS_PX && d < bestDist) { bestDist = d; internal = { seg, idx: i, pt: p }; }
    }
  }
  if (internal) { applyRoundPolyline(internal.seg, internal.idx, radiusCm); return; }

  if (!bestVtx) { setStatus('Nenhum vértice encontrado · clique mais perto de uma quina'); return; }

  const { pt: vertex, list } = bestVtx;
  if (list.length < 2) { setStatus('Vértice precisa conectar 2 segmentos'); return; }
  if (list[0].seg.id === list[1].seg.id) {
    setStatus('Fillet precisa de dois objetos diferentes');
    return;
  }

  applyRound(list[0].seg, list[1].seg, vertex, radiusCm);
}

function applyRoundPolyline(seg, idx, radius) {
  const pts = seg.points;
  const v = pts[idx], A = pts[idx-1], B = pts[idx+1];
  const lenA = distPts(A, v), lenB = distPts(B, v);
  if (lenA < 1e-6 || lenB < 1e-6) { setStatus('Vértice degenerado'); return; }

  const dA = { x:(A.x-v.x)/lenA, y:(A.y-v.y)/lenA };
  const dB = { x:(B.x-v.x)/lenB, y:(B.y-v.y)/lenB };
  const dot = Math.min(1, Math.max(-1, dA.x*dB.x + dA.y*dB.y));
  const angle = Math.acos(dot);
  if (angle < 0.01 || angle > Math.PI - 0.01) {
    setStatus('Vértice sem ângulo para fillet');
    return;
  }

  const dist = radius / Math.tan(angle/2);
  if (dist >= lenA - 1e-3 || dist >= lenB - 1e-3) {
    toast('Raio maior que o trecho disponível', 'warn');
    return;
  }

  const tA = { x: v.x + dA.x*dist, y: v.y + dA.y*dist };
  const tB = { x: v.x + dB.x*dist, y: v.y + dB.y*dist };

  const bx = dA.x + dB.x, by = dA.y + dB.y;
  const blen = Math.hypot(bx, by);
  if (blen < 1e-9) { setStatus('Vértice sem ângulo para fillet'); return; }
  const cx = v.x + (bx/blen) * (radius / Math.sin(angle/2));
  const cy = v.y + (by/blen) * (radius / Math.sin(angle/2));

  const aA = Math.atan2(tA.y-cy, tA.x-cx);
  const aB = Math.atan2(tB.y-cy, tB.x-cx);
  let sweep = normAngle(aB - aA);
  if (sweep > Math.PI) sweep -= TWO_PI;
  const aMid = aA + sweep/2;
  const mid = { x: cx + radius*Math.cos(aMid), y: cy + radius*Math.sin(aMid) };

  const total = segLength(seg);
  let vertexT = 0;
  for (let i = 1; i <= idx; i++) vertexT += distPts(pts[i-1], pts[i]);
  vertexT = total > 1e-9 ? vertexT/total : 0;

  saveUndo();
  const left = pts.slice(0, idx);
  const right = pts.slice(idx+1);
  left.push({ ...tA });
  right.unshift({ ...tB });

  seg.type = left.length === 2 ? 'line' : 'polyline';
  seg.points = left.map(p => ({ ...p }));
  delete seg.radius;

  const rightSeg = segmentFromPoints(right);
  const arcSeg = {
    id: state.nextId++, type: 'arc', selected: false,
    points: [{ ...tA }, { ...mid }, { ...tB }],
  };
  state.segments.push(rightSeg, arcSeg);

  ['start','end'].forEach(k => {
    const n = state.nodes[k];
    if (!n || n.segId !== seg.id) return;
    const dest = n.t <= vertexT + 1e-9 ? seg : rightSeg;
    const cp = closestPointOnSeg(dest, n.x, n.y);
    n.segId = dest.id; n.x = cp.pt.x; n.y = cp.pt.y; n.t = cp.t;
  });

  refreshAfterEdit();
  toast(`Round R${radius}cm aplicado`, 'success');
}

function applyRound(segA, segB, vertex, radius) {
  function dirAway(seg, v) {
    const eps = segEndpoints(seg);
    const other = Math.hypot(eps[0].x-v.x, eps[0].y-v.y) < 0.5 ? eps[1] : eps[0];
    const len = Math.hypot(other.x-v.x, other.y-v.y);
    if (len < 0.001) return { x: 1, y: 0 };
    return { x: (other.x-v.x)/len, y: (other.y-v.y)/len };
  }

  const dA = dirAway(segA, vertex);
  const dB = dirAway(segB, vertex);
  const dot = Math.min(1, Math.max(-1, dA.x*dB.x + dA.y*dB.y));
  const angle = Math.acos(dot);
  if (angle < 0.01 || angle > Math.PI - 0.01) {
    setStatus('Segmentos alinhados, fillet não aplicável');
    return;
  }

  const dist = radius / Math.tan(angle / 2);

  // Tangent points
  const tA = { x: vertex.x + dA.x*dist, y: vertex.y + dA.y*dist };
  const tB = { x: vertex.x + dB.x*dist, y: vertex.y + dB.y*dist };

  // Centro do arco circular
  // bissetriz normalizada
  const bx = dA.x + dB.x, by = dA.y + dB.y;
  const blen = Math.hypot(bx, by);
  const cx = vertex.x + (bx/blen) * (radius / Math.sin(angle/2));
  const cy = vertex.y + (by/blen) * (radius / Math.sin(angle/2));

  // Ponto intermediário sobre o arco circular real (menor arco tA→tB)
  const aA = Math.atan2(tA.y - cy, tA.x - cx);
  const aB = Math.atan2(tB.y - cy, tB.x - cx);
  const TWO = Math.PI * 2;
  let sweepMinor = ((aB - aA) % TWO + TWO) % TWO;
  if (sweepMinor > Math.PI) sweepMinor -= TWO;
  const aMid = aA + sweepMinor / 2;
  const mid  = {
    x: cx + radius * Math.cos(aMid),
    y: cy + radius * Math.sin(aMid),
  };

  saveUndo();

  // Truncar os segmentos no ponto de tangência
  function trimEndpoint(seg, v, newPt) {
    const eps = segEndpoints(seg);
    const idx = Math.hypot(eps[0].x-v.x, eps[0].y-v.y) < 0.5 ? 0 : 1;
    if (seg.type === 'line') {
      seg.points[idx] = { ...newPt };
    } else if (seg.type === 'arc') {
      const pIdx = idx === 0 ? 0 : 2;
      seg.points[pIdx] = { ...newPt };
    }
  }

  trimEndpoint(segA, vertex, tA);
  trimEndpoint(segB, vertex, tB);

  // Arco de concordância (circular real, passando pelo ponto médio)
  state.segments.push({
    id:     state.nextId++,
    type:   'arc',
    points: [{ ...tA }, { ...mid }, { ...tB }],
    selected: false,
  });

  reattachNodes([segA.id, segB.id]);
  state.dijkstraPath = [];
  updatePanelInfo();
  render();
  toast(`Round R${radius}cm aplicado`, 'success');
}

// ══════════════════════════════════════════════════════════
// FERRAMENTAS DE EDIÇÃO (Grupo 3)
// ══════════════════════════════════════════════════════════

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

function findSegmentAt(wx, wy, maxPx) {
  maxPx = maxPx || 10;
  const sp = w2s(wx, wy);
  let best = null, bestD = maxPx;
  for (const seg of state.segments) {
    const d = screenDistToSeg(seg, sp.x, sp.y);
    if (d < bestD) { bestD = d; best = seg; }
  }
  return best;
}

function segmentFromPoints(points) {
  return {
    id: state.nextId++,
    type: points.length === 2 ? 'line' : 'polyline',
    points: points.map(p => ({ ...p })),
    selected: false,
  };
}

function refreshAfterEdit() {
  state.dijkstraPath = [];
  updatePanelInfo();
  updateSelectionPanel();
  updateDijkstraPanel();
  render();
}

// ── GEOMETRIA AUXILIAR (trim / extend) ────────────────────
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

function targetIntersections(seg) {
  const raw = [];
  const others = state.segments.filter(s => s.id !== seg.id);
  for (const tp of targetPieces(seg)) {
    for (const other of others) {
      for (const piece of segPieces(other)) {
        for (const it of intersectPieces(tp.piece, piece)) {
          const t = tp.t0 + it.tA * (tp.t1 - tp.t0);
          if (t > 1e-4 && t < 1 - 1e-4) raw.push({ t, pt:it.pt });
        }
      }
    }
  }
  raw.sort((a,b) => a.t - b.t);
  const out = [];
  for (const c of raw) {
    if (!out.length || Math.abs(c.t - out[out.length-1].t) > 1e-4) out.push(c);
  }
  return out;
}

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

function makePieceSegment(pts, arcLike) {
  return {
    id: state.nextId++,
    type: arcLike ? 'arc' : (pts.length === 2 ? 'line' : 'polyline'),
    points: pts.map(p => ({ ...p })),
    selected: false,
  };
}

function reattachNodes(segIds) {
  const ids = new Set(segIds);
  ['start','end'].forEach(k => {
    const n = state.nodes[k];
    if (!n || !ids.has(n.segId)) return;
    const seg = state.segments.find(s => s.id === n.segId);
    if (!seg) { state.nodes[k] = null; return; }
    const cp = closestPointOnSeg(seg, n.x, n.y);
    n.x = cp.pt.x; n.y = cp.pt.y; n.t = cp.t;
  });
}

function reattachSplit(segId, cutT, segA, segB) {
  ['start','end'].forEach(k => {
    const n = state.nodes[k];
    if (!n || n.segId !== segId) return;
    const dest = n.t <= cutT + 1e-9 ? segA : segB;
    const cp = closestPointOnSeg(dest, n.x, n.y);
    n.segId = dest.id; n.x = cp.pt.x; n.y = cp.pt.y; n.t = cp.t;
  });
}

// ── TRIM (aparar) ─────────────────────────────────────────
function trimCircle(target, wx, wy) {
  const c = target.points[0], r = target.radius;
  const probe = { kind:'circle', c, r, a0:0, sweep:TWO_PI, full:true };
  const raw = [];
  for (const other of state.segments) {
    if (other.id === target.id) continue;
    for (const p of segPieces(other)) {
      for (const it of intersectPieces(probe, p)) raw.push({ t: it.tA, pt: it.pt });
    }
  }
  raw.sort((a,b) => a.t - b.t);
  const cuts = [];
  for (const it of raw) {
    if (!cuts.length || Math.abs(it.t - cuts[cuts.length-1].t) > 1e-4) cuts.push(it);
  }
  if (cuts.length < 2) {
    saveUndo();
    state.segments = state.segments.filter(s => s.id !== target.id);
    refreshAfterEdit();
    toast('Círculo apagado (sem interseções válidas para aparar)', 'warn');
    return;
  }
  const tc = closestPointOnSeg(target, wx, wy).t;
  const last = cuts.length - 1;
  let idx = -1;
  for (let i = 0; i < cuts.length; i++) {
    const lo = cuts[i].t;
    const hi = i === last ? cuts[0].t + 1 : cuts[i+1].t;
    if (tc >= lo - 1e-6 && tc <= hi + 1e-6) { idx = i; break; }
  }
  if (idx < 0) idx = last;
  const lo = cuts[idx].t;
  const hi = idx === last ? cuts[0].t + 1 : cuts[idx+1].t;
  const startT = hi % 1;
  const sweepKeep = lo + 1 - hi;
  if (sweepKeep < 1e-4) {
    saveUndo();
    state.segments = state.segments.filter(s => s.id !== target.id);
    refreshAfterEdit();
    toast('Círculo apagado (trecho resultante muito pequeno)', 'warn');
    return;
  }

  saveUndo();
  const at = t => {
    const a = t * TWO_PI;
    return { x: c.x + r*Math.cos(a), y: c.y + r*Math.sin(a) };
  };
  target.type = 'arc';
  target.points = [ at(startT), at(startT + sweepKeep/2), at(startT + sweepKeep) ];
  // Preserva informações do círculo original (AutoCAD-like)
  target.originalCircle = { c: { ...c }, r };
  delete target.radius;
  reattachNodes([target.id]);
  refreshAfterEdit();
  toast('Círculo aparado', 'success');
}

function trimClick(wx, wy) {
  const target = findSegmentAt(wx, wy, 14);
  if (!target) { setStatus('Clique sobre um objeto para aparar'); return; }
  if (target.type === 'circle') { trimCircle(target, wx, wy); return; }

  const cuts = targetIntersections(target);
  
  // Se não há interseções, apaga o objeto
  if (!cuts.length) {
    saveUndo();
    state.segments = state.segments.filter(s => s.id !== target.id);
    refreshAfterEdit();
    toast('Objeto apagado (sem interseção para aparar)', 'warn');
    return;
  }

  const tc = closestPointOnSeg(target, wx, wy).t;
  const bounds = [0, ...cuts.map(c => c.t), 1].sort((a,b) => a-b);
  let j = -1;
  for (let i = 0; i < bounds.length-1; i++) {
    if (tc >= bounds[i] - 1e-6 && tc <= bounds[i+1] + 1e-6) { j = i; break; }
  }
  if (j < 0) { setStatus('Não foi possível identificar o trecho'); return; }
  const lo = bounds[j], hi = bounds[j+1];
  if (hi - lo < 1e-4) { setStatus('Trecho muito pequeno'); return; }

  const arcLike = target.type === 'arc';
  saveUndo();
  
  // Comportamento original: remove o trecho clicado, mantém o(s) restante(s)
  if (lo <= 1e-4) {
    // Clicou no primeiro trecho (início até 1ª interseção) -> mantém do hi até fim
    assignPiece(target, subSegmentPoints(target, hi, 1));
  } else if (hi >= 1 - 1e-4) {
    // Clicou no último trecho (última interseção até fim) -> mantém do início até lo
    assignPiece(target, subSegmentPoints(target, 0, lo));
  } else {
    // Clicou no meio -> divide em dois (mantém início-lo e hi-fim)
    const keep = subSegmentPoints(target, 0, lo);
    const rest = subSegmentPoints(target, hi, 1);
    assignPiece(target, keep);
    state.segments.push(makePieceSegment(rest, arcLike));
  }
  reattachNodes([target.id]);
  refreshAfterEdit();
  toast('Objeto aparado', 'success');
}

// ── EXTEND (estender) ─────────────────────────────────────
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

function rayCandidates(origin, dir, excludeId) {
  const out = [];
  for (const other of state.segments) {
    if (other.id === excludeId) continue;
    for (const piece of segPieces(other)) {
      if (piece.kind === 'line') {
        const r = raySegmentIntersection(origin, dir, piece.a, piece.b);
        if (r) out.push({ t: r.t, pt: r.pt });
      } else {
        for (const it of rayCircleHits(origin, dir, piece.c, piece.r)) {
          if (it.t <= 1e-6) continue;
          const ang = Math.atan2(it.pt.y-piece.c.y, it.pt.x-piece.c.x);
          if (circlePieceParam(piece, ang) === null) continue;
          out.push({ t: it.t, pt: it.pt });
        }
      }
    }
  }
  return out;
}

function extendStraightPoint(target, isFirst) {
  const pts = target.points;
  const base = isFirst ? pts[1] : pts[pts.length-2];
  const end  = isFirst ? pts[0] : pts[pts.length-1];
  const len = Math.hypot(end.x-base.x, end.y-base.y);
  if (len < 1e-9) { setStatus('Objeto degenerado'); return null; }
  const dir = { x:(end.x-base.x)/len, y:(end.y-base.y)/len };
  let best = null;
  for (const c of rayCandidates(base, dir, target.id)) {
    if (c.t <= len + 1e-3) continue;
    if (!best || c.t < best.t) best = c;
  }
  if (!best) { setStatus('Nenhuma interseção à frente para estender'); return null; }
  return { ...best.pt };
}

function extendArcPoint(target, endIdx) {
  const g = arcGeometry(target);
  if (!g) { setStatus('Arco inválido'); return null; }
  const sign = g.sweep > 0 ? 1 : -1;
  const startA = g.a0;
  const endA = g.a0 + g.sweep;
  const fromA = endIdx === 2 ? endA : startA;
  const gap = TWO_PI - Math.abs(g.sweep);
  if (gap < 1e-4) { setStatus('Arco já está completo'); return null; }

  const probe = { kind:'circle', c:{ x:g.cx, y:g.cy }, r:g.r, a0:0, sweep:TWO_PI, full:true };
  let best = null;
  for (const other of state.segments) {
    if (other.id === target.id) continue;
    for (const piece of segPieces(other)) {
      for (const it of intersectPieces(probe, piece)) {
        const ang = Math.atan2(it.pt.y-g.cy, it.pt.x-g.cx);
        const d = endIdx === 2
          ? (sign > 0 ? normAngle(ang - endA) : normAngle(endA - ang))
          : (sign > 0 ? normAngle(startA - ang) : normAngle(ang - startA));
        if (d < 1e-4 || d > gap - 1e-6) continue;
        if (!best || d < best.d) best = { d, ang };
      }
    }
  }
  if (!best) { setStatus('Nenhuma interseção à frente para estender'); return null; }
  const newA = endIdx === 2 ? fromA + sign*best.d : fromA - sign*best.d;
  return { x:g.cx + g.r*Math.cos(newA), y:g.cy + g.r*Math.sin(newA) };
}

function extendClick(wx, wy) {
  const target = findSegmentAt(wx, wy, 14);
  if (!target) { setStatus('Clique sobre um objeto para estender'); return; }
  if (target.type === 'circle') { setStatus('Estender não se aplica a círculos'); return; }

  let endIdx = -1, pt = null;
  if (target.type === 'line') {
    endIdx = Math.hypot(wx-target.points[0].x, wy-target.points[0].y)
           < Math.hypot(wx-target.points[1].x, wy-target.points[1].y) ? 0 : 1;
    pt = extendStraightPoint(target, endIdx === 0);
  } else if (target.type === 'polyline') {
    const n = target.points.length - 1;
    endIdx = Math.hypot(wx-target.points[0].x, wy-target.points[0].y)
           < Math.hypot(wx-target.points[n].x, wy-target.points[n].y) ? 0 : n;
    pt = extendStraightPoint(target, endIdx === 0);
  } else if (target.type === 'arc') {
    endIdx = Math.hypot(wx-target.points[0].x, wy-target.points[0].y)
           < Math.hypot(wx-target.points[2].x, wy-target.points[2].y) ? 0 : 2;
    pt = extendArcPoint(target, endIdx);
  }

  if (!pt) return;
  saveUndo();
  target.points[endIdx] = { ...pt };
  reattachNodes([target.id]);
  refreshAfterEdit();
  toast('Objeto estendido', 'success');
}

// ── JOIN (unir) ───────────────────────────────────────────
function joinSelected() {
  const segs = state.segments.filter(s =>
    ui.selection.has(s.id) && (s.type === 'line' || s.type === 'polyline'));
  if (segs.length < 2) { toast('Selecione ao menos 2 linhas/polilinhas', 'warn'); return; }

  const chains = segs.map(s =>
    s.type === 'line' ? [{ ...s.points[0] }, { ...s.points[1] }] : s.points.map(p => ({ ...p })));
  let merged = chains.shift();
  const remaining = chains.slice();
  const TOL = 0.6;
  let progress = true;
  while (remaining.length && progress) {
    progress = false;
    for (let i = 0; i < remaining.length; i++) {
      const ch = remaining[i];
      const startA = merged[0], endA = merged[merged.length-1];
      const startB = ch[0], endB = ch[ch.length-1];
      if (distPts(endA, startB) < TOL) {
        merged = merged.concat(ch.slice(1));
      } else if (distPts(endA, endB) < TOL) {
        merged = merged.concat(ch.slice(0, -1).reverse());
      } else if (distPts(startA, endB) < TOL) {
        merged = ch.concat(merged.slice(1));
      } else if (distPts(startA, startB) < TOL) {
        merged = ch.slice().reverse().concat(merged.slice(1));
      } else {
        continue;
      }
      remaining.splice(i, 1);
      progress = true;
      break;
    }
  }
  if (remaining.length) { toast('Segmentos não conectados entre si', 'warn'); return; }

  saveUndo();
  const selectedIds = new Set(ui.selection);
  state.segments = state.segments.filter(s => !ui.selection.has(s.id));
  const joined = segmentFromPoints(merged);
  state.segments.push(joined);
  ['start','end'].forEach(k => {
    const n = state.nodes[k];
    if (!n || !selectedIds.has(n.segId)) return;
    const cp = closestPointOnSeg(joined, n.x, n.y);
    n.segId = joined.id; n.x = cp.pt.x; n.y = cp.pt.y; n.t = cp.t;
  });
  ui.selection.clear();
  ui.selection.add(joined.id);
  refreshAfterEdit();
  toast('Segmentos unidos', 'success');
}

// ── BREAK (quebrar no ponto) ──────────────────────────────
function breakClick(wx, wy) {
  const target = findSegmentAt(wx, wy, 12);
  if (!target) { setStatus('Clique sobre um segmento para quebrar'); return; }
  const cp = closestPointOnSeg(target, wx, wy);

  if (target.type === 'line') {
    if (cp.t < 0.02 || cp.t > 0.98) { setStatus('Muito perto da extremidade'); return; }
    saveUndo();
    const p0 = target.points[0], p1 = target.points[1];
    target.points = [{ ...p0 }, { ...cp.pt }];
    const second = { id: state.nextId++, type: 'line',
      points: [{ ...cp.pt }, { ...p1 }], selected: false };
    state.segments.push(second);
    reattachSplit(target.id, cp.t, target, second);
    refreshAfterEdit();
    toast('Linha quebrada', 'success');
    return;
  }

  if (target.type === 'polyline') {
    let bi = -1, bpt = null, bd = Infinity;
    for (let i = 1; i < target.points.length; i++) {
      const a = target.points[i-1], b = target.points[i];
      const dx = b.x-a.x, dy = b.y-a.y, len2 = dx*dx+dy*dy;
      let u = len2 > 1e-12 ? ((wx-a.x)*dx + (wy-a.y)*dy)/len2 : 0;
      u = Math.max(0, Math.min(1, u));
      const pt = { x: a.x+u*dx, y: a.y+u*dy };
      const d = Math.hypot(wx-pt.x, wy-pt.y);
      if (d < bd) { bd = d; bi = i; bpt = pt; }
    }
    if (bi < 0) { setStatus('Não foi possível quebrar'); return; }
    const total = segLength(target);
    let acc = 0;
    for (let i = 1; i <= bi; i++) {
      const a = target.points[i-1], b = target.points[i];
      const len = Math.hypot(b.x-a.x, b.y-a.y);
      if (i < bi) {
        acc += len;
      } else {
        const dx = b.x-a.x, dy = b.y-a.y, len2 = dx*dx+dy*dy;
        let u = len2 > 1e-12 ? ((wx-a.x)*dx + (wy-a.y)*dy)/len2 : 0;
        u = Math.max(0, Math.min(1, u));
        acc += u*len;
      }
    }
    const cutT = total > 1e-9 ? acc/total : 0;
    saveUndo();
    const first  = target.points.slice(0, bi).concat([{ ...bpt }]);
    const secondPts = [{ ...bpt }].concat(target.points.slice(bi));
    target.type = first.length === 2 ? 'line' : 'polyline';
    target.points = first;
    const second = segmentFromPoints(secondPts);
    state.segments.push(second);
    reattachSplit(target.id, cutT, target, second);
    refreshAfterEdit();
    toast('Polilinha quebrada', 'success');
    return;
  }

  if (target.type === 'arc') {
    if (cp.t < 0.02 || cp.t > 0.98) { setStatus('Muito perto da extremidade'); return; }
    const mid1 = arcPointAt(target, cp.t/2);
    const mid2 = arcPointAt(target, (1+cp.t)/2);
    saveUndo();
    const p0 = target.points[0], p1 = target.points[2];
    target.points = [{ ...p0 }, { ...mid1 }, { ...cp.pt }];
    const second = { id: state.nextId++, type: 'arc',
      points: [{ ...cp.pt }, { ...mid2 }, { ...p1 }], selected: false };
    state.segments.push(second);
    reattachSplit(target.id, cp.t, target, second);
    refreshAfterEdit();
    toast('Arco quebrado', 'success');
    return;
  }

  setStatus('Break disponível para linha, polilinha e arco');
}

// ── OFFSET ────────────────────────────────────────────────
function sideOfEdge(a, b, px, py) {
  const cross = (b.x-a.x)*(py-a.y) - (b.y-a.y)*(px-a.x);
  if (Math.abs(cross) < 1e-12) return 1;
  return cross > 0 ? 1 : -1;
}

function buildOffset(target, wx, wy, dist) {
  if (target.type === 'line') {
    const a = target.points[0], b = target.points[1];
    const dx = b.x-a.x, dy = b.y-a.y, len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const nx = -dy/len, ny = dx/len;
    const side = sideOfEdge(a, b, wx, wy);
    const ox = nx*dist*side, oy = ny*dist*side;
    return { id: state.nextId++, type: 'line', selected: false,
      points: [{ x: a.x+ox, y: a.y+oy }, { x: b.x+ox, y: b.y+oy }] };
  }

  if (target.type === 'circle') {
    const c = target.points[0];
    const dClick = Math.hypot(wx-c.x, wy-c.y);
    const side = dClick < target.radius ? -1 : 1;
    const r = target.radius + dist*side;
    if (r <= 0.01) { toast('Raio resultante inválido', 'warn'); return null; }
    return { id: state.nextId++, type: 'circle', selected: false,
      points: [{ ...c }], radius: r };
  }

  if (target.type === 'arc') {
    const g = arcGeometry(target);
    if (!g) { setStatus('Arco inválido'); return null; }
    const dClick = Math.hypot(wx-g.cx, wy-g.cy);
    const side = dClick < g.r ? -1 : 1;
    const r2 = g.r + dist*side;
    if (r2 <= 0.01) { toast('Raio resultante inválido', 'warn'); return null; }
    const k = r2 / g.r;
    return { id: state.nextId++, type: 'arc', selected: false,
      points: target.points.map(p => ({
        x: g.cx + (p.x-g.cx)*k,
        y: g.cy + (p.y-g.cy)*k,
      })) };
  }

  if (target.type === 'polyline') {
    const pts = target.points;
    const e = polylineEdgeAt(target, wx, wy);
    const side = e ? sideOfEdge(e.a, e.b, wx, wy) : 1;
    const normals = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i-1], b = pts[i];
      const dx = b.x-a.x, dy = b.y-a.y, l = Math.hypot(dx, dy);
      if (l < 1e-9) { normals.push({ x: 0, y: 0 }); continue; }
      normals.push({ x: side*(-dy/l), y: side*(dx/l) });
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) {
        const n = normals[0];
        out.push({ x: pts[i].x + n.x*dist, y: pts[i].y + n.y*dist });
      } else if (i === pts.length-1) {
        const n = normals[normals.length-1];
        out.push({ x: pts[i].x + n.x*dist, y: pts[i].y + n.y*dist });
      } else {
        const n1 = normals[i-1], n2 = normals[i];
        let mx = n1.x+n2.x, my = n1.y+n2.y;
        const ml = Math.hypot(mx, my);
        if (ml < 1e-9) {
          out.push({ x: pts[i].x + n1.x*dist, y: pts[i].y + n1.y*dist });
          continue;
        }
        mx /= ml; my /= ml;
        const denom = mx*n1.x + my*n1.y;
        if (Math.abs(denom) < 0.1) {
          out.push({ x: pts[i].x + n1.x*dist, y: pts[i].y + n1.y*dist });
        } else {
          const s = dist / denom;
          out.push({ x: pts[i].x + mx*s, y: pts[i].y + my*s });
        }
      }
    }
    return { id: state.nextId++, type: 'polyline', selected: false, points: out };
  }

  return null;
}

function offsetClick(wx, wy) {
  let target = ui.offsetTargetId !== null
    ? state.segments.find(s => s.id === ui.offsetTargetId)
    : null;

  if (!target) {
    target = findSegmentAt(wx, wy, 14);
    if (!target) { setStatus('Clique sobre um objeto para escolher o offset'); return; }
    ui.offsetTargetId = target.id;
    ui.selection.clear();
    ui.selection.add(target.id);
    updateSelectionPanel();
    setStatus('Objeto escolhido · clique no lado desejado');
    render();
    return;
  }

  const dist = parseFloat(document.getElementById('offset-dist').value) || 1;
  if (dist <= 0) { toast('Distância inválida', 'warn'); return; }

  const created = buildOffset(target, wx, wy, dist);
  if (!created) { setStatus('Offset não suportado neste tipo'); return; }

  saveUndo();
  state.segments.push(created);
  ui.selection.clear();
  ui.selection.add(created.id);
  ui.offsetTargetId = null;
  refreshAfterEdit();
  toast(`Offset de ${dist}cm criado`, 'success');
}

// ── MIRROR (espelhar) ─────────────────────────────────────
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

function applyMirror(a, b) {
  if (!ui.selection.size) { toast('Selecione objetos para espelhar', 'warn'); return false; }
  if (distPts(a, b) < 1e-6) { toast('Eixo inválido', 'warn'); return false; }
  saveUndo();
  const copies = [];
  for (const seg of state.segments) {
    if (!ui.selection.has(seg.id)) continue;
    const copy = JSON.parse(JSON.stringify(seg));
    copy.id = state.nextId++;
    copy.selected = false;
    copy.points = copy.points.map(p => reflectPoint(p, a, b));
    copies.push(copy);
  }
  state.segments.push(...copies);
  refreshAfterEdit();
  toast(`${copies.length} objeto(s) espelhado(s)`, 'success');
  return true;
}

function mirrorClick(wx, wy) {
  if (!ui.mirrorPts.length) {
    const seg = findSegmentAt(wx, wy, 14);
    const axis = mirrorAxisFromSegment(seg, wx, wy);
    if (axis) { applyMirror(axis[0], axis[1]); return; }
  }
  ui.mirrorPts.push({ x: wx, y: wy });
  if (ui.mirrorPts.length < 2) {
    setStatus('Clique noutra linha para usar como eixo ou no 2º ponto do eixo manual');
    render();
    return;
  }
  const a = ui.mirrorPts[0], b = ui.mirrorPts[1];
  ui.mirrorPts = [];
  applyMirror(a, b);
}

// ── TRANSFORMAÇÕES (rotate / scale / array) ───────────────
function selectedSegs() {
  return state.segments.filter(s => ui.selection.has(s.id));
}

function selectionCentroid() {
  const segs = selectedSegs();
  let sx = 0, sy = 0, n = 0;
  for (const s of segs) {
    for (const p of s.points) { sx += p.x; sy += p.y; n++; }
  }
  return n ? { x: sx/n, y: sy/n } : null;
}

function transformAttachedNodes(fn) {
  ['start','end'].forEach(k => {
    const n = state.nodes[k];
    if (!n || !ui.selection.has(n.segId)) return;
    const p = fn({ x: n.x, y: n.y });
    n.x = p.x; n.y = p.y;
  });
}

function applyRotate() {
  const angle = parseFloat(document.getElementById('rotate-angle').value);
  if (isNaN(angle)) { toast('Ângulo inválido', 'warn'); return; }
  if (!ui.selection.size) { toast('Selecione objetos para girar', 'warn'); return; }
  const c = selectionCentroid();
  if (!c) return;
  const rad = angle * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  saveUndo();
  for (const seg of selectedSegs()) {
    seg.points.forEach(p => {
      const dx = p.x-c.x, dy = p.y-c.y;
      p.x = c.x + dx*cos - dy*sin;
      p.y = c.y + dx*sin + dy*cos;
    });
  }
  transformAttachedNodes(p => {
    const dx = p.x-c.x, dy = p.y-c.y;
    return { x: c.x + dx*cos - dy*sin, y: c.y + dx*sin + dy*cos };
  });
  refreshAfterEdit();
  toast(`Giro de ${angle}° aplicado`, 'success');
}

function applyScale() {
  const factor = parseFloat(document.getElementById('scale-factor').value);
  if (isNaN(factor) || factor <= 0) { toast('Fator inválido', 'warn'); return; }
  if (!ui.selection.size) { toast('Selecione objetos para escalar', 'warn'); return; }
  const c = selectionCentroid();
  if (!c) return;
  saveUndo();
  for (const seg of selectedSegs()) {
    seg.points.forEach(p => {
      p.x = c.x + (p.x-c.x)*factor;
      p.y = c.y + (p.y-c.y)*factor;
    });
    if (seg.type === 'circle') seg.radius *= factor;
    if (seg.originalCircle) seg.originalCircle.r *= factor;
  }
  transformAttachedNodes(p => ({
    x: c.x + (p.x-c.x)*factor,
    y: c.y + (p.y-c.y)*factor,
  }));
  refreshAfterEdit();
  toast(`Escala ${factor}× aplicada`, 'success');
}

function applyArray() {
  const count = parseInt(document.getElementById('array-count').value, 10);
  const dx = parseFloat(document.getElementById('array-dx').value) || 0;
  const dy = parseFloat(document.getElementById('array-dy').value) || 0;
  if (isNaN(count) || count < 1) { toast('Quantidade inválida', 'warn'); return; }
  if (!ui.selection.size) { toast('Selecione objetos para copiar', 'warn'); return; }
  saveUndo();
  const originals = selectedSegs().map(s => JSON.parse(JSON.stringify(s)));
  const created = [];
  for (let i = 1; i <= count; i++) {
    for (const src of originals) {
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = state.nextId++;
      copy.selected = false;
      copy.points.forEach(p => { p.x += dx*i; p.y += dy*i; });
      state.segments.push(copy);
      created.push(copy);
    }
  }
  ui.selection.clear();
  created.forEach(c => ui.selection.add(c.id));
  refreshAfterEdit();
  toast(`${created.length} cópia(s) criada(s)`, 'success');
}

// ── EDIÇÃO DE VÉRTICE ─────────────────────────────────────
function findNearestVertex(sx, sy) {
  let best = null, bestD = 9;
  for (const seg of state.segments) {
    for (const v of segVertices(seg)) {
      const sp = w2s(v.pt.x, v.pt.y);
      const d = Math.hypot(sp.x-sx, sp.y-sy);
      if (d < bestD) { bestD = d; best = { seg, idx: v.idx, pt: v.pt }; }
    }
  }
  return best;
}

function vertexEditDown(sx, sy, e) {
  // Clique no selo "E" marca/desmarca a coordenada do vértice.
  const badge = vertexBadgeAt(sx, sy);
  if (badge) { toggleVertexExport(badge.seg, badge.idx); return; }

  const hit = findNearestVertex(sx, sy);
  if (!hit) { setStatus('Clique no selo "E" (ou Ctrl+clique) para marcar coordenada · dblclick insere · Alt+clique remove'); return; }
  if (e.altKey) { removeVertexAt(hit); return; }
  if (e.ctrlKey || e.metaKey || e.shiftKey) { toggleVertexExport(hit.seg, hit.idx); return; }

  saveUndo();
  ui.dragVertex = { segId: hit.seg.id, idx: hit.idx };
  setStatus('Arraste o vértice · clique no selo "E" marca coordenada · Alt+clique remove · dblclick insere');
}

function removeVertexAt(hit) {
  const seg = hit.seg;
  if (seg.type === 'polyline') {
    if (seg.points.length <= 2) { toast('Polilinha precisa de 2 pontos', 'warn'); return; }
    saveUndo();
    seg.points.splice(hit.idx, 1);
    reattachNodes([seg.id]);
    refreshAfterEdit();
    setStatus('Vértice removido');
    return;
  }
  if (seg.type === 'line') { toast('Linha tem apenas 2 vértices', 'warn'); return; }
  toast('Remoção não suportada neste tipo', 'warn');
}

function insertVertexAt(sx, sy) {
  let best = null, bestD = 10;
  for (const seg of state.segments) {
    const d = screenDistToSeg(seg, sx, sy);
    if (d < bestD) { bestD = d; best = seg; }
  }
  if (!best) { setStatus('Clique sobre um segmento'); return; }
  const wp = s2w(sx, sy);

  if (best.type === 'line') {
    const cp = closestPointOnSeg(best, wp.x, wp.y);
    if (cp.t < 0.02 || cp.t > 0.98) { setStatus('Muito perto da extremidade'); return; }
    saveUndo();
    best.type = 'polyline';
    best.points = [{ ...best.points[0] }, { ...cp.pt }, { ...best.points[1] }];
    reattachNodes([best.id]);
    refreshAfterEdit();
    setStatus('Vértice inserido');
    return;
  }

  if (best.type === 'polyline') {
    let bi = -1, bpt = null, bd = Infinity;
    for (let i = 1; i < best.points.length; i++) {
      const a = best.points[i-1], b = best.points[i];
      const dx = b.x-a.x, dy = b.y-a.y, len2 = dx*dx+dy*dy;
      let u = len2 > 1e-12 ? ((wp.x-a.x)*dx + (wp.y-a.y)*dy)/len2 : 0;
      u = Math.max(0, Math.min(1, u));
      const pt = { x: a.x+u*dx, y: a.y+u*dy };
      const d = Math.hypot(wp.x-pt.x, wp.y-pt.y);
      if (d < bd) { bd = d; bi = i; bpt = pt; }
    }
    if (bi < 0) return;
    saveUndo();
    best.points.splice(bi, 0, { ...bpt });
    reattachNodes([best.id]);
    refreshAfterEdit();
    setStatus('Vértice inserido');
    return;
  }

  setStatus('Inserção de vértice disponível para linha/polilinha');
}

// ── HUDs DAS NOVAS FERRAMENTAS ────────────────────────────
function showCoordHud() {
  document.getElementById('coord-hud').classList.remove('hidden');
  setTimeout(() => document.getElementById('coord-x-input').focus(), 20);
}
function hideCoordHud() { document.getElementById('coord-hud').classList.add('hidden'); }

function applyCoordHud() {
  const x = parseFloat(document.getElementById('coord-x-input').value);
  const y = parseFloat(document.getElementById('coord-y-input').value);
  if (isNaN(x) || isNaN(y)) { toast('Coordenadas inválidas', 'warn'); return; }
  const mode = document.getElementById('coord-mode').value;
  let target = { x, y };
  if (mode === 'rel' && ui.lineStart) {
    target = { x: ui.lineStart.x + x, y: ui.lineStart.y + y };
  }
  if (ui.lineStart) commitLine(ui.lineStart, target);
  ui.lineStart = { ...target };
  if (!document.getElementById('polar-hud').classList.contains('hidden')) {
    updatePolarHud();
  }
  updatePanelInfo();
  setStatus(`Coordenada (${target.x.toFixed(2)}, ${target.y.toFixed(2)}) cm`);
  render();
}

function showOffsetHud() { document.getElementById('offset-hud').classList.remove('hidden'); }
function hideOffsetHud() { document.getElementById('offset-hud').classList.add('hidden'); }

function showRotateHud() { document.getElementById('rotate-hud').classList.remove('hidden'); }
function hideRotateHud() { document.getElementById('rotate-hud').classList.add('hidden'); }

function showScaleHud() { document.getElementById('scale-hud').classList.remove('hidden'); }
function hideScaleHud() { document.getElementById('scale-hud').classList.add('hidden'); }

function showArrayHud() { document.getElementById('array-hud').classList.remove('hidden'); }
function hideArrayHud() { document.getElementById('array-hud').classList.add('hidden'); }

function openCoordHud()  { showCoordHud(); }
function openOffsetHud() { showOffsetHud(); }
function openRotateHud() { showRotateHud(); }
function openScaleHud()  { showScaleHud(); }
function openArrayHud()  { showArrayHud(); }

// ── NÓS (ligados a segmento) ──────────────────────────────
function placeNode(sx, sy, kind) {
  // Encontra segmento mais próximo do clique
  let bestSeg = null, bestDist = Infinity;
  for (const seg of state.segments) {
    const d = screenDistToSeg(seg, sx, sy);
    if (d < bestDist) { bestDist = d; bestSeg = seg; }
  }

  if (!bestSeg || bestDist > 18) {
    setStatus('Clique em cima de um segmento para colocar o nó');
    return;
  }

  const wp = s2w(sx, sy);
  const closest = closestPointOnSeg(bestSeg, wp.x, wp.y);

  saveUndo();
  state.nodes[kind] = {
    x:     closest.pt.x,
    y:     closest.pt.y,
    segId: bestSeg.id,
    t:     closest.t,
  };
  state.dijkstraPath = [];
  updateDijkstraPanel();
  render();
  setStatus(`Nó ${kind==='start'?'Início':'Chegada'} fixado ao segmento`);
  setTool('select');
}

// ── COMPRIMENTO DA PISTA (percurso pelos segmentos) ───────
// Calcula a distância total percorrida pelos segmentos que
// ligam o nó início ao nó chegada, passando pela rede de segmentos.
// O comprimento inclui somente os segmentos do caminho,
// descontando os trechos antes do início e após a chegada.
function runTrackAnalysis() {
  state.dijkstraPath = []; // Limpa o destaque anterior

  // Grafo de segmentos conectados por endpoints
  const graph = buildGraph(GRAPH_NODE_MERGE_EPS);
  if (!graph.nodes.length) { toast('Nenhum segmento para analisar', 'warn'); return; }

  if (state.dijkstraMode === 'shortest_path') {
    const ns = state.nodes.start, ne = state.nodes.end;
    if (!ns || !ne) { toast('Defina os nós Início e Chegada em segmentos', 'warn'); render(); return; }

    // Nó gráfico mais próximo do ponto de início/chegada no segmento
    const startSeg = state.segments.find(s => s.id === ns.segId);
    const endSeg   = state.segments.find(s => s.id === ne.segId);
    if (!startSeg || !endSeg) { toast('Segmento do nó não encontrado', 'error'); render(); return; }

    // Endpoints do segmento de início e chegada
    const [sA, sB] = segEndpoints(startSeg);
    const [eA, eB] = segEndpoints(endSeg);

    // Distâncias parciais nos segmentos de borda
    const lenStart = segLength(startSeg);
    const lenEnd   = segLength(endSeg);
    const tS = ns.t, tE = ne.t;
    // Trecho do nó início até o fim do segmento (direção B)
    const dStartToB = lenStart * (1 - tS);
    const dStartToA = lenStart * tS;
    // Trecho do início do segmento de chegada até o nó chegada
    const dAToEnd   = lenEnd * tE;
    const dBToEnd   = lenEnd * (1 - tE);

    // Encontrar os 4 nós de grafo candidatos
    const idxSA = findGraphNode(graph, sA);
    const idxSB = findGraphNode(graph, sB);
    const idxEA = findGraphNode(graph, eA);
    const idxEB = findGraphNode(graph, eB);

    // Tentar todos os pares (sA/sB) → (eA/eB) e pegar menor
    const candidates = [
      { from: idxSA, extraFrom: dStartToA, to: idxEA, extraTo: dAToEnd },
      { from: idxSA, extraFrom: dStartToA, to: idxEB, extraTo: dBToEnd },
      { from: idxSB, extraFrom: dStartToB, to: idxEA, extraTo: dAToEnd },
      { from: idxSB, extraFrom: dStartToB, to: idxEB, extraTo: dBToEnd },
    ];

    let best = null;
    for (const c of candidates) {
      if (c.from < 0 || c.to < 0) continue;
      // Se mesmo segmento de início e chegada
      if (startSeg.id === endSeg.id) {
        const direct = lenStart * Math.abs(tE - tS);
        best = { dist: direct, path: [startSeg.id] };
        break;
      }
      const res = dijkstraGraph(graph, c.from, c.to);
      if (!res) continue;
      const total = c.extraFrom + res.dist + c.extraTo;
      if (!best || total < best.dist) {
        best = { dist: total, path: res.path, extraFrom: c.extraFrom, extraTo: c.extraTo };
      }
    }

    if (!best) {
      toast('Nenhum caminho conectado encontrado', 'error');
      render();
      return;
    }

    const path = best.path.slice();
    if (best.extraFrom > 1e-9 && path[0] !== startSeg.id) path.unshift(startSeg.id);
    if (best.extraTo   > 1e-9 && path[path.length-1] !== endSeg.id) path.push(endSeg.id);

    state.dijkstraPath = path;
    render();

    document.getElementById('dijk-result').classList.remove('hidden');
    document.getElementById('dijk-dist').textContent = best.dist.toFixed(2) + ' cm';
    document.getElementById('dijk-segs').textContent = path.length;
    toast(`Pista: ${best.dist.toFixed(1)} cm · ${path.length} segmentos`, 'success');

  } else if (state.dijkstraMode === 'perimeter_loop') {
    const loopPath = findClosedLoop(graph);
    if (!loopPath || loopPath.length === 0) { toast('Nenhum loop fechado encontrado', 'warn'); render(); return; }

    let perimeter = 0;
    for (const segId of loopPath) {
      const seg = state.segments.find(s => s.id === segId);
      if (seg) perimeter += segLength(seg);
    }

    state.dijkstraPath = loopPath;
    render();

    document.getElementById('dijk-result').classList.remove('hidden');
    document.getElementById('dijk-dist').textContent = perimeter.toFixed(2) + ' cm';
    document.getElementById('dijk-segs').textContent = loopPath.length;
    toast(`Perímetro: ${perimeter.toFixed(1)} cm · ${loopPath.length} segmentos`, 'success');
  }
}

function buildGraph(EPS) {
  const nodes = [], edges = [];

  function nodeIdx(pt) {
    for (let i = 0; i < nodes.length; i++)
      if (Math.hypot(nodes[i].x-pt.x, nodes[i].y-pt.y) < EPS) return i;
    nodes.push({ x: pt.x, y: pt.y });
    return nodes.length - 1;
  }

  for (const seg of state.segments) {
    for (const e of segEdgeList(seg)) {
      const a = nodeIdx(e.a), b = nodeIdx(e.b);
      edges.push({ from: a, to: b, weight: e.w, segId: seg.id });
      edges.push({ from: b, to: a, weight: e.w, segId: seg.id });
    }
  }
  return { nodes, edges };
}

function findGraphNode(graph, pt) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const d = Math.hypot(graph.nodes[i].x-pt.x, graph.nodes[i].y-pt.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Acha um loop simples no grafo de segmentos e retorna os IDs dos segmentos
function findClosedLoop(graph) {
  const n = graph.nodes.length;
  const visited = Array(n).fill(false);
  const pathStack = [];
  let loopSegments = null;

  function dfs(u, incomingSegId, parentNodeIdx) {
    visited[u] = true;
    pathStack.push({ nodeIdx: u, segId: incomingSegId });

    for (const edge of graph.edges.filter(e => e.from === u)) {
      const v = edge.to;
      const segId = edge.segId;

      if (segId === incomingSegId && v === parentNodeIdx) continue;
      if (v === u) continue;

      if (visited[v]) {
        const cycleStartIndex = pathStack.findIndex(item => item.nodeIdx === v);
        if (cycleStartIndex !== -1) {
          const loop = [];
          for (let i = cycleStartIndex; i < pathStack.length; i++) {
            if (pathStack[i].segId) loop.push(pathStack[i].segId);
          }
          loop.push(segId);
          loopSegments = [...new Set(loop)];
          return true;
        }
      }

      if (dfs(v, segId, u)) return true;
    }

    pathStack.pop();
    return false;
  }

  for (let i = 0; i < n; i++) {
    if (!visited[i] && dfs(i, null, -1)) {
      break;
    }
  }

  return loopSegments;
}

function dijkstraGraph(graph, src, dst) {
  const n    = graph.nodes.length;
  const dist = Array(n).fill(Infinity);
  const prev = Array(n).fill(-1);
  const pseg = Array(n).fill(-1);
  const vis  = Array(n).fill(false);
  dist[src]  = 0;
  const pq   = [{ node: src, d: 0 }];

  while (pq.length) {
    pq.sort((a,b) => a.d - b.d);
    const { node: u } = pq.shift();
    if (vis[u]) continue;
    vis[u] = true;
    if (u === dst) break;
    for (const e of graph.edges) {
      if (e.from !== u) continue;
      const nd = dist[u] + e.weight;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = u;
        pseg[e.to] = e.segId;
        pq.push({ node: e.to, d: nd });
      }
    }
  }

  if (dist[dst] === Infinity) return null;

  const path = [];
  let cur = dst;
  while (cur !== src && cur !== -1) {
    const id = pseg[cur];
    if (id !== -1 && path[0] !== id) path.unshift(id);
    cur = prev[cur];
  }
  return { dist: dist[dst], path };
}

// ── SELEÇÃO ───────────────────────────────────────────────
function handleSelectDown(sx, sy, e) {
  let hit = null;
  for (let i = state.segments.length-1; i >= 0; i--) {
    if (screenDistToSeg(state.segments[i], sx, sy) < 7) {
      hit = state.segments[i]; break;
    }
  }

  if (hit) {
    if (e.ctrlKey) {
      ui.selection.has(hit.id) ? ui.selection.delete(hit.id) : ui.selection.add(hit.id);
    } else {
      if (!ui.selection.has(hit.id)) {
        ui.selection.clear();
        ui.selection.add(hit.id);
      } else {
        // Já selecionado → inicia arrasto (estilo AutoCAD)
        if (startMoveDrag(s2w(sx, sy))) return;
      }
    }
  } else {
    if (!e.ctrlKey) ui.selection.clear();
    ui.boxSelStart = { x: sx, y: sy };
  }
  updateSelectionPanel();
  render();
}

function selectInBox(x0,y0,x1,y1) {
  const minX=Math.min(x0,x1), maxX=Math.max(x0,x1);
  const minY=Math.min(y0,y1), maxY=Math.max(y0,y1);
  state.segments.forEach(seg => {
    const pts = segSnapPoints(seg);
    if (!pts.length) return;
    const inside = pts.every(ep => {
      const sp = w2s(ep.x, ep.y);
      return sp.x>=minX && sp.x<=maxX && sp.y>=minY && sp.y<=maxY;
    });
    if (inside) ui.selection.add(seg.id);
  });
}

function deleteSelection() {
  if (!ui.selection.size) return;
  saveUndo();
  // remover nós ligados a segmentos deletados
  ['start','end'].forEach(k => {
    if (state.nodes[k] && ui.selection.has(state.nodes[k].segId))
      state.nodes[k] = null;
  });
  state.segments = state.segments.filter(s => !ui.selection.has(s.id));
  ui.selection.clear();
  state.dijkstraPath = [];
  updatePanelInfo();
  updateSelectionPanel();
  updateDijkstraPanel();
  render();
  toast('Excluído');
}

function selectAll() {
  state.segments.forEach(s => ui.selection.add(s.id));
  updateSelectionPanel();
  render();
}

// ── MOVER POR ARRASTO (objetos selecionados) ──────────────
function translateSeg(seg, dx, dy) {
  seg.points.forEach(p => { p.x += dx; p.y += dy; });
  if (seg.originalCircle && seg.originalCircle.c) {
    seg.originalCircle.c.x += dx;
    seg.originalCircle.c.y += dy;
  }
}

function cloneTranslated(seg, dx, dy) {
  const c = JSON.parse(JSON.stringify(seg));
  translateSeg(c, dx, dy);
  return c;
}

// Centro da caixa envolvente dos segmentos (âncora de colagem)
function segmentsAnchor(segs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const seg of segs) {
    seg.points.forEach(p => add(p.x, p.y));
    if (seg.type === 'circle') {
      add(seg.points[0].x - seg.radius, seg.points[0].y - seg.radius);
      add(seg.points[0].x + seg.radius, seg.points[0].y + seg.radius);
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function startMoveDrag(wp) {
  if (!ui.selection.size) return false;
  const ids = new Set(ui.selection);
  const originals = new Map();
  state.segments.forEach(seg => {
    if (ids.has(seg.id)) originals.set(seg.id, JSON.parse(JSON.stringify(seg)));
  });
  const nodeOriginals = {};
  ['start', 'end'].forEach(k => {
    const n = state.nodes[k];
    nodeOriginals[k] = (n && ids.has(n.segId)) ? { x: n.x, y: n.y } : null;
  });
  ui.dragMove = {
    ids, originals, nodeOriginals,
    start: { x: wp.x, y: wp.y },
    last:  { x: wp.x, y: wp.y },
    moved: false,
    undoPushed: false,
  };
  canvas.classList.add('cursor-move');
  return true;
}

function updateMoveDrag(wp) {
  const d = ui.dragMove;
  if (!d) return;
  // Ponto de destino: ímã magnético ou cursor com restrição de eixo/ângulo
  const target = ui.snapTarget ? { ...ui.snapTarget } : pointFromConstraint(d.start, { x: wp.x, y: wp.y });
  const dx = target.x - d.start.x;
  const dy = target.y - d.start.y;

  if (!d.moved && Math.hypot(dx, dy) < 1e-9) return;

  // Primeiro movimento real: registra undo uma única vez
  if (!d.moved) {
    saveUndo();
    d.moved = true;
    d.undoPushed = true;
  }

  for (const [id, orig] of d.originals) {
    const seg = state.segments.find(s => s.id === id);
    if (!seg) continue;
    seg.points = orig.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    if (orig.originalCircle) {
      seg.originalCircle = {
        c: { x: orig.originalCircle.c.x + dx, y: orig.originalCircle.c.y + dy },
        r: orig.originalCircle.r,
      };
    }
  }
  ['start', 'end'].forEach(k => {
    const o = d.nodeOriginals[k];
    if (!o) return;
    const n = state.nodes[k];
    if (n) { n.x = o.x + dx; n.y = o.y + dy; }
  });
  d.last = { x: target.x, y: target.y };
}

function finishMoveDrag() {
  const d = ui.dragMove;
  if (!d) return;
  ui.dragMove = null;
  canvas.classList.remove('cursor-move');
  if (!d.moved) { render(); return; }
  state.dijkstraPath = [];
  reattachNodes([...d.ids]);
  updatePanelInfo();
  updateSelectionPanel();
  render();
  setStatus('Objeto(s) movido(s)');
}

function cancelMoveDrag() {
  const d = ui.dragMove;
  if (!d) return false;
  // Remove o undo registrado no início do arrasto
  if (d.undoPushed) state.undoStack.pop();
  // Restaura posições originais
  for (const [id, orig] of d.originals) {
    const idx = state.segments.findIndex(s => s.id === id);
    if (idx >= 0) {
      const live = state.segments[idx];
      const fresh = JSON.parse(JSON.stringify(orig));
      Object.assign(live, fresh);
    }
  }
  ['start', 'end'].forEach(k => {
    const o = d.nodeOriginals[k];
    if (!o) return;
    const n = state.nodes[k];
    if (n) { n.x = o.x; n.y = o.y; }
  });
  ui.dragMove = null;
  canvas.classList.remove('cursor-move');
  render();
  setStatus('Movimento cancelado');
  return true;
}

// ── COPIAR / COLAR (estilo AutoCAD) ───────────────────────
function copySelection() {
  if (!ui.selection.size) { toast('Selecione objetos para copiar', 'warn'); return false; }
  const segs = state.segments
    .filter(s => ui.selection.has(s.id))
    .map(s => JSON.parse(JSON.stringify(s)));
  ui.clipboard = { segs, anchor: segmentsAnchor(segs) };
  toast(`${segs.length} objeto(s) copiado(s)`, 'success');
  return true;
}

function startPasteMode() {
  if (!ui.clipboard || !ui.clipboard.segs.length) {
    toast('Nada para colar', 'warn');
    return false;
  }
  if (ui.dragMove) finishMoveDrag();
  // Fantasma já nasce sob o cursor (estilo PASTECLIP do AutoCAD)
  const cursor = ui.snapTarget ? { ...ui.snapTarget } : { ...ui.mouseWorld };
  ui.pasteMode = {
    segs: JSON.parse(JSON.stringify(ui.clipboard.segs)),
    anchor: { ...ui.clipboard.anchor },
    offset: {
      x: cursor.x - ui.clipboard.anchor.x,
      y: cursor.y - ui.clipboard.anchor.y,
    },
  };
  setStatus('Clique para colar · Enter confirma no cursor · Esc cancela');
  render();
  return true;
}

function updatePasteOffset(wp) {
  const pm = ui.pasteMode;
  if (!pm) return;
  const target = ui.snapTarget ? { ...ui.snapTarget } : { x: wp.x, y: wp.y };
  pm.offset = { x: target.x - pm.anchor.x, y: target.y - pm.anchor.y };
}

function commitPaste() {
  const pm = ui.pasteMode;
  if (!pm) return false;
  saveUndo();
  const created = [];
  for (const src of pm.segs) {
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = state.nextId++;
    copy.selected = false;
    translateSeg(copy, pm.offset.x, pm.offset.y);
    state.segments.push(copy);
    created.push(copy);
  }
  ui.selection.clear();
  created.forEach(c => ui.selection.add(c.id));
  ui.pasteMode = null;
  refreshAfterEdit();
  toast(`${created.length} objeto(s) colado(s)`, 'success');
  return true;
}

function cancelPaste() {
  if (!ui.pasteMode) return false;
  ui.pasteMode = null;
  render();
  setStatus('Colagem cancelada');
  return true;
}

// ── MOVER COM PRECISÃO ────────────────────────────────────
function openMoveHud() {
  if (!ui.selection.size) { toast('Selecione segmentos para mover', 'warn'); return; }
  document.getElementById('move-dist-input').value  = '';
  document.getElementById('move-angle-input').value = '0';
  document.getElementById('move-hud').classList.remove('hidden');
  document.getElementById('move-dist-input').focus();
  setStatus('Digite distância e ângulo · Enter para aplicar');
}

function applyPrecisionMove() {
  const dist  = parseFloat(document.getElementById('move-dist-input').value);
  const angle = parseFloat(document.getElementById('move-angle-input').value) || 0;
  if (isNaN(dist) || dist <= 0) { toast('Distância inválida', 'warn'); return; }

  const rad = angle * Math.PI / 180;
  const dx  = dist * Math.cos(rad);
  const dy  = -dist * Math.sin(rad); // Y invertido no canvas

  saveUndo();
  state.segments.forEach(seg => {
    if (!ui.selection.has(seg.id)) return;
    seg.points.forEach(pt => { pt.x += dx; pt.y += dy; });
  });
  // atualizar nós ligados
  ['start','end'].forEach(k => {
    const n = state.nodes[k];
    if (!n || !ui.selection.has(n.segId)) return;
    n.x += dx; n.y += dy;
  });

  hideMoveHud();
  state.dijkstraPath = [];
  updatePanelInfo();
  render();
  toast(`Movido ${dist}cm a ${angle}°`, 'success');
}

function hideMoveHud() {
  document.getElementById('move-hud').classList.add('hidden');
}

// ── ALERTAS CRÍTICOS ─────────────────────────────────────
function findCriticalVertices() {
  const EPS = 0.5;
  const map = new Map();
  for (const seg of state.segments) {
    segEndpoints(seg).forEach(ep => {
      const key = `${Math.round(ep.x/EPS)},${Math.round(ep.y/EPS)}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ seg, ep });
    });
  }
  const crits = [];
  for (const [, list] of map) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++)
      for (let j = i+1; j < list.length; j++) {
        const ang = angleBetweenSegs(list[i].seg, list[i].ep, list[j].seg, list[j].ep);
        if (ang < CRIT_ANGLE) crits.push({ pt: list[i].ep, angle: ang });
      }
  }
  return crits;
}

function angleBetweenSegs(segA, vA, segB, vB) {
  function dir(seg, v) {
    const eps = segEndpoints(seg);
    const other = Math.hypot(eps[0].x-v.x, eps[0].y-v.y) < 0.5 ? eps[1] : eps[0];
    const len = Math.hypot(other.x-v.x, other.y-v.y);
    if (len < 0.001) return { x:1, y:0 };
    return { x:(other.x-v.x)/len, y:(other.y-v.y)/len };
  }
  const dA = dir(segA, vA), dB = dir(segB, vB);
  const dot = Math.min(1, Math.max(-1, dA.x*dB.x + dA.y*dB.y));
  return Math.acos(dot) * 180 / Math.PI;
}

// ── RENDER ────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0a0a0c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state.showGrid)    drawGrid();
  drawWorkspaceBorder();
  const dzViolations = findDeadzoneViolations();
  drawDeadzone(dzViolations);
  drawDeadzoneAlerts(dzViolations);
  drawSegments();
  drawCircleQuadrants();
  drawVertexHandles();
  drawVertexCoordLeader();
  drawNodes();
  if (state.showCritical) drawCriticalAlerts();
  drawPreview();
  drawMagneticIndicator();
}

function drawGrid() {
  const minorPx = cm2px(1);
  const majorPx = cm2px(10);

  if (minorPx > 5) {
    ctx.strokeStyle = 'rgba(255,255,255,0.015)';
    ctx.lineWidth = 0.5;
    drawGridLines(minorPx);
  }
  if (majorPx > 3) {
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 0.5;
    drawGridLines(majorPx);
  }

  const ox = w2s(0,0);
  ctx.strokeStyle = 'rgba(232,0,61,0.2)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(ox.x,0); ctx.lineTo(ox.x, canvas.height);
  ctx.moveTo(0,ox.y); ctx.lineTo(canvas.width, ox.y);
  ctx.stroke();
}

function drawGridLines(cellPx) {
  // Fase ancorada ao mundo: a linha de grade k fica em x = k*cellPx + cam.x.
  // Módulo positivo garante o mesmo reticulado ao mover/zoom da câmera.
  const sx = ((cam.x % cellPx) + cellPx) % cellPx;
  const sy = ((cam.y % cellPx) + cellPx) % cellPx;
  ctx.beginPath();
  for (let x = sx; x < canvas.width;  x += cellPx) { ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); }
  for (let y = sy; y < canvas.height; y += cellPx) { ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); }
  ctx.stroke();
}

function drawWorkspaceBorder() {
  const tl = w2s(0, 0);
  const br = w2s(state.workspace.w, state.workspace.h);
  ctx.strokeStyle = 'rgba(232,0,61,0.35)';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(tl.x, tl.y, br.x-tl.x, br.y-tl.y);
  ctx.setLineDash([]);

  ctx.font = `${Math.max(9, 11*cam.scale)}px JetBrains Mono, monospace`;
  ctx.fillStyle = 'rgba(232,0,61,0.5)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${state.workspace.w}×${state.workspace.h} cm`, tl.x+4, tl.y-3);
}

function drawDeadzone(violations) {
  const r = deadzoneRect();
  const countEl = document.getElementById('info-dz-count');
  if (countEl) countEl.textContent = violations.length;
  if (r.dz <= 0) return;

  const tl = w2s(r.x0, r.y0);
  const br = w2s(r.x1, r.y1);
  const alert = violations.length > 0;
  ctx.save();
  ctx.strokeStyle = alert ? 'rgba(255,71,87,0.65)' : 'rgba(255,200,0,0.28)';
  ctx.lineWidth   = alert ? 1.5 : 1;
  ctx.setLineDash([4, 5]);
  ctx.strokeRect(tl.x, tl.y, br.x-tl.x, br.y-tl.y);
  ctx.setLineDash([]);

  ctx.font = `${Math.max(8, 9*cam.scale)}px JetBrains Mono, monospace`;
  ctx.fillStyle = alert ? 'rgba(255,71,87,0.85)' : 'rgba(255,200,0,0.5)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const label = alert
    ? `DEADZONE ${r.dz} cm · ${violations.length} trecho(s)`
    : `Zona de segurança ${r.dz} cm`;
  ctx.fillText(label, tl.x+4, tl.y-3);
  ctx.restore();
}

function drawDeadzoneAlerts(violations) {
  if (!violations.length) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,71,87,0.35)';
  ctx.lineWidth   = Math.max(6, cm2px(state.lineWidth) + 6);
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.shadowColor = 'rgba(255,71,87,0.5)';
  ctx.shadowBlur  = 12;
  for (const seg of violations) strokeSegPath(seg);
  ctx.restore();
}

function drawSegments() {
  const lineWidthPx = cm2px(state.lineWidth);

  for (const seg of state.segments) {
    const inPath = state.dijkstraPath.includes(seg.id);
    const sel    = ui.selection.has(seg.id);
    const baseW  = Math.max(0.5, 1.5 * cam.scale);
    const isConstruction = seg.type === 'line' && seg.isConstruction;

    // Linha de construção — estilo próprio, não entra na faixa de largura
    if (isConstruction) {
      ctx.save();
      ctx.strokeStyle = sel ? '#ff00ff' : '#ff00ffcc'; // magenta
      ctx.lineWidth   = Math.max(0.5, 0.75 * cam.scale);
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.setLineDash([8 * cam.scale, 8 * cam.scale]);
      strokeSegPath(seg);
      ctx.setLineDash([]);
      ctx.restore();
      // Endpoints magnéticos para snap
      drawEndpoints(seg, sel);
      continue;
    }

    // Faixa de largura (visualização da largura real da linha)
    if (lineWidthPx > 2) {
      ctx.save();
      ctx.strokeStyle = sel
        ? 'rgba(255,255,255,0.07)'
        : inPath
          ? 'rgba(255,255,255,0.06)'
          : 'rgba(74,158,255,0.05)';
      ctx.lineWidth = lineWidthPx;
      ctx.lineCap   = 'round';
      ctx.lineJoin  = 'round';
      strokeSegPath(seg);
      ctx.restore();
    }

    // Linha central
    ctx.save();
    if (sel) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = baseW + 1.5;
      ctx.shadowColor = 'rgba(255,255,255,0.35)';
      ctx.shadowBlur  = 6;
    } else if (inPath) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = baseW + 1;
      ctx.shadowColor = 'rgba(255,255,255,0.45)';
      ctx.shadowBlur  = 8;
    } else {
      ctx.strokeStyle = '#4a9eff';
      ctx.lineWidth   = baseW;
      ctx.shadowBlur  = 0;
    }
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
    strokeSegPath(seg);
    ctx.restore();

    // Pontos extremo (endpoints magnéticos)
    drawEndpoints(seg, sel);

    // Cotas
    if (seg.type === 'line' && segLength(seg) >= MIN_COTA_CM)
      drawDimension(seg);
  }
}

function strokeSegPath(seg) {
  ctx.beginPath();
  if (seg.type === 'line') {
    const p0 = w2s(seg.points[0].x, seg.points[0].y);
    const p1 = w2s(seg.points[1].x, seg.points[1].y);
    ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
  } else if (seg.type === 'arc') {
    const g = arcGeometry(seg);
    if (g) {
      const N = Math.max(24, Math.min(120, Math.ceil(Math.abs(g.sweep) * 18)));
      for (let i = 0; i <= N; i++) {
        const wp = arcPointAt(seg, i / N);
        const sp = w2s(wp.x, wp.y);
        if (i === 0) ctx.moveTo(sp.x, sp.y);
        else         ctx.lineTo(sp.x, sp.y);
      }
    } else {
      const sp0 = w2s(seg.points[0].x, seg.points[0].y);
      const sp1 = w2s(seg.points[2].x, seg.points[2].y);
      ctx.moveTo(sp0.x, sp0.y); ctx.lineTo(sp1.x, sp1.y);
    }
  } else if (seg.type === 'polyline') {
    for (let i = 0; i < seg.points.length; i++) {
      const sp = w2s(seg.points[i].x, seg.points[i].y);
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else         ctx.lineTo(sp.x, sp.y);
    }
  } else if (seg.type === 'circle') {
    const c = w2s(seg.points[0].x, seg.points[0].y);
    ctx.arc(c.x, c.y, cm2px(seg.radius), 0, Math.PI*2);
  }
  ctx.stroke();
}

function drawEndpoints(seg, sel) {
  let pts = segEndpoints(seg);
  if (seg.type === 'polyline') pts = seg.points;
  if (seg.type === 'circle')   pts = seg.points.slice(0, 1);
  pts.forEach(ep => {
    const sp = w2s(ep.x, ep.y);
    // anel externo
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, sel ? 5 : 4, 0, Math.PI*2);
    ctx.strokeStyle = sel ? '#ffffff' : 'rgba(74,158,255,0.6)';
    ctx.lineWidth   = 1.2;
    ctx.stroke();
    // ponto interno
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 2, 0, Math.PI*2);
    ctx.fillStyle = sel ? '#ffffff' : '#4a9eff';
    ctx.fill();
  });

  // Desenha o centro do círculo original para arcos aparados (referência de construção)
  if (seg.type === 'arc' && seg.originalCircle) {
    const center = seg.originalCircle.c;
    const sp = w2s(center.x, center.y);
    // Cruz central (estilo AutoCAD center mark)
    const size = sel ? 8 : 6;
    ctx.beginPath();
    ctx.moveTo(sp.x - size, sp.y);
    ctx.lineTo(sp.x + size, sp.y);
    ctx.moveTo(sp.x, sp.y - size);
    ctx.lineTo(sp.x, sp.y + size);
    ctx.strokeStyle = sel ? '#ffffff' : 'rgba(255,224,102,0.8)';
    ctx.lineWidth = sel ? 1.5 : 1;
    ctx.stroke();
    // Ponto central
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 2, 0, Math.PI*2);
    ctx.fillStyle = sel ? '#ffffff' : '#ffe066';
    ctx.fill();
  }
}

// ── QUADRANTES VISÍVEIS DOS CÍRCULOS (N/L/S/O) ────────────
function drawCircleQuadrants() {
  if (!state.showCircleQuads) return;
  const activeSide = (ui.tool === 'circle' && ui.circleMode === 'side') ? ui.circleSide : null;

  for (const seg of state.segments) {
    if (seg.type !== 'circle') continue;
    const r = seg.radius || (seg.originalCircle ? seg.originalCircle.r : 0);
    if (cm2px(r) < 4) continue;
    for (const q of circleQuadrantPoints(seg)) {
      const sp = w2s(q.x, q.y);
      const active = q.side === activeSide;
      const rad = active ? 5.5 : 4;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y - rad);
      ctx.lineTo(sp.x + rad, sp.y);
      ctx.lineTo(sp.x, sp.y + rad);
      ctx.lineTo(sp.x - rad, sp.y);
      ctx.closePath();
      ctx.fillStyle   = active ? 'rgba(255,224,102,0.95)' : 'rgba(10,10,12,0.75)';
      ctx.fill();
      ctx.strokeStyle = active ? '#ffe066' : 'rgba(255,224,102,0.85)';
      ctx.lineWidth   = active ? 1.8 : 1.1;
      ctx.stroke();

      const s = CIRCLE_SIDES[q.side];
      ctx.font         = '700 9px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle    = active ? '#ffe066' : 'rgba(255,224,102,0.7)';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.letter, sp.x + s.dx * 11, sp.y + s.dy * 11);
      ctx.restore();
    }
  }
}

// ── MARCAÇÃO DE COORDENADAS POR VÉRTICE ───────────────────
// Todo vértice começa "cinza" (ignorado); exportCoord === true o marca.
const BADGE_OFFSET = { x: 11, y: -11 };
const BADGE_R = 6;

function coordExportEnabled(pt) {
  return !!pt && pt.exportCoord === true;
}

function toggleVertexExport(seg, idx) {
  const pt = seg.points[idx];
  if (!pt) return;
  saveUndo();
  pt.exportCoord = !coordExportEnabled(pt);
  state.dijkstraPath = [];
  updatePanelInfo();
  updateSelectionPanel();
  render();
  toast(pt.exportCoord
    ? `Coordenada marcada: (${pt.x.toFixed(2)}, ${pt.y.toFixed(2)})`
    : 'Coordenada desmarcada', pt.exportCoord ? 'success' : '');
  setStatus(pt.exportCoord
    ? 'Coordenada marcada · Ctrl+clique alterna · Alt+clique remove'
    : 'Coordenada desmarcada · Ctrl+clique alterna');
}

function vertexBadgeScreen(sp) {
  return { x: sp.x + BADGE_OFFSET.x, y: sp.y + BADGE_OFFSET.y };
}

function vertexBadgeAt(sx, sy) {
  let best = null, bestD = BADGE_R + 4;
  for (const seg of state.segments) {
    for (const v of segVertices(seg)) {
      const sp = w2s(v.pt.x, v.pt.y);
      const bp = vertexBadgeScreen(sp);
      const d = Math.hypot(bp.x - sx, bp.y - sy);
      if (d < bestD) { bestD = d; best = { seg, idx: v.idx, pt: v.pt }; }
    }
  }
  return best;
}

function drawVertexHandles() {
  if (ui.tool !== 'vertex-edit') return;

  for (const seg of state.segments) {
    for (const v of segVertices(seg)) {
      const sp = w2s(v.pt.x, v.pt.y);
      const on = coordExportEnabled(v.pt);

      // Handle do vértice
      ctx.save();
      ctx.fillStyle   = 'rgba(255,224,102,0.15)';
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.rect(sp.x-4, sp.y-4, 8, 8);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Badge clicável: verde = coordenada marcada, cinza = desmarcada
      const bp = vertexBadgeScreen(sp);
      ctx.save();
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, BADGE_R, 0, Math.PI * 2);
      if (on) {
        ctx.fillStyle   = '#00cc66';
        ctx.strokeStyle = '#eafff2';
      } else {
        ctx.fillStyle   = 'rgba(20,24,30,0.92)';
        ctx.strokeStyle = 'rgba(180,190,205,0.75)';
      }
      ctx.lineWidth = 1.4;
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle    = on ? '#04240f' : 'rgba(200,210,225,0.9)';
      ctx.font         = 'bold 9px JetBrains Mono, monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('E', bp.x, bp.y + 0.5);
      ctx.restore();
    }
  }
}

function drawVertexCoordLeader() {
  if (!state.showVertexCoords) return;

  const labels = [];
  const placed = [];
  const pxPerWorld = PX_PER_CM * cam.scale;

  ctx.save();
  ctx.font = '600 12px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  const entries = [];
  for (const seg of state.segments) {
    for (const pt of seg.points) {
      if (coordExportEnabled(pt)) entries.push(pt);
    }
  }

  for (const pt of entries) {
    const sp = w2s(pt.x, pt.y);
    const text = `(${pt.x.toFixed(2)}, ${pt.y.toFixed(2)})`;
    const w = Math.max(74, ctx.measureText(text).width + 16);
    const h = 21;
    const gap = 16;

    // Quatro quadrantes ao redor do vértice. A etiqueta fica sempre FORA da linha.
    const dirs = [
      { x:  1, y: -1 },
      { x: -1, y: -1 },
      { x: -1, y:  1 },
      { x:  1, y:  1 },
    ];

    let best = null;
    for (const d of dirs) {
      const bx = d.x > 0 ? sp.x + gap : sp.x - gap - w;
      const by = d.y > 0 ? sp.y + gap : sp.y - gap - h;

      // Folga até a geometria (em px de tela): quanto maior, melhor.
      let minDist = Infinity;
      const probes = [
        { x: bx + w * 0.5, y: by + h * 0.5 },
        { x: bx + 6,       y: by + 6 },
        { x: bx + w - 6,   y: by + h - 6 },
      ];
      for (const probe of probes) {
        const wp = s2w(probe.x, probe.y);
        for (const s of state.segments) {
          const cp = closestPointOnSeg(s, wp.x, wp.y);
          const dpx = cp.dist * pxPerWorld;
          if (dpx < minDist) minDist = dpx;
        }
      }
      let score = Math.min(minDist, 160);

      // Penaliza sobreposição com outras etiquetas já posicionadas.
      for (const b of placed) {
        const overlap = !(bx + w < b.x || bx > b.x + b.w || by + h < b.y || by > b.y + b.h);
        if (overlap) score -= 600;
      }
      // Mantém a etiqueta dentro da viewport (desconta a barra de status inferior).
      if (bx < 6 || by < 6 || bx + w > canvas.width - 6 || by + h > canvas.height - 36) {
        score -= 250;
      }

      if (!best || score > best.score) best = { score, bx, by };
    }

    placed.push({ x: best.bx, y: best.by, w, h });
    labels.push({ sp, text, w, h, bx: best.bx, by: best.by });
  }

  for (const L of labels) {
    // Ponto de ancoragem na borda da caixa mais próxima do vértice.
    const ax = Math.max(L.bx + 5, Math.min(L.sp.x, L.bx + L.w - 5));
    const ay = Math.max(L.by + 5, Math.min(L.sp.y, L.by + L.h - 5));

    ctx.strokeStyle = 'rgba(74,158,255,0.95)';
    ctx.fillStyle   = 'rgba(74,158,255,0.95)';
    ctx.lineWidth   = 1.2;
    ctx.lineJoin    = 'round';

    // Linha de chamada (leader) do vértice até a etiqueta.
    ctx.beginPath();
    ctx.moveTo(L.sp.x, L.sp.y);
    ctx.lineTo(ax, ay);
    ctx.stroke();

    // Marcador no vértice.
    ctx.beginPath();
    ctx.arc(L.sp.x, L.sp.y, 2.2, 0, Math.PI * 2);
    ctx.fill();

    // Caixa de texto com fundo sólido e legível.
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(L.bx + r, L.by);
    ctx.lineTo(L.bx + L.w - r, L.by);
    ctx.arcTo(L.bx + L.w, L.by, L.bx + L.w, L.by + r, r);
    ctx.lineTo(L.bx + L.w, L.by + L.h - r);
    ctx.arcTo(L.bx + L.w, L.by + L.h, L.bx + L.w - r, L.by + L.h, r);
    ctx.lineTo(L.bx + r, L.by + L.h);
    ctx.arcTo(L.bx, L.by + L.h, L.bx, L.by + L.h - r, r);
    ctx.lineTo(L.bx, L.by + r);
    ctx.arcTo(L.bx, L.by, L.bx + r, L.by, r);
    ctx.closePath();
    ctx.fillStyle   = 'rgba(9,12,18,0.94)';
    ctx.strokeStyle = 'rgba(74,158,255,0.95)';
    ctx.lineWidth   = 1.1;
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle    = '#eaf2ff';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.font         = '600 12px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText(L.text, L.bx + L.w / 2, L.by + L.h / 2 + 0.5);
  }

  ctx.restore();
}

function drawDimension(seg) {
  const p0 = seg.points[0], p1 = seg.points[1];
  const sp0 = w2s(p0.x, p0.y), sp1 = w2s(p1.x, p1.y);
  const mx = (sp0.x+sp1.x)/2, my = (sp0.y+sp1.y)/2;
  const dx = sp1.x-sp0.x, dy = sp1.y-sp0.y;
  const nd = Math.hypot(dx,dy) || 1;
  const ox = -dy/nd*14, oy = dx/nd*14;
  ctx.save();
  ctx.font = `${Math.max(8, 9*cam.scale)}px JetBrains Mono, monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${segLength(seg).toFixed(2)}cm`, mx+ox, my+oy);
  ctx.restore();
}

function drawNodes() {
  const configs = [
    { key:'start', color:'#00ff87', label:'S' },
    { key:'end',   color:'#ff4757', label:'E' },
  ];
  for (const { key, color, label } of configs) {
    const n = state.nodes[key];
    if (!n) continue;
    const sp = w2s(n.x, n.y);
    const r  = 10;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI*2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 14;
    ctx.stroke();
    ctx.shadowBlur  = 0;
    ctx.fillStyle = `${color}22`;
    ctx.fill();
    ctx.font = 'bold 10px JetBrains Mono, monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, sp.x, sp.y);

    // linha tracejada ligando ao segmento
    const seg = state.segments.find(s => s.id === n.segId);
    if (seg) {
      ctx.strokeStyle = `${color}44`;
      ctx.lineWidth   = 0.8;
      ctx.setLineDash([3,3]);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r+3, 0, Math.PI*2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawCriticalAlerts() {
  const crits = findCriticalVertices();
  document.getElementById('info-crit-count').textContent = crits.length;
  for (const c of crits) {
    const sp = w2s(c.pt.x, c.pt.y);
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 16, 0, Math.PI*2);
    ctx.strokeStyle = '#ff6b35';
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = '#ff6b35';
    ctx.shadowBlur  = 10;
    ctx.stroke();
    ctx.shadowBlur  = 0;
    ctx.font = 'bold 9px Barlow Condensed, sans-serif';
    ctx.fillStyle = '#ff6b35';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${c.angle.toFixed(0)}°`, sp.x, sp.y-22);
  }
}

function drawPreview() {
  const wp = ui.mouseWorld;
  const pt = ui.snapTarget ? { ...ui.snapTarget } : { ...wp };

  // Prévia de colagem (fantasma seguindo o cursor)
  if (ui.pasteMode) {
    const off = ui.pasteMode.offset;
    ctx.save();
    ctx.globalAlpha  = 0.6;
    ctx.strokeStyle  = '#ffe066';
    ctx.lineWidth    = Math.max(0.5, 1.5 * cam.scale);
    ctx.lineCap      = 'round';
    ctx.lineJoin     = 'round';
    ctx.setLineDash([7 * cam.scale, 5 * cam.scale]);
    for (const src of ui.pasteMode.segs) {
      strokeSegPath(cloneTranslated(src, off.x, off.y));
    }
    ctx.setLineDash([]);
    ctx.restore();
    // Ponto de encaixe (âncora da colagem)
    const ap = w2s(ui.pasteMode.anchor.x + off.x, ui.pasteMode.anchor.y + off.y);
    ctx.beginPath();
    ctx.arc(ap.x, ap.y, 3, 0, Math.PI*2);
    ctx.fillStyle = '#ffe066';
    ctx.fill();
  }

  if (ui.tool === 'line' && ui.lineStart) {
    const end = ui.snapTarget ? pt : pointFromConstraint(ui.lineStart, pt);
    drawDashedLine(ui.lineStart, end, 'rgba(74,158,255,0.45)');
    drawMeasureLabel(ui.lineStart, end);
  }

  if (ui.tool === 'polyline' && ui.polyPoints.length) {
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(74,158,255,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    const first = w2s(ui.polyPoints[0].x, ui.polyPoints[0].y);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < ui.polyPoints.length; i++) {
      const sp = w2s(ui.polyPoints[i].x, ui.polyPoints[i].y);
      ctx.lineTo(sp.x, sp.y);
    }
    const last = ui.polyPoints[ui.polyPoints.length-1];
    const end  = ui.snapTarget ? pt : pointFromConstraint(last, pt);
    const esp  = w2s(end.x, end.y);
    ctx.lineTo(esp.x, esp.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawMeasureLabel(last, end);
    ui.polyPoints.forEach(p => {
      const sp = w2s(p.x, p.y);
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 3, 0, Math.PI*2);
      ctx.fillStyle = '#4a9eff'; ctx.fill();
    });
  }

  if (ui.tool === 'spiral') {
    const p   = readSpiralParams();
    const pts = buildSpiralPoints(p.center, p);
    if (pts.length > 1) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(74,158,255,0.6)';
      ctx.lineWidth   = 1.5;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      const s0 = w2s(pts[0].x, pts[0].y);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < pts.length; i++) {
        const sp = w2s(pts[i].x, pts[i].y);
        ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // Marca o centro da espiral
      const c = w2s(p.center.x, p.center.y);
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(c.x-6, c.y); ctx.lineTo(c.x+6, c.y);
      ctx.moveTo(c.x, c.y-6); ctx.lineTo(c.x, c.y+6);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (ui.tool === 'arc' && ui.arcPoints.length > 0) {
    ui.arcPoints.forEach(p => {
      const sp = w2s(p.x, p.y);
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, Math.PI*2);
      ctx.fillStyle = '#a78bfa'; ctx.fill();
    });
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(74,158,255,0.55)';
    ctx.lineWidth   = 1.5;
    if (ui.arcPoints.length === 2) {
      const probe = { type:'arc', points:[ui.arcPoints[0], ui.arcPoints[1], pt] };
      ctx.beginPath();
      if (arcGeometry(probe)) {
        const g = arcGeometry(probe);
        const N = Math.max(16, Math.min(80, Math.ceil(Math.abs(g.sweep) * 12)));
        for (let i = 0; i <= N; i++) {
          const pp = arcPointAt(probe, i/N);
          const sp = w2s(pp.x, pp.y);
          if (i === 0) ctx.moveTo(sp.x, sp.y);
          else         ctx.lineTo(sp.x, sp.y);
        }
      } else {
        const a = w2s(ui.arcPoints[0].x, ui.arcPoints[0].y);
        const b = w2s(pt.x, pt.y);
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    } else {
      const a = w2s(ui.arcPoints[0].x, ui.arcPoints[0].y);
      const b = w2s(pt.x, pt.y);
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  if (ui.tool === 'circle') {
    if (ui.circleMode === 'side' && !ui.circleCenter) {
      drawCircleCompass(ui.mouseScreen.x, ui.mouseScreen.y);
    } else if (ui.circleCenter) {
      drawCircleInProgress(pt);
    }
  }

  if (ui.tool === 'rect' && ui.rectStart) {
    const end = ui.snapTarget ? pt : pointFromConstraint(ui.rectStart, pt);
    const a = w2s(ui.rectStart.x, ui.rectStart.y);
    const b = w2s(end.x, end.y);
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(74,158,255,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(Math.min(a.x,b.x), Math.min(a.y,b.y), Math.abs(b.x-a.x), Math.abs(b.y-a.y));
    ctx.setLineDash([]);
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${Math.abs(end.x-ui.rectStart.x).toFixed(2)} × ${Math.abs(end.y-ui.rectStart.y).toFixed(2)} cm`,
                 (a.x+b.x)/2, Math.min(a.y,b.y)-6);
  }

  if (ui.tool === 'mirror' && ui.mirrorPts.length === 1) {
    drawDashedLine(ui.mirrorPts[0], pt, 'rgba(232,0,61,0.6)');
  }
}

function drawCircleCompass(sx, sy) {
  const R = 24;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,224,102,0.22)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([3,3]);
  ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI*2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx-R, sy); ctx.lineTo(sx+R, sy);
  ctx.moveTo(sx, sy-R); ctx.lineTo(sx, sy+R);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const side of CIRCLE_SIDE_ORDER) {
    const s = CIRCLE_SIDES[side];
    const active = side === ui.circleSide;
    const x = sx + s.dx * (R + 11);
    const y = sy + s.dy * (R + 11);
    ctx.beginPath();
    ctx.arc(x, y, active ? 9 : 7, 0, Math.PI*2);
    ctx.fillStyle   = active ? 'rgba(255,224,102,0.95)' : 'rgba(10,10,12,0.8)';
    ctx.fill();
    ctx.strokeStyle = active ? '#ffe066' : 'rgba(255,224,102,0.5)';
    ctx.lineWidth   = active ? 1.8 : 1;
    ctx.stroke();
    ctx.font         = '700 9px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle    = active ? '#0a0a0c' : 'rgba(255,224,102,0.8)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.letter, x, y + 0.5);
  }
  ctx.restore();
}

function drawCircleInProgress(pt) {
  const start = ui.circleCenter;
  let center, r, diameter = 0, far = null;

  if (ui.circleMode === 'side') {
    const s = CIRCLE_SIDES[ui.circleSide];
    diameter = Math.abs((pt.x - start.x) * s.dx + (pt.y - start.y) * s.dy);
    r = diameter / 2;
    if (r < 0.001) return;
    center = pointOnCircleSide(start, r, ui.circleSide);
    far    = pointOnCircleSide(start, diameter, ui.circleSide);
  } else {
    center = start;
    r = Math.hypot(pt.x - center.x, pt.y - center.y);
    if (r < 0.001) return;
  }

  const sc = w2s(center.x, center.y);
  const ss = w2s(start.x, start.y);

  ctx.save();
  ctx.setLineDash([4,4]);
  ctx.strokeStyle = 'rgba(74,158,255,0.6)';
  ctx.lineWidth   = 1.5;
  ctx.beginPath(); ctx.arc(sc.x, sc.y, cm2px(r), 0, Math.PI*2); ctx.stroke();

  if (ui.circleMode === 'side' && far) {
    const sf = w2s(far.x, far.y);
    // diâmetro e centro
    ctx.strokeStyle = 'rgba(255,224,102,0.8)';
    ctx.beginPath(); ctx.moveTo(ss.x, ss.y); ctx.lineTo(sf.x, sf.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sc.x-5, sc.y); ctx.lineTo(sc.x+5, sc.y);
    ctx.moveTo(sc.x, sc.y-5); ctx.lineTo(sc.x, sc.y+5);
    ctx.stroke();
    // início (verde) e lado oposto (amarelo)
    for (const [sp, color] of [[ss, '#00ff87'], [sf, '#ffe066']]) {
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, Math.PI*2);
      ctx.fillStyle = color; ctx.fill();
    }
    ctx.font         = '600 10px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle    = 'rgba(255,255,255,0.7)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    const mx = (ss.x + sf.x) / 2;
    const my = (ss.y + sf.y) / 2 - 8;
    ctx.fillText(`Ø ${diameter.toFixed(2)}cm · centro ${CIRCLE_SIDES[ui.circleSide].label}`, mx, my);
  } else {
    const sp = w2s(pt.x, pt.y);
    ctx.beginPath(); ctx.moveTo(sc.x, sc.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font         = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle    = 'rgba(255,255,255,0.55)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`R ${r.toFixed(2)}cm`, (sc.x+sp.x)/2, (sc.y+sp.y)/2 - 6);
  }
  ctx.restore();
}

function drawDashedLine(a, b, color) {
  const sp0 = w2s(a.x, a.y), sp1 = w2s(b.x, b.y);
  ctx.setLineDash([4,4]);
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.lineCap     = 'round';
  ctx.beginPath();
  ctx.moveTo(sp0.x, sp0.y); ctx.lineTo(sp1.x, sp1.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawMeasureLabel(a, b) {
  const dist = Math.hypot(b.x-a.x, b.y-a.y);
  const ang  = ((Math.atan2(-(b.y-a.y), b.x-a.x) * 180/Math.PI) + 360) % 360;
  const sp0 = w2s(a.x, a.y), sp1 = w2s(b.x, b.y);
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${dist.toFixed(2)}cm · ${ang.toFixed(1)}°`, (sp0.x+sp1.x)/2, (sp0.y+sp1.y)/2 - 6);
}

function drawMagneticIndicator() {
  if (!ui.snapTarget) return;
  const sp = w2s(ui.snapTarget.x, ui.snapTarget.y);
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, 8, 0, Math.PI*2);
  ctx.strokeStyle = '#ffe066';
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = '#ffe066';
  ctx.shadowBlur  = 8;
  ctx.stroke();
  ctx.shadowBlur  = 0;
  // cruz
  ctx.strokeStyle = '#ffe066';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(sp.x-5,sp.y); ctx.lineTo(sp.x+5,sp.y);
  ctx.moveTo(sp.x,sp.y-5); ctx.lineTo(sp.x,sp.y+5);
  ctx.stroke();
}

// ── PAN / ZOOM ────────────────────────────────────────────
function doZoom(factor, cx, cy) {
  const prev = cam.scale;
  cam.scale  = Math.min(30, Math.max(0.03, cam.scale * factor));
  cam.x = cx - (cx-cam.x) * (cam.scale/prev);
  cam.y = cy - (cy-cam.y) * (cam.scale/prev);
  updateZoomDisplay();
  render();
}

function fitView() {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const exp = (x,y) => {
    if(x<minX)minX=x; if(x>maxX)maxX=x;
    if(y<minY)minY=y; if(y>maxY)maxY=y;
  };
  state.segments.forEach(s => {
    if (s.type === 'circle') {
      const c = s.points[0];
      exp(c.x - s.radius, c.y - s.radius);
      exp(c.x + s.radius, c.y + s.radius);
    } else {
      s.points.forEach(p => exp(p.x, p.y));
    }
  });
  ['start','end'].forEach(k => { if(state.nodes[k]) exp(state.nodes[k].x,state.nodes[k].y); });
  if (!isFinite(minX)) { exp(0,0); exp(state.workspace.w, state.workspace.h); }

  const pad = 50;
  const bw  = (maxX-minX) * PX_PER_CM;
  const bh  = (maxY-minY) * PX_PER_CM;
  const sw  = canvas.width  - pad*2;
  const sh  = canvas.height - pad*2;
  const sc  = Math.min(sw/(bw||1), sh/(bh||1), 10);
  cam.scale = sc;
  cam.x = pad + (sw-bw*sc)/2 - minX*PX_PER_CM*sc;
  cam.y = pad + (sh-bh*sc)/2 - minY*PX_PER_CM*sc;
  updateZoomDisplay();
  render();
}

function updateZoomDisplay() {
  document.getElementById('zoom-label').textContent = `${Math.round(cam.scale*100)}%`;
}

// ── MOUSE EVENTS ──────────────────────────────────────────
canvas.addEventListener('mousedown',   onMouseDown);
canvas.addEventListener('mousemove',   onMouseMove);
canvas.addEventListener('mouseup',     onMouseUp);
canvas.addEventListener('dblclick',    onDblClick);
canvas.addEventListener('wheel',       onWheel, { passive: false });
canvas.addEventListener('contextmenu', e => e.preventDefault());

function onMouseDown(e) {
  const { sx, sy } = getCanvasXY(e);
  const wp = s2w(sx, sy);

  if (e.button === 1) {
    ui.isPanning = true;
    ui.panStart  = { x: sx, y: sy };
    ui.camStart  = { x: cam.x, y: cam.y };
    canvas.classList.add('cursor-pan');
    return;
  }
  if (e.button === 2) {
    if (cancelPaste()) return;
    cancelCurrentTool();
    return;
  }
  if (e.button !== 0) return;

  // Modo de colocação de colagem: clique confirma
  if (ui.pasteMode) { commitPaste(); return; }

  switch (ui.tool) {
    case 'select':      handleSelectDown(sx, sy, e); break;
    case 'line':        lineClick(wp.x, wp.y);        break;
    case 'arc':         arcClick(wp.x, wp.y);         break;
    case 'circle':      circleClick(wp.x, wp.y, e);   break;
    case 'rect':        rectClick(wp.x, wp.y);        break;
    case 'polyline':    polyClick(wp.x, wp.y);        break;
    case 'spiral':      spiralClick(wp.x, wp.y);      break;
    case 'fillet':      filletClick(wp.x, wp.y);      break;
    case 'start-node':  placeNode(sx, sy, 'start');   break;
    case 'end-node':    placeNode(sx, sy, 'end');     break;
    case 'move':        openMoveHud();                break;
    case 'vertex-edit': vertexEditDown(sx, sy, e);    break;
    case 'trim':        trimClick(wp.x, wp.y);        break;
    case 'extend':      extendClick(wp.x, wp.y);      break;
    case 'join':        joinSelected();               break;
    case 'break':       breakClick(wp.x, wp.y);       break;
    case 'offset':      offsetClick(wp.x, wp.y);      break;
    case 'mirror':      mirrorClick(wp.x, wp.y);      break;
    case 'rotate':      openRotateHud();               break;
    case 'scale':       openScaleHud();                break;
    case 'array':       openArrayHud();                break;
  }
}

function onMouseMove(e) {
  const { sx, sy } = getCanvasXY(e);
  const wp = s2w(sx, sy);

  ui.mouseScreen = { x: sx, y: sy };
  ui.mouseWorld  = wp;

  // Snap magnético (ignora o próprio vértice que está sendo arrastado)
  ui.snapTarget = getMagneticSnap(sx, sy, ui.dragVertex, ui.dragMove ? ui.dragMove.ids : null);

  // Escolha do lado (N/L/S/O) no modo "pela borda" do círculo
  const prevScreen = ui.prevMouseScreen;
  ui.prevMouseScreen = { x: sx, y: sy };
  if (ui.tool === 'circle' && ui.circleMode === 'side') {
    if (!ui.circleCenter) {
      if (prevScreen) {
        const dx = sx - prevScreen.x, dy = sy - prevScreen.y;
        if (Math.hypot(dx, dy) >= 3) ui.circleSide = circleSideFromDelta(dx, dy);
      }
    } else {
      const dx = wp.x - ui.circleCenter.x, dy = wp.y - ui.circleCenter.y;
      if (Math.hypot(dx, dy) > 0.5) ui.circleSide = circleSideFromDelta(dx, dy);
    }
  }

  // Arrasto de objetos selecionados (mover)
  if (ui.dragMove) {
    updateMoveDrag(wp);
  }

  // Modo de colocação de colagem: atualiza a prévia
  if (ui.pasteMode) {
    updatePasteOffset(wp);
  }

  // Arrasto de vértice (Editar Vértice)
  if (ui.dragVertex) {
    const seg = state.segments.find(s => s.id === ui.dragVertex.segId);
    if (seg) {
      let target = ui.snapTarget ? { ...ui.snapTarget } : { ...wp };
      if (!ui.snapTarget) {
        if (seg.type === 'line') {
          const other = seg.points[ui.dragVertex.idx === 0 ? 1 : 0];
          target = pointFromConstraint(other, target);
        } else if (seg.type === 'polyline') {
          const idx = ui.dragVertex.idx;
          const nb  = idx > 0 ? seg.points[idx-1] : seg.points[idx+1];
          if (nb) target = pointFromConstraint(nb, target);
        }
      }
      seg.points[ui.dragVertex.idx] = { ...target };
      state.dijkstraPath = [];
    }
  }

  const display = ui.snapTarget || wp;
  document.getElementById('coord-x').textContent = display.x.toFixed(2);
  document.getElementById('coord-y').textContent = display.y.toFixed(2);

  // Atualiza HUD do círculo em tempo real
  if (ui.tool === 'circle') updateCircleHud();
  // Atualiza HUD polar da linha em tempo real
  if (ui.tool === 'line' && ui.lineStart) updatePolarHud();

  // Status bar coordinate display
  const coordEl = document.getElementById('status-coord');
  if (coordEl) {
    let text = `X: ${display.x.toFixed(2)} cm  Y: ${display.y.toFixed(2)} cm`;
    if (ui.tool === 'vertex-edit') {
      const hit = findNearestVertex(sx, sy);
      if (hit) {
        text += coordExportEnabled(hit.pt)
          ? '  ·  COORD: marcada'
          : '  ·  COORD: livre (clique no selo E)';
      }
    }
    coordEl.textContent = text;
  }

  if (ui.isPanning) {
    cam.x = ui.camStart.x + (sx-ui.panStart.x);
    cam.y = ui.camStart.y + (sy-ui.panStart.y);
    render();
    return;
  }

  if (ui.boxSelStart) {
    renderBoxSelectDOM(sx, sy);
  }

  render();
}

function onMouseUp(e) {
  if (e.button === 1) {
    ui.isPanning = false;
    canvas.classList.remove('cursor-pan');
    return;
  }
  if (e.button === 0 && ui.dragMove) {
    finishMoveDrag();
    return;
  }
  if (e.button === 0 && ui.dragVertex) {
    const segId = ui.dragVertex.segId;
    ui.dragVertex = null;
    reattachNodes([segId]);
    state.dijkstraPath = [];
    updatePanelInfo();
    updateSelectionPanel();
    render();
    setStatus('Vértice atualizado');
    return;
  }
  if (ui.boxSelStart) {
    const { sx, sy } = getCanvasXY(e);
    selectInBox(ui.boxSelStart.x, ui.boxSelStart.y, sx, sy);
    ui.boxSelStart = null;
    clearBoxSelectDOM();
    updateSelectionPanel();
    render();
  }
}

function onDblClick() {
  if (ui.tool === 'line') {
    ui.lineStart = null;
    hidePolarHud();
    setStatus('Linha finalizada');
    render();
    return;
  }
  if (ui.tool === 'polyline') {
    finalizePolyline();
    return;
  }
  if (ui.tool === 'vertex-edit') {
    insertVertexAt(ui.mouseScreen.x, ui.mouseScreen.y);
  }
}

function onWheel(e) {
  e.preventDefault();
  const { sx, sy } = getCanvasXY(e);
  doZoom(e.deltaY < 0 ? 1.12 : 1/1.12, sx, sy);
}

function getCanvasXY(e) {
  const r = canvas.getBoundingClientRect();
  return { sx: e.clientX-r.left, sy: e.clientY-r.top };
}

// ── BOX SELECT DOM ────────────────────────────────────────
function renderBoxSelectDOM(ex, ey) {
  let el = document.getElementById('box-select-rect');
  if (!el) {
    el = document.createElement('div');
    el.id = 'box-select-rect';
    document.getElementById('canvas-area').appendChild(el);
  }
  el.style.display = 'block';
  el.style.left    = Math.min(ui.boxSelStart.x,ex)+'px';
  el.style.top     = Math.min(ui.boxSelStart.y,ey)+'px';
  el.style.width   = Math.abs(ex-ui.boxSelStart.x)+'px';
  el.style.height  = Math.abs(ey-ui.boxSelStart.y)+'px';
}
function clearBoxSelectDOM() {
  const el = document.getElementById('box-select-rect');
  if (el) el.style.display = 'none';
}

// ── KEYBOARD ─────────────────────────────────────────────
document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', e => { ui.shiftKey = e.shiftKey; });

function onKeyDown(e) {
  ui.shiftKey = e.shiftKey;
  // Ignorar se foco está em campo de texto EXCETO para Escape e Enter em HUDs
  const tag  = document.activeElement.tagName;
  const inInput = (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA');

  // Escape sempre funciona
  if (e.key === 'Escape') {
    e.preventDefault();
    if (cancelPaste()) return;
    if (cancelMoveDrag()) return;
    cancelCurrentTool();
    return;
  }

  // Se HUD da linha está aberto e nenhum input focado, direciona números para o input apropriado
  const lineHudOpen = !document.getElementById('polar-hud').classList.contains('hidden');
  if (lineHudOpen && !inInput && /^[0-9.,]$/.test(e.key)) {
    let targetInput;
    if (ui.polarInputMode === 'polar') {
      targetInput = document.getElementById('polar-dist-input');
    } else {
      // Modo absoluto: se não tem início definido, foca no Início X, senão no Final X
      targetInput = ui.lineStart ? document.getElementById('polar-end-x-input') : document.getElementById('polar-start-x-input');
    }
    if (targetInput) {
      e.preventDefault();
      // Reset na primeira digitação
      if (!targetInput.dataset.typing) {
        targetInput.value = '';
        targetInput.dataset.typing = 'true';
      }
      targetInput.focus();
      const cursorPos = targetInput.selectionStart;
      const val = targetInput.value;
      targetInput.value = val.slice(0, cursorPos) + e.key + val.slice(cursorPos);
      targetInput.setSelectionRange(cursorPos + 1, cursorPos + 1);
      targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }

  // Se HUD do círculo está aberto e nenhum input focado, direciona números para o input de diâmetro
  const circleHudOpen = !document.getElementById('circle-hud').classList.contains('hidden');
  if (circleHudOpen && !inInput && /^[0-9.,]$/.test(e.key)) {
    const diameterInput = ui.circleMode === 'center' 
      ? document.getElementById('circle-diameter-input')
      : document.getElementById('circle-diameter-input-side');
    if (diameterInput) {
      e.preventDefault();
      // Reset na primeira digitação
      if (!diameterInput.dataset.typing) {
        diameterInput.value = '';
        diameterInput.dataset.typing = 'true';
      }
      diameterInput.focus();
      const cursorPos = diameterInput.selectionStart;
      const val = diameterInput.value;
      diameterInput.value = val.slice(0, cursorPos) + e.key + val.slice(cursorPos);
      diameterInput.setSelectionRange(cursorPos + 1, cursorPos + 1);
      diameterInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }

  // Tab na ferramenta Círculo alterna entre iniciar pelo centro e pela borda (4 lados)
  // Funciona mesmo com HUD aberto (antes do early return de inInput)
  if (e.key === 'Tab' && ui.tool === 'circle' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleCircleMode();
    return;
  }

  // Enter nos HUDs
  if (e.key === 'Enter' && inInput) {
    e.preventDefault();
    if (!document.getElementById('polar-hud').classList.contains('hidden')) {
      commitPolarHud();
    }
    if (!document.getElementById('move-hud').classList.contains('hidden')) {
      applyPrecisionMove();
    }
    if (!document.getElementById('coord-hud').classList.contains('hidden')) {
      applyCoordHud();
    }
    if (!document.getElementById('rotate-hud').classList.contains('hidden')) {
      applyRotate();
    }
    if (!document.getElementById('scale-hud').classList.contains('hidden')) {
      applyScale();
    }
    if (!document.getElementById('circle-hud').classList.contains('hidden')) {
      commitCircleHud();
    }
    if (!document.getElementById('array-hud').classList.contains('hidden')) {
      applyArray();
    }
    if (ui.tool === 'rotate' || ui.tool === 'scale' || ui.tool === 'array') {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
    return;
  }

  const ctrl = e.ctrlKey || e.metaKey;

  // Ctrl+Z / Ctrl+Y devem funcionar mesmo com input focado
  if (ctrl && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (ctrl && (e.key==='y'||e.key==='Y')) { e.preventDefault(); redo(); return; }

  // Ctrl+C / Ctrl+V: copiar e colar objetos (ignora quando foco está em input)
  if (!inInput && ctrl && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    copySelection();
    return;
  }
  if (!inInput && ctrl && (e.key === 'v' || e.key === 'V')) {
    e.preventDefault();
    startPasteMode();
    return;
  }

  if (inInput) return;

  // Tab na ferramenta Círculo alterna entre iniciar pelo centro e pela borda (4 lados)
  if (e.key === 'Tab' && ui.tool === 'circle' && !ctrl) {
    e.preventDefault();
    toggleCircleMode();
    return;
  }

  // Enter finaliza construções no canvas
  if (e.key === 'Enter') {
    if (ui.pasteMode) { e.preventDefault(); commitPaste(); return; }
    if (ui.tool === 'polyline') { e.preventDefault(); finalizePolyline(); return; }
    if (ui.tool === 'line') {
      e.preventDefault();
      ui.lineStart = null;
      hidePolarHud();
      setStatus('Linha finalizada');
      render();
      return;
    }
  }

  // Atalhos com Shift (não conflitam com os atalhos simples)
  if (e.shiftKey && !ctrl) {
    switch (e.key) {
      case 'R': e.preventDefault(); setTool('rotate'); openRotateHud(); return;
      case 'S': e.preventDefault(); setTool('scale');  openScaleHud();  return;
      case 'A': e.preventDefault(); setTool('array');  openArrayHud();  return;
      case 'V': e.preventDefault(); setTool('vertex-edit'); return;
      case 'E': e.preventDefault(); setTool('spiral'); return;
    }
  }

  switch (e.key) {
    case 'v': case 'V': setTool('select'); break;
    case 'l': case 'L': setTool('line');   break;
    case 'a': case 'A': if (!ctrl) setTool('arc'); break;
    case 'r': case 'R': setTool('fillet'); break;
    case 'm': case 'M': setTool('move'); openMoveHud(); break;
    case 'c': case 'C': if (!ctrl) setTool('circle');   break;
    case 'b': case 'B': if (!ctrl) setTool('rect');     break;
    case 'p': case 'P': if (!ctrl) setTool('polyline'); break;
    case 'o': case 'O': if (!ctrl) setTool('offset');   break;
    case 't': case 'T': if (!ctrl) setTool('trim');     break;
    case 'e': case 'E': if (!ctrl) setTool('extend');   break;
    case 'j': case 'J': if (!ctrl) setTool('join');     break;
    case 'k': case 'K': if (!ctrl) setTool('break');    break;
    case 'x': case 'X': if (!ctrl) setTool('mirror');   break;
    case 'q': case 'Q': if (!ctrl) { setTool('line'); openCoordHud(); } break;
    case '1': if (ctrl) setTool('start-node'); break;
    case '2': if (ctrl) setTool('end-node');   break;
    case 'Delete': case 'Backspace': deleteSelection(); break;
    case 'f': case 'F': if (!ctrl) { e.preventDefault(); fitView(); } break;
    case 'g': case 'G':
      state.showGrid = !state.showGrid;
      document.getElementById('btn-toggle-grid').classList.toggle('active', state.showGrid);
      render();
      break;
    case 's': case 'S':
      if (!ctrl) {
        state.snapEnabled = !state.snapEnabled;
        document.getElementById('btn-toggle-snap').classList.toggle('active', state.snapEnabled);
      }
      break;
    case 'F5': e.preventDefault(); runTrackAnalysis(); break;
    case 'F9': e.preventDefault(); toggleDistSnap(); break;
    case 'Home':
      cam.x = canvas.width/2; cam.y = canvas.height/2; cam.scale = 1;
      updateZoomDisplay(); render();
      break;
  }
}

function cancelCurrentTool() {
  // Cancela colagem/arrasto pendentes antes de limpar a ferramenta
  if (ui.pasteMode) ui.pasteMode = null;
  if (ui.dragMove) { cancelMoveDrag(); }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  ui.lineStart    = null;
  ui.arcPoints    = [];
  ui.polyPoints   = [];
  ui.rectStart    = null;
  ui.circleCenter = null;
  ui.circleMode   = 'center';
  ui.circleSide   = 'E';
  ui.spiralCenter = null;
  ui.mirrorPts    = [];
  ui.dragVertex   = null;
  ui.offsetTargetId = null;
  hidePolarHud();
  hideFilletHud();
  hideMoveHud();
  hideCoordHud();
  hideOffsetHud();
  hideRotateHud();
  hideScaleHud();
  hideArrayHud();
  hideCircleHud();
  hideSpiralHud();
  ui.selection.clear();
  updateSelectionPanel();
  setTool('select');
  render();
}

// ── HUD POLAR (LINHA) ─────────────────────────────────────
function showPolarHud(origin) {
  const hasOrigin = origin !== null && origin !== undefined;

  // Preenche Início X/Y (agora são inputs editáveis)
  const startXIn = document.getElementById('polar-start-x-input');
  const startYIn = document.getElementById('polar-start-y-input');
  if (hasOrigin) {
    if (startXIn && document.activeElement !== startXIn) startXIn.value = origin.x.toFixed(2);
    if (startYIn && document.activeElement !== startYIn) startYIn.value = origin.y.toFixed(2);
  } else {
    // Se não há origem, preenche com posição atual do mouse como sugestão
    if (startXIn && document.activeElement !== startXIn) startXIn.value = ui.mouseWorld.x.toFixed(2);
    if (startYIn && document.activeElement !== startYIn) startYIn.value = ui.mouseWorld.y.toFixed(2);
  }

  // Reseta modo de entrada para o padrão
  ui.polarInputMode = ui.polarInputMode || 'polar';

  // Sincroniza o select
  const modeSel = document.getElementById('polar-mode-select');
  if (modeSel) modeSel.value = ui.polarInputMode;

  // Mostra/esconde grupos de campos conforme o modo
  const polarFields = document.getElementById('polar-fields-polar');
  const absFields = document.getElementById('polar-fields-absolute');
  const absStartFields = document.getElementById('polar-fields-absolute-start');
  
  // Início X/Y sempre visíveis no modo absoluto
  if (absStartFields) absStartFields.style.display = 'block';

  if (ui.polarInputMode === 'polar') {
    if (polarFields) polarFields.style.display = 'block';
    if (absFields) absFields.style.display = 'none';
  } else {
    if (polarFields) polarFields.style.display = 'none';
    if (absFields) absFields.style.display = 'block';
  }

  // Limpa valores dos inputs de final/dist/ângulo (mantém início se já preenchido)
  document.getElementById('polar-dist-input').value = '';
  document.getElementById('polar-angle-input').value = '0';
  document.getElementById('polar-end-x-input').value = '';
  document.getElementById('polar-end-y-input').value = '';

  // Reseta estado de digitação para todos os inputs
  document.getElementById('polar-start-x-input').dataset.typing = '';
  document.getElementById('polar-start-y-input').dataset.typing = '';
  document.getElementById('polar-dist-input').dataset.typing = '';
  document.getElementById('polar-angle-input').dataset.typing = '';
  document.getElementById('polar-end-x-input').dataset.typing = '';
  document.getElementById('polar-end-y-input').dataset.typing = '';

  document.getElementById('polar-hud').classList.remove('hidden');
  // NÃO foca automaticamente para permitir Tab no canvas
}

function updatePolarHud() {
  // Se não tem origem definida, não atualiza campos de final/dist/ângulo baseado no mouse
  // (o usuário pode estar digitando as coordenadas manualmente)
  if (!ui.lineStart) return;

  // Atualiza o select se mudou (proteção)
  const modeSel = document.getElementById('polar-mode-select');
  if (modeSel && modeSel.value !== ui.polarInputMode) {
    ui.polarInputMode = modeSel.value;
    showPolarHud(ui.lineStart);
    return;
  }

  // Usa o mesmo ponto restringido da prévia (ímã, passo angular e de distância)
  const eff = ui.snapTarget ? { ...ui.snapTarget } : pointFromConstraint(ui.lineStart, ui.mouseWorld);
  const dx = eff.x - ui.lineStart.x;
  const dy = eff.y - ui.lineStart.y;
  const dist = Math.hypot(dx, dy);
  const ang = ((Math.atan2(-dy, dx) * 180/Math.PI) + 360) % 360;

  if (ui.polarInputMode === 'polar') {
    const distIn = document.getElementById('polar-dist-input');
    const angIn = document.getElementById('polar-angle-input');
    if (distIn && document.activeElement !== distIn) distIn.value = dist.toFixed(2);
    if (angIn && document.activeElement !== angIn) angIn.value = ang.toFixed(1);
  } else {
    const endXIn = document.getElementById('polar-end-x-input');
    const endYIn = document.getElementById('polar-end-y-input');
    if (endXIn && document.activeElement !== endXIn) endXIn.value = eff.x.toFixed(2);
    if (endYIn && document.activeElement !== endYIn) endYIn.value = eff.y.toFixed(2);
  }
}

function hidePolarHud() {
  // Reseta estado de digitação para todos os inputs ao esconder
  document.getElementById('polar-start-x-input').dataset.typing = '';
  document.getElementById('polar-start-y-input').dataset.typing = '';
  document.getElementById('polar-dist-input').dataset.typing = '';
  document.getElementById('polar-angle-input').dataset.typing = '';
  document.getElementById('polar-end-x-input').dataset.typing = '';
  document.getElementById('polar-end-y-input').dataset.typing = '';

  document.getElementById('polar-hud').classList.add('hidden');
}

// ── HUD CÍRCULO ─────────────────────────────────────────────
function showCircleHud() {
  document.getElementById('circle-hud').classList.remove('hidden');
  // Preenche Centro X/Y com posição atual do mouse se não há centro definido
  if (!ui.circleCenter) {
    document.getElementById('circle-cx-input').value = ui.mouseWorld.x.toFixed(2);
    document.getElementById('circle-cy-input').value = ui.mouseWorld.y.toFixed(2);
    document.getElementById('circle-start-x-input').value = ui.mouseWorld.x.toFixed(2);
    document.getElementById('circle-start-y-input').value = ui.mouseWorld.y.toFixed(2);
  }
  // Reseta estado de digitação para todos os inputs
  document.getElementById('circle-diameter-input').dataset.typing = '';
  document.getElementById('circle-cx-input').dataset.typing = '';
  document.getElementById('circle-cy-input').dataset.typing = '';
  document.getElementById('circle-diameter-input-side').dataset.typing = '';
  document.getElementById('circle-start-x-input').dataset.typing = '';
  document.getElementById('circle-start-y-input').dataset.typing = '';

  // Auto-foca no input de Diâmetro (modo centro é o padrão)
  setTimeout(() => {
    const diameterInput = document.getElementById('circle-diameter-input');
    if (diameterInput) diameterInput.focus();
  }, 30);
}

function hideCircleHud() {
  // Reseta estado de digitação para todos os inputs ao esconder
  document.getElementById('circle-diameter-input').dataset.typing = '';
  document.getElementById('circle-cx-input').dataset.typing = '';
  document.getElementById('circle-cy-input').dataset.typing = '';
  document.getElementById('circle-diameter-input-side').dataset.typing = '';
  document.getElementById('circle-start-x-input').dataset.typing = '';
  document.getElementById('circle-start-y-input').dataset.typing = '';

  document.getElementById('circle-hud').classList.add('hidden');
}

function updateCircleHud() {
  const modeSel = document.getElementById('circle-mode-select');
  if (modeSel) modeSel.value = ui.circleMode;

  const centerFields = document.getElementById('circle-hud-center-fields');
  const sideFields = document.getElementById('circle-hud-side-fields');
  if (ui.circleMode === 'center') {
    if (centerFields) centerFields.style.display = 'block';
    if (sideFields) sideFields.style.display = 'none';
    if (ui.circleCenter) {
      const r = Math.hypot(ui.mouseWorld.x - ui.circleCenter.x, ui.mouseWorld.y - ui.circleCenter.y);
      const diameter = r * 2;
      const dIn = document.getElementById('circle-diameter-input');
      if (dIn && document.activeElement !== dIn && !dIn.dataset.typing) dIn.value = diameter.toFixed(2);
      const cxIn = document.getElementById('circle-cx-input');
      if (cxIn && document.activeElement !== cxIn && !cxIn.dataset.typing) cxIn.value = ui.circleCenter.x.toFixed(2);
      const cyIn = document.getElementById('circle-cy-input');
      if (cyIn && document.activeElement !== cyIn && !cyIn.dataset.typing) cyIn.value = ui.circleCenter.y.toFixed(2);
    }
  } else {
    if (centerFields) centerFields.style.display = 'none';
    if (sideFields) sideFields.style.display = 'block';
    const sideSel = document.getElementById('circle-side-select');
    if (sideSel && document.activeElement !== sideSel) sideSel.value = ui.circleSide;
    if (ui.circleCenter) {
      const start = ui.circleCenter;
      const pt = ui.mouseWorld;
      const s = CIRCLE_SIDES[ui.circleSide];
      const diameter = Math.abs((pt.x - start.x) * s.dx + (pt.y - start.y) * s.dy);
      const r = diameter / 2;
      const center = pointOnCircleSide(start, r, ui.circleSide);
      const dIn = document.getElementById('circle-diameter-input-side');
      if (dIn && document.activeElement !== dIn && !dIn.dataset.typing) dIn.value = diameter.toFixed(2);
      const sxIn = document.getElementById('circle-start-x-input');
      if (sxIn && document.activeElement !== sxIn && !sxIn.dataset.typing) sxIn.value = start.x.toFixed(2);
      const syIn = document.getElementById('circle-start-y-input');
      if (syIn && document.activeElement !== syIn && !syIn.dataset.typing) syIn.value = start.y.toFixed(2);
    }
  }
}

function commitCircleHud() {
  const mode = document.getElementById('circle-mode-select').value;
  if (mode === 'center') {
    const diameter = parseFloat(document.getElementById('circle-diameter-input').value);
    const cx = parseFloat(document.getElementById('circle-cx-input').value);
    const cy = parseFloat(document.getElementById('circle-cy-input').value);
    const r = diameter / 2;
    if (isNaN(diameter) || diameter <= 0) { toast('Diâmetro inválido', 'warn'); return; }
    if (isNaN(cx) || isNaN(cy)) { toast('Coordenadas do centro inválidas', 'warn'); return; }
    saveUndo();
    state.segments.push({ id: state.nextId++, type: 'circle',
      points: [{ x: cx, y: cy }], radius: r, selected: false });
    state.dijkstraPath = [];
    updatePanelInfo();
    render();
    toast(`Círculo Ø${diameter.toFixed(2)} cm (R${r.toFixed(2)} cm) em (${cx.toFixed(2)}, ${cy.toFixed(2)})`);
    // Prepara para próximo círculo e reseta estado de digitação
    document.getElementById('circle-diameter-input').value = '';
    document.getElementById('circle-diameter-input').dataset.typing = '';
    document.getElementById('circle-diameter-input').focus();
  } else {
    const diameter = parseFloat(document.getElementById('circle-diameter-input-side').value);
    const sx = parseFloat(document.getElementById('circle-start-x-input').value);
    const sy = parseFloat(document.getElementById('circle-start-y-input').value);
    const side = document.getElementById('circle-side-select').value;
    if (isNaN(diameter) || diameter <= 0) { toast('Diâmetro inválido', 'warn'); return; }
    if (isNaN(sx) || isNaN(sy)) { toast('Coordenadas de início inválidas', 'warn'); return; }
    const start = { x: sx, y: sy };
    const r = diameter / 2;
    const center = pointOnCircleSide(start, r, side);
    saveUndo();
    state.segments.push({ id: state.nextId++, type: 'circle',
      points: [{ ...center }], radius: r, selected: false,
      startSide: side, startPoint: { ...start } });
    state.dijkstraPath = [];
    updatePanelInfo();
    render();
    toast(`Círculo Ø${diameter.toFixed(2)} cm (R${r.toFixed(2)} cm) · centro para ${CIRCLE_SIDES[side].label}`);
    // Prepara para próximo círculo e reseta estado de digitação
    document.getElementById('circle-diameter-input-side').value = '';
    document.getElementById('circle-diameter-input-side').dataset.typing = '';
    document.getElementById('circle-diameter-input-side').focus();
  }
}

function commitLineHud() {
  let startX, startY, endX, endY;

  if (!ui.lineStart) {
    // Primeira vez: lê Início X/Y dos inputs
    startX = parseFloat(document.getElementById('polar-start-x-input').value);
    startY = parseFloat(document.getElementById('polar-start-y-input').value);
    if (isNaN(startX) || isNaN(startY)) { toast('Coordenadas de início inválidas', 'warn'); return; }
    ui.lineStart = { x: startX, y: startY };
  } else {
    startX = ui.lineStart.x;
    startY = ui.lineStart.y;
  }

  if (ui.polarInputMode === 'polar') {
    const dist  = parseFloat(document.getElementById('polar-dist-input').value);
    const angle = parseFloat(document.getElementById('polar-angle-input').value) || 0;
    if (isNaN(dist) || dist <= 0) { toast('Distância inválida', 'warn'); return; }

    const rad  = angle * Math.PI / 180;
    endX = startX + dist * Math.cos(rad);
    endY = startY - dist * Math.sin(rad);
  } else {
    endX = parseFloat(document.getElementById('polar-end-x-input').value);
    endY = parseFloat(document.getElementById('polar-end-y-input').value);
    if (isNaN(endX) || isNaN(endY)) { toast('Coordenadas de final inválidas', 'warn'); return; }
  }

  commitLine({ x: startX, y: startY }, { x: endX, y: endY });
  ui.lineStart = { x: endX, y: endY };

  // Limpa campos do HUD (mantém Início X/Y para próxima linha contígua) e reseta estado de digitação
  document.getElementById('polar-dist-input').value  = '';
  document.getElementById('polar-angle-input').value = '0';
  document.getElementById('polar-end-x-input').value = '';
  document.getElementById('polar-end-y-input').value = '';

  document.getElementById('polar-dist-input').dataset.typing = '';
  document.getElementById('polar-angle-input').dataset.typing = '';
  document.getElementById('polar-end-x-input').dataset.typing = '';
  document.getElementById('polar-end-y-input').dataset.typing = '';
  document.getElementById('polar-start-x-input').dataset.typing = '';
  document.getElementById('polar-start-y-input').dataset.typing = '';

  // Atualiza o HUD com o novo ponto de início
  showPolarHud(ui.lineStart);

  setStatus(`Linha criada · continue ou Esc para finalizar`);
}

// Mantém compatibilidade com chamadas antigas
function commitPolarHud() { commitLineHud(); }

// ── HUD FILLET ────────────────────────────────────────────
function showFilletHud() { document.getElementById('fillet-hud').classList.remove('hidden'); }
function hideFilletHud() { document.getElementById('fillet-hud').classList.add('hidden'); }

// ── PAINEIS ───────────────────────────────────────────────
function updatePanelInfo() {
  document.getElementById('info-seg-count').textContent = state.segments.length;
  const total = state.segments.reduce((acc,s) => acc+segLength(s), 0);
  document.getElementById('info-total-len').textContent = total.toFixed(2)+' cm';
}

function updateSelectionPanel() {
  const ids = [...ui.selection];
  document.getElementById('status-sel').textContent = ids.length ? `${ids.length} sel.` : '';

  if (!ids.length) {
    document.getElementById('sel-empty').classList.remove('hidden');
    document.getElementById('sel-props').classList.add('hidden');
    return;
  }
  document.getElementById('sel-empty').classList.add('hidden');
  document.getElementById('sel-props').classList.remove('hidden');

  const segs = state.segments.filter(s => ui.selection.has(s.id));
  const TYPE_NAMES = { line:'Linha', arc:'Arco', polyline:'Polilinha', circle:'Círculo' };
  if (segs.length === 1) {
    const s = segs[0];
    document.getElementById('sel-type').textContent = TYPE_NAMES[s.type] || s.type;
    document.getElementById('sel-len').textContent  = segLength(s).toFixed(3)+' cm';
    document.getElementById('sel-resize-val').value = segLength(s).toFixed(2);
    document.getElementById('sel-line-controls').style.display = s.type==='line'?'block':'none';
    if (s.type === 'line') {
      const cb = document.getElementById('sel-construction');
      cb.checked = !!s.isConstruction;
    }
  } else {
    document.getElementById('sel-type').textContent = `${segs.length} segmentos`;
    document.getElementById('sel-len').textContent  =
      segs.reduce((acc,s)=>acc+segLength(s),0).toFixed(3)+' cm';
    document.getElementById('sel-line-controls').style.display = 'none';
  }
}

function updateDijkstraPanel() {
  document.getElementById('dijk-start').textContent =
    state.nodes.start ? `(${state.nodes.start.x.toFixed(1)}, ${state.nodes.start.y.toFixed(1)})` : 'Não definido';
  document.getElementById('dijk-end').textContent =
    state.nodes.end   ? `(${state.nodes.end.x.toFixed(1)}, ${state.nodes.end.y.toFixed(1)})` : 'Não definido';
}

// ── REDIMENSIONAR LINHA ───────────────────────────────────
document.getElementById('sel-resize-apply').addEventListener('click', () => {
  const newLen = parseFloat(document.getElementById('sel-resize-val').value);
  if (isNaN(newLen) || newLen <= 0) return;
  const ids = [...ui.selection];
  if (ids.length !== 1) return;
  const seg = state.segments.find(s => s.id === ids[0]);
  if (!seg || seg.type !== 'line') return;
  saveUndo();
  const p0=seg.points[0], p1=seg.points[1];
  const dx=p1.x-p0.x, dy=p1.y-p0.y;
  const len=Math.hypot(dx,dy);
  if (len<0.001) return;
  const sc = newLen/len;
  seg.points[1] = { x:p0.x+dx*sc, y:p0.y+dy*sc };
  state.dijkstraPath = [];
  updatePanelInfo();
  updateSelectionPanel();
  render();
  toast('Comprimento atualizado');
});

// ── LINHA DE CONSTRUÇÃO ──────────────────────────────────────
document.getElementById('sel-construction').addEventListener('change', e => {
  const ids = [...ui.selection];
  if (ids.length !== 1) return;
  const seg = state.segments.find(s => s.id === ids[0]);
  if (!seg || seg.type !== 'line') return;
  saveUndo();
  seg.isConstruction = e.target.checked;
  render();
  toast(seg.isConstruction ? 'Linha marcada como construção' : 'Linha normal');
});

// ── ÁREA DE TRABALHO ──────────────────────────────────────
// ── ÁREA DE TRABALHO ──────────────────────────────────────
document.getElementById('btn-apply-workspace').addEventListener('click', () => {
  const w  = parseFloat(document.getElementById('workspace-w').value);
  const h  = parseFloat(document.getElementById('workspace-h').value);
  const dz = parseFloat(document.getElementById('deadzone-input').value);
  if (isNaN(w)||isNaN(h)||w<=0||h<=0) { toast('Dimensões inválidas','warn'); return; }
  if (isNaN(dz)||dz<0||dz*2 >= Math.min(w,h)) {
    toast('Deadzone deve ser menor que metade da menor dimensão','warn');
    return;
  }
  state.workspace = { w, h };
  state.deadzone  = dz;
  render();
  toast(`Área de trabalho: ${w}×${h} cm · deadzone ${dz} cm`, 'success');
});

// Deadzone configurável com alerta imediato
document.getElementById('deadzone-input').addEventListener('change', () => {
  const dz = parseFloat(document.getElementById('deadzone-input').value);
  const minDim = Math.min(state.workspace.w, state.workspace.h);
  if (isNaN(dz)||dz<0||dz*2 >= minDim) {
    toast('Deadzone deve ser menor que metade da menor dimensão','warn');
    document.getElementById('deadzone-input').value = state.deadzone;
    return;
  }
  state.deadzone = dz;
  render();
});

// Modo Dijkstra (menor caminho vs perímetro)
document.getElementById('dijkstra-mode-select').addEventListener('change', () => {
  const mode = document.getElementById('dijkstra-mode-select').value;
  if (mode === 'shortest_path' || mode === 'perimeter_loop') {
    state.dijkstraMode = mode;
    state.dijkstraPath = [];
    render();
    toast(`Modo: ${mode === 'shortest_path' ? 'Menor Caminho' : 'Perímetro do Loop'}`, 'success');
  }
});

// ── LARGURA DA LINHA ──────────────────────────────────────
document.getElementById('line-width-input').addEventListener('change', () => {
  const v = parseFloat(document.getElementById('line-width-input').value);
  if (isNaN(v)||v<=0) return;
  state.lineWidth = v;
  render();
});

// ── SAVE / LOAD ───────────────────────────────────────────
function saveJSON() {
  const sp = readSpiralParams();
  const data = JSON.stringify({
    version:   10,
    segments:  state.segments,
    nodes:     state.nodes,
    nextId:    state.nextId,
    workspace: state.workspace,
    deadzone:  state.deadzone,
    lineWidth: state.lineWidth,
    angleSnap: state.angleSnap,
    angleStep: state.angleStep,
    distSnap:  state.distSnap,
    distStep:  state.distStep,
    dijkstraMode: state.dijkstraMode,
    orthoLock:    state.orthoLock,
    showVertexCoords: state.showVertexCoords,
    showCircleQuads:  state.showCircleQuads,
    spiral: {
      r1: sp.r1, angle: sp.stepAngle, factor: sp.factor,
      count: sp.count, start: sp.startAngle, dir: sp.dir, tail: sp.tail,
    },
  }, null, 2);
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([data],{type:'application/json'}));
  a.download = 'linetrack-pista.json';
  a.click();
  toast('JSON salvo', 'success');
}

function loadJSON(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      saveUndo();
      state.segments  = d.segments  || [];
      state.nodes     = d.nodes     || { start:null, end:null };
      state.nextId    = d.nextId    || 1;
      if (d.workspace) state.workspace = d.workspace;
      if (d.lineWidth) {
        state.lineWidth = d.lineWidth;
        document.getElementById('line-width-input').value = d.lineWidth;
      }
      if (d.workspace) {
        document.getElementById('workspace-w').value = d.workspace.w;
        document.getElementById('workspace-h').value = d.workspace.h;
      }
      if (typeof d.angleSnap === 'boolean') state.angleSnap = d.angleSnap;
      if (typeof d.angleStep === 'number') {
        state.angleStep = d.angleStep;
        const stepEl = document.getElementById('angle-step-input');
        if (stepEl) stepEl.value = d.angleStep;
      }
      if (typeof d.distSnap === 'boolean') state.distSnap = d.distSnap;
      if (typeof d.distStep === 'number' && d.distStep > 0) {
        state.distStep = d.distStep;
        const dStepEl = document.getElementById('dist-step-input');
        if (dStepEl) dStepEl.value = d.distStep;
      }
      if (typeof d.deadzone === 'number' && d.deadzone >= 0) {
        state.deadzone = d.deadzone;
        const dzEl = document.getElementById('deadzone-input');
        if (dzEl) dzEl.value = d.deadzone;
      }
      if (typeof d.dijkstraMode === 'string') state.dijkstraMode = d.dijkstraMode;
      if (typeof d.orthoLock === 'boolean') state.orthoLock = d.orthoLock;
      if (typeof d.showVertexCoords === 'boolean') {
        state.showVertexCoords = d.showVertexCoords;
        const vcEl = document.getElementById('exp-vertex-coords');
        if (vcEl) vcEl.checked = d.showVertexCoords;
      }
      if (typeof d.showCircleQuads === 'boolean') {
        state.showCircleQuads = d.showCircleQuads;
        const cqEl = document.getElementById('circle-quads-toggle');
        if (cqEl) cqEl.checked = d.showCircleQuads;
      }
      if (d.spiral && typeof d.spiral === 'object') {
        const sp = d.spiral;
        const setVal = (id, v) => {
          const el = document.getElementById(id);
          if (el && Number.isFinite(v)) el.value = v;
        };
        setVal('spiral-r1', sp.r1);
        setVal('spiral-angle', sp.angle);
        setVal('spiral-factor', sp.factor);
        setVal('spiral-count', sp.count);
        setVal('spiral-start', sp.start);
        setVal('spiral-tail', sp.tail);
        const dirEl = document.getElementById('spiral-dir');
        if (dirEl && (sp.dir === 1 || sp.dir === -1)) dirEl.value = String(sp.dir);
        updateSpiralInfo();
      }
      // Normaliza a marcação de coordenadas de cada vértice.
      // Ausente = cinza (ignorado); true = marcado.
      for (const seg of state.segments) {
        if (!Array.isArray(seg.points)) continue;
        for (const pt of seg.points) {
          pt.exportCoord = pt.exportCoord === true;
        }
      }
      const modeEl = document.getElementById('dijkstra-mode-select');
      if (modeEl) modeEl.value = state.dijkstraMode;
      const orthoBtn = document.getElementById('btn-toggle-ortho');
      if (orthoBtn) orthoBtn.classList.toggle('active', state.orthoLock);
      const angBtn = document.getElementById('btn-toggle-angle');
      if (angBtn) angBtn.classList.toggle('active', state.angleSnap);
      const distBtn = document.getElementById('btn-toggle-dist');
      if (distBtn) distBtn.classList.toggle('active', state.distSnap);
      state.dijkstraPath = [];
      ui.selection.clear();
      updatePanelInfo();
      updateDijkstraPanel();
      updateSelectionPanel();
      fitView();
      toast('Projeto carregado', 'success');
    } catch { toast('Erro ao carregar JSON','error'); }
  };
  reader.readAsText(file);
}

document.getElementById('file-input').addEventListener('change', e => {
  if (e.target.files[0]) { loadJSON(e.target.files[0]); e.target.value=''; }
});

// ── NOVO PROJETO ──────────────────────────────────────────
function newProject() {
  if (state.segments.length && !confirm('Criar novo projeto? O projeto atual será perdido.')) return;
  state.segments = [];
  state.nodes    = { start:null, end:null };
  state.nextId   = 1;
  state.workspace = { w: DEFAULT_WORKSPACE_W, h: DEFAULT_WORKSPACE_H };
  state.deadzone  = DEFAULT_DEADZONE;
  document.getElementById('workspace-w').value = DEFAULT_WORKSPACE_W;
  document.getElementById('workspace-h').value = DEFAULT_WORKSPACE_H;
  document.getElementById('deadzone-input').value = DEFAULT_DEADZONE;
  state.dijkstraPath = [];
  state.undoStack = [];
  state.redoStack = [];
  ui.selection.clear();
  ui.lineStart    = null;
  ui.arcPoints    = [];
  ui.polyPoints   = [];
  ui.rectStart    = null;
  ui.circleCenter = null;
  ui.spiralCenter = null;
  ui.mirrorPts    = [];
  ui.dragVertex   = null;
  ui.offsetTargetId = null;
  hidePolarHud();
  hideFilletHud();
  hideMoveHud();
  hideCoordHud();
  hideOffsetHud();
  hideRotateHud();
  hideScaleHud();
  hideArrayHud();
  hideSpiralHud();
  updatePanelInfo();
  updateDijkstraPanel();
  updateSelectionPanel();
  document.getElementById('dijk-result').classList.add('hidden');
  render();
  toast('Novo projeto');
}

// ── EXPORTAR PDF (real, via print) ────────────────────────
function exportPDF() {
  const format = document.getElementById('exp-format').value;
  const margin = parseFloat(document.getElementById('exp-margin').value) || 2;
  const invert = document.getElementById('exp-invert').checked;
  const cotas  = document.getElementById('exp-cotas').checked;
  const showVertexCoords = document.getElementById('exp-vertex-coords').checked;

  if (!state.segments.length) { toast('Nenhum segmento para exportar','warn'); return; }

  const PAGE_SIZES = {
    A4:[21,29.7], A3:[29.7,42], A2:[42,59.4], A1:[59.4,84.1], A0:[84.1,118.9]
  };

  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  state.segments.forEach(s => {
    if (s.type === 'circle') {
      const c = s.points[0];
      if (c.x-s.radius<minX) minX=c.x-s.radius;
      if (c.x+s.radius>maxX) maxX=c.x+s.radius;
      if (c.y-s.radius<minY) minY=c.y-s.radius;
      if (c.y+s.radius>maxY) maxY=c.y+s.radius;
    } else {
      s.points.forEach(p => {
        if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x;
        if(p.y<minY)minY=p.y; if(p.y>maxY)maxY=p.y;
      });
    }
  });

  const trackW = maxX-minX, trackH = maxY-minY;
  let pageW, pageH;
  if (format === 'auto') {
    pageW = trackW + margin*2;
    pageH = trackH + margin*2;
  } else {
    [pageW, pageH] = PAGE_SIZES[format];
    if (trackW > trackH && pageW < pageH) [pageW,pageH] = [pageH,pageW];
  }

  const drawScale = Math.min((pageW-margin*2)/(trackW||1), (pageH-margin*2)/(trackH||1));
  const offX = margin - minX*drawScale;
  const offY = margin - minY*drawScale;

  // Criar SVG
  const svgW = pageW, svgH = pageH; // cm
  const CM2SVG = 37.795; // 96dpi

  function toSVG(x, y) {
    return { x:(x*drawScale+offX)*CM2SVG, y:(y*drawScale+offY)*CM2SVG };
  }

  const bg   = invert ? '#000000' : '#ffffff';
  const fg   = invert ? '#ffffff' : '#1a1a2e';
  const pathColor = invert ? '#ffffff' : '#1a1a2e';
  const dijkColor = invert ? '#ffffff' : '#b8860b'; // branco em fundo preto, dourado em branco

  let paths = '';
  for (const seg of state.segments) {
    // Pular linhas de construção na exportação
    if (seg.type === 'line' && seg.isConstruction) continue;
    
    const inPath = state.dijkstraPath.includes(seg.id);
    const color  = inPath ? dijkColor : pathColor;
    const sw     = Math.max(0.5, state.lineWidth * drawScale * CM2SVG);

    if (seg.type === 'circle') {
      const c = toSVG(seg.points[0].x, seg.points[0].y);
      const r = seg.radius * drawScale * CM2SVG;
      paths += `<circle cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${r.toFixed(2)}" stroke="${color}" stroke-width="${sw.toFixed(2)}" fill="none"/>`;
    } else {
      let d = '';
      if (seg.type === 'line') {
        const p0=toSVG(seg.points[0].x,seg.points[0].y);
        const p1=toSVG(seg.points[1].x,seg.points[1].y);
        d = `M${p0.x.toFixed(2)},${p0.y.toFixed(2)} L${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
      } else if (seg.type === 'arc') {
        const g = arcGeometry(seg);
        if (g) {
          const N = Math.max(16, Math.min(120, Math.ceil(Math.abs(g.sweep) * 18)));
          const p0 = toSVG(seg.points[0].x, seg.points[0].y);
          d = `M${p0.x.toFixed(2)},${p0.y.toFixed(2)}`;
          for (let i = 1; i <= N; i++) {
            const pp = arcPointAt(seg, i/N);
            const sp = toSVG(pp.x, pp.y);
            d += ` L${sp.x.toFixed(2)},${sp.y.toFixed(2)}`;
          }
        } else {
          const sp0 = toSVG(seg.points[0].x, seg.points[0].y);
          const sp1 = toSVG(seg.points[2].x, seg.points[2].y);
          d = `M${sp0.x.toFixed(2)},${sp0.y.toFixed(2)} L${sp1.x.toFixed(2)},${sp1.y.toFixed(2)}`;
        }
      } else if (seg.type === 'polyline') {
        const first = toSVG(seg.points[0].x, seg.points[0].y);
        d = `M${first.x.toFixed(2)},${first.y.toFixed(2)}`;
        for (let i = 1; i < seg.points.length; i++) {
          const sp = toSVG(seg.points[i].x, seg.points[i].y);
          d += ` L${sp.x.toFixed(2)},${sp.y.toFixed(2)}`;
        }
      }
      if (d) paths += `<path d="${d}" stroke="${color}" stroke-width="${sw.toFixed(2)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    }

    // cotas
    if (cotas && seg.type==='line' && segLength(seg)>=MIN_COTA_CM) {
      const p0=seg.points[0], p1=seg.points[1];
      const sp0=toSVG(p0.x,p0.y), sp1=toSVG(p1.x,p1.y);
      const mx=(sp0.x+sp1.x)/2, my=(sp0.y+sp1.y)/2;
      const dx=sp1.x-sp0.x, dy=sp1.y-sp0.y;
      const nd=Math.hypot(dx,dy)||1;
      const ox=-dy/nd*12, oy=dx/nd*12;
      const cotaColor = invert?'rgba(255,255,255,0.5)':'rgba(0,0,0,0.4)';
      paths += `<text x="${(mx+ox).toFixed(1)}" y="${(my+oy).toFixed(1)}" font-family="JetBrains Mono,monospace" font-size="8" fill="${cotaColor}" text-anchor="middle" dominant-baseline="middle">${segLength(seg).toFixed(2)}cm</text>`;
    }
  }

  // Nós
  for (const [key,color] of [['start','#00cc55'],['end','#cc2200']]) {
    const n = state.nodes[key];
    if (!n) continue;
    const sp = toSVG(n.x, n.y);
    const r  = 8;
    paths += `<circle cx="${sp.x.toFixed(1)}" cy="${sp.y.toFixed(1)}" r="${r}" stroke="${color}" stroke-width="1.5" fill="${color}22"/>`;
    paths += `<text x="${sp.x.toFixed(1)}" y="${(sp.y+0.5).toFixed(1)}" font-family="JetBrains Mono,monospace" font-size="9" font-weight="bold" fill="${color}" text-anchor="middle" dominant-baseline="middle">${key==='start'?'S':'E'}</text>`;
  }

  // Coordenadas dos vértices (se habilitado)
  if (showVertexCoords) {
    const coordColor = invert ? '#ffffff' : '#101018';
    const boxFill    = invert ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.96)';
    const boxStroke  = invert ? 'rgba(255,255,255,0.75)' : 'rgba(20,24,40,0.55)';
    const leaderCol  = invert ? 'rgba(120,190,255,0.9)' : 'rgba(30,90,190,0.85)';
    const fontSize   = 11;
    const placedBoxes = [];

    // Converte SVG (px) de volta para o mundo (cm), para medir folga.
    const svg2world = (sx, sy) => ({
      x: (sx / CM2SVG - offX) / drawScale,
      y: (sy / CM2SVG - offY) / drawScale,
    });

    for (const seg of state.segments) {
      for (const pt of seg.points) {
        if (!coordExportEnabled(pt)) continue;

        const v = toSVG(pt.x, pt.y);
        const text = `(${pt.x.toFixed(2)}, ${pt.y.toFixed(2)})`;
        const boxW = Math.max(74, text.length * fontSize * 0.62 + 12);
        const boxH = 17;
        const gap  = 13;

        const dirs = [
          { x:  1, y: -1 },
          { x: -1, y: -1 },
          { x: -1, y:  1 },
          { x:  1, y:  1 },
        ];

        let best = null;
        for (const d of dirs) {
          const bx = d.x > 0 ? v.x + gap : v.x - gap - boxW;
          const by = d.y > 0 ? v.y + gap : v.y - gap - boxH;

          // Folga até a geometria (em px do SVG).
          let minDist = Infinity;
          const probes = [
            { x: bx + boxW * 0.5, y: by + boxH * 0.5 },
            { x: bx + 5,          y: by + 5 },
            { x: bx + boxW - 5,   y: by + boxH - 5 },
          ];
          for (const probe of probes) {
            const wp = svg2world(probe.x, probe.y);
            for (const other of state.segments) {
              const cp = closestPointOnSeg(other, wp.x, wp.y);
              const dpx = cp.dist * drawScale * CM2SVG;
              if (dpx < minDist) minDist = dpx;
            }
          }
          let score = Math.min(minDist, 140);

          for (const b of placedBoxes) {
            const overlap = !(bx + boxW < b.x || bx > b.x + b.w || by + boxH < b.y || by > b.y + b.h);
            if (overlap) score -= 600;
          }

          // Mantém a etiqueta dentro da página.
          const pagePxW = svgW * CM2SVG, pagePxH = svgH * CM2SVG;
          if (bx < 3 || by < 3 || bx + boxW > pagePxW - 3 || by + boxH > pagePxH - 3) {
            score -= 300;
          }

          if (!best || score > best.score) best = { score, bx, by };
        }

        placedBoxes.push({ x: best.bx, y: best.by, w: boxW, h: boxH });

        // Linha de chamada do vértice até a borda da etiqueta.
        const ax = Math.max(best.bx + 4, Math.min(v.x, best.bx + boxW - 4));
        const ay = Math.max(best.by + 4, Math.min(v.y, best.by + boxH - 4));
        paths += `<line x1="${v.x.toFixed(1)}" y1="${v.y.toFixed(1)}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}" stroke="${leaderCol}" stroke-width="0.9"/>`;
        paths += `<circle cx="${v.x.toFixed(1)}" cy="${v.y.toFixed(1)}" r="1.6" fill="${leaderCol}"/>`;

        // Caixa de fundo + texto legível.
        paths += `<rect x="${best.bx.toFixed(1)}" y="${best.by.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" rx="3" fill="${boxFill}" stroke="${boxStroke}" stroke-width="0.8"/>`;
        paths += `<text x="${(best.bx + boxW / 2).toFixed(1)}" y="${(best.by + boxH / 2 + 0.5).toFixed(1)}" font-family="JetBrains Mono, ui-monospace, monospace" font-size="${fontSize}" font-weight="600" fill="${coordColor}" text-anchor="middle" dominant-baseline="middle">${text}</text>`;
      }
    }
  }

  // Rodapé
  const footerY = (svgH - margin*0.4) * CM2SVG;
  const footerColor = invert?'rgba(255,255,255,0.3)':'rgba(0,0,0,0.25)';
  paths += `<text x="${(margin*CM2SVG).toFixed(0)}" y="${footerY.toFixed(0)}" font-family="Rajdhani,sans-serif" font-size="9" fill="${footerColor}">LineTrack CAD · Formato ${format} · ${new Date().toLocaleDateString('pt-BR')}</text>`;

  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${(svgW*CM2SVG).toFixed(0)}"
     height="${(svgH*CM2SVG).toFixed(0)}"
     viewBox="0 0 ${(svgW*CM2SVG).toFixed(0)} ${(svgH*CM2SVG).toFixed(0)}">
  <rect width="100%" height="100%" fill="${bg}"/>
  ${paths}
</svg>`;

  // Gerar PDF via print de SVG em janela nova
  const win = window.open('', '_blank');
  if (!win) { toast('Permita pop-ups para exportar PDF','warn'); return; }

  win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>LineTrack CAD — Exportar PDF</title>
<style>
  @page { size: ${pageW}cm ${pageH}cm; margin: 0; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${pageW}cm; height:${pageH}cm; overflow:hidden; }
  img  { width:${pageW}cm; height:${pageH}cm; display:block; }
</style>
</head>
<body>
<img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}" />
<script>
  window.onload = function() {
    setTimeout(function(){ window.print(); }, 400);
  };
<\/script>
</body>
</html>`);
  win.document.close();
  toast('Janela de impressão aberta · Salve como PDF', 'success');
}

// ── MENU / BOTÕES ─────────────────────────────────────────
document.querySelectorAll('[data-action]').forEach(btn => {
  btn.addEventListener('click', () => {
    switch (btn.dataset.action) {
      case 'new':         newProject();    break;
      case 'save':        saveJSON();      break;
      case 'load':        document.getElementById('file-input').click(); break;
      case 'export-pdf':  exportPDF();     break;
      case 'undo':        undo();          break;
      case 'redo':        redo();          break;
      case 'select-all':  selectAll();     break;
      case 'delete-sel':  deleteSelection(); break;
      case 'dijkstra':    runTrackAnalysis(); break;
      case 'clear-path':
        state.dijkstraPath = [];
        document.getElementById('dijk-result').classList.add('hidden');
        render(); toast('Destaque limpo'); break;
      case 'fit-view':    fitView(); break;
      case 'toggle-grid':
        state.showGrid = !state.showGrid;
        document.getElementById('btn-toggle-grid').classList.toggle('active', state.showGrid);
        render(); break;
      case 'clear-grid':
        // "limpar grade" = ocultar temporariamente (toggle)
        state.showGrid = false;
        document.getElementById('btn-toggle-grid').classList.remove('active');
        render(); toast('Grade ocultada · G para reexibir'); break;
      case 'toggle-snap':
        state.snapEnabled = !state.snapEnabled;
        document.getElementById('btn-toggle-snap').classList.toggle('active', state.snapEnabled);
        break;
      case 'toggle-crit':
        state.showCritical = !state.showCritical;
        render(); break;
      case 'coord':         setTool('line'); openCoordHud(); break;
      case 'tool-circle':   setTool('circle');   break;
      case 'tool-rect':     setTool('rect');     break;
      case 'tool-polyline': setTool('polyline'); break;
      case 'tool-spiral':   setTool('spiral');   break;
      case 'tool-offset':   setTool('offset');   break;
      case 'tool-mirror':   setTool('mirror');   break;
      case 'tool-rotate':   setTool('rotate');   break;
      case 'tool-scale':    setTool('scale');    break;
      case 'tool-array':    setTool('array');    break;
      case 'tool-vertex':   setTool('vertex-edit'); break;
      case 'tool-trim':     setTool('trim');     break;
      case 'tool-extend':   setTool('extend');   break;
      case 'tool-join':     setTool('join');     break;
      case 'tool-break':    setTool('break');    break;
    }
  });
});

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    setTool(btn.dataset.tool);
    if (btn.dataset.tool === 'move') openMoveHud();
  });
});

document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);
document.getElementById('btn-delete-sel').addEventListener('click', deleteSelection);
document.getElementById('btn-dijkstra').addEventListener('click', runTrackAnalysis);
document.getElementById('btn-export-pdf').addEventListener('click', exportPDF);
document.getElementById('exp-vertex-coords').addEventListener('change', e => {
  state.showVertexCoords = e.target.checked;
  render();
});
document.getElementById('circle-quads-toggle').addEventListener('change', e => {
  state.showCircleQuads = e.target.checked;
  render();
});
document.getElementById('btn-coord-all').addEventListener('click', () => {
  if (!state.segments.length) { toast('Nenhum vértice para marcar', 'warn'); return; }
  saveUndo();
  for (const seg of state.segments)
    for (const pt of seg.points) pt.exportCoord = true;
  updatePanelInfo(); render();
  toast('Todos os vértices marcados', 'success');
});
document.getElementById('btn-coord-none').addEventListener('click', () => {
  saveUndo();
  for (const seg of state.segments)
    for (const pt of seg.points) pt.exportCoord = false;
  updatePanelInfo(); render();
  toast('Coordenadas desmarcadas');
});
document.getElementById('btn-zoom-reset').addEventListener('click', () => {
  cam.x = canvas.width/2; cam.y = canvas.height/2; cam.scale = 1;
  updateZoomDisplay(); render();
});
document.getElementById('btn-toggle-grid').addEventListener('click', () => {
  state.showGrid = !state.showGrid;
  document.getElementById('btn-toggle-grid').classList.toggle('active', state.showGrid);
  render();
});
document.getElementById('btn-toggle-snap').addEventListener('click', () => {
  state.snapEnabled = !state.snapEnabled;
  document.getElementById('btn-toggle-snap').classList.toggle('active', state.snapEnabled);
});

// HUD polar botões
document.getElementById('polar-confirm-btn').addEventListener('click', commitPolarHud);
document.getElementById('polar-cancel-btn').addEventListener('click', () => {
  ui.lineStart = null;
  hidePolarHud();
  setTool('select');
});
document.getElementById('polar-mode-select').addEventListener('change', e => {
  ui.polarInputMode = e.target.value;
  if (ui.lineStart) showPolarHud(ui.lineStart);
  render();
});

// HUD círculo botões
document.getElementById('circle-confirm-btn').addEventListener('click', commitCircleHud);
document.getElementById('circle-cancel-btn').addEventListener('click', () => {
  ui.circleCenter = null;
  ui.circleMode = 'center';
  ui.circleSide = 'E';
  hideCircleHud();
  setTool('select');
});
document.getElementById('circle-mode-select').addEventListener('change', e => {
  ui.circleMode = e.target.value;
  ui.circleCenter = null;
  ui.circleSide = 'E';
  updateCircleHud();
  render();
});

// HUD move botões
document.getElementById('move-confirm-btn').addEventListener('click', applyPrecisionMove);
document.getElementById('move-cancel-btn').addEventListener('click', () => {
  hideMoveHud();
  setTool('select');
});

// HUD coordenadas
document.getElementById('coord-confirm-btn').addEventListener('click', applyCoordHud);
document.getElementById('coord-cancel-btn').addEventListener('click', () => {
  hideCoordHud();
});
document.getElementById('coord-mode').addEventListener('change', e => {
  ui.coordMode = e.target.value;
});

// HUD rotate / scale / array
document.getElementById('rotate-apply-btn').addEventListener('click', applyRotate);
document.getElementById('rotate-cancel-btn').addEventListener('click', () => {
  hideRotateHud();
  setTool('select');
});
document.getElementById('scale-apply-btn').addEventListener('click', applyScale);
document.getElementById('scale-cancel-btn').addEventListener('click', () => {
  hideScaleHud();
  setTool('select');
});
document.getElementById('array-apply-btn').addEventListener('click', applyArray);
document.getElementById('array-cancel-btn').addEventListener('click', () => {
  hideArrayHud();
  setTool('select');
});

// Snap angular configurável
document.getElementById('btn-toggle-angle').addEventListener('click', () => {
  state.angleSnap = !state.angleSnap;
  document.getElementById('btn-toggle-angle').classList.toggle('active', state.angleSnap);
  render();
});
document.getElementById('angle-step-input').addEventListener('change', () => {
  const v = parseFloat(document.getElementById('angle-step-input').value);
  if (!isNaN(v) && v > 0) state.angleStep = v;
});

// Snap de distância configurável (F9)
function toggleDistSnap() {
  state.distSnap = !state.distSnap;
  const btn = document.getElementById('btn-toggle-dist');
  if (btn) btn.classList.toggle('active', state.distSnap);
  render();
}
document.getElementById('btn-toggle-dist').addEventListener('click', toggleDistSnap);
document.getElementById('dist-step-input').addEventListener('change', () => {
  const v = parseFloat(document.getElementById('dist-step-input').value);
  if (!isNaN(v) && v > 0) state.distStep = v;
});

// Previne Tab de sair dos HUDs — navega entre os campos internos
function polarHudTabCycle(e, forward) {
  e.preventDefault();
  const mode = ui.polarInputMode;
  let fields;
  if (mode === 'polar') {
    fields = [
      document.getElementById('polar-start-x-input'),
      document.getElementById('polar-start-y-input'),
      document.getElementById('polar-dist-input'),
      document.getElementById('polar-angle-input'),
    ];
  } else {
    fields = [
      document.getElementById('polar-start-x-input'),
      document.getElementById('polar-start-y-input'),
      document.getElementById('polar-end-x-input'),
      document.getElementById('polar-end-y-input'),
    ];
  }
  const active = document.activeElement;
  const idx = fields.findIndex(f => f === active);
  if (idx >= 0) {
    const nextIdx = forward ? (idx + 1) % fields.length : (idx - 1 + fields.length) % fields.length;
    fields[nextIdx].focus();
  }
}
document.getElementById('polar-start-x-input').addEventListener('keydown', e => {
  if (e.key === 'Tab') { polarHudTabCycle(e, !e.shiftKey); }
});
document.getElementById('polar-start-y-input').addEventListener('keydown', e => {
  if (e.key === 'Tab') { polarHudTabCycle(e, !e.shiftKey); }
});
document.getElementById('polar-dist-input').addEventListener('keydown', e => {
  if (e.key === 'Tab') { polarHudTabCycle(e, !e.shiftKey); }
});
document.getElementById('polar-angle-input').addEventListener('keydown', e => {
  if (e.key === 'Tab') { polarHudTabCycle(e, !e.shiftKey); }
});
document.getElementById('polar-end-x-input').addEventListener('keydown', e => {
  if (e.key === 'Tab') { polarHudTabCycle(e, !e.shiftKey); }
});
document.getElementById('polar-end-y-input').addEventListener('keydown', e => {
  if (e.key === 'Tab') { polarHudTabCycle(e, !e.shiftKey); }
});
document.getElementById('move-dist-input').addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    document.getElementById('move-angle-input').focus();
  }
});
document.getElementById('move-angle-input').addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    document.getElementById('move-dist-input').focus();
  }
});

// Circle HUD - Enter/Escape e Tab entre campos
['circle-diameter-input', 'circle-cx-input', 'circle-cy-input',
 'circle-diameter-input-side', 'circle-start-x-input', 'circle-start-y-input'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitCircleHud(); }
    if (e.key === 'Escape') { hideCircleHud(); setTool('select'); }
  });
});
document.getElementById('circle-mode-select').addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideCircleHud(); setTool('select'); }
});

// Espiral HUD - botões, Enter/Escape, prévia ao digitar
document.getElementById('spiral-confirm-btn').addEventListener('click', applySpiral);
document.getElementById('spiral-cancel-btn').addEventListener('click', () => {
  hideSpiralHud();
  setTool('select');
});
['spiral-cx', 'spiral-cy', 'spiral-r1', 'spiral-angle', 'spiral-factor',
 'spiral-count', 'spiral-start', 'spiral-tail'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    if (id === 'spiral-cx' || id === 'spiral-cy') {
      const cx = parseFloat(document.getElementById('spiral-cx').value);
      const cy = parseFloat(document.getElementById('spiral-cy').value);
      if (Number.isFinite(cx) && Number.isFinite(cy)) ui.spiralCenter = { x: cx, y: cy };
    }
    updateSpiralInfo();
    render();
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); applySpiral(); }
    if (e.key === 'Escape') { hideSpiralHud(); setTool('select'); }
  });
});
document.getElementById('spiral-dir').addEventListener('change', () => {
  updateSpiralInfo();
  render();
});
document.getElementById('spiral-dir').addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideSpiralHud(); setTool('select'); }
});

// Polar HUD - Enter/Escape
['polar-start-x-input', 'polar-start-y-input', 'polar-dist-input', 'polar-angle-input', 'polar-end-x-input', 'polar-end-y-input'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitPolarHud(); }
    if (e.key === 'Escape') { hidePolarHud(); setTool('select'); }
  });
});

// ── STATUS ────────────────────────────────────────────────
function setStatus(msg) {
  document.getElementById('status-msg').textContent = msg;
}

// ── TOAST ─────────────────────────────────────────────────
function toast(msg, type='') {
  let c = document.getElementById('toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    document.body.appendChild(c);
  }
  const t = document.createElement('div');
  t.className = `toast${type?' '+type:''}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

// ── INIT ─────────────────────────────────────────────────
resizeCanvas();
cam.x = canvas.width  / 2;
cam.y = canvas.height / 2;
cam.scale = 1;
updateZoomDisplay();
updatePanelInfo();
updateDijkstraPanel();
setTool('select');
toast('LineTrack CAD · L=Linha A=Arco R=Fillet 1/2=Nós F5=Comprimento', 'success');
