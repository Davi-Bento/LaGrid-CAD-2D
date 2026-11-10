/* ═══════════════════════════════════════════════════════
   LAGRID CAD 2D — app.js v2
   Unidade base: CM. 1 cm = PX_PER_CM px na escala 1:1
═══════════════════════════════════════════════════════ */
'use strict';

// ── CONSTANTES E ESTADO ───────────────────────────────────
// Ver js/config.js (constantes) e js/state.js (estado da aplicação).




function resizeCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width  = r.width;
  canvas.height = r.height;
  render();
}
window.addEventListener('resize', resizeCanvas);


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
  if (bg.adjust) bgSetAdjust(false, true);
  if (ui.dragMove) finishMoveDrag();
  if (ui.pasteMode) { ui.pasteMode = null; ui.pasteLabel = null; }
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
  ui.spiralAnchor = null;
  ui.spiralAnchorSet = false;
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
  if (tool === 'spiral') setStatus('Clique para definir a referência · ajuste R1, A, F e N · Enter aplica');
  render();
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

// ── BIBLIOTECA DE CURVAS ─────────────────────────────────
// Cada curva é montada com linhas e arcos de 3 pontos do próprio editor.
// A geometria é escrita em coordenadas matemáticas (Y para cima), que agora
// coincidem com o mundo do editor no primeiro quadrante.

function libPt(x, y) { return { x, y }; }

function libLine(x0, y0, x1, y1) {
  return { type: 'line', points: [libPt(x0, y0), libPt(x1, y1)] };
}

function libArc(cx, cy, r, a0, a1) {
  const rad = d => d * Math.PI / 180;
  const mid = (a0 + a1) / 2;
  return {
    type: 'arc',
    points: [
      libPt(cx + r * Math.cos(rad(a0)), cy + r * Math.sin(rad(a0))),
      libPt(cx + r * Math.cos(rad(mid)), cy + r * Math.sin(rad(mid))),
      libPt(cx + r * Math.cos(rad(a1)), cy + r * Math.sin(rad(a1))),
    ],
  };
}

// Waypoints com cantos arredondados: gera linhas + arcos tangentes.
// `radii[i]` é o raio desejado no vértice i (0 = canto vivo).
function libRoundedPath(pts, radii) {
  const segs = [];
  let start = { x: pts[0][0], y: pts[0][1] };
  const pushLine = (a, b) => {
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) segs.push(libLine(a.x, a.y, b.x, b.y));
  };

  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
    const wanted = (radii && radii[i]) || 0;
    let ux = cur[0] - prev[0], uy = cur[1] - prev[1];
    let vx = next[0] - cur[0], vy = next[1] - cur[1];
    const ul = Math.hypot(ux, uy), vl = Math.hypot(vx, vy);
    ux /= ul; uy /= ul; vx /= vl; vy /= vl;

    const cross = ux * vy - uy * vx;
    const dot   = ux * vx + uy * vy;
    const theta = Math.atan2(Math.abs(cross), dot);
    if (wanted <= 1e-9 || theta < 1e-6 || Math.abs(cross) < 1e-9) {
      pushLine(start, { x: cur[0], y: cur[1] });
      start = { x: cur[0], y: cur[1] };
      continue;
    }

    // Limita o raio para os dois lados do vértice caberem nos trechos.
    const maxT = 0.45 * Math.min(ul, vl);
    const r = Math.min(wanted, maxT * Math.tan(theta / 2));
    const t = r / Math.tan(theta / 2);
    const t1 = { x: cur[0] - ux * t, y: cur[1] - uy * t };
    const t2 = { x: cur[0] + vx * t, y: cur[1] + vy * t };

    // Centro do arco: normal para o lado da curva.
    const sgn = cross > 0 ? 1 : -1;
    const center = { x: t1.x - uy * sgn * r, y: t1.y + ux * sgn * r };

    pushLine(start, t1);
    const a0 = Math.atan2(t1.y - center.y, t1.x - center.x);
    const a1 = Math.atan2(t2.y - center.y, t2.x - center.x);
    let delta = a1 - a0;
    if (sgn > 0 && delta < 0) delta += Math.PI * 2;
    if (sgn < 0 && delta > 0) delta -= Math.PI * 2;
    const am = a0 + delta / 2;
    segs.push({
      type: 'arc',
      points: [
        libPt(t1.x, t1.y),
        libPt(center.x + r * Math.cos(am), center.y + r * Math.sin(am)),
        libPt(t2.x, t2.y),
      ],
    });
    start = t2;
  }

  const last = pts[pts.length - 1];
  pushLine(start, { x: last[0], y: last[1] });
  return segs;
}

const TRACK_LIBRARY = [
  {
    id: 'senna-s', name: 'S do Senna', track: 'Interlagos · Brasil',
    build: () => libRoundedPath(
      [[-28, 16], [-18, 16], [-12, 4], [-4, 12], [2, 2], [12, 2]],
      [0, 5, 4, 4, 3, 0]),
  },
  {
    id: 'parabolica', name: 'Parabólica', track: 'Monza · Itália',
    build: () => [
      libLine(-30, 0, 0, 0),
      libArc(0, -22, 22, 90, -90),
      libLine(0, -44, -30, -44),
    ],
  },
  {
    id: 'hairpin-loews', name: 'Hairpin Loews', track: 'Mônaco',
    build: () => [
      libLine(-18, 0, 0, 0),
      libArc(0, -5, 5, 90, -90),
      libLine(0, -10, -18, -10),
    ],
  },
  {
    id: 'eau-rouge', name: 'Eau Rouge / Raidillon', track: 'Spa-Francorchamps · Bélgica',
    build: () => libRoundedPath(
      [[-26, -12], [-16, -12], [-10, -2], [-2, -8], [4, 4], [14, 4]],
      [0, 5, 4, 4, 3, 0]),
  },
  {
    id: 'corkscrew', name: 'Corkscrew', track: 'Laguna Seca · EUA',
    build: () => libRoundedPath(
      [[-20, 10], [-12, 10], [-9, 4], [-2, 6], [6, 0], [16, 0]],
      [0, 3, 2.5, 2.5, 2.5, 0]),
  },
  {
    id: 'spoon', name: 'Spoon', track: 'Suzuka · Japão',
    build: () => [
      libLine(-30, 0, 0, 0),
      libArc(0, 12, 12, -90, 0),
      libLine(12, 12, 12, 18),
      libArc(0, 18, 12, 0, 90),
      libLine(0, 30, -30, 30),
    ],
  },
  {
    id: '130r', name: '130R', track: 'Suzuka · Japão',
    build: () => {
      const a1 = 40;
      const end = { x: 18 * Math.cos(a1 * Math.PI / 180), y: 18 + 18 * Math.sin(a1 * Math.PI / 180) };
      const tx  = -Math.sin(a1 * Math.PI / 180), ty = Math.cos(a1 * Math.PI / 180);
      return [
        libLine(-25, 0, 0, 0),
        libArc(0, 18, 18, -90, a1),
        libLine(end.x, end.y, end.x + tx * 12, end.y + ty * 12),
      ];
    },
  },
  {
    id: 'bico-de-pato', name: 'Bico de Pato', track: 'Interlagos · Brasil',
    build: () => [
      libLine(-25, 0, 0, 0),
      libArc(0, 12, 12, -90, 0),
      libLine(12, 12, 12, 24),
    ],
  },
  {
    id: 'tamburello', name: 'Tamburello', track: 'Imola · Itália',
    build: () => libRoundedPath(
      [[-30, 0], [-14, 0], [-8, 8], [0, 0], [8, 8], [18, 0]],
      [0, 4, 3, 3, 3, 0]),
  },
  {
    id: 'turn-8', name: 'Turn 8', track: 'Istambul · Turquia',
    build: () => libRoundedPath(
      [[-30, 0], [-4, 0], [6, 4], [10, 10], [6, 16], [-4, 20], [-30, 20]],
      [0, 4, 5, 5, 5, 4, 0]),
  },
];

