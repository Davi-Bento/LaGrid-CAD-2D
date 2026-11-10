/* ═══════════════════════════════════════════════════════
   LAGRID CAD 2D — tools.js
   Ferramentas de desenho e edição, snap magnético, seleção,
   arrasto e cópia/colagem.
═══════════════════════════════════════════════════════ */
'use strict';

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


// Aplica a trava de 90° (Shift) ou o snap angular ao ponto em relação a uma origem
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
    return 'Círculo: clique no centro · Ctrl+Tab inicia pela borda (4 lados)';
  }
  const s = CIRCLE_SIDES[ui.circleSide];
  if (!ui.circleCenter) {
    return `Círculo pela borda · mova o mouse para escolher o lado (centro para ${s.label}) · clique no início · Ctrl+Tab volta ao centro`;
  }
  return `Início definido · centro para ${s.label} · clique no lado oposto (diâmetro) · Ctrl+Tab volta ao centro`;
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
      setStatus('Centro definido · clique para definir o raio · Ctrl+Tab inicia pela borda');
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
  const anchorEl = document.getElementById('spiral-anchor');
  const centerEl = document.getElementById('spiral-center-start');
  const count = Math.max(1, Math.min(2000, Math.round(spiralInput('spiral-count', 60))));
  let subdiv = Math.max(1, Math.min(20, Math.round(spiralInput('spiral-subdiv', 4))));
  // Limite de segurança: no máximo 8000 segmentos por espiral
  if (count * subdiv > 8000) subdiv = Math.max(1, Math.floor(8000 / count));
  return {
    anchorPoint: (ui.spiralAnchorSet && ui.spiralAnchor) ? { ...ui.spiralAnchor } : { ...ui.mouseWorld },
    anchor:      anchorEl ? anchorEl.value : 'center',
    centerStart: !!(centerEl && centerEl.checked),
    r1:          spiralInput('spiral-r1', 2.5),
    stepAngle:   spiralInput('spiral-angle', SPIRAL_ANGLE_DEFAULT),
    factor:      spiralInput('spiral-factor', 1.017),
    count,
    subdiv,
    startAngle:  spiralInput('spiral-start', 90),
    dir:         dirEl && dirEl.value === '-1' ? -1 : 1,
    tail:        Math.max(0, spiralInput('spiral-tail', 0)),
  };
}

// Gera a espiral em coordenadas locais (centro na origem). Ângulos seguem a
// convenção do resto do editor: 0° = direita, 90° = cima, anti-horário.
// Com `centerStart`, a espiral nasce no centro (raio 0) e cresce até o raio
// externo; sem ele, começa no raio R1.
function buildSpiralPoints(anchorPoint, p) {
  const startRad = p.startAngle * Math.PI / 180;
  const stepRad  = p.stepAngle  * Math.PI / 180;
  const sub      = p.subdiv || 1;
  const dStep    = stepRad / sub;
  const dFactor  = Math.pow(p.factor, 1 / sub);
  const n        = p.count * sub;
  const dN       = Math.pow(dFactor, n);
  const qInvN    = 1 / dN;

  // Raio externo: com início no centro, R1 já é o raio externo.
  const rOut = p.centerStart ? p.r1 : p.r1 * Math.pow(p.factor, p.count);

  const local = [];
  for (let i = 0; i <= n; i++) {
    let r;
    if (p.centerStart) {
      // Curva exponencial deslocada: r(0) = 0 e r(n) = rOut.
      r = i === 0 ? 0 : rOut * (Math.pow(dFactor, i - n) - qInvN) / (1 - qInvN);
    } else {
      r = p.r1 * Math.pow(dFactor, i);
    }
    const a = startRad - p.dir * i * dStep;   // dir=1 = horário visual
    local.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }

  // Cauda tangente, mas sempre alinhada aos eixos: horizontal (deitada) ou
  // vertical (em pé), conforme o ângulo inicial. Com ângulos múltiplos de 90°
  // o encaixe no eixo mantém a continuidade visual com a espiral.
  let tailPt = null;
  if (p.tail > 0 && local.length >= 2) {
    const p0 = local[0], p1 = local[1];
    let tx = p0.x - p1.x, ty = p0.y - p1.y;
    const tl = Math.hypot(tx, ty);
    if (tl > 1e-12) {
      tx /= tl; ty /= tl;
      if (Math.abs(tx) >= Math.abs(ty)) { tx = tx >= 0 ? 1 : -1; ty = 0; }
      else                              { ty = ty >= 0 ? 1 : -1; tx = 0; }
      tailPt = { x: p0.x + tx * p.tail, y: p0.y + ty * p.tail };
    }
  }

  // Ponto de referência que ficará sobre o ponto informado.
  // Sem cauda, a ponta da cauda coincide com o início da espiral.
  let ref = { x: 0, y: 0 };
  if (p.anchor === 'start') {
    ref = local[0];
  } else if (p.anchor === 'tail') {
    ref = tailPt || local[0];
  }

  const dx = anchorPoint.x - ref.x;
  const dy = anchorPoint.y - ref.y;
  const pts = [];
  if (tailPt) pts.push({ x: tailPt.x + dx, y: tailPt.y + dy });
  for (const q of local) pts.push({ x: q.x + dx, y: q.y + dy });
  return { points: pts, center: { x: dx, y: dy }, ref: { x: ref.x + dx, y: ref.y + dy } };
}

