/* ═══════════════════════════════════════════════════════
   LAGRID CAD 2D — app.js
   Bootstrap: inicializa o editor depois de carregar os módulos.
   Unidade base: CM. 1 cm = PX_PER_CM px na escala 1:1
═══════════════════════════════════════════════════════ */
'use strict';

// ── INIT ─────────────────────────────────────────────────
resizeCanvas();
fitWorkspace();
updateZoomDisplay();
updatePanelInfo();
updateDijkstraPanel();
setTool('select');
toast('LaGrid CAD 2D · L=Linha A=Arco R=Fillet 1/2=Nós F5=Comprimento', 'success');
