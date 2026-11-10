/* ═══════════════════════════════════════════════════════
   LAGRID CAD 2D — render.js
   Renderização do canvas: grade, segmentos, cotas, previews,
   imagem de fundo e miniaturas da biblioteca.
═══════════════════════════════════════════════════════ */
'use strict';

// ── MINIATURAS DA BIBLIOTECA ────────────────────────────────
function drawLibraryThumb(canvas, segs) {
  if (!canvas) return;
  const cssW = canvas.clientWidth || 150;
  const cssH = canvas.clientHeight || 58;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cssW, cssH);

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
  if (!isFinite(minX)) return;

  const pad = 8;
  const w = Math.max(maxX - minX, 1e-6);
  const h = Math.max(maxY - minY, 1e-6);
  const sc = Math.min((cssW - pad * 2) / w, (cssH - pad * 2) / h);
  const ox = (cssW - w * sc) / 2 - minX * sc;
  const oy = (cssH - h * sc) / 2 - minY * sc;
  const tx = p => ({ x: p.x * sc + ox, y: p.y * sc + oy });

  c.strokeStyle = '#e3000f';
  c.lineWidth = 1.6;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const seg of segs) {
    c.beginPath();
    if (seg.type === 'line' || seg.type === 'polyline') {
      seg.points.forEach((p, i) => {
        const q = tx(p);
        if (i === 0) c.moveTo(q.x, q.y); else c.lineTo(q.x, q.y);
      });
    } else if (seg.type === 'arc') {
      const N = 36;
      for (let i = 0; i <= N; i++) {
        const q = tx(arcPointAt(seg, i / N));
        if (i === 0) c.moveTo(q.x, q.y); else c.lineTo(q.x, q.y);
      }
    } else if (seg.type === 'circle') {
      const q = tx(seg.points[0]);
      c.arc(q.x, q.y, seg.radius * sc, 0, Math.PI * 2);
    }
    c.stroke();
  }
}

// ── IMAGEM DE FUNDO (DESENHO) ───────────────────────────────
function drawBackgroundImage() {
  if (!bg.image || !bg.visible) return;
  const c = w2s(bg.x, bg.y);
  const w = cm2px(bg.widthCm);
  const h = cm2px(bgHeightCm());
  ctx.save();
  ctx.globalAlpha = bg.opacity;
  ctx.translate(c.x, c.y);
  ctx.rotate(-bg.rotation * Math.PI / 180);
  ctx.drawImage(bg.image, -w/2, -h/2, w, h);
  ctx.restore();
}

function drawBackgroundOverlay() {
  if (!bg.image || !bg.adjust) return;

  const corners = bgCornersWorld().map(p => w2s(p.x, p.y));
  const rotHandle = w2s(bgRotationHandleWorld().x, bgRotationHandleWorld().y);

  ctx.save();
  ctx.strokeStyle = 'rgba(34,211,238,0.9)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  corners.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // Haste da alça de rotação
  const topMid = { x: (corners[0].x + corners[1].x)/2, y: (corners[0].y + corners[1].y)/2 };
  ctx.beginPath();
  ctx.moveTo(topMid.x, topMid.y);
  ctx.lineTo(rotHandle.x, rotHandle.y);
  ctx.stroke();

  // Alças de canto
  ctx.fillStyle = '#08080f';
  corners.forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
  });

  // Alça de rotação
  ctx.beginPath();
  ctx.arc(rotHandle.x, rotHandle.y, 6, 0, Math.PI*2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(rotHandle.x, rotHandle.y, 2, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(34,211,238,0.9)';
  ctx.fill();

  // Medidas no centro da imagem
  const center = w2s(bg.x, bg.y);
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(34,211,238,0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `${bg.widthCm.toFixed(1)} × ${bgHeightCm().toFixed(1)} cm · ${Math.round(bg.rotation)}°`,
    center.x, center.y
  );
  ctx.restore();
}

// ── RENDER ────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#08080f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state.showGrid)    drawGrid();
  drawBackgroundImage();
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
  drawBackgroundOverlay();
}

