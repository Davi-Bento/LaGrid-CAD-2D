/* ═══════════════════════════════════════════════════════
   LAGRID CAD 2D — state.js
   Estado da aplicação, UI, câmera, imagem de fundo e canvas.
═══════════════════════════════════════════════════════ */
'use strict';

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
  shiftKey:     false,  // trava de 90° (Shift) durante o desenho
  dragVertex:   null,   // {segId, idx} — vértice sendo arrastado
  mirrorPts:    [],     // eixo do espelho em construção
  offsetTargetId: null, // objeto escolhido para offset
  coordMode:    'abs',  // 'abs' | 'rel'
  circleMode:   'center', // 'center' | 'side' (Ctrl+Tab alterna)
  circleSide:   'E',      // lado do centro em relação ao início: E/N/W/S
  spiralAnchor: null,     // ponto de referência da espiral em construção
  spiralAnchorSet: false, // true depois de clicar/digitar a referência
  polarInputMode: 'polar', // 'polar' | 'absolute' — modo de entrada do HUD polar
  prevMouseScreen:  null,
  dragMove:     null,   // arrasto de objetos selecionados { ids, originals, nodeOriginals, start, moved }
  pasteMode:    null,   // colocação de colagem estilo AutoCAD { segs, anchor, offset }
  pasteLabel:   null,   // nome exibido no status ao confirmar a colagem (biblioteca)
  clipboard:    null,   // { segs, anchor } — cópia em memória
};

// ── IMAGEM DE FUNDO (só na sessão; não entra no JSON nem no PDF) ──
const bg = {
  image:    null,   // canvas offscreen já reduzido
  name:     '',
  x:        0,      // centro em coordenadas de mundo (cm)
  y:        0,
  widthCm:  0,
  rotation: 0,      // graus, positivo = anti-horário
  opacity:  0.4,
  visible:  true,
  adjust:   false,
  drag:     null,   // { mode, handle, startWorld, startX, startY, startW, startRot, startAngle }
};

// ── CANVAS ───────────────────────────────────────────────
const canvas = document.getElementById('main-canvas');
const ctx    = canvas.getContext('2d');
