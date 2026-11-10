/* ═══════════════════════════════════════════════════════
   LAGRID CAD 2D — persistence.js
   Salvamento, carregamento e migração do JSON do projeto.
═══════════════════════════════════════════════════════ */
'use strict';

// ── SAVE / LOAD ───────────────────────────────────────────
function saveJSON() {
  const sp = readSpiralParams();
  const data = JSON.stringify({
    version:   PROJECT_SCHEMA_VERSION,
    yUp:       true,
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
    showVertexCoords: state.showVertexCoords,
    showCircleQuads:  state.showCircleQuads,
    spiral: {
      r1: sp.r1, angle: sp.stepAngle, factor: sp.factor,
      count: sp.count, subdiv: sp.subdiv, start: sp.startAngle,
      dir: sp.dir, tail: sp.tail, anchor: sp.anchor, centerStart: sp.centerStart,
    },
  }, null, 2);
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([data],{type:'application/json'}));
  a.download = 'lagrid-pista.json';
  a.click();
  toast('JSON salvo', 'success');
}

// Projetos antigos foram salvos com Y para baixo (origem no topo). Ao abrir no
// novo sistema (primeiro quadrante, Y para cima), espelha o Y em torno da
// altura da área de trabalho para o desenho continuar com o mesmo formato.
function migrateProjectToYUp(d) {
  if (!d || d.yUp === true) return;
  const wsH = (d.workspace && d.workspace.h > 0) ? d.workspace.h : null;

  let maxY = -Infinity;
  const scan = p => {
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) maxY = Math.max(maxY, p.y);
  };
  const eachPoint = fn => {
    (d.segments || []).forEach(s => {
      (s.points || []).forEach(fn);
      if (s.startPoint) fn(s.startPoint);
      if (s.originalCircle && s.originalCircle.c) fn(s.originalCircle.c);
    });
    ['start', 'end'].forEach(k => { if (d.nodes && d.nodes[k]) fn(d.nodes[k]); });
  };

  eachPoint(scan);
  const refH = wsH || (isFinite(maxY) ? maxY : 0);
  eachPoint(p => { if (p && Number.isFinite(p.y)) p.y = refH - p.y; });

  d.yUp = true;
}

function loadJSON(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      migrateProjectToYUp(d);
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
        setVal('spiral-subdiv', sp.subdiv);
        setVal('spiral-start', sp.start);
        setVal('spiral-tail', sp.tail);
        const dirEl = document.getElementById('spiral-dir');
        if (dirEl && (sp.dir === 1 || sp.dir === -1)) dirEl.value = String(sp.dir);
        const anchorEl = document.getElementById('spiral-anchor');
        if (anchorEl && ['center', 'start', 'tail'].includes(sp.anchor)) anchorEl.value = sp.anchor;
        const centerEl = document.getElementById('spiral-center-start');
        if (centerEl) centerEl.checked = sp.centerStart === true;
        updateSpiralInfo();
      }
      normalizeVertexCoordFlags(state.segments);
      const modeEl = document.getElementById('dijkstra-mode-select');
      if (modeEl) modeEl.value = state.dijkstraMode;
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