function drawGrid() {
  const minorPx = cm2px(1);
  const majorPx = cm2px(10);

  if (minorPx > 5) {
    ctx.strokeStyle = 'rgba(232,232,240,0.02)';
    ctx.lineWidth = 0.5;
    drawGridLines(minorPx);
  }
  if (majorPx > 3) {
    ctx.strokeStyle = 'rgba(232,232,240,0.055)';
    ctx.lineWidth = 0.5;
    drawGridLines(majorPx);
  }

  const ox = w2s(0,0);
  ctx.strokeStyle = 'rgba(227,0,15,0.2)';
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
  const a = w2s(0, 0);
  const b = w2s(state.workspace.w, state.workspace.h);
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  ctx.strokeStyle = 'rgba(227,0,15,0.35)';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x0, y0, x1-x0, y1-y0);
  ctx.setLineDash([]);

  ctx.font = `${Math.max(9, 11*cam.scale)}px JetBrains Mono, monospace`;
  ctx.fillStyle = 'rgba(227,0,15,0.5)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${state.workspace.w}×${state.workspace.h} cm`, x0+4, y0-3);
}

function drawDeadzone(violations) {
  const r = deadzoneRect();
  const countEl = document.getElementById('info-dz-count');
  if (countEl) countEl.textContent = violations.length;
  if (r.dz <= 0) return;

  const a = w2s(r.x0, r.y0);
  const b = w2s(r.x1, r.y1);
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const alert = violations.length > 0;
  ctx.save();
  ctx.strokeStyle = alert ? 'rgba(255,77,77,0.65)' : 'rgba(245,196,0,0.28)';
  ctx.lineWidth   = alert ? 1.5 : 1;
  ctx.setLineDash([4, 5]);
  ctx.strokeRect(x0, y0, x1-x0, y1-y0);
  ctx.setLineDash([]);

  ctx.font = `${Math.max(8, 9*cam.scale)}px JetBrains Mono, monospace`;
  ctx.fillStyle = alert ? 'rgba(255,77,77,0.85)' : 'rgba(245,196,0,0.5)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const label = alert
    ? `DEADZONE ${r.dz} cm · ${violations.length} trecho(s)`
    : `Zona de segurança ${r.dz} cm`;
  ctx.fillText(label, x0+4, y0-3);
  ctx.restore();
}

function drawDeadzoneAlerts(violations) {
  if (!violations.length) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,77,77,0.35)';
  ctx.lineWidth   = Math.max(6, cm2px(state.lineWidth) + 6);
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.shadowColor = 'rgba(255,77,77,0.5)';
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
      ctx.strokeStyle = sel ? '#f5c400' : 'rgba(245,196,0,0.8)'; // magenta
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
        ? 'rgba(34,211,238,0.10)'
        : inPath
          ? 'rgba(245,196,0,0.08)'
          : 'rgba(232,232,240,0.05)';
      ctx.lineWidth = lineWidthPx;
      ctx.lineCap   = 'round';
      ctx.lineJoin  = 'round';
      strokeSegPath(seg);
      ctx.restore();
    }

    // Linha central
    ctx.save();
    if (sel) {
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth   = baseW + 1.5;
      ctx.shadowColor = 'rgba(34,211,238,0.4)';
      ctx.shadowBlur  = 6;
    } else if (inPath) {
      ctx.strokeStyle = '#f5c400';
      ctx.lineWidth   = baseW + 1;
      ctx.shadowColor = 'rgba(245,196,0,0.55)';
      ctx.shadowBlur  = 8;
    } else {
      ctx.strokeStyle = '#e8e8f0';
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
    ctx.strokeStyle = sel ? '#22d3ee' : 'rgba(34,211,238,0.6)';
    ctx.lineWidth   = 1.2;
    ctx.stroke();
    // ponto interno
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 2, 0, Math.PI*2);
    ctx.fillStyle = sel ? '#22d3ee' : '#e8e8f0';
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
    ctx.strokeStyle = sel ? '#22d3ee' : 'rgba(245,196,0,0.8)';
    ctx.lineWidth = sel ? 1.5 : 1;
    ctx.stroke();
    // Ponto central
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 2, 0, Math.PI*2);
    ctx.fillStyle = sel ? '#22d3ee' : '#f5c400';
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
      ctx.fillStyle   = active ? 'rgba(245,196,0,0.95)' : 'rgba(10,10,12,0.75)';
      ctx.fill();
      ctx.strokeStyle = active ? '#f5c400' : 'rgba(245,196,0,0.85)';
      ctx.lineWidth   = active ? 1.8 : 1.1;
      ctx.stroke();

      const s = CIRCLE_SIDES[q.side];
      ctx.font         = '700 9px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle    = active ? '#f5c400' : 'rgba(245,196,0,0.7)';
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
      ctx.fillStyle   = 'rgba(245,196,0,0.15)';
      ctx.strokeStyle = '#f5c400';
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
        ctx.fillStyle   = '#22c55e';
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

    ctx.strokeStyle = 'rgba(34,211,238,0.95)';
    ctx.fillStyle   = 'rgba(34,211,238,0.95)';
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
    ctx.strokeStyle = 'rgba(34,211,238,0.95)';
    ctx.lineWidth   = 1.1;
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle    = '#fff5d6';
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
  ctx.fillStyle = 'rgba(245,196,0,0.60)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${segLength(seg).toFixed(2)}cm`, mx+ox, my+oy);
  ctx.restore();
}