// ── Curvas próprias ──────────────────────────────────────
// As curvas do usuário ficam no localStorage: continuam disponíveis até o
// navegador ser limpo ("resetado"), mesmo trocando de projeto. Também podem
// ser exportadas como bloco de código para curvas/minhas-curvas.js.
const CUSTOM_CURVES_KEY = STORAGE_KEY_CURVES;

function isValidCurveSeg(seg) {
  if (!seg || typeof seg.type !== 'string') return false;
  if (!Array.isArray(seg.points) || !seg.points.length) return false;
  if (!seg.points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
  if (seg.type === 'circle') return Number.isFinite(seg.radius) && seg.radius > 0;
  if (seg.type === 'line' || seg.type === 'polyline') return seg.points.length >= 2;
  if (seg.type === 'arc') return seg.points.length >= 3;
  return false;
}

function cleanCurveSegs(segs) {
  const out = [];
  for (const seg of Array.isArray(segs) ? segs : []) {
    if (!isValidCurveSeg(seg)) continue;
    const clean = {
      type: seg.type,
      points: seg.points.map(p => ({ x: +p.x, y: +p.y })),
    };
    if (seg.type === 'circle') clean.radius = +seg.radius;
    out.push(clean);
  }
  return out;
}

function loadCustomCurves() {
  let raw;
  try { raw = localStorage.getItem(CUSTOM_CURVES_KEY); } catch (_) { return []; }
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch (_) { return []; }
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const segs = cleanCurveSegs(item.segs);
    if (!segs.length) continue;
    const id = String(item.id || '').trim() || `custom-${Date.now()}-${out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(item.name || 'Curva sem nome').slice(0, 60),
      track: String(item.track || 'Minha pista').slice(0, 60),
      segs,
    });
  }
  return out;
}

function saveCustomCurves(list) {
  try {
    localStorage.setItem(CUSTOM_CURVES_KEY, JSON.stringify(list));
    return true;
  } catch (_) {
    toast('Não foi possível salvar no navegador', 'warn');
    return false;
  }
}

function newCustomCurveId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function storedCurveItem(entry) {
  return {
    id: entry.id,
    name: entry.name,
    track: entry.track,
    custom: true,
    stored: true,
    build: () => cleanCurveSegs(entry.segs),
  };
}

// Biblioteca efetiva = curvas do código + curvas salvas no navegador.
// Curvas vindas do código têm prioridade quando o id coincide.
function libraryItems() {
  const items = TRACK_LIBRARY.map(item => ({ ...item, stored: false }));
  const ids = new Set(items.map(i => i.id));
  for (const entry of loadCustomCurves()) {
    if (ids.has(entry.id)) continue;
    items.push(storedCurveItem(entry));
    ids.add(entry.id);
  }
  return items;
}

function curveCard(item) {
  const card = document.createElement('div');
  card.className = 'lib-card';
  card.dataset.curve = item.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.title = `${item.name} — ${item.track}`;

  const cv = document.createElement('canvas');
  cv.className = 'lib-thumb';
  const name = document.createElement('span');
  name.className = 'lib-name';
  name.textContent = item.name;
  const track = document.createElement('span');
  track.className = 'lib-track';
  track.textContent = item.track;
  card.append(cv, name, track);

  if (item.custom) {
    const badge = document.createElement('span');
    badge.className = 'lib-badge';
    badge.textContent = 'MEU';
    card.appendChild(badge);

    const actions = document.createElement('div');
    actions.className = 'lib-card-actions';
    const codeBtn = document.createElement('button');
    codeBtn.type = 'button';
    codeBtn.className = 'lib-btn lib-code-btn';
    codeBtn.textContent = 'Código';
    codeBtn.title = 'Gerar código para adicionar ao projeto';
    actions.appendChild(codeBtn);

    if (item.stored) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'lib-del';
      del.textContent = '×';
      del.title = 'Excluir esta curva';
      actions.appendChild(del);
    }
    card.appendChild(actions);
  }

  let segs = [];
  try { segs = item.build(); } catch (_) { segs = []; }
  drawLibraryThumb(cv, segs);

  card.addEventListener('click', e => {
    if (e.target.closest('.lib-del')) {
      e.stopPropagation();
      deleteCustomCurve(item.id);
      return;
    }
    if (e.target.closest('.lib-code-btn')) {
      e.stopPropagation();
      showCurveCode(item);
      return;
    }
    insertLibraryCurve(item.id);
  });
  card.addEventListener('keydown', e => {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      insertLibraryCurve(item.id);
    }
  });
  return card;
}

function renderCurveLibraryGrid() {
  const grid = document.getElementById('curve-library-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const item of libraryItems()) grid.appendChild(curveCard(item));
}

function saveSelectionAsCurve() {
  const nameEl = document.getElementById('custom-curve-name');
  const trackEl = document.getElementById('custom-curve-track');
  const name = ((nameEl && nameEl.value) || '').trim();
  if (!name) {
    toast('Dê um nome para a curva', 'warn');
    if (nameEl) nameEl.focus();
    return;
  }
  const picked = selectedSegs();
  if (!picked.length) {
    toast('Selecione os trechos da curva no desenho', 'warn');
    return;
  }

  const segs = cleanCurveSegs(picked);
  if (!segs.length) {
    toast('A seleção não tem linhas ou arcos válidos', 'warn');
    return;
  }

  // Normaliza em torno do centro da caixa delimitadora para guardar a
  // geometria relativa. A inserção recoloca esse centro onde for clicado.
  const anchor = segmentsAnchor(segs);
  for (const seg of segs) {
    for (const p of seg.points) {
      p.x -= anchor.x;
      p.y -= anchor.y;
    }
  }

  const entry = {
    id: newCustomCurveId(),
    name: name.slice(0, 60),
    track: (trackEl && trackEl.value.trim() || 'Minha pista').slice(0, 60),
    segs,
  };
  const list = loadCustomCurves();
  list.push(entry);
  if (!saveCustomCurves(list)) return;

  if (nameEl) nameEl.value = '';
  if (trackEl) trackEl.value = '';
  renderCurveLibraryGrid();
  toast(`Curva "${entry.name}" salva`, 'success');
  setStatus(`Curva "${entry.name}" salva em Minhas Curvas`);
}

function deleteCustomCurve(id) {
  const list = loadCustomCurves();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) return;
  if (!saveCustomCurves(next)) return;
  closeCurveCode();
  renderCurveLibraryGrid();
  toast('Curva excluída', 'success');
}

// ── Exportar / importar curvas como código ───────────────

function jsNum(n) {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? '0' : String(v);
}

function segToCode(seg) {
  const pts = seg.points.map(p => `libPt(${jsNum(p.x)}, ${jsNum(p.y)})`).join(', ');
  if (seg.type === 'circle') {
    return `    { type: 'circle', points: [${pts}], radius: ${jsNum(seg.radius)} },`;
  }
  return `    { type: '${seg.type}', points: [${pts}] },`;
}

function curveCode(item) {
  let segs = [];
  try { segs = item.build(); } catch (_) { segs = []; }
  return [
    '// Curva salva no LaGrid — cole em curvas/minhas-curvas.js',
    'TRACK_LIBRARY.push({',
    `  id: ${JSON.stringify(String(item.id))},`,
    `  name: ${JSON.stringify(String(item.name))},`,
    `  track: ${JSON.stringify(String(item.track || 'Minha pista'))},`,
    '  custom: true,',
    '  build: () => ([',
    ...segs.map(segToCode),
    '  ]),',
    '});',
    '',
  ].join('\n');
}

function customCurvesCode() {
  const custom = libraryItems().filter(i => i.custom);
  if (!custom.length) {
    return '// Nenhuma curva própria salva ainda.\n// Use "Salvar seleção" na Biblioteca de Curvas do LaGrid.\n';
  }
  return custom.map(curveCode).join('\n');
}

let libCodeItem = null;

function showCurveCode(item) {
  const box = document.getElementById('curve-library-code');
  const title = document.getElementById('lib-code-title');
  const text = document.getElementById('lib-code-text');
  if (!box || !text) return;
  libCodeItem = item;
  if (title) title.textContent = `${item.name} · código`;
  text.textContent = curveCode(item);
  box.classList.remove('hidden');
  if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
}

function closeCurveCode() {
  const box = document.getElementById('curve-library-code');
  if (box) box.classList.add('hidden');
  libCodeItem = null;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* cai no fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function slugify(s) {
  return String(s).normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'curva';
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/javascript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function importCurveCode(code) {
  const temp = [];
  try {
    const fn = new Function(
      'TRACK_LIBRARY', 'libPt', 'libLine', 'libArc', 'libRoundedPath',
      '"use strict";\n' + code
    );
    fn(temp, libPt, libLine, libArc, libRoundedPath);
  } catch (err) {
    toast('Arquivo inválido: ' + err.message, 'warn');
    return 0;
  }

  const list = loadCustomCurves();
  let added = 0;
  for (const item of temp) {
    if (!item || typeof item !== 'object' || typeof item.build !== 'function') continue;
    let segs;
    try { segs = cleanCurveSegs(item.build()); } catch (_) { continue; }
    if (!segs.length) continue;

    const anchor = segmentsAnchor(segs);
    for (const seg of segs) {
      for (const p of seg.points) {
        p.x -= anchor.x;
        p.y -= anchor.y;
      }
    }

    let id = String(item.id || '').trim() || newCustomCurveId();
    // Não sobrescreve curvas que já vêm do código do projeto.
    if (TRACK_LIBRARY.some(i => i.id === id)) id = newCustomCurveId();

    const entry = {
      id,
      name: String(item.name || 'Curva importada').slice(0, 60),
      track: String(item.track || 'Minha pista').slice(0, 60),
      segs,
    };
    const idx = list.findIndex(c => c.id === id);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    added++;
  }

  if (!added) {
    toast('Nenhuma curva encontrada no arquivo', 'warn');
    return 0;
  }
  if (!saveCustomCurves(list)) return 0;
  renderCurveLibraryGrid();
  toast(`${added} curva(s) importada(s)`, 'success');
  setStatus(`${added} curva(s) importada(s) para Minhas Curvas`);
  return added;
}

async function handleCurveFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    importCurveCode(text);
  } catch (_) {
    toast('Não foi possível ler o arquivo', 'warn');
  }
  const input = document.getElementById('custom-curve-import');
  if (input) input.value = '';
}

function openCurveLibrary() {
  const win = document.getElementById('curve-library');
  if (!win) return;
  // Uma colocação pendente é cancelada para não misturar os dois modos.
  if (ui.pasteMode) {
    ui.pasteMode = null;
    ui.pasteLabel = null;
    render();
  }
  win.classList.remove('hidden');
  renderCurveLibraryGrid();
  const btn = document.getElementById('btn-curve-library');
  if (btn) btn.classList.add('active');
  setStatus('Biblioteca de Curvas: escolha uma curva · Esc fecha');
}

function closeCurveLibrary() {
  const win = document.getElementById('curve-library');
  if (win) win.classList.add('hidden');
  closeCurveCode();
  const btn = document.getElementById('btn-curve-library');
  if (btn) btn.classList.remove('active');
}

function toggleCurveLibrary() {
  const win = document.getElementById('curve-library');
  if (!win) return;
  if (win.classList.contains('hidden')) openCurveLibrary();
  else closeCurveLibrary();
}

function scaleSegsAboutAnchor(segs, factor) {
  const a = segmentsAnchor(segs);
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return a;
  for (const seg of segs) {
    seg.points.forEach(p => {
      p.x = a.x + (p.x - a.x) * factor;
      p.y = a.y + (p.y - a.y) * factor;
    });
    if (seg.type === 'circle') seg.radius *= factor;
    if (seg.originalCircle) seg.originalCircle.r *= factor;
  }
  return a;
}

function insertLibraryCurve(id) {
  const item = libraryItems().find(i => i.id === id);
  if (!item) return;
  const scaleEl = document.getElementById('curve-library-scale');
  let factor = parseFloat(scaleEl && scaleEl.value);
  if (!Number.isFinite(factor) || factor <= 0) factor = 1;
  factor = Math.max(0.1, Math.min(5, factor));

  const segs = item.build().map(seg => ({
    ...seg,
    selected: false,
    points: seg.points.map(p => ({ ...p })),
  }));
  const anchor = scaleSegsAboutAnchor(segs, factor);

  closeCurveLibrary();
  setTool('select');
  ui.snapTarget = null;
  ui.clipboard = { segs, anchor: { ...anchor } };
  if (!startPasteMode()) return;
  ui.pasteLabel = item.name;
  setStatus(`${item.name}: clique no desenho para inserir · ${PASTE_HINT}`);
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
  const dy  = dist * Math.sin(rad); // Y para cima (primeiro quadrante)

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

// ── IMAGEM DE FUNDO ───────────────────────────────────────
function bgAspect() {
  return bg.image ? bg.image.height / bg.image.width : 1;
}

function bgHeightCm() {
  return bg.widthCm * bgAspect();
}

// Converte um deslocamento local (cm) em coordenada de mundo, já rotacionado.
function bgLocalToWorld(lx, ly) {
  const rad = bg.rotation * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { x: bg.x + lx*cos - ly*sin,
           y: bg.y + lx*sin + ly*cos };
}

function bgCornersWorld() {
  const hw = bg.widthCm / 2, hh = bgHeightCm() / 2;
  return [bgLocalToWorld(-hw, -hh), bgLocalToWorld(hw, -hh),
          bgLocalToWorld(hw, hh),   bgLocalToWorld(-hw, hh)];
}

function bgRotationHandleWorld() {
  const marginCm = 28 / (PX_PER_CM * cam.scale);
  return bgLocalToWorld(0, bgHeightCm()/2 + marginCm);
}

function bgPointInside(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-9) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function bgHitTest(sx, sy) {
  if (!bg.image || !bg.adjust) return null;

  const rot = bgRotationHandleWorld();
  const rs = w2s(rot.x, rot.y);
  if (Math.hypot(sx - rs.x, sy - rs.y) <= 9) return { mode: 'rotate' };

  const corners = bgCornersWorld().map(p => w2s(p.x, p.y));
  for (let i = 0; i < corners.length; i++) {
    if (Math.hypot(sx - corners[i].x, sy - corners[i].y) <= 8) {
      return { mode: 'resize', handle: i };
    }
  }
  if (bgPointInside({ x: sx, y: sy }, corners)) return { mode: 'move' };
  return null;
}

function bgBeginDrag(hit, wp) {
  bg.drag = {
    mode:       hit.mode,
    handle:     hit.handle,
    startWorld: { x: wp.x, y: wp.y },
    startX:     bg.x,
    startY:     bg.y,
    startW:     bg.widthCm,
    startRot:   bg.rotation,
    startAngle: Math.atan2(wp.y - bg.y, wp.x - bg.x),
  };
  if (hit.mode === 'rotate') canvas.style.cursor = 'grabbing';
}

function bgUpdateDrag(wp, shiftKey) {
  const d = bg.drag;
  if (!d) return;

  if (d.mode === 'move') {
    bg.x = d.startX + (wp.x - d.startWorld.x);
    bg.y = d.startY + (wp.y - d.startWorld.y);
  } else if (d.mode === 'resize') {
    const d0 = Math.hypot(d.startWorld.x - d.startX, d.startWorld.y - d.startY);
    const d1 = Math.hypot(wp.x - bg.x, wp.y - bg.y);
    if (d0 > 0.01) bg.widthCm = Math.max(1, d.startW * (d1 / d0));
  } else if (d.mode === 'rotate') {
    const a = Math.atan2(wp.y - bg.y, wp.x - bg.x);
    let deg = d.startRot + (a - d.startAngle) * 180 / Math.PI;
    if (shiftKey) deg = Math.round(deg / 15) * 15;
    bg.rotation = ((deg % 360) + 360) % 360;
  }
}

function bgFitToWorkspace() {
  if (!bg.image) return;
  const maxW = state.workspace.w * 0.9;
  const maxH = state.workspace.h * 0.9;
  const aspect = bgAspect();
  let w = maxW, h = w * aspect;
  if (h > maxH) { h = maxH; w = h / aspect; }
  bg.widthCm = Math.max(1, w);
  bg.x = state.workspace.w / 2;
  bg.y = state.workspace.h / 2;
}

function bgCenter() {
  if (!bg.image) return;
  bg.x = state.workspace.w / 2;
  bg.y = state.workspace.h / 2;
}

function bgSyncControls() {
  const has = !!bg.image;
  ['bg-visible', 'bg-opacity', 'bg-width', 'bg-rotation', 'bg-x', 'bg-y',
   'btn-bg-adjust', 'btn-bg-fit', 'btn-bg-center', 'btn-bg-remove'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !has;
  });

  const meta = document.getElementById('bg-meta');
  if (meta) {
    meta.textContent = has
      ? `${bg.name} · ${bg.image.width}×${bg.image.height} px`
      : 'Nenhuma imagem carregada';
    meta.classList.toggle('has-image', has);
  }

  const setVal = (id, value) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = value;
  };
  setVal('bg-width',     has ? bg.widthCm.toFixed(1) : 0);
  setVal('bg-rotation',  has ? bg.rotation.toFixed(1) : 0);
  setVal('bg-x',         has ? bg.x.toFixed(1) : 0);
  setVal('bg-y',         has ? bg.y.toFixed(1) : 0);

  const visible = document.getElementById('bg-visible');
  if (visible) visible.checked = bg.visible;

  const opacity = document.getElementById('bg-opacity');
  if (opacity) opacity.value = Math.round(bg.opacity * 100);

  const opacityVal = document.getElementById('bg-opacity-val');
  if (opacityVal) opacityVal.textContent = `${Math.round(bg.opacity * 100)}%`;

  const adjust = document.getElementById('btn-bg-adjust');
  if (adjust) adjust.classList.toggle('active', bg.adjust);
}

// Liga/desliga o modo de ajuste. silent evita render/status (usado por setTool).
function bgSetAdjust(on, silent) {
  const next = !!on && !!bg.image;
  bg.adjust = next;
  bg.drag = null;
  canvas.style.cursor = '';
  bgSyncControls();
  if (silent) return;
  if (next) {
    setStatus('Imagem de fundo: arraste para mover · cantos redimensionam · alça gira · Shift trava 15° · Esc sai');
  } else {
    setStatus('Pronto');
  }
  render();
}

function bgLoadImage(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, BG_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    off.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);

    bg.image    = off;
    bg.name     = file.name || 'imagem';
    bg.rotation = 0;
    bg.opacity  = 0.4;
    bg.visible  = true;
    bg.adjust   = false;
    bg.drag     = null;
    bgFitToWorkspace();
    bgSyncControls();
    render();
    toast('Imagem de fundo carregada', 'success');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast('Não foi possível carregar a imagem', 'warn');
  };
  img.src = url;
}

function bgRemove() {
  bg.image   = null;
  bg.name    = '';
  bg.drag    = null;
  bg.adjust  = false;
  canvas.style.cursor = '';
  bgSyncControls();
  render();
  setStatus('Imagem de fundo removida');
  toast('Imagem de fundo removida');
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

function fitWorkspace() {
  const pad = 50;
  const bw  = state.workspace.w * PX_PER_CM;
  const bh  = state.workspace.h * PX_PER_CM;
  const sw  = canvas.width  - pad*2;
  const sh  = canvas.height - pad*2;
  const sc  = Math.min(sw/(bw||1), sh/(bh||1), 10);
  cam.scale = sc;
  cam.x = pad + (sw-bw*sc)/2;
  // Primeiro quadrante: a origem (0,0) fica na base da área de trabalho.
  cam.y = pad + (sh-bh*sc)/2 + state.workspace.h * PX_PER_CM * sc;
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
  // Y para cima: o maior Y do mundo fica no topo da tela.
  cam.y = pad + (sh-bh*sc)/2 + maxY*PX_PER_CM*sc;
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
    if (bg.adjust) { bgSetAdjust(false); return; }
    if (cancelPaste()) return;
    cancelCurrentTool();
    return;
  }
  if (e.button !== 0) return;

  // Modo de ajuste da imagem de fundo: alças e arrasto têm prioridade
  if (bg.adjust) {
    const hit = bgHitTest(sx, sy);
    if (hit) { bgBeginDrag(hit, wp); return; }
    bgSetAdjust(false);
    return;
  }

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

  // Arrasto da imagem de fundo (mover, redimensionar ou girar)
  if (bg.drag) {
    bgUpdateDrag(wp, e.shiftKey);
    const cx = document.getElementById('coord-x');
    const cy = document.getElementById('coord-y');
    if (cx) cx.textContent = wp.x.toFixed(2);
    if (cy) cy.textContent = wp.y.toFixed(2);
    const sc = document.getElementById('status-coord');
    if (sc) sc.textContent = `X: ${wp.x.toFixed(2)} cm  Y: ${wp.y.toFixed(2)} cm`;
    render();
    return;
  }

  // Cursor contextual das alças no modo de ajuste
  if (bg.adjust) {
    const hit = bgHitTest(sx, sy);
    canvas.style.cursor = !hit ? 'default'
      : hit.mode === 'rotate' ? 'grab'
      : hit.mode === 'move'   ? 'move'
      : (hit.handle % 2 === 0 ? 'nesw-resize' : 'nwse-resize');
  }

  // Snap magnético (ignora o próprio vértice que está sendo arrastado)
  ui.snapTarget = getMagneticSnap(sx, sy, ui.dragVertex, ui.dragMove ? ui.dragMove.ids : null);

  // Escolha do lado (N/L/S/O) no modo "pela borda" do círculo
  const prevScreen = ui.prevMouseScreen;
  ui.prevMouseScreen = { x: sx, y: sy };
  if (ui.tool === 'circle' && ui.circleMode === 'side') {
    if (!ui.circleCenter) {
      if (prevScreen) {
        const dx = sx - prevScreen.x, dy = sy - prevScreen.y;
        if (Math.hypot(dx, dy) >= 3) ui.circleSide = circleSideFromDelta(dx, -dy);
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
  // Espiral: enquanto a referência não foi definida, ela segue o mouse
  if (ui.tool === 'spiral' && !ui.spiralAnchorSet) {
    const cxIn = document.getElementById('spiral-cx');
    const cyIn = document.getElementById('spiral-cy');
    if (cxIn && document.activeElement !== cxIn) cxIn.value = ui.mouseWorld.x.toFixed(2);
    if (cyIn && document.activeElement !== cyIn) cyIn.value = ui.mouseWorld.y.toFixed(2);
    updateSpiralInfo();
  }

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
  if (e.button === 0 && bg.drag) {
    bg.drag = null;
    canvas.style.cursor = '';
    bgSyncControls();
    render();
    setStatus('Imagem de fundo ajustada');
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
    if (bg.adjust) { bgSetAdjust(false); return; }
    const lib = document.getElementById('curve-library');
    if (lib && !lib.classList.contains('hidden')) {
      const code = document.getElementById('curve-library-code');
      if (code && !code.classList.contains('hidden')) { closeCurveCode(); return; }
      closeCurveLibrary();
      return;
    }
    if (cancelPaste()) return;
    if (cancelMoveDrag()) return;
    cancelCurrentTool();
    return;
  }

  // Ctrl+Tab alterna a aba do HUD (modo/referência) sem sair do campo.
  if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
    if (cycleHudTab(!e.shiftKey)) { e.preventDefault(); return; }
  }

  // Digitou um número sem campo focado? Vai para o parâmetro principal do HUD
  // e a primeira digitação substitui o valor (estilo AutoCAD).
  const hud = activeHud();
  if (hud && !inInput && /^[0-9.,-]$/.test(e.key)) {
    const target = hudPrimaryInput(hud);
    if (target) {
      e.preventDefault();
      typeIntoHudInput(target, e.key);
      return;
    }
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

  // Modo colagem: setas mudam a escala, R gira 90° e Tab troca a âncora.
  // Fica antes dos atalhos de ferramenta para o R não abrir o fillet.
  if (ui.pasteMode && !ctrl) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = e.key === 'ArrowUp' ? 1.1 : 1 / 1.1;
      ui.pasteMode.scale = Math.max(0.05, Math.min(20, ui.pasteMode.scale * step));
      setStatus(`Colagem: escala ${ui.pasteMode.scale.toFixed(2)}× · ${PASTE_HINT}`);
      render();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      ui.pasteMode.rotation = (ui.pasteMode.rotation + Math.PI / 2) % (Math.PI * 2);
      const deg = Math.round(ui.pasteMode.rotation * 180 / Math.PI);
      setStatus(`Colagem: giro ${deg}° · ${PASTE_HINT}`);
      render();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      cyclePasteAnchor();
      return;
    }
  }

  // Tab percorre os parâmetros do HUD aberto (não sai da janela).
  if (e.key === 'Tab' && !ctrl && !e.altKey && hudTabMove(e, !e.shiftKey)) return;

  // Enter também conclui o ajuste da imagem de fundo
  if (e.key === 'Enter' && bg.adjust) {
    e.preventDefault();
    bgSetAdjust(false);
    return;
  }

  // Toggles de precisão (F1–F4) funcionam mesmo com um campo focado.
  switch (e.key) {
    case 'F1': e.preventDefault(); toggleGrid();      return;
    case 'F2': e.preventDefault(); toggleSnap();      return;
    case 'F3': e.preventDefault(); toggleAngleSnap(); return;
    case 'F4': e.preventDefault(); toggleDistSnap();  return;
  }

  if (inInput) return;

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
    case 'F5': e.preventDefault(); runTrackAnalysis(); break;
    case 'Home':
      e.preventDefault();
      fitWorkspace();
      break;
  }
}

function cancelCurrentTool() {
  // Cancela colagem/arrasto pendentes antes de limpar a ferramenta
  if (ui.pasteMode) { ui.pasteMode = null; ui.pasteLabel = null; }
  if (ui.dragMove) { cancelMoveDrag(); }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  ui.lineStart    = null;
  ui.arcPoints    = [];
  ui.polyPoints   = [];
  ui.rectStart    = null;
  ui.circleCenter = null;
  ui.circleMode   = 'center';
  ui.circleSide   = 'E';
  ui.spiralAnchor = null;
  ui.spiralAnchorSet = false;
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
  // NÃO foca automaticamente para permitir digitação direta no canvas
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
  const ang = ((Math.atan2(dy, dx) * 180/Math.PI) + 360) % 360;

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
    endY = startY + dist * Math.sin(rad);
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

// ── IMAGEM DE FUNDO ───────────────────────────────────────
document.getElementById('btn-bg-load').addEventListener('click', () => {
  document.getElementById('bg-image-input').click();
});

document.getElementById('bg-image-input').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (file) bgLoadImage(file);
  e.target.value = '';
});

document.getElementById('bg-visible').addEventListener('change', e => {
  bg.visible = e.target.checked;
  render();
});

document.getElementById('bg-opacity').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (!Number.isFinite(v)) return;
  bg.opacity = Math.min(1, Math.max(0.05, v / 100));
  bgSyncControls();
  render();
});

function bindBgNumber(id, apply) {
  const el = document.getElementById(id);
  el.addEventListener('input', () => {
    if (!bg.image) return;
    const v = parseFloat(el.value);
    if (!Number.isFinite(v)) return;
    apply(v);
    render();
  });
}
bindBgNumber('bg-width',    v => { bg.widthCm = Math.max(1, v); });
bindBgNumber('bg-rotation', v => { bg.rotation = v; });
bindBgNumber('bg-x',        v => { bg.x = v; });
bindBgNumber('bg-y',        v => { bg.y = v; });

document.getElementById('btn-bg-adjust').addEventListener('click', () => {
  bgSetAdjust(!bg.adjust);
});
document.getElementById('btn-bg-fit').addEventListener('click', () => {
  bgFitToWorkspace();
  bgSyncControls();
  render();
  setStatus('Imagem encaixada na área de trabalho');
});
document.getElementById('btn-bg-center').addEventListener('click', () => {
  bgCenter();
  bgSyncControls();
  render();
  setStatus('Imagem centralizada');
});
document.getElementById('btn-bg-remove').addEventListener('click', bgRemove);

bgSyncControls();


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
  ui.spiralAnchor = null;
  ui.spiralAnchorSet = false;
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

  // Área de trabalho: dimensões configuradas no painel (cm).
  let wsW = Number(state.workspace && state.workspace.w);
  let wsH = Number(state.workspace && state.workspace.h);
  if (!(wsW > 0)) wsW = DEFAULT_WORKSPACE_W;
  if (!(wsH > 0)) wsH = DEFAULT_WORKSPACE_H;

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
  let pageW, pageH, fixedScale = null;
  if (format === 'workspace') {
    // Página do tamanho exato da área de trabalho, desenhada em escala 1:1.
    pageW = wsW;
    pageH = wsH;
    fixedScale = 1;
  } else if (format === 'auto') {
    pageW = trackW + margin*2;
    pageH = trackH + margin*2;
  } else {
    [pageW, pageH] = PAGE_SIZES[format];
    if (trackW > trackH && pageW < pageH) [pageW,pageH] = [pageH,pageW];
  }

  const drawScale = fixedScale !== null
    ? fixedScale
    : Math.min((pageW-margin*2)/(trackW||1), (pageH-margin*2)/(trackH||1));
  // Na área de trabalho o desenho mantém as coordenadas do editor (origem no canto).
  const offX = format === 'workspace' ? 0 : margin - minX*drawScale;
  // Y para cima no mundo: o maior Y fica no topo da página.
  const offY = format === 'workspace' ? pageH : margin + maxY*drawScale;

  const clippedByWorkspace = format === 'workspace' &&
    (minX < -1e-6 || minY < -1e-6 || maxX > wsW + 1e-6 || maxY > wsH + 1e-6);

  // Criar SVG
  const svgW = pageW, svgH = pageH; // cm
  const CM2SVG = 37.795; // 96dpi

  function toSVG(x, y) {
    return { x:(x*drawScale+offX)*CM2SVG, y:(offY-y*drawScale)*CM2SVG };
  }

  const pageBg = invert ? '#000000' : '#ffffff';
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
      y: (offY - sy / CM2SVG) / drawScale,
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
  const footerPad = format === 'workspace' ? Math.max(0.4, margin) : margin;
  const footerY = (svgH - footerPad*0.4) * CM2SVG;
  const footerColor = invert?'rgba(255,255,255,0.3)':'rgba(0,0,0,0.25)';
  const formatLabel = format === 'workspace'
    ? `Área de trabalho ${wsW}×${wsH} cm · 1:1`
    : `Formato ${format}`;
  paths += `<text x="${(footerPad*CM2SVG).toFixed(0)}" y="${footerY.toFixed(0)}" font-family="Rajdhani,sans-serif" font-size="9" fill="${footerColor}">LaGrid CAD 2D · ${formatLabel} · ${new Date().toLocaleDateString('pt-BR')}</text>`;

  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${(svgW*CM2SVG).toFixed(0)}"
     height="${(svgH*CM2SVG).toFixed(0)}"
     viewBox="0 0 ${(svgW*CM2SVG).toFixed(0)} ${(svgH*CM2SVG).toFixed(0)}">
  <rect width="100%" height="100%" fill="${pageBg}"/>
  ${paths}
</svg>`;

  // Gerar PDF via print de SVG em janela nova
  const win = window.open('', '_blank');
  if (!win) { toast('Permita pop-ups para exportar PDF','warn'); return; }

  win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>LaGrid CAD 2D — Exportar PDF</title>
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
  toast(clippedByWorkspace
    ? 'PDF 1:1 aberto · atenção: parte da pista está fora da área de trabalho'
    : 'Janela de impressão aberta · Salve como PDF',
    clippedByWorkspace ? 'warn' : 'success');
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
      case 'toggle-grid':  toggleGrid(); break;
      case 'clear-grid':
        // "limpar grade" = ocultar temporariamente (toggle)
        state.showGrid = false;
        document.getElementById('btn-toggle-grid').classList.remove('active');
        render(); toast('Grade ocultada · F1 para reexibir'); break;
      case 'toggle-snap':  toggleSnap(); break;
      case 'toggle-angle': toggleAngleSnap(); break;
      case 'toggle-dist':  toggleDistSnap(); break;
      case 'toggle-crit':
        state.showCritical = !state.showCritical;
        render(); break;
      case 'coord':         setTool('line'); openCoordHud(); break;
      case 'curve-library': toggleCurveLibrary(); break;
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

document.getElementById('btn-curve-library').addEventListener('click', toggleCurveLibrary);
document.getElementById('curve-library-close').addEventListener('click', closeCurveLibrary);

document.getElementById('custom-curve-save').addEventListener('click', saveSelectionAsCurve);
['custom-curve-name', 'custom-curve-track'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      saveSelectionAsCurve();
    }
  });
});
document.getElementById('custom-curve-import-btn').addEventListener('click', () => {
  const input = document.getElementById('custom-curve-import');
  if (input) input.click();
});
document.getElementById('custom-curve-import').addEventListener('change', e => {
  handleCurveFile(e.target.files && e.target.files[0]);
});
document.getElementById('custom-curve-download-all').addEventListener('click', () => {
  const custom = libraryItems().filter(i => i.custom);
  if (!custom.length) {
    toast('Nenhuma curva própria para baixar', 'warn');
    return;
  }
  downloadText('minhas-curvas.js', custom.map(curveCode).join('\n'));
  toast('Arquivo minhas-curvas.js gerado', 'success');
});
document.getElementById('lib-code-copy').addEventListener('click', async () => {
  const text = document.getElementById('lib-code-text').textContent || '';
  if (await copyText(text)) toast('Código copiado', 'success');
  else toast('Não foi possível copiar', 'warn');
});
document.getElementById('lib-code-download').addEventListener('click', () => {
  if (!libCodeItem) return;
  downloadText(`curva-${slugify(libCodeItem.name)}.js`, curveCode(libCodeItem));
});
document.getElementById('lib-code-close').addEventListener('click', closeCurveCode);

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
  fitWorkspace();
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

