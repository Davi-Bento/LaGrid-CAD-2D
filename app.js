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

// ── ESTADO ────────────────────────────────────────────────
const state = {
  segments:      [],   // {id, type, points[], selected}
  nodes:         { start: null, end: null }, // {x,y,segId,t} — ligados a segmento
  dijkstraPath:  [],   // ids de segmentos no caminho
  undoStack:     [],
  redoStack:     [],
  nextId:        1,
  workspace:     { w: 200, h: 150 }, // cm
  lineWidth:     DEFAULT_LINE_W,      // cm
  showGrid:      true,
  snapEnabled:   true,
  showCritical:  true,
};

const cam = { x: 0, y: 0, scale: 1 };

const ui = {
  tool:         'select',
  lineStart:    null,
  arcPoints:    [],
  mouseWorld:   { x: 0, y: 0 },
  mouseScreen:  { x: 0, y: 0 },
  selection:    new Set(),
  boxSelStart:  null,
  isPanning:    false,
  panStart:     { x: 0, y: 0 },
  camStart:     { x: 0, y: 0 },
  snapTarget:   null,   // ponto magnético atual {x,y}
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
// Coleta todos os endpoints de todos os segmentos
function getAllEndpoints() {
  const pts = [];
  for (const seg of state.segments) {
    const eps = segEndpoints(seg);
    for (const ep of eps) pts.push({ x: ep.x, y: ep.y, segId: seg.id });
  }
  // midpoints de arcos também são pontos de controle relevantes
  return pts;
}

// Retorna ponto magnético mais próximo (em px de tela) ou null
function getMagneticSnap(sx, sy) {
  if (!state.snapEnabled) return null;
  const pts = getAllEndpoints();
  let best = null, bestD = Infinity;
  for (const pt of pts) {
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
function segEndpoints(seg) {
  if (seg.type === 'line') return [seg.points[0], seg.points[1]];
  if (seg.type === 'arc')  return [seg.points[0], seg.points[2]];
  return [];
}

function segLength(seg) {
  if (seg.type === 'line') {
    const p0 = seg.points[0], p1 = seg.points[1];
    return Math.hypot(p1.x - p0.x, p1.y - p0.y);
  }
  if (seg.type === 'arc') return arcLength(seg);
  return 0;
}

function arcLength(seg) {
  const [p0, pm, p1] = seg.points;
  const steps = 60;
  let len = 0, prev = bqAt(p0, pm, p1, 0);
  for (let i = 1; i <= steps; i++) {
    const cur = bqAt(p0, pm, p1, i / steps);
    len += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    prev = cur;
  }
  return len;
}

function bqAt(p0, p1, p2, t) {
  const mt = 1 - t;
  return { x: mt*mt*p0.x + 2*mt*t*p1.x + t*t*p2.x,
           y: mt*mt*p0.y + 2*mt*t*p1.y + t*t*p2.y };
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
    const [p0, pm, p2] = seg.points;
    let best = { t: 0, dist: Infinity, pt: p0 };
    for (let i = 0; i <= 60; i++) {
      const t  = i / 60;
      const pt = bqAt(p0, pm, p2, t);
      const d  = Math.hypot(wx-pt.x, wy-pt.y);
      if (d < best.dist) best = { t, dist: d, pt };
    }
    return best;
  }
  return null;
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
    const [p0,pm,p2] = seg.points;
    let best = Infinity;
    for (let i = 0; i <= STEPS; i++) {
      const wp = bqAt(p0, pm, p2, i/STEPS);
      const sp = w2s(wp.x, wp.y);
      best = Math.min(best, Math.hypot(sp.x-sx, sp.y-sy));
    }
    return best;
  }
  return Infinity;
}

function distPtToSegPx(px,py,ax,ay,bx,by) {
  const dx=bx-ax, dy=by-ay, len2=dx*dx+dy*dy;
  if (len2===0) return Math.hypot(px-ax,py-ay);
  let t=((px-ax)*dx+(py-ay)*dy)/len2;
  t=Math.max(0,Math.min(1,t));
  return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
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
  ui.tool      = tool;
  ui.lineStart = null;
  ui.arcPoints = [];
  hidePolarHud();
  hideFilletHud();
  hideMoveHud();

  canvas.className = '';
  if (tool === 'select')     canvas.classList.add('cursor-select');
  if (tool === 'move')       canvas.classList.add('cursor-select');
  if (tool === 'start-node' || tool === 'end-node') canvas.classList.add('cursor-node');

  document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));

  if (tool === 'fillet') showFilletHud();

  const labels = {
    select:       'SELECIONAR',
    line:         'LINHA',
    arc:          'ARCO 3PTS',
    fillet:       'ROUND/FILLET',
    'start-node': 'NÓ INÍCIO',
    'end-node':   'NÓ CHEGADA',
    move:         'MOVER PRECISÃO',
  };
  document.getElementById('status-tool').textContent = labels[tool] || tool.toUpperCase();
  setStatus('Pronto');
  render();
}