function drawNodes() {
  const configs = [
    { key:'start', color:'#22c55e', label:'S' },
    { key:'end',   color:'#e3000f', label:'E' },
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
    ctx.strokeStyle = '#ff4d4d';
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = '#ff4d4d';
    ctx.shadowBlur  = 10;
    ctx.stroke();
    ctx.shadowBlur  = 0;
    ctx.font = 'bold 9px Titillium Web, sans-serif';
    ctx.fillStyle = '#ff4d4d';
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
    const pm = ui.pasteMode;
    ctx.save();
    ctx.globalAlpha  = 0.6;
    ctx.strokeStyle  = '#f5c400';
    ctx.lineWidth    = Math.max(0.5, 1.5 * cam.scale);
    ctx.lineCap      = 'round';
    ctx.lineJoin     = 'round';
    ctx.setLineDash([7 * cam.scale, 5 * cam.scale]);
    for (const src of pm.segs) {
      strokeSegPath(transformPasteSeg(src, pm));
    }
    ctx.setLineDash([]);
    ctx.restore();
    // Ponto de encaixe (âncora da colagem)
    const ap = w2s(pm.position.x, pm.position.y);
    ctx.strokeStyle = '#f5c400';
    ctx.fillStyle = '#f5c400';
    ctx.lineWidth = 1.5;
    if (pm.anchor.kind === 'centro') {
      ctx.beginPath();
      ctx.arc(ap.x, ap.y, 3, 0, Math.PI*2);
      ctx.fill();
    } else {
      // Ponta selecionada: quadrado vazado para diferenciar do centro.
      ctx.strokeRect(ap.x - 4, ap.y - 4, 8, 8);
      ctx.beginPath();
      ctx.moveTo(ap.x - 6, ap.y); ctx.lineTo(ap.x + 6, ap.y);
      ctx.moveTo(ap.x, ap.y - 6); ctx.lineTo(ap.x, ap.y + 6);
      ctx.stroke();
    }
  }

  if (ui.tool === 'line' && ui.lineStart) {
    const end = ui.snapTarget ? pt : pointFromConstraint(ui.lineStart, pt);
    drawDashedLine(ui.lineStart, end, 'rgba(34,211,238,0.45)');
    drawMeasureLabel(ui.lineStart, end);
  }

  if (ui.tool === 'polyline' && ui.polyPoints.length) {
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(34,211,238,0.45)';
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
      ctx.fillStyle = '#22d3ee'; ctx.fill();
    });
  }

  if (ui.tool === 'spiral') {
    const p = readSpiralParams();
    const { points: pts, center, ref } = buildSpiralPoints(p.anchorPoint, p);
    if (pts.length > 1) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(34,211,238,0.6)';
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
      // Marca o centro (discreto) e o ponto de referência escolhido (destaque)
      const c = w2s(center.x, center.y);
      ctx.fillStyle = 'rgba(34,211,238,0.4)';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
      ctx.fill();

      const r0 = w2s(ref.x, ref.y);
      ctx.strokeStyle = '#f5c400';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(r0.x-7, r0.y); ctx.lineTo(r0.x+7, r0.y);
      ctx.moveTo(r0.x, r0.y-7); ctx.lineTo(r0.x, r0.y+7);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(r0.x, r0.y, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (ui.tool === 'arc' && ui.arcPoints.length > 0) {
    ui.arcPoints.forEach(p => {
      const sp = w2s(p.x, p.y);
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, Math.PI*2);
      ctx.fillStyle = '#22d3ee'; ctx.fill();
    });
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(34,211,238,0.55)';
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
    ctx.strokeStyle = 'rgba(34,211,238,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(Math.min(a.x,b.x), Math.min(a.y,b.y), Math.abs(b.x-a.x), Math.abs(b.y-a.y));
    ctx.setLineDash([]);
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(245,196,0,0.75)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${Math.abs(end.x-ui.rectStart.x).toFixed(2)} × ${Math.abs(end.y-ui.rectStart.y).toFixed(2)} cm`,
                 (a.x+b.x)/2, Math.min(a.y,b.y)-6);
  }

  if (ui.tool === 'mirror' && ui.mirrorPts.length === 1) {
    drawDashedLine(ui.mirrorPts[0], pt, 'rgba(227,0,15,0.6)');
  }
}

function drawCircleCompass(sx, sy) {
  const R = 24;
  ctx.save();
  ctx.strokeStyle = 'rgba(245,196,0,0.22)';
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
    ctx.fillStyle   = active ? 'rgba(245,196,0,0.95)' : 'rgba(10,10,12,0.8)';
    ctx.fill();
    ctx.strokeStyle = active ? '#f5c400' : 'rgba(245,196,0,0.5)';
    ctx.lineWidth   = active ? 1.8 : 1;
    ctx.stroke();
    ctx.font         = '700 9px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle    = active ? '#08080f' : 'rgba(245,196,0,0.8)';
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
  ctx.strokeStyle = 'rgba(34,211,238,0.6)';
  ctx.lineWidth   = 1.5;
  ctx.beginPath(); ctx.arc(sc.x, sc.y, cm2px(r), 0, Math.PI*2); ctx.stroke();

  if (ui.circleMode === 'side' && far) {
    const sf = w2s(far.x, far.y);
    // diâmetro e centro
    ctx.strokeStyle = 'rgba(245,196,0,0.8)';
    ctx.beginPath(); ctx.moveTo(ss.x, ss.y); ctx.lineTo(sf.x, sf.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sc.x-5, sc.y); ctx.lineTo(sc.x+5, sc.y);
    ctx.moveTo(sc.x, sc.y-5); ctx.lineTo(sc.x, sc.y+5);
    ctx.stroke();
    // início (verde) e lado oposto (amarelo)
    for (const [sp, color] of [[ss, '#22c55e'], [sf, '#f5c400']]) {
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
    ctx.fillStyle    = 'rgba(245,196,0,0.75)';
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
  const ang  = ((Math.atan2(b.y-a.y, b.x-a.x) * 180/Math.PI) + 360) % 360;
  const sp0 = w2s(a.x, a.y), sp1 = w2s(b.x, b.y);
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(245,196,0,0.75)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${dist.toFixed(2)}cm · ${ang.toFixed(1)}°`, (sp0.x+sp1.x)/2, (sp0.y+sp1.y)/2 - 6);
}

function drawMagneticIndicator() {
  if (!ui.snapTarget) return;
  const sp = w2s(ui.snapTarget.x, ui.snapTarget.y);
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, 8, 0, Math.PI*2);
  ctx.strokeStyle = '#f5c400';
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = '#f5c400';
  ctx.shadowBlur  = 8;
  ctx.stroke();
  ctx.shadowBlur  = 0;
  // cruz
  ctx.strokeStyle = '#f5c400';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(sp.x-5,sp.y); ctx.lineTo(sp.x+5,sp.y);
  ctx.moveTo(sp.x,sp.y-5); ctx.lineTo(sp.x,sp.y+5);
  ctx.stroke();
}