// ── TOGGLES DO STATUS BAR (F1–F4) ─────────────────────────
function toggleGrid() {
  state.showGrid = !state.showGrid;
  const btn = document.getElementById('btn-toggle-grid');
  if (btn) btn.classList.toggle('active', state.showGrid);
  render();
}

function toggleSnap() {
  state.snapEnabled = !state.snapEnabled;
  const btn = document.getElementById('btn-toggle-snap');
  if (btn) btn.classList.toggle('active', state.snapEnabled);
}

function toggleAngleSnap() {
  state.angleSnap = !state.angleSnap;
  const btn = document.getElementById('btn-toggle-angle');
  if (btn) btn.classList.toggle('active', state.angleSnap);
  render();
}

// Snap de distância configurável (F4)
function toggleDistSnap() {
  state.distSnap = !state.distSnap;
  const btn = document.getElementById('btn-toggle-dist');
  if (btn) btn.classList.toggle('active', state.distSnap);
  render();
}

document.getElementById('btn-toggle-grid').addEventListener('click', toggleGrid);
document.getElementById('btn-toggle-snap').addEventListener('click', toggleSnap);
document.getElementById('btn-toggle-angle').addEventListener('click', toggleAngleSnap);
document.getElementById('btn-toggle-dist').addEventListener('click', toggleDistSnap);
document.getElementById('angle-step-input').addEventListener('change', () => {
  const v = parseFloat(document.getElementById('angle-step-input').value);
  if (!isNaN(v) && v > 0) state.angleStep = v;
});
document.getElementById('dist-step-input').addEventListener('change', () => {
  const v = parseFloat(document.getElementById('dist-step-input').value);
  if (!isNaN(v) && v > 0) state.distStep = v;
});