// ── LINHA ─────────────────────────────────────────────────
function lineClick(wx, wy) {
  const pt = ui.snapTarget || { x: wx, y: wy };
  if (!ui.lineStart) {
    ui.lineStart = { ...pt };
    showPolarHud(pt);
    setStatus('Ponto inicial definido · clique para ponto final ou use o HUD polar');
    return;
  }
  commitLine(ui.lineStart, pt);
  ui.lineStart = { ...pt };
  updatePolarHudOrigin(ui.lineStart);
}

function commitLine(p0, p1) {
  if (Math.hypot(p1.x-p0.x, p1.y-p0.y) < 0.01) return;
  saveUndo();
  state.segments.push({ id: state.nextId++, type: 'line',
    points: [{ ...p0 }, { ...p1 }], selected: false });
  state.dijkstraPath = [];
  updatePanelInfo();
  render();
}

// ── ARCO 3PTS ────────────────────────────────────────────
function arcClick(wx, wy) {
  const pt = ui.snapTarget || { x: wx, y: wy };
  ui.arcPoints.push({ ...pt });
  if (ui.arcPoints.length === 3) {
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

  if (!bestVtx) { setStatus('Nenhum vértice encontrado · clique mais perto de uma quina'); return; }

  const { pt: vertex, list } = bestVtx;
  if (list.length < 2) { setStatus('Vértice precisa conectar 2 segmentos'); return; }

  applyRound(list[0].seg, list[1].seg, vertex, radiusCm);
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
  if (angle < 0.01) { setStatus('Segmentos paralelos, fillet não aplicável'); return; }

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

  // Ponto de controle Bézier para aproximar o arco circular
  // Fórmula: ponto de controle = interseção das tangentes (= vertex) ponderada
  // Para arco circular real com Bézier quad: k = (4/3)*tan(angle/4)
  const k  = (4/3) * Math.tan(angle/4);
  const cpx = (tA.x + tB.x)/2 + k * (vertex.x - (tA.x+tB.x)/2);
  const cpy = (tA.y + tB.y)/2 + k * (vertex.y - (tA.y+tB.y)/2);

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

  // Arco de concordância
  state.segments.push({
    id:     state.nextId++,
    type:   'arc',
    points: [{ ...tA }, { x: cpx, y: cpy }, { ...tB }],
    selected: false,
  });

  state.dijkstraPath = [];
  updatePanelInfo();
  render();
  toast(`Round R${radius}cm aplicado`, 'success');
}

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
function calcTrackLength() {
  const ns = state.nodes.start, ne = state.nodes.end;
  if (!ns || !ne) { toast('Defina os nós Início e Chegada em segmentos', 'warn'); return; }

  // Grafo de segmentos conectados por endpoints
  const EPS = 0.5;
  const graph = buildGraph(EPS);
  if (!graph.nodes.length) { toast('Nenhum segmento para analisar', 'warn'); return; }

  // Nó gráfico mais próximo do ponto de início/chegada no segmento
  const startSeg = state.segments.find(s => s.id === ns.segId);
  const endSeg   = state.segments.find(s => s.id === ne.segId);
  if (!startSeg || !endSeg) { toast('Segmento do nó não encontrado', 'error'); return; }

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
      best = { dist: direct, path: [startSeg.id], extra: 0 };
      break;
    }
    const res = dijkstraGraph(graph, c.from, c.to);
    if (!res) continue;
    const total = c.extraFrom + res.dist + c.extraTo;
    if (!best || total < best.dist) {
      best = { dist: total, path: res.path, extra: c.extraFrom + c.extraTo };
    }
  }

  if (!best) {
    toast('Nenhum caminho conectado encontrado', 'error');
    state.dijkstraPath = [];
    render();
    return;
  }

  state.dijkstraPath = best.path;
  render();

  document.getElementById('dijk-result').classList.remove('hidden');
  document.getElementById('dijk-dist').textContent = best.dist.toFixed(2) + ' cm';
  document.getElementById('dijk-segs').textContent = best.path.length;
  toast(`Pista: ${best.dist.toFixed(1)} cm · ${best.path.length} segmentos`, 'success');
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
    const eps = segEndpoints(seg);
    if (eps.length < 2) continue;
    const a = nodeIdx(eps[0]), b = nodeIdx(eps[1]);
    const w = segLength(seg);
    edges.push({ from: a, to: b, weight: w, segId: seg.id });
    edges.push({ from: b, to: a, weight: w, segId: seg.id });
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
    if (pseg[cur] !== -1) path.unshift(pseg[cur]);
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
      if (!ui.selection.has(hit.id)) { ui.selection.clear(); ui.selection.add(hit.id); }
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
    const inside = segEndpoints(seg).every(ep => {
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
  drawSegments();
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
  const sx = ((-cam.x % cellPx) + cellPx) % cellPx;
  const sy = ((-cam.y % cellPx) + cellPx) % cellPx;
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

function drawSegments() {
  const lineWidthPx = cm2px(state.lineWidth);

  for (const seg of state.segments) {
    const inPath = state.dijkstraPath.includes(seg.id);
    const sel    = ui.selection.has(seg.id);
    const baseW  = Math.max(0.5, 1.5 * cam.scale);

    // Faixa de largura (visualização da largura real da linha)
    if (lineWidthPx > 2) {
      ctx.save();
      ctx.strokeStyle = sel
        ? 'rgba(255,255,255,0.07)'
        : inPath
          ? 'rgba(255,224,102,0.06)'
          : seg.type === 'arc'
            ? 'rgba(167,139,250,0.05)'
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
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth   = baseW + 1;
      ctx.shadowColor = 'rgba(255,224,102,0.45)';
      ctx.shadowBlur  = 8;
    } else if (seg.type === 'arc') {
      ctx.strokeStyle = '#a78bfa';
      ctx.lineWidth   = baseW;
      ctx.shadowBlur  = 0;
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
    const [p0,pm,p1] = seg.points;
    const sp0 = w2s(p0.x,p0.y), spm = w2s(pm.x,pm.y), sp1 = w2s(p1.x,p1.y);
    ctx.moveTo(sp0.x, sp0.y);
    ctx.quadraticCurveTo(spm.x, spm.y, sp1.x, sp1.y);
  }
  ctx.stroke();
}

function drawEndpoints(seg, sel) {
  segEndpoints(seg).forEach(ep => {
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
  const pt = ui.snapTarget || wp;

  if (ui.tool === 'line' && ui.lineStart) {
    const sp0 = w2s(ui.lineStart.x, ui.lineStart.y);
    const sp1 = w2s(pt.x, pt.y);
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(74,158,255,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(sp0.x, sp0.y); ctx.lineTo(sp1.x, sp1.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // comprimento em tempo real
    const dist = Math.hypot(pt.x-ui.lineStart.x, pt.y-ui.lineStart.y);
    const mx   = (sp0.x+sp1.x)/2, my = (sp0.y+sp1.y)/2;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${dist.toFixed(2)}cm`, mx, my-6);
  }

  if (ui.tool === 'arc' && ui.arcPoints.length > 0) {
    ui.arcPoints.forEach(p => {
      const sp = w2s(p.x, p.y);
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, Math.PI*2);
      ctx.fillStyle = '#a78bfa'; ctx.fill();
    });
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(167,139,250,0.45)';
    ctx.lineWidth   = 1.5;
    const sp1 = w2s(pt.x, pt.y);
    if (ui.arcPoints.length === 2) {
      const spm = w2s(ui.arcPoints[1].x, ui.arcPoints[1].y);
      const sp0 = w2s(ui.arcPoints[0].x, ui.arcPoints[0].y);
      ctx.beginPath();
      ctx.moveTo(sp0.x,sp0.y);
      ctx.quadraticCurveTo(spm.x,spm.y,sp1.x,sp1.y);
      ctx.stroke();
    } else {
      const sp0 = w2s(ui.arcPoints[0].x, ui.arcPoints[0].y);
      ctx.beginPath(); ctx.moveTo(sp0.x,sp0.y); ctx.lineTo(sp1.x,sp1.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
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
  state.segments.forEach(s => s.points.forEach(p => exp(p.x,p.y)));
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
    cancelCurrentTool();
    return;
  }
  if (e.button !== 0) return;

  switch (ui.tool) {
    case 'select':     handleSelectDown(sx, sy, e); break;
    case 'line':       lineClick(wp.x, wp.y);        break;
    case 'arc':        arcClick(wp.x, wp.y);          break;
    case 'fillet':     filletClick(wp.x, wp.y);       break;
    case 'start-node': placeNode(sx, sy, 'start');    break;
    case 'end-node':   placeNode(sx, sy, 'end');      break;
    case 'move':       openMoveHud();                 break;
  }
}

function onMouseMove(e) {
  const { sx, sy } = getCanvasXY(e);
  const wp = s2w(sx, sy);

  ui.mouseScreen = { x: sx, y: sy };
  ui.mouseWorld  = wp;

  // Snap magnético
  ui.snapTarget = getMagneticSnap(sx, sy);

  const display = ui.snapTarget || wp;
  document.getElementById('coord-x').textContent = display.x.toFixed(2);
  document.getElementById('coord-y').textContent = display.y.toFixed(2);

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

function onKeyDown(e) {
  // Ignorar se foco está em campo de texto EXCETO para Escape e Enter em HUDs
  const tag  = document.activeElement.tagName;
  const inInput = (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA');

  // Escape sempre funciona
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelCurrentTool();
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
    return;
  }

  if (inInput) return;

  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (ctrl && (e.key==='y'||e.key==='Y')) { e.preventDefault(); redo(); return; }
  if (ctrl && e.key === 's') { e.preventDefault(); saveJSON(); return; }
  if (ctrl && e.key === 'o') { e.preventDefault(); document.getElementById('file-input').click(); return; }
  if (ctrl && e.key === 'n') { e.preventDefault(); newProject(); return; }
  if (ctrl && e.key === 'a') { e.preventDefault(); selectAll(); return; }

  switch (e.key) {
    case 'v': case 'V': setTool('select'); break;
    case 'l': case 'L': setTool('line');   break;
    case 'a': case 'A': if (!ctrl) setTool('arc'); break;
    case 'r': case 'R': setTool('fillet'); break;
    case 'm': case 'M': setTool('move'); openMoveHud(); break;
    case '1': setTool('start-node'); break;
    case '2': setTool('end-node');   break;
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
    case 'F5': e.preventDefault(); calcTrackLength(); break;
    case 'Home':
      cam.x = canvas.width/2; cam.y = canvas.height/2; cam.scale = 1;
      updateZoomDisplay(); render();
      break;
  }
}

function cancelCurrentTool() {
  ui.lineStart = null;
  ui.arcPoints = [];
  hidePolarHud();
  hideFilletHud();
  hideMoveHud();
  ui.selection.clear();
  updateSelectionPanel();
  setTool('select');
  render();
}

// ── HUD POLAR (LINHA) ─────────────────────────────────────
function showPolarHud(origin) {
  document.getElementById('polar-dist-input').value  = '';
  document.getElementById('polar-angle-input').value = '0';
  document.getElementById('polar-hud').classList.remove('hidden');
  // Foca no campo de distância sem usar Tab
  setTimeout(() => document.getElementById('polar-dist-input').focus(), 30);
}

function updatePolarHudOrigin(pt) {
  // atualiza ângulo baseado na posição do mouse
  const dx = ui.mouseWorld.x - pt.x;
  const dy = ui.mouseWorld.y - pt.y;
  const ang = ((Math.atan2(-dy, dx) * 180/Math.PI) + 360) % 360;
  document.getElementById('polar-angle-input').value = ang.toFixed(1);
}

function hidePolarHud() {
  document.getElementById('polar-hud').classList.add('hidden');
}

function commitPolarHud() {
  if (!ui.lineStart) return;
  const dist  = parseFloat(document.getElementById('polar-dist-input').value);
  const angle = parseFloat(document.getElementById('polar-angle-input').value) || 0;
  if (isNaN(dist) || dist <= 0) { toast('Distância inválida', 'warn'); return; }

  const rad  = angle * Math.PI / 180;
  const endX = ui.lineStart.x + dist * Math.cos(rad);
  const endY = ui.lineStart.y - dist * Math.sin(rad);

  commitLine(ui.lineStart, { x: endX, y: endY });
  ui.lineStart = { x: endX, y: endY };
  document.getElementById('polar-dist-input').value  = '';
  document.getElementById('polar-angle-input').value = '0';
  document.getElementById('polar-dist-input').focus();
  setStatus(`Linha ${dist}cm a ${angle}° · continue ou Esc para finalizar`);
}

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
  if (segs.length === 1) {
    const s = segs[0];
    document.getElementById('sel-type').textContent = s.type === 'line' ? 'Linha' : 'Arco';
    document.getElementById('sel-len').textContent  = segLength(s).toFixed(3)+' cm';
    document.getElementById('sel-resize-val').value = segLength(s).toFixed(2);
    document.getElementById('sel-line-controls').style.display = s.type==='line'?'block':'none';
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

// ── ÁREA DE TRABALHO ──────────────────────────────────────
document.getElementById('btn-apply-workspace').addEventListener('click', () => {
  const w = parseFloat(document.getElementById('workspace-w').value);
  const h = parseFloat(document.getElementById('workspace-h').value);
  if (isNaN(w)||isNaN(h)||w<=0||h<=0) { toast('Dimensões inválidas','warn'); return; }
  state.workspace = { w, h };
  render();
  toast(`Área de trabalho: ${w}×${h} cm`, 'success');
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
  const data = JSON.stringify({
    version:   3,
    segments:  state.segments,
    nodes:     state.nodes,
    nextId:    state.nextId,
    workspace: state.workspace,
    lineWidth: state.lineWidth,
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
  state.dijkstraPath = [];
  state.undoStack = [];
  state.redoStack = [];
  ui.selection.clear();
  ui.lineStart = null;
  ui.arcPoints = [];
  hidePolarHud();
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

  if (!state.segments.length) { toast('Nenhum segmento para exportar','warn'); return; }

  const PAGE_SIZES = {
    A4:[21,29.7], A3:[29.7,42], A2:[42,59.4], A1:[59.4,84.1], A0:[84.1,118.9]
  };

  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  state.segments.forEach(s => s.points.forEach(p => {
    if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x;
    if(p.y<minY)minY=p.y; if(p.y>maxY)maxY=p.y;
  }));

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
  const dijkColor = invert ? '#ffe066' : '#b8860b'; // amarelo em fundo preto, dourado em branco

  let paths = '';
  for (const seg of state.segments) {
    const inPath = state.dijkstraPath.includes(seg.id);
    const color  = inPath ? dijkColor : (seg.type==='arc' ? (invert?'#c4b5fd':'#7c3aed') : pathColor);
    const sw     = Math.max(0.5, state.lineWidth * drawScale * CM2SVG);

    let d = '';
    if (seg.type === 'line') {
      const p0=toSVG(seg.points[0].x,seg.points[0].y);
      const p1=toSVG(seg.points[1].x,seg.points[1].y);
      d = `M${p0.x.toFixed(2)},${p0.y.toFixed(2)} L${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
    } else if (seg.type === 'arc') {
      const [p0,pm,p1] = seg.points;
      const sp0=toSVG(p0.x,p0.y), spm=toSVG(pm.x,pm.y), sp1=toSVG(p1.x,p1.y);
      d = `M${sp0.x.toFixed(2)},${sp0.y.toFixed(2)} Q${spm.x.toFixed(2)},${spm.y.toFixed(2)} ${sp1.x.toFixed(2)},${sp1.y.toFixed(2)}`;
    }
    if (d) paths += `<path d="${d}" stroke="${color}" stroke-width="${sw.toFixed(2)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

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
      case 'dijkstra':    calcTrackLength(); break;
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
document.getElementById('btn-dijkstra').addEventListener('click', calcTrackLength);
document.getElementById('btn-export-pdf').addEventListener('click', exportPDF);
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

// HUD move botões
document.getElementById('move-confirm-btn').addEventListener('click', applyPrecisionMove);
document.getElementById('move-cancel-btn').addEventListener('click', () => {
  hideMoveHud();
  setTool('select');
});

// Previne Tab de sair dos HUDs — navega entre os campos internos
document.getElementById('polar-dist-input').addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    document.getElementById('polar-angle-input').focus();
  }
});
document.getElementById('polar-angle-input').addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    document.getElementById('polar-dist-input').focus();
  }
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