function syncSpiralAnchorInputs() {
  if (!ui.spiralAnchor) return;
  const cx = document.getElementById('spiral-cx');
  const cy = document.getElementById('spiral-cy');
  if (cx) cx.value = ui.spiralAnchor.x.toFixed(2);
  if (cy) cy.value = ui.spiralAnchor.y.toFixed(2);
}

function showSpiralHud() {
  if (!ui.spiralAnchor) ui.spiralAnchor = { ...ui.mouseWorld };
  syncSpiralAnchorInputs();
  const hud = document.getElementById('spiral-hud');
  if (hud) hud.classList.remove('hidden');
  updateSpiralInfo();
}

function hideSpiralHud() {
  const hud = document.getElementById('spiral-hud');
  if (hud) hud.classList.add('hidden');
}

function updateSpiralR1Label() {
  const cb = document.getElementById('spiral-center-start');
  const label = document.getElementById('spiral-r1-label');
  if (label) label.textContent = (cb && cb.checked) ? 'Raio externo (cm)' : 'Raio inicial R1 (cm)';
}

function updateSpiralInfo() {
  const p = readSpiralParams();
  const turns = (p.count * p.stepAngle) / 360;
  const rEnd  = p.centerStart ? p.r1 : p.r1 * Math.pow(p.factor, p.count);
  updateSpiralR1Label();
  const anchorNames = { center: 'Centro', start: 'Início', tail: 'Cauda' };
  const base = anchorNames[p.anchor] || 'Centro';
  const cxLabel = document.getElementById('spiral-cx-label');
  const cyLabel = document.getElementById('spiral-cy-label');
  if (cxLabel) cxLabel.textContent = `${base} X (cm)`;
  if (cyLabel) cyLabel.textContent = `${base} Y (cm)`;
  const info = document.getElementById('spiral-info');
  if (!info) return;
  const total = p.count * p.subdiv + 1 + (p.tail > 0 ? 1 : 0);
  info.textContent =
    `${p.centerStart ? 'início no centro · ' : ''}${turns.toFixed(2)} volta(s) · raio externo ${Number.isFinite(rEnd) ? rEnd.toFixed(2) : '—'} cm · ${total} pontos`;
}

function spiralClick(wx, wy) {
  ui.spiralAnchor = ui.snapTarget ? { ...ui.snapTarget } : { x: wx, y: wy };
  ui.spiralAnchorSet = true;
  syncSpiralAnchorInputs();
  updateSpiralInfo();
  setStatus('Ponto de referência definido · ajuste os parâmetros e clique em Aplicar (ou Enter)');
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

  const { points: pts } = buildSpiralPoints(p.anchorPoint, p);
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
  toast(`Espiral criada · ${turns.toFixed(2)} volta(s) · ${pts.length} pontos`, 'success');
  setStatus(`Espiral: R1=${p.r1} cm · A=${p.stepAngle}° · F=${p.factor} · N=${p.count} · Sub=${p.subdiv}`);
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
  const segs = JSON.parse(JSON.stringify(ui.clipboard.segs));
  const anchors = pasteAnchorPoints(segs);
  ui.pasteMode = {
    segs,
    anchors,
    anchorIndex: 0,
    anchor: { ...anchors[0] },   // âncora local (centro por padrão)
    position: { x: cursor.x, y: cursor.y }, // posição da âncora no mundo
    scale: 1,
    rotation: 0,
  };
  setStatus(`Clique para colar · ${PASTE_HINT}`);
  render();
  return true;
}