// ── NAVEGAÇÃO DOS HUDs (estilo AutoCAD) ──────────────────
// Tab percorre os parâmetros; Ctrl+Tab alterna a aba (modo/referência).
// A primeira digitação substitui o valor; depois de uma pausa o campo
// volta a "zerar" na próxima tecla, como no AutoCAD.
const HUD_IDLE_MS = 2500;
const HUD_SPECS = {
  line: {
    panel: 'polar-hud',
    tab: 'polar-mode-select',
    primary: () => ui.polarInputMode === 'polar'
      ? 'polar-dist-input'
      : (ui.lineStart ? 'polar-end-x-input' : 'polar-start-x-input'),
    fields: () => ui.polarInputMode === 'polar'
      ? ['polar-start-x-input', 'polar-start-y-input', 'polar-dist-input', 'polar-angle-input']
      : ['polar-start-x-input', 'polar-start-y-input', 'polar-end-x-input', 'polar-end-y-input'],
  },
  circle: {
    panel: 'circle-hud',
    tab: 'circle-mode-select',
    primary: () => ui.circleMode === 'center'
      ? 'circle-diameter-input'
      : 'circle-diameter-input-side',
    fields: () => ui.circleMode === 'center'
      ? ['circle-diameter-input', 'circle-cx-input', 'circle-cy-input']
      : ['circle-diameter-input-side', 'circle-start-x-input', 'circle-start-y-input', 'circle-side-select'],
  },
  spiral: {
    panel: 'spiral-hud',
    tab: 'spiral-anchor',
    primary: 'spiral-cx',
    fields: ['spiral-cx', 'spiral-cy', 'spiral-center-start', 'spiral-r1', 'spiral-angle',
             'spiral-factor', 'spiral-count', 'spiral-subdiv', 'spiral-start', 'spiral-dir', 'spiral-tail'],
  },
  offset: { panel: 'offset-hud', primary: 'offset-dist', fields: ['offset-dist'] },
  fillet: { panel: 'fillet-hud', primary: 'fillet-radius', fields: ['fillet-radius'] },
  rotate: { panel: 'rotate-hud', primary: 'rotate-angle', fields: ['rotate-angle'] },
  scale:  { panel: 'scale-hud',  primary: 'scale-factor', fields: ['scale-factor'] },
  array:  { panel: 'array-hud',  primary: 'array-count',  fields: ['array-count', 'array-dx', 'array-dy'] },
  coord:  { panel: 'coord-hud',  tab: 'coord-mode', primary: 'coord-x-input', fields: ['coord-x-input', 'coord-y-input'] },
  move:   { panel: 'move-hud',   primary: 'move-dist-input', fields: ['move-dist-input', 'move-angle-input'] },
};

