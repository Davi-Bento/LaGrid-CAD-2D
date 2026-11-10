/* ═══════════════════════════════════════════════════════
   LAGRID CAD 2D — config.js
   Constantes globais, identidade e chaves de armazenamento.
═══════════════════════════════════════════════════════ */
'use strict';

// ── CONSTANTES ────────────────────────────────────────────
const PX_PER_CM     = 37.795;   // 96dpi → 1cm = 37.795px
const SNAP_MAG_PX   = 14;       // raio magnético em pixels de tela
const CRIT_ANGLE    = 90;       // alerta raio crítico (graus)
const MIN_COTA_CM   = 1.5;      // mínimo para desenhar cota automática
const DEFAULT_LINE_W = 1.9;     // cm — largura padrão de faixa
const ANGLE_STEP_DEFAULT = 90;  // graus — snap angular configurável
const SPIRAL_ANGLE_DEFAULT = 15; // graus — passo angular padrão da espiral
const DIST_STEP_DEFAULT  = 1;   // cm — snap de distância configurável
const DEFAULT_WORKSPACE_W = 285; // cm
const DEFAULT_WORKSPACE_H = 180; // cm
const DEFAULT_DEADZONE = 30;     // cm — margem de alerta até a borda
const GRAPH_NODE_MERGE_EPS = 0.5; // cm — tolerância para agrupar endpoints em nós do grafo

const BG_MAX_PX = 2400; // px — limite da imagem de fundo reduzida
const APP_NAME = 'LaGrid CAD 2D';
const APP_VERSION = '2.0.0';
// Chave legada mantida de propósito para não perder curvas já salvas.
const STORAGE_KEY_CURVES = 'linetrack.curveLibrary.v1';
