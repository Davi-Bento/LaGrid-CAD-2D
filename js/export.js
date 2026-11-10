/* ═══════════════════════════════════════════════════════
   LAGRID CAD 2D — export.js
   Análise da pista (deadzone, Dijkstra, alertas) e exportação em PDF.
═══════════════════════════════════════════════════════ */
'use strict';

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