function visibleHud(tool) {
  const spec = HUD_SPECS[tool];
  if (!spec) return null;
  const panel = document.getElementById(spec.panel);
  return panel && !panel.classList.contains('hidden') ? { tool, spec, panel } : null;
}

function activeHud() {
  const ae = document.activeElement;
  for (const tool of Object.keys(HUD_SPECS)) {
    const hud = visibleHud(tool);
    if (hud && ae && hud.panel.contains(ae)) return hud;
  }
  const byTool = visibleHud(ui.tool);
  if (byTool) return byTool;
  for (const tool of Object.keys(HUD_SPECS)) {
    const hud = visibleHud(tool);
    if (hud) return hud;
  }
  return null;
}

function hudFields(hud) {
  const ids = typeof hud.spec.fields === 'function' ? hud.spec.fields() : hud.spec.fields;
  return ids.map(id => document.getElementById(id)).filter(el => el && el.offsetParent !== null);
}

function hudPrimaryInput(hud) {
  const id = typeof hud.spec.primary === 'function' ? hud.spec.primary() : hud.spec.primary;
  const el = id ? document.getElementById(id) : null;
  return el && el.offsetParent !== null ? el : null;
}

function typeIntoHudInput(el, key) {
  if (!el.dataset.typing) {
    el.value = '';
    el.dataset.typing = 'true';
  }
  el.focus();
  const pos = el.selectionStart ?? el.value.length;
  const val = el.value;
  el.value = val.slice(0, pos) + key + val.slice(pos);
  // Inputs numéricos não suportam setSelectionRange; o cursor já fica no fim.
  if (typeof el.selectionStart === 'number') el.setSelectionRange(pos + 1, pos + 1);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  armHudIdle(el);
}