const PASTE_HINT = '↑↓ escala · R gira 90° · Tab âncora · Enter confirma · Esc cancela';

// Âncoras possíveis: centro da caixa + pontas inicial/final.
// O Tab alterna entre elas sem perder a posição do cursor.
function pasteAnchorPoints(segs) {
  const center = segmentsAnchor(segs);
  const anchors = [{ x: center.x, y: center.y, kind: 'centro' }];
  const push = (p, kind) => {
    if (!p) return;
    if (anchors.some(a => Math.hypot(a.x - p.x, a.y - p.y) < 1e-6)) return;
    anchors.push({ x: p.x, y: p.y, kind });
  };
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (first) {
    if (first.type === 'circle') {
      const c = first.points[0], r = first.radius;
      push({ x: c.x + r, y: c.y }, 'direita');
      push({ x: c.x - r, y: c.y }, 'esquerda');
    } else {
      push(first.points[0], 'início');
    }
  }
  if (last) {
    if (last.type === 'circle') {
      const c = last.points[0], r = last.radius;
      push({ x: c.x, y: c.y + r }, 'topo');
      push({ x: c.x, y: c.y - r }, 'baixo');
    } else {
      push(last.points[last.points.length - 1], 'fim');
    }
  }
  return anchors;
}

function transformPastePoint(p, pm) {
  const dx = (p.x - pm.anchor.x) * pm.scale;
  const dy = (p.y - pm.anchor.y) * pm.scale;
  const cos = Math.cos(pm.rotation);
  const sin = Math.sin(pm.rotation);
  return {
    x: pm.position.x + dx * cos - dy * sin,
    y: pm.position.y + dx * sin + dy * cos,
  };
}

function transformPasteSeg(seg, pm) {
  const out = { ...seg, points: seg.points.map(p => transformPastePoint(p, pm)) };
  if (seg.type === 'circle') out.radius = seg.radius * pm.scale;
  if (seg.originalCircle) {
    out.originalCircle = { ...seg.originalCircle };
    if (seg.originalCircle.c) {
      out.originalCircle.c = transformPastePoint(seg.originalCircle.c, pm);
    }
    if (Number.isFinite(seg.originalCircle.r)) {
      out.originalCircle.r = seg.originalCircle.r * pm.scale;
    }
  }
  return out;
}

function cyclePasteAnchor() {
  const pm = ui.pasteMode;
  if (!pm) return;
  pm.anchorIndex = (pm.anchorIndex + 1) % pm.anchors.length;
  pm.anchor = { ...pm.anchors[pm.anchorIndex] };
  setStatus(`Colagem: âncora ${pm.anchor.kind} · ${PASTE_HINT}`);
  render();
}

function updatePasteOffset(wp) {
  const pm = ui.pasteMode;
  if (!pm) return;
  const target = ui.snapTarget ? { ...ui.snapTarget } : { x: wp.x, y: wp.y };
  pm.position = { x: target.x, y: target.y };
}

function commitPaste() {
  const pm = ui.pasteMode;
  if (!pm) return false;
  const label = ui.pasteLabel;
  saveUndo();
  const created = [];
  for (const src of pm.segs) {
    const copy = transformPasteSeg(src, pm);
    copy.id = state.nextId++;
    copy.selected = false;
    state.segments.push(copy);
    created.push(copy);
  }
  ui.selection.clear();
  created.forEach(c => ui.selection.add(c.id));
  ui.pasteMode = null;
  ui.pasteLabel = null;
  refreshAfterEdit();
  setStatus(label ? `${label} inserida` : `${created.length} objeto(s) colado(s)`);
  toast(label ? `${label} inserida` : `${created.length} objeto(s) colado(s)`, 'success');
  return true;
}

function cancelPaste() {
  if (!ui.pasteMode) return false;
  ui.pasteMode = null;
  ui.pasteLabel = null;
  render();
  setStatus('Colagem cancelada');
  return true;
}
