/* ═══════════════════════════════════════════════════════
   LAGRID CAD 2D — model.js
   Modelo de dados do projeto: tipos documentados, versão do
   schema e normalização de vértices.
═══════════════════════════════════════════════════════ */
'use strict';

/**
 * Versão do schema do arquivo de projeto (JSON).
 * Incremente ao mudar o formato de forma incompatível.
 */
const PROJECT_SCHEMA_VERSION = 11;

/**
 * Ponto no espaço do mundo, em centímetros.
 * @typedef {Object} WorldPoint
 * @property {number} x
 * @property {number} y
 * @property {boolean} [exportCoord] Vértice marcado para exportar coordenadas.
 */

/**
 * Segmento de desenho.
 * `line`: points = [a, b]
 * `arc`: points = [a, meio, b] (arco circular por três pontos)
 * `polyline`: points = [p0, p1, ...]
 * `circle`: points = [centro] + radius
 * @typedef {Object} Segment
 * @property {number} id
 * @property {'line'|'arc'|'polyline'|'circle'} type
 * @property {WorldPoint[]} points
 * @property {number} [radius] Raio em cm (apenas círculos).
 * @property {boolean} [selected]
 */

/**
 * Documento de projeto salvo em JSON.
 * @typedef {Object} ProjectDocument
 * @property {number} version Versão do schema (`PROJECT_SCHEMA_VERSION`).
 * @property {boolean} yUp Convenção de Y para cima.
 * @property {Segment[]} segments
 * @property {{start: (WorldPoint|null), end: (WorldPoint|null)}} nodes
 * @property {number} nextId
 * @property {{w: number, h: number}} workspace
 * @property {number} deadzone
 * @property {number} lineWidth
 * @property {boolean} angleSnap
 * @property {number} angleStep
 * @property {boolean} distSnap
 * @property {number} distStep
 * @property {string} dijkstraMode
 * @property {boolean} showVertexCoords
 * @property {boolean} showCircleQuads
 * @property {Object} spiral
 */

/**
 * Normaliza a marcação de coordenadas de cada vértice.
 * Ausente = cinza (ignorado); true = marcado.
 * @param {Segment[]} segments
 */
function normalizeVertexCoordFlags(segments) {
  for (const seg of segments || []) {
    if (!Array.isArray(seg.points)) continue;
    for (const pt of seg.points) {
      pt.exportCoord = pt.exportCoord === true;
    }
  }
}