function hudTabMove(e, forward) {
  const hud = activeHud();
  if (!hud) return false;
  const fields = hudFields(hud);
  if (!fields.length) return false;
  e.preventDefault();
  const idx = fields.indexOf(document.activeElement);
  const next = idx < 0
    ? (forward ? 0 : fields.length - 1)
    : (idx + (forward ? 1 : -1) + fields.length) % fields.length;
  fields[next].focus();
  return true;
}

function cycleHudTab(forward) {
  const hud = activeHud();
  if (!hud || !hud.spec.tab) return false;
  const sel = document.getElementById(hud.spec.tab);
  if (!sel || sel.tagName !== 'SELECT' || !sel.options.length) return false;
  const i = (sel.selectedIndex + (forward ? 1 : -1) + sel.options.length) % sel.options.length;
  sel.selectedIndex = i;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  // Se o campo focado sumiu na nova aba, vai para o primeiro parâmetro visível.
  const ae = document.activeElement;
  if (!ae || ae === document.body || ae.offsetParent === null) {
    const first = hudFields(activeHud() || hud)[0];
    if (first) first.focus();
  }
  return true;
}

const hudIdleTimers = new WeakMap();
function armHudIdle(el) {
  const prev = hudIdleTimers.get(el);
  if (prev) clearTimeout(prev);
  hudIdleTimers.set(el, setTimeout(() => {
    el.dataset.typing = '';
  }, HUD_IDLE_MS));
}

// Primeira tecla depois do foco (ou de uma pausa) zera o campo e começa novo valor.
document.querySelectorAll('.hud-panel input[type="number"]').forEach(el => {
  el.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!/^[0-9.,-]$/.test(e.key)) return;
    if (!el.dataset.typing) {
      el.dataset.typing = 'true';
      el.value = '';
    }
    armHudIdle(el);
  });
  el.addEventListener('input', () => { el.dataset.typing = 'true'; armHudIdle(el); });
  el.addEventListener('blur', () => {
    const t = hudIdleTimers.get(el);
    if (t) clearTimeout(t);
    hudIdleTimers.delete(el);
    el.dataset.typing = '';
  });
});

// Circle HUD - Enter/Escape (Tab entre campos é tratado no handler global)
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
 'spiral-count', 'spiral-subdiv', 'spiral-start', 'spiral-tail'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    if (id === 'spiral-cx' || id === 'spiral-cy') {
      const cx = parseFloat(document.getElementById('spiral-cx').value);
      const cy = parseFloat(document.getElementById('spiral-cy').value);
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        ui.spiralAnchor = { x: cx, y: cy };
        ui.spiralAnchorSet = true;
      }
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
document.getElementById('spiral-anchor').addEventListener('change', () => {
  updateSpiralInfo();
  render();
});
document.getElementById('spiral-anchor').addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideSpiralHud(); setTool('select'); }
});
// Ao alternar "Começar no centro", R1 muda de raio inicial para raio externo.
// Converte o valor para manter o tamanho da espiral.
document.getElementById('spiral-center-start').addEventListener('change', () => {
  const cb = document.getElementById('spiral-center-start');
  const r1 = document.getElementById('spiral-r1');
  const F  = Math.max(0.1, spiralInput('spiral-factor', 1.017));
  const N  = Math.max(1, Math.min(2000, Math.round(spiralInput('spiral-count', 60))));
  const scale = Math.pow(F, N);
  const v = parseFloat(r1.value);
  if (Number.isFinite(v) && v > 0) {
    r1.value = (cb.checked ? v * scale : v / scale).toFixed(2);
  }
  updateSpiralInfo();
  render();
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
fitWorkspace();
updateZoomDisplay();
updatePanelInfo();
updateDijkstraPanel();
setTool('select');
toast('LaGrid CAD 2D · L=Linha A=Arco R=Fillet 1/2=Nós F5=Comprimento', 'success');
