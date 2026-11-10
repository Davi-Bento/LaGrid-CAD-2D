/* ═══════════════════════════════════════════════════════
   LINETRACK CAD — GABARITO DE MONTAGEM
   Desenho de obra: pista, guias, centros e raios.
   Tudo client-side. PDF direto via pdf-lib (vendor local).
═══════════════════════════════════════════════════════ */
'use strict';

(function () {
  const PT_PER_CM = 72 / 2.54;
  const MM_PER_CM = 10;
  const DATE = new Date();
  const DATE_ISO = DATE.toISOString().slice(0, 10);
  const DATE_BR = DATE_ISO.split('-').reverse().join('/');

  const COLORS = {
    track:         '#16161e',
    construction:  '#7c8aa6',
    center:        '#7c7c94',
    axis:          '#e2a0b2',
    radius:        '#d9556d',
    border:        '#949aad',
    dim:           '#454b5e',
    label:         '#101018',
    labelSub:      '#34394a',
    footer:        '#6a7080',
  };

  const ui = {
    tab: 'drawing',
    data: null,
    busy: false,
  };

  // ── FORMATAÇÃO ─────────────────────────────────────────
  function fmt(v, d) {
    if (d === undefined) d = 1;
    if (!Number.isFinite(v)) return '—';
    let s = v.toFixed(d);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0') s = '0';
    return s.replace('.', ',');
  }

  function fmtAngle(v) {
    if (!Number.isFinite(v)) return '—';
    return fmt(v, 1) + '°';
  }

  function fmtPt(p) {
    return p ? `${fmt(p.x)}, ${fmt(p.y)}` : '—';
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function num(v) {
    return Number.isFinite(v) ? v : 0;
  }

  function normAngle(rad) {
    let deg = rad * 180 / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
  }

  function kindLabel(kind) {
    return kind === 'circle' ? 'Círculo' : 'Arco';
  }

  function guideLabel(kind) {
    if (kind === 'construction') return 'Guia de construção';
    if (kind === 'axis') return 'Eixo do centro';
    return 'Centro da reta';
  }

  function notify(msg, type) {
    try {
      if (typeof toast === 'function') toast(msg, type || '');
    } catch (_) { /* fora do editor */ }
  }

  // ── GEOMETRIA / EXTRAÇÃO ────────────────────────────────
  function arcSamples(seg) {
    const g = typeof arcGeometry === 'function' ? arcGeometry(seg) : null;
    if (!g) return null;
    const n = Math.max(18, Math.min(180, Math.ceil(Math.abs(g.sweep) * 24)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      pts.push(typeof arcPointAt === 'function'
        ? arcPointAt(seg, i / n)
        : { x: g.cx + g.r * Math.cos(g.a0 + g.sweep * (i / n)),
            y: g.cy + g.r * Math.sin(g.a0 + g.sweep * (i / n)) });
    }
    return { g, pts };
  }

  function expandBounds(b, x, y) {
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }

  function trackEditorBounds(segs) {
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const seg of segs) {
      if (seg.type === 'circle') {
        const c = seg.points && seg.points[0];
        const r = num(seg.radius);
        if (!c) continue;
        expandBounds(b, c.x - r, c.y - r);
        expandBounds(b, c.x + r, c.y + r);
      } else if (seg.type === 'arc') {
        const s = arcSamples(seg);
        if (!s) {
          (seg.points || []).forEach(p => expandBounds(b, p.x, p.y));
        } else {
          s.pts.forEach(p => expandBounds(b, p.x, p.y));
        }
      } else if (Array.isArray(seg.points)) {
        seg.points.forEach(p => expandBounds(b, p.x, p.y));
      }
    }
    if (!Number.isFinite(b.minX)) return null;
    b.width = b.maxX - b.minX;
    b.height = b.maxY - b.minY;
    return b;
  }

  function clipRect(x1, y1, x2, y2, rx0, ry0, rx1, ry1) {
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1 - rx0, rx1 - x1, y1 - ry0, ry1 - y1];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) {
        if (q[i] < 0) return null;
      } else {
        const t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
        else          { if (t < t0) return null; if (t < t1) t1 = t; }
      }
    }
    return {
      x1: x1 + t0 * dx, y1: y1 + t0 * dy,
      x2: x1 + t1 * dx, y2: y1 + t1 * dy,
    };
  }

  function lineThroughRect(a, b, rect) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const ux = dx / len, uy = dy / len;
    const ext = Math.hypot(rect.x1 - rect.x0, rect.y1 - rect.y0) * 1.5 + 10;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const clipped = clipRect(
      mx - ux * ext, my - uy * ext,
      mx + ux * ext, my + uy * ext,
      rect.x0, rect.y0, rect.x1, rect.y1
    );
    if (!clipped) return null;
    if (Math.hypot(clipped.x2 - clipped.x1, clipped.y2 - clipped.y1) < 0.05) return null;
    return clipped;
  }

  function makeStraight(id, type, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    return {
      id, type,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      length: Math.hypot(dx, dy),
      angle: normAngle(Math.atan2(dy, dx)),
    };
  }

  function sameGuide(a, b) {
    const eps = 0.15;
    const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    return (d(a.p1, b.p1) < eps && d(a.p2, b.p2) < eps) ||
           (d(a.p1, b.p2) < eps && d(a.p2, b.p1) < eps);
  }

  function buildAssemblyData(opts) {
    opts = opts || {};
    const originMode = opts.origin === 'editor' ? 'editor' : 'track';
    const showGuides = opts.guides !== false;
    const showAxes = opts.axes !== false;

    const all = (typeof state !== 'undefined' && state.segments) ? state.segments : [];
    const trackSegs = all.filter(s => s && s.points && !(s.type === 'line' && s.isConstruction));
    if (!trackSegs.length) return null;

    const eb = trackEditorBounds(trackSegs);
    if (!eb) return null;

    const yUp = originMode === 'track';
    const tr = p => yUp
      ? { x: p.x - eb.minX, y: eb.maxY - p.y }
      : { x: p.x, y: p.y };

    const curves = [];
    const straights = [];
    const track = [];
    const construction = [];
    const axis = [];
    const center = [];
    const warnings = [];
    let curveNo = 0;
    let straightNo = 0;

    for (const seg of all) {
      if (seg.type === 'line' && seg.isConstruction) {
        const a = tr(seg.points[0]), b = tr(seg.points[1]);
        construction.push({ a, b });
        continue;
      }

      if (seg.type === 'line') {
        const a = tr(seg.points[0]), b = tr(seg.points[1]);
        straightNo++;
        straights.push(makeStraight('R' + straightNo, 'Pista', a, b));
        track.push({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        center.push({ a, b });
        continue;
      }

      if (seg.type === 'polyline') {
        const pts = seg.points.map(tr);
        if (pts.length < 2) continue;
        straightNo++;
        const base = straightNo;
        for (let i = 1; i < pts.length; i++) {
          straights.push(makeStraight(`R${base}.${i}`, 'Pista', pts[i - 1], pts[i]));
          center.push({ a: pts[i - 1], b: pts[i] });
        }
        track.push({ type: 'path', points: pts });
        continue;
      }

      if (seg.type === 'circle') {
        const c = tr(seg.points[0]);
        const r = num(seg.radius);
        curveNo++;
        curves.push({
          id: 'C' + curveNo, kind: 'circle',
          cx: c.x, cy: c.y, r,
          sweepDeg: 360, start: null, end: null, path: null,
        });
        track.push({ type: 'circle', cx: c.x, cy: c.y, r });
        axis.push({ x: c.x, y: c.y });
        continue;
      }

      if (seg.type === 'arc') {
        const s = arcSamples(seg);
        if (!s) {
          warnings.push(`Arco inválido ignorado no gabarito (segmento ${seg.id}).`);
          const a = tr(seg.points[0]), b = tr(seg.points[2]);
          straightNo++;
          straights.push(makeStraight('R' + straightNo, 'Arco inválido', a, b));
          track.push({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          continue;
        }
        const c = tr({ x: s.g.cx, y: s.g.cy });
        const pts = s.pts.map(tr);
        curveNo++;
        curves.push({
          id: 'C' + curveNo, kind: 'arc',
          cx: c.x, cy: c.y, r: s.g.r,
          sweepDeg: Math.abs(s.g.sweep * 180 / Math.PI),
          start: tr(seg.points[0]),
          end: tr(seg.points[2]),
          path: pts,
        });
        track.push({ type: 'path', points: pts });
        axis.push({ x: c.x, y: c.y });
      }
    }

    if (!track.length) return null;

    // Limites reais do desenho (já transformados)
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const t of track) {
      if (t.type === 'line') {
        expandBounds(b, t.x1, t.y1); expandBounds(b, t.x2, t.y2);
      } else if (t.type === 'circle') {
        expandBounds(b, t.cx - t.r, t.cy - t.r);
        expandBounds(b, t.cx + t.r, t.cy + t.r);
      } else if (t.points) {
        t.points.forEach(p => expandBounds(b, p.x, p.y));
      }
    }
    b.width = b.maxX - b.minX;
    b.height = b.maxY - b.minY;

    const guideMargin = Math.max(4, Math.min(b.width, b.height) * 0.06);
    const viewPad = guideMargin + Math.max(2, Math.min(b.width, b.height) * 0.025);
    const view = {
      x0: b.minX - viewPad, y0: b.minY - viewPad,
      x1: b.maxX + viewPad, y1: b.maxY + viewPad,
      width: b.width + viewPad * 2,
      height: b.height + viewPad * 2,
    };
    const clip = {
      x0: b.minX - guideMargin, y0: b.minY - guideMargin,
      x1: b.maxX + guideMargin, y1: b.maxY + guideMargin,
    };

    // ── GUIAS ────────────────────────────────────────────
    const candidates = [];
    let order = 0;
    if (showGuides) {
      for (const g of construction) {
        const c = clipRect(g.a.x, g.a.y, g.b.x, g.b.y, clip.x0, clip.y0, clip.x1, clip.y1);
        if (c) candidates.push({ kind: 'construction', priority: 0, order: order++, ...c });
      }
    }
    if (showAxes) {
      for (const a of axis) {
        candidates.push({
          kind: 'axis', priority: 1, order: order++,
          x1: clip.x0, y1: a.y, x2: clip.x1, y2: a.y,
        });
        candidates.push({
          kind: 'axis', priority: 1, order: order++,
          x1: a.x, y1: clip.y0, x2: a.x, y2: clip.y1,
        });
      }
    }
    if (showGuides) {
      for (const c of center) {
        const l = lineThroughRect(c.a, c.b, clip);
        if (l) candidates.push({ kind: 'center', priority: 2, order: order++, ...l });
      }
    }

    candidates.sort((p, q) => p.priority - q.priority || p.order - q.order);
    const accepted = [];
    for (const c of candidates) {
      if (Math.hypot(c.x2 - c.x1, c.y2 - c.y1) < 0.1) continue;
      const p1 = { x: c.x1, y: c.y1 }, p2 = { x: c.x2, y: c.y2 };
      const probe = { p1, p2 };
      if (accepted.some(a => sameGuide(a.probe, probe))) continue;
      accepted.push({ kind: c.kind, probe });
    }
    const guides = accepted.map((g, i) => {
      const p1 = g.probe.p1, p2 = g.probe.p2;
      return Object.assign(
        makeStraight('G' + (i + 1), guideLabel(g.kind), p1, p2),
        { kind: g.kind }
      );
    });

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      dateBR: DATE_BR,
      origin: originMode,
      yUp,
      lineWidth: num(typeof state !== 'undefined' ? state.lineWidth : 1.9) || 1.9,
      bounds: b,
      view,
      guideMargin,
      track,
      curves,
      straights,
      guides,
      counts: {
        curves: curves.length,
        straights: straights.length,
        guides: guides.length,
      },
      warnings,
    };
  }

  // ── SVG ─────────────────────────────────────────────────
  function svgView(data, mode) {
    const W = data.view.width, H = data.view.height;

    if (mode === 'preview') {
      const scale = 1200 / Math.max(W, H);
      return {
        mode, pageW: W * scale, pageH: H * scale, ox: 0, oy: 0, scale,
        labelSize: 12, subSize: 10, minLabel: 7.5, minSub: 6.5,
        thin: 1, trackW: Math.max(1.5, data.lineWidth * scale),
        borderW: 0.9, dimSize: 11, dash: [6, 5], font: 'Helvetica, Arial, sans-serif',
      };
    }

    if (mode === 'real') {
      const scale = MM_PER_CM;
      return {
        mode, pageW: W * scale, pageH: H * scale, ox: 0, oy: 0, scale,
        labelSize: 50, subSize: 43, minLabel: 10, minSub: 9,
        thin: 0.85, trackW: data.lineWidth * scale,
        borderW: 0.7, dimSize: 12, dash: [18, 11], font: 'Helvetica, Arial, sans-serif',
      };
    }

    const pageW = 297, pageH = 210;
    const margin = 9, header = 14, footer = 7;
    const aw = pageW - margin * 2;
    const ah = pageH - header - footer;
    const scale = Math.min(aw / W, ah / H);
    return {
      mode, pageW, pageH,
      ox: (pageW - W * scale) / 2,
      oy: header + (ah - H * scale) / 2,
      scale,
      labelSize: 2.7, subSize: 2.3, minLabel: 1.5, minSub: 1.3,
      thin: 0.28, trackW: Math.max(0.4, data.lineWidth * scale),
      borderW: 0.28, dimSize: 2.6, dash: [1.5, 1.1],
      font: 'Helvetica, Arial, sans-serif',
    };
  }

  function n(v) {
    return (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
  }

  function svgMap(data, vp) {
    return (x, y) => ({
      x: vp.ox + (x - data.view.x0) * vp.scale,
      y: vp.oy + (data.yUp
        ? (data.view.y1 - y)
        : (y - data.view.y0)) * vp.scale,
    });
  }

  function svgPath(points, map) {
    if (!points || !points.length) return '';
    let d = '';
    for (let i = 0; i < points.length; i++) {
      const p = map(points[i].x, points[i].y);
      d += (i === 0 ? 'M' : 'L') + n(p.x) + ',' + n(p.y);
      if (i < points.length - 1) d += ' ';
    }
    return d;
  }

  function svgLabelSize(text, maxW, desired, min) {
    const est = Math.max(1, text.length * 0.56);
    if (maxW <= 0) return desired;
    return Math.max(min, Math.min(desired, maxW / est));
  }

  function renderSVG(data, opts) {
    opts = opts || {};
    const mode = opts.mode || 'preview';
    const vp = svgView(data, mode);
    const map = svgMap(data, vp);
    const out = [];
    const sw = vp.trackW;

    out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(vp.pageW)} ${n(vp.pageH)}"${mode === 'preview' ? ' width="100%"' : ` width="${n(vp.pageW)}mm" height="${n(vp.pageH)}mm"`} preserveAspectRatio="xMidYMid meet">`);
    out.push(`<title>Gabarito de Montagem — LineTrack CAD</title>`);
    out.push(`<desc>Pista ${fmt(data.bounds.width)} x ${fmt(data.bounds.height)} cm; ${data.counts.curves} curvas; ${data.counts.straights} retas; ${data.counts.guides} guias.</desc>`);
    out.push(`<rect x="0" y="0" width="${n(vp.pageW)}" height="${n(vp.pageH)}" fill="#ffffff"/>`);

    // Guias
    for (const g of data.guides) {
      const a = map(g.x1, g.y1), b = map(g.x2, g.y2);
      const color = g.kind === 'axis' ? COLORS.axis
        : g.kind === 'construction' ? COLORS.construction : COLORS.center;
      const dash = g.kind === 'construction'
        ? ` stroke-dasharray="${n(vp.dash[0])} ${n(vp.dash[1])}"` : '';
      const op = g.kind === 'axis' ? 0.8 : 0.72;
      out.push(`<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${color}" stroke-opacity="${op}" stroke-width="${n(vp.thin)}"${dash} stroke-linecap="round"/>`);
    }

    // Círculos-guia dos raios (somente arcos)
    for (const c of data.curves) {
      if (c.kind !== 'arc' || c.r <= 0) continue;
      const p = map(c.cx, c.cy);
      out.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(c.r * vp.scale)}" fill="none" stroke="${COLORS.radius}" stroke-opacity="0.62" stroke-width="${n(vp.thin)}"/>`);
    }

    // Pista
    for (const t of data.track) {
      if (t.type === 'line') {
        const a = map(t.x1, t.y1), b = map(t.x2, t.y2);
        out.push(`<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${COLORS.track}" stroke-width="${n(sw)}" stroke-linecap="round"/>`);
      } else if (t.type === 'circle') {
        const p = map(t.cx, t.cy);
        out.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(t.r * vp.scale)}" fill="none" stroke="${COLORS.track}" stroke-width="${n(sw)}"/>`);
      } else if (t.type === 'path') {
        out.push(`<path d="${svgPath(t.points, map)}" fill="none" stroke="${COLORS.track}" stroke-width="${n(sw)}" stroke-linecap="round" stroke-linejoin="round"/>`);
      }
    }

    // Borda / cotas gerais
    appendSvgBorder(out, data, vp, map);

    // Rótulos das curvas
    appendSvgLabels(out, data, vp, map);

    // Cabeçalho nas páginas exportadas
    if (mode === 'a4') {
      out.push(`<text x="${n(vp.ox > 4 ? vp.ox : 9)}" y="6.2" font-family="${vp.font}" font-size="4.2" font-weight="700" fill="${COLORS.label}">GABARITO DE MONTAGEM</text>`);
      out.push(`<text x="${n(vp.ox > 4 ? vp.ox : 9)}" y="10.4" font-family="${vp.font}" font-size="2.35" fill="${COLORS.labelSub}">Pista ${fmt(data.bounds.width)} x ${fmt(data.bounds.height)} cm · ${data.counts.curves} curvas · ${data.counts.straights} retas · ${data.counts.guides} guias</text>`);
      out.push(`<text x="${n(vp.pageW - 9)}" y="6.2" text-anchor="end" font-family="${vp.font}" font-size="2.2" fill="${COLORS.footer}">A4 paisagem · ${DATE_BR}</text>`);
      out.push(`<text x="${n(vp.pageW / 2)}" y="${n(vp.pageH - 3)}" text-anchor="middle" font-family="${vp.font}" font-size="1.9" fill="${COLORS.footer}">LineTrack CAD · medidas em cm · origem: ${data.origin === 'track' ? 'canto inferior esquerdo da pista' : 'coordenadas do editor'}</text>`);
    } else if (mode === 'real') {
      out.push(`<text x="18" y="34" font-family="${vp.font}" font-size="22" font-weight="700" fill="${COLORS.label}">GABARITO DE MONTAGEM — 1:1</text>`);
      out.push(`<text x="18" y="64" font-family="${vp.font}" font-size="12" fill="${COLORS.labelSub}">Pista ${fmt(data.bounds.width)} x ${fmt(data.bounds.height)} cm · ${data.counts.curves} curvas · ${data.counts.straights} retas · ${data.counts.guides} guias</text>`);
      out.push(`<text x="18" y="${n(vp.pageH - 14)}" font-family="${vp.font}" font-size="7" fill="${COLORS.footer}">LineTrack CAD · 1 cm no papel = 1 cm na pista · ${DATE_BR}</text>`);
    }

    out.push('</svg>');
    return out.join('\n');
  }

  function appendSvgBorder(out, data, vp, map) {
    const b = data.bounds;
    const p1 = map(b.minX, b.minY), p2 = map(b.maxX, b.maxY);
    const x0 = Math.min(p1.x, p2.x), x1 = Math.max(p1.x, p2.x);
    const y0 = Math.min(p1.y, p2.y), y1 = Math.max(p1.y, p2.y);
    const dim = vp.dimSize;

    out.push(`<rect x="${n(x0)}" y="${n(y0)}" width="${n(x1 - x0)}" height="${n(y1 - y0)}" fill="none" stroke="${COLORS.border}" stroke-width="${n(vp.borderW)}"/>`);

    // Cotas gerais
    out.push(`<text x="${n((x0 + x1) / 2)}" y="${n(y1 + dim * 1.25)}" text-anchor="middle" font-family="${vp.font}" font-size="${n(dim)}" fill="${COLORS.dim}">${fmt(b.width)} cm</text>`);
    out.push(`<text transform="translate(${n(x0 - dim * 0.8)},${n((y0 + y1) / 2)}) rotate(-90)" text-anchor="middle" font-family="${vp.font}" font-size="${n(dim)}" fill="${COLORS.dim}">${fmt(b.height)} cm</text>`);

    // Ticks dos cantos
    const tick = Math.max(dim * 0.45, vp.thin * 2);
    for (const [xa, ya] of [[x0, y0], [x0, y1], [x1, y0], [x1, y1]]) {
      const sx = xa === x0 ? -1 : 1;
      const sy = ya === y0 ? -1 : 1;
      out.push(`<line x1="${n(xa)}" y1="${n(ya)}" x2="${n(xa + sx * tick)}" y2="${n(ya)}" stroke="${COLORS.border}" stroke-width="${n(vp.borderW)}"/>`);
      out.push(`<line x1="${n(xa)}" y1="${n(ya)}" x2="${n(xa)}" y2="${n(ya + sy * tick)}" stroke="${COLORS.border}" stroke-width="${n(vp.borderW)}"/>`);
    }

    // Origem (0,0)
    const op = map(0, 0);
    if (op.x >= x0 - viewSlack(vp) && op.x <= x1 + viewSlack(vp) &&
        op.y >= y0 - viewSlack(vp) && op.y <= y1 + viewSlack(vp)) {
      const d = dim * 0.55;
      out.push(`<line x1="${n(op.x - d)}" y1="${n(op.y)}" x2="${n(op.x + d)}" y2="${n(op.y)}" stroke="${COLORS.dim}" stroke-width="${n(vp.borderW * 1.5)}"/>`);
      out.push(`<line x1="${n(op.x)}" y1="${n(op.y - d)}" x2="${n(op.x)}" y2="${n(op.y + d)}" stroke="${COLORS.dim}" stroke-width="${n(vp.borderW * 1.5)}"/>`);
      out.push(`<text x="${n(op.x + d * 1.3)}" y="${n(op.y + dim * 0.9)}" font-family="${vp.font}" font-size="${n(dim * 0.85)}" fill="${COLORS.dim}">0,0</text>`);
    }
  }

  function viewSlack(vp) {
    return (vp.dimSize * 3) / vp.scale;
  }

  function appendSvgLabels(out, data, vp, map) {
    const placed = [];
    const ordered = data.curves.slice().sort((a, b) => b.r - a.r);
    for (const c of ordered) {
      const p = map(c.cx, c.cy);
      const main = 'R' + fmt(c.r);
      const sub = `${fmt(c.cx)}, ${fmt(c.cy)}`;
      const maxW = c.r * vp.scale * 1.8;
      let mainSize = Math.min(vp.labelSize, Math.max(vp.minLabel, c.r * vp.scale * 0.55));
      let subSize = Math.min(vp.subSize, Math.max(vp.minSub, c.r * vp.scale * 0.5));
      mainSize = svgLabelSize(main, maxW, mainSize, vp.minLabel);
      subSize = svgLabelSize(sub, maxW, subSize, vp.minSub);
      const gap = subSize * 0.25;
      const maxH = (c.kind === 'circle'
        ? Math.max(0, 2 * (c.r - data.lineWidth / 2))
        : 2 * c.r) * vp.scale * 0.82;
      if (maxH > 0 && mainSize + subSize + gap > maxH) {
        const k = Math.max(0.45, maxH / (mainSize + subSize + gap));
        mainSize *= k;
        subSize *= k;
      }
      const w = Math.max(main.length * mainSize * 0.56, sub.length * subSize * 0.56);
      const h = mainSize + subSize + subSize * 0.25;
      const step = h * 1.35;
      const candidates = [
        { dx: 0, dy: 0 },
        { dx: 0, dy: -step }, { dx: 0, dy: step },
        { dx: 0, dy: -step * 2 }, { dx: 0, dy: step * 2 },
      ];
      let pos = candidates[0];
      for (const cand of candidates) {
        const cx = p.x + cand.dx, cy = p.y + cand.dy;
        const rect = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
        if (!placed.some(r => !(rect.x1 < r.x0 || rect.x0 > r.x1 || rect.y1 < r.y0 || rect.y0 > r.y1))) {
          pos = cand;
          placed.push(rect);
          break;
        }
        if (cand === candidates[candidates.length - 1]) placed.push(rect);
      }
      const cx = p.x + pos.dx, cy = p.y + pos.dy;
      if (pos.dx || pos.dy) {
        const edgeY = cy + (pos.dy < 0 ? h / 2 : -h / 2);
        out.push(`<line x1="${n(p.x)}" y1="${n(p.y)}" x2="${n(cx)}" y2="${n(edgeY)}" stroke="${COLORS.labelSub}" stroke-opacity="0.45" stroke-width="${n(vp.borderW)}"/>`);
      }
      out.push(`<text x="${n(cx)}" y="${n(cy - subSize * 0.52)}" text-anchor="middle" dominant-baseline="middle" font-family="${vp.font}" font-size="${n(mainSize)}" font-weight="700" fill="${COLORS.label}">${esc(main)}</text>`);
      out.push(`<text x="${n(cx)}" y="${n(cy + mainSize * 0.58)}" text-anchor="middle" dominant-baseline="middle" font-family="${vp.font}" font-size="${n(subSize)}" fill="${COLORS.labelSub}">${esc(sub)}</text>`);
    }
  }

  // ── PDF (pdf-lib) ───────────────────────────────────────
  function pdfView(data, mode) {
    const W = data.view.width, H = data.view.height;
    if (mode === 'real') {
      const scale = PT_PER_CM;
      const side = 2 * PT_PER_CM;
      const top = 4 * PT_PER_CM;
      return {
        mode, pageW: W * scale + side * 2, pageH: H * scale + side + top,
        scale, ox: side, oy: side, real: true, side, top,
        labelSize: 5.0 * PT_PER_CM, subSize: 4.25 * PT_PER_CM,
        minLabel: 1.0 * PT_PER_CM, minSub: 0.9 * PT_PER_CM,
        thin: 1.25, trackW: data.lineWidth * scale,
        borderW: 1.3, dash: [30, 18], dimSize: 1.15 * PT_PER_CM,
      };
    }
    const pageW = 842, pageH = 595;
    const margin = 26, header = 50, footer = 24;
    const aw = pageW - margin * 2;
    const ah = pageH - header - footer;
    const scale = Math.min(aw / W, ah / H);
    return {
      mode, pageW, pageH,
      scale,
      ox: (pageW - W * scale) / 2,
      oy: footer + (ah - H * scale) / 2,
      real: false,
      labelSize: 7.6, subSize: 6.4, minLabel: 2.2, minSub: 1.9,
      thin: 0.5, trackW: Math.max(1.2, data.lineWidth * scale),
      borderW: 0.6, dash: [2, 1.5], dimSize: 7,
    };
  }

  function pdfMap(data, vp) {
    return (x, y) => ({
      x: vp.ox + (x - data.view.x0) * vp.scale,
      y: vp.oy + (data.yUp
        ? (y - data.view.y0)
        : (data.view.y1 - y)) * vp.scale,
    });
  }

  function rgbOf(PDFLib, hex) {
    const v = parseInt(hex.slice(1), 16);
    return PDFLib.rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
  }

  async function buildPDFBytes(data, opts) {
    if (typeof PDFLib === 'undefined') throw new Error('pdf-lib não carregado');
    const { PDFDocument, StandardFonts, degrees, LineCapStyle } = PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const ctx = { doc, font, bold, degrees, LineCapStyle, PDFLib };

    const vp = pdfView(data, opts.real ? 'real' : 'a4');
    const page = doc.addPage([vp.pageW, vp.pageH]);
    drawPDFSheet(ctx, page, data, vp, opts);

    if (opts.includeTable) addPDFTablePages(ctx, data);

    addPDFFooters(ctx);

    return await doc.save();
  }

  function drawPDFSheet(ctx, page, data, vp, opts) {
    const { font, bold, PDFLib } = ctx;
    const map = pdfMap(data, vp);
    const col = hex => rgbOf(PDFLib, hex);

    // Título
    if (vp.real) {
      const title = 'GABARITO DE MONTAGEM — 1:1';
      page.drawText(title, {
        x: vp.side, y: vp.pageH - 1.9 * PT_PER_CM,
        size: 32, font: bold, color: col(COLORS.label),
      });
      page.drawText(`Pista ${fmt(data.bounds.width)} x ${fmt(data.bounds.height)} cm · ${data.counts.curves} curvas · ${data.counts.straights} retas · ${data.counts.guides} guias`, {
        x: vp.side, y: vp.pageH - 3.0 * PT_PER_CM,
        size: 15, font, color: col(COLORS.labelSub),
      });
    } else {
      page.drawText('GABARITO DE MONTAGEM', {
        x: 26, y: vp.pageH - 26, size: 15.5, font: bold, color: col(COLORS.label),
      });
      page.drawText(`Pista ${fmt(data.bounds.width)} x ${fmt(data.bounds.height)} cm · ${data.counts.curves} curvas · ${data.counts.straights} retas · ${data.counts.guides} guias`, {
        x: 26, y: vp.pageH - 39, size: 8.2, font, color: col(COLORS.labelSub),
      });
      const right = `A4 paisagem · ${DATE_BR}`;
      page.drawText(right, {
        x: vp.pageW - 26 - font.widthOfTextAtSize(right, 8),
        y: vp.pageH - 26, size: 8, font, color: col(COLORS.footer),
      });
    }

    // Guias
    for (const g of data.guides) {
      const a = map(g.x1, g.y1), b = map(g.x2, g.y2);
      const color = g.kind === 'axis' ? COLORS.axis
        : g.kind === 'construction' ? COLORS.construction : COLORS.center;
      const draw = {
        start: a, end: b, thickness: vp.thin, color: col(color),
        opacity: g.kind === 'axis' ? 0.8 : 0.72,
        lineCap: ctx.LineCapStyle.Round,
      };
      if (g.kind === 'construction') {
        draw.dashArray = vp.dash;
        draw.dashPhase = 0;
      }
      page.drawLine(draw);
    }

    // Círculos-guia
    for (const c of data.curves) {
      if (c.kind !== 'arc' || c.r <= 0) continue;
      const p = map(c.cx, c.cy);
      page.drawCircle({
        x: p.x, y: p.y, size: c.r * vp.scale,
        borderColor: col(COLORS.radius), borderWidth: vp.thin,
        borderOpacity: 0.62,
      });
    }

    // Pista
    for (const t of data.track) {
      if (t.type === 'line') {
        page.drawLine({
          start: map(t.x1, t.y1), end: map(t.x2, t.y2),
          thickness: vp.trackW, color: col(COLORS.track),
          lineCap: ctx.LineCapStyle.Round,
        });
      } else if (t.type === 'circle') {
        const p = map(t.cx, t.cy);
        page.drawCircle({
          x: p.x, y: p.y, size: t.r * vp.scale,
          borderColor: col(COLORS.track), borderWidth: vp.trackW,
        });
      } else if (t.type === 'path' && t.points && t.points.length > 1) {
        for (let i = 1; i < t.points.length; i++) {
          page.drawLine({
            start: map(t.points[i - 1].x, t.points[i - 1].y),
            end: map(t.points[i].x, t.points[i].y),
            thickness: vp.trackW, color: col(COLORS.track),
            lineCap: ctx.LineCapStyle.Round,
          });
        }
      }
    }

    drawPDFBorder(ctx, page, data, vp, map);
    drawPDFLabels(ctx, page, data, vp, map);

    if (!vp.real) {
      page.drawText(`LineTrack CAD · medidas em cm · origem: ${data.origin === 'track' ? 'canto inferior esquerdo da pista' : 'coordenadas do editor'}`, {
        x: vp.pageW / 2 - font.widthOfTextAtSize(`LineTrack CAD · medidas em cm · origem: ${data.origin === 'track' ? 'canto inferior esquerdo da pista' : 'coordenadas do editor'}`, 6.4) / 2,
        y: 10, size: 6.4, font, color: col(COLORS.footer),
      });
    } else {
      page.drawText(`LineTrack CAD · 1 cm no papel = 1 cm na pista · ${DATE_BR}`, {
        x: vp.side, y: 0.9 * PT_PER_CM,
        size: 12, font, color: col(COLORS.footer),
      });
    }
  }

  function drawPDFBorder(ctx, page, data, vp, map) {
    const { font, PDFLib } = ctx;
    const b = data.bounds;
    const p1 = map(b.minX, b.minY), p2 = map(b.maxX, b.maxY);
    const x0 = Math.min(p1.x, p2.x), x1 = Math.max(p1.x, p2.x);
    const y0 = Math.min(p1.y, p2.y), y1 = Math.max(p1.y, p2.y);
    const dim = vp.dimSize;
    const col = hex => rgbOf(PDFLib, hex);

    page.drawRectangle({
      x: x0, y: y0, width: x1 - x0, height: y1 - y0,
      borderColor: col(COLORS.border), borderWidth: vp.borderW,
    });

    const wText = `${fmt(b.width)} cm`;
    const hText = `${fmt(b.height)} cm`;
    page.drawText(wText, {
      x: (x0 + x1) / 2 - font.widthOfTextAtSize(wText, dim) / 2,
      y: y0 - dim * 1.0, size: dim, font, color: col(COLORS.dim),
    });
    page.drawText(hText, {
      x: x0 - dim * 1.6,
      y: (y0 + y1) / 2 - font.widthOfTextAtSize(hText, dim) / 2,
      size: dim, font, color: col(COLORS.dim), rotate: ctx.degrees(90),
    });

    const tick = Math.max(dim * 0.45, vp.thin * 2);
    for (const [xa, ya] of [[x0, y0], [x0, y1], [x1, y0], [x1, y1]]) {
      const sx = xa === x0 ? -1 : 1;
      const sy = ya === y0 ? -1 : 1;
      page.drawLine({ start: { x: xa, y: ya }, end: { x: xa + sx * tick, y: ya }, thickness: vp.borderW, color: col(COLORS.border) });
      page.drawLine({ start: { x: xa, y: ya }, end: { x: xa, y: ya + sy * tick }, thickness: vp.borderW, color: col(COLORS.border) });
    }

    const op = map(0, 0);
    const slack = dim * 2.2;
    if (op.x >= x0 - slack && op.x <= x1 + slack && op.y >= y0 - slack && op.y <= y1 + slack) {
      const d = dim * 0.55;
      page.drawLine({ start: { x: op.x - d, y: op.y }, end: { x: op.x + d, y: op.y }, thickness: vp.borderW * 1.4, color: col(COLORS.dim) });
      page.drawLine({ start: { x: op.x, y: op.y - d }, end: { x: op.x, y: op.y + d }, thickness: vp.borderW * 1.4, color: col(COLORS.dim) });
      page.drawText('0,0', { x: op.x + d * 1.2, y: op.y + d * 1.2, size: dim * 0.85, font, color: col(COLORS.dim) });
    }
  }

  function drawPDFLabels(ctx, page, data, vp, map) {
    const { font, bold, PDFLib } = ctx;
    const placed = [];
    const ordered = data.curves.slice().sort((a, b) => b.r - a.r);
    const col = hex => rgbOf(PDFLib, hex);

    for (const c of ordered) {
      const p = map(c.cx, c.cy);
      const main = 'R' + fmt(c.r);
      const sub = `${fmt(c.cx)}, ${fmt(c.cy)}`;
      const maxW = Math.max(0, c.r * vp.scale * 1.8);

      let mainSize = Math.min(vp.labelSize, Math.max(vp.minLabel, c.r * vp.scale * 0.55));
      let subSize = Math.min(vp.subSize, Math.max(vp.minSub, c.r * vp.scale * 0.5));
      const mw = bold.widthOfTextAtSize(main, mainSize);
      if (maxW > 0 && mw > maxW) mainSize = Math.max(vp.minLabel, mainSize * maxW / mw);
      const sw = font.widthOfTextAtSize(sub, subSize);
      if (maxW > 0 && sw > maxW) subSize = Math.max(vp.minSub, subSize * maxW / sw);

      const gap = subSize * 0.25;
      const maxH = (c.kind === 'circle'
        ? Math.max(0, 2 * (c.r - data.lineWidth / 2))
        : 2 * c.r) * vp.scale * 0.82;
      if (maxH > 0 && mainSize + subSize + gap > maxH) {
        const k = Math.max(0.45, maxH / (mainSize + subSize + gap));
        mainSize *= k;
        subSize *= k;
      }

      const mainW = bold.widthOfTextAtSize(main, mainSize);
      const subW = font.widthOfTextAtSize(sub, subSize);
      const w = Math.max(mainW, subW);
      const h = mainSize + subSize + gap;
      const step = h * 1.3;
      const candidates = [
        { dx: 0, dy: 0 },
        { dx: 0, dy: step }, { dx: 0, dy: -step },
        { dx: 0, dy: step * 2 }, { dx: 0, dy: -step * 2 },
      ];

      let cx = p.x, cy = p.y;
      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        const lx = p.x + cand.dx, ly = p.y + cand.dy;
        const rect = { x0: lx - w / 2, x1: lx + w / 2, y0: ly - h / 2, y1: ly + h / 2 };
        const hit = placed.some(r => !(rect.x1 < r.x0 || rect.x0 > r.x1 || rect.y1 < r.y0 || rect.y0 > r.y1));
        if (!hit) {
          cx = lx; cy = ly; placed.push(rect); break;
        }
        if (i === candidates.length - 1) { cx = lx; cy = ly; placed.push(rect); }
      }

      const mainCenter = cy + subSize / 2 + gap / 2;
      const subCenter = cy - mainSize / 2 - gap / 2;
      if (cx !== p.x || cy !== p.y) {
        const edgeY = cy + (cy < p.y ? h / 2 : -h / 2);
        page.drawLine({
          start: { x: p.x, y: p.y }, end: { x: cx, y: edgeY },
          thickness: vp.borderW, color: col(COLORS.labelSub), opacity: 0.45,
        });
      }
      page.drawText(main, {
        x: cx - mainW / 2, y: mainCenter - mainSize * 0.35,
        size: mainSize, font: bold, color: col(COLORS.label),
      });
      page.drawText(sub, {
        x: cx - subW / 2, y: subCenter - subSize * 0.35,
        size: subSize, font, color: col(COLORS.labelSub),
      });
    }
  }

  // ── TABELA PDF ──────────────────────────────────────────
  const TROW = 13;
  const CURVE_HEADERS = ['ID', 'Tipo', 'Raio (cm)', 'Centro X', 'Centro Y', 'Início', 'Fim', 'Arco'];
  const CURVE_WIDTHS  = [42, 78, 62, 74, 74, 118, 118, 62];
  const LINE_HEADERS  = ['ID', 'Tipo', 'X1', 'Y1', 'X2', 'Y2', 'Comprimento', 'Ângulo'];
  const LINE_WIDTHS   = [52, 112, 68, 68, 68, 68, 88, 64];

  function addPDFTablePages(ctx, data) {
    let page = ctx.doc.addPage([842, 595]);
    let y = 524;

    const newPage = () => {
      page = ctx.doc.addPage([842, 595]);
      y = 524;
      drawTablePageTitle(ctx, page);
    };

    const ensure = (need) => {
      if (y - need < 36) newPage();
    };

    const section = (title, headers, widths, aligns, rows) => {
      if (!rows.length) return;
      ensure(38 + TROW);
      drawSectionHead(ctx, page, title, headers, widths, aligns, y);
      y -= 38;
      for (const row of rows) {
        if (y - TROW < 36) {
          newPage();
          drawSectionHead(ctx, page, title + ' (continuação)', headers, widths, aligns, y);
          y -= 38;
        }
        drawTableRow(ctx, page, row, widths, aligns, y);
        y -= TROW;
      }
      y -= 10;
    };

    drawTablePageTitle(ctx, page);

    const curveRows = data.curves.map(c => [
      c.id, kindLabel(c.kind), fmt(c.r),
      fmt(c.cx), fmt(c.cy),
      fmtPt(c.start), fmtPt(c.end),
      fmt(c.sweepDeg, 0) + '°',
    ]);
    section('CURVAS', CURVE_HEADERS, CURVE_WIDTHS,
      ['left', 'left', 'right', 'right', 'right', 'left', 'left', 'right'], curveRows);

    const lineRows = data.straights.map(s => [
      s.id, 'Pista', fmt(s.x1), fmt(s.y1), fmt(s.x2), fmt(s.y2),
      fmt(s.length), fmtAngle(s.angle),
    ]);
    section('RETAS DA PISTA', LINE_HEADERS, LINE_WIDTHS,
      ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'], lineRows);

    const guideRows = data.guides.map(g => [
      g.id, guideLabel(g.kind), fmt(g.x1), fmt(g.y1), fmt(g.x2), fmt(g.y2),
      fmt(g.length), fmtAngle(g.angle),
    ]);
    section('GUIAS', LINE_HEADERS, LINE_WIDTHS,
      ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'], guideRows);

    if (data.warnings.length) {
      ensure(18 + data.warnings.length * 11);
      page.drawText('Avisos', { x: 26, y, size: 9.5, font: ctx.bold, color: rgbOf(ctx.PDFLib, COLORS.label) });
      y -= 14;
      for (const w of data.warnings) {
        page.drawText(w.slice(0, 120), { x: 26, y, size: 7, font: ctx.font, color: rgbOf(ctx.PDFLib, COLORS.labelSub) });
        y -= 11;
      }
    }
  }

  function drawTablePageTitle(ctx, page) {
    const col = hex => rgbOf(ctx.PDFLib, hex);
    page.drawText('TABELA DE MONTAGEM', { x: 26, y: 560, size: 14, font: ctx.bold, color: col(COLORS.label) });
    page.drawText(`Medidas em cm · origem: ${ui.data && ui.data.origin === 'editor' ? 'coordenadas do editor' : 'canto inferior esquerdo da pista'} · ${DATE_BR}`, {
      x: 26, y: 547, size: 7.2, font: ctx.font, color: col(COLORS.labelSub),
    });
  }

  function drawSectionHead(ctx, page, title, headers, widths, aligns, y) {
    const col = hex => rgbOf(ctx.PDFLib, hex);
    page.drawText(title, { x: 26, y, size: 9.5, font: ctx.bold, color: col(COLORS.label) });
    y -= 15;
    const total = widths.reduce((a, b) => a + b, 0);
    page.drawRectangle({
      x: 26, y: y - 3, width: total, height: 13,
      color: col('#eceef3'),
    });
    let x = 26;
    for (let i = 0; i < headers.length; i++) {
      const w = widths[i];
      const text = headers[i];
      const size = 7;
      const tw = ctx.bold.widthOfTextAtSize(text, size);
      const tx = aligns[i] === 'right' ? x + w - tw - 3 : x + 3;
      page.drawText(text, { x: tx, y: y + 1, size, font: ctx.bold, color: col('#33384a') });
      x += w;
    }
    page.drawLine({
      start: { x: 26, y: y - 3 }, end: { x: 26 + total, y: y - 3 },
      thickness: 0.6, color: col('#b9becd'),
    });
  }

  function drawTableRow(ctx, page, row, widths, aligns, y) {
    const col = hex => rgbOf(ctx.PDFLib, hex);
    let x = 26;
    for (let i = 0; i < row.length; i++) {
      const text = String(row[i]);
      const size = 6.8;
      const w = widths[i];
      const tw = ctx.font.widthOfTextAtSize(text, size);
      const tx = aligns[i] === 'right' ? x + w - tw - 3 : x + 3;
      page.drawText(text, { x: tx, y, size, font: ctx.font, color: col('#23283a') });
      x += w;
    }
    page.drawLine({
      start: { x: 26, y: y - 3.5 }, end: { x: 26 + widths.reduce((a, b) => a + b, 0), y: y - 3.5 },
      thickness: 0.25, color: col('#dde0e8'),
    });
  }

  function addPDFFooters(ctx) {
    const { doc, font, PDFLib } = ctx;
    const pages = doc.getPages();
    const total = pages.length;
    const col = hex => rgbOf(PDFLib, hex);
    pages.forEach((page, idx) => {
      const size = page.getWidth();
      const big = size > 2000;
      const fs = big ? 22 : 6.8;
      const margin = big ? 1.8 * PT_PER_CM : 26;
      const y = big ? 1.2 * PT_PER_CM : 12;
      const left = 'LineTrack CAD · Gabarito de montagem';
      page.drawText(left, { x: margin, y, size: fs, font, color: col(COLORS.footer) });
      const right = `Página ${idx + 1} de ${total}`;
      page.drawText(right, {
        x: page.getWidth() - margin - font.widthOfTextAtSize(right, fs),
        y, size: fs, font, color: col(COLORS.footer),
      });
    });
  }

  // ── DOWNLOADS ───────────────────────────────────────────
  function fileName(ext) {
    return `gabarito-pista-${DATE_ISO}.${ext}`;
  }

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function downloadText(name, text, mime, bom) {
    const blob = new Blob([bom ? '\uFEFF' : '', text], { type: mime + ';charset=utf-8' });
    downloadBlob(name, blob);
  }

  function csvText(data) {
    const lines = [];
    const push = (...cells) => lines.push(cells.join(';'));
    push('GABARITO DE MONTAGEM');
    push('Pista', `${fmt(data.bounds.width)} x ${fmt(data.bounds.height)} cm`);
    push('Origem', data.origin === 'track' ? 'Canto inferior esquerdo da pista' : 'Coordenadas do editor');
    push('Gerado em', DATE_BR);
    push('');
    push('CURVAS');
    push('ID', 'Tipo', 'Raio (cm)', 'Centro X', 'Centro Y', 'Inicio X', 'Inicio Y', 'Fim X', 'Fim Y', 'Arco (graus)');
    for (const c of data.curves) {
      push(c.id, kindLabel(c.kind), fmt(c.r), fmt(c.cx), fmt(c.cy),
        c.start ? fmt(c.start.x) : '', c.start ? fmt(c.start.y) : '',
        c.end ? fmt(c.end.x) : '', c.end ? fmt(c.end.y) : '',
        fmt(c.sweepDeg, 1));
    }
    push('');
    push('RETAS E GUIAS');
    push('ID', 'Tipo', 'X1', 'Y1', 'X2', 'Y2', 'Comprimento', 'Angulo (graus)');
    for (const s of data.straights) {
      push(s.id, s.type, fmt(s.x1), fmt(s.y1), fmt(s.x2), fmt(s.y2), fmt(s.length), fmt(s.angle));
    }
    for (const g of data.guides) {
      push(g.id, guideLabel(g.kind), fmt(g.x1), fmt(g.y1), fmt(g.x2), fmt(g.y2), fmt(g.length), fmt(g.angle));
    }
    return lines.join('\r\n') + '\r\n';
  }

  function roundDeep(v) {
    if (typeof v === 'number') return Math.round(v * 100) / 100;
    if (Array.isArray(v)) return v.map(roundDeep);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = roundDeep(v[k]);
      return o;
    }
    return v;
  }

  function jsonText(data) {
    return JSON.stringify(roundDeep(data), null, 2);
  }

  // ── JANELA ──────────────────────────────────────────────
  function el(id) {
    return document.getElementById(id);
  }

  function isOpen() {
    const w = el('gabarito-window');
    return !!(w && !w.classList.contains('hidden'));
  }

  function setActive(on) {
    const b = el('btn-gabarito');
    if (b) b.classList.toggle('active', !!on);
  }

  function openGabarito() {
    const win = el('gabarito-window');
    if (!win) return;
    if (typeof closeCurveLibrary === 'function') {
      const lib = el('curve-library');
      if (lib && !lib.classList.contains('hidden')) closeCurveLibrary();
    }
    const back = el('gabarito-backdrop');
    if (back) back.classList.remove('hidden');
    win.classList.remove('hidden');
    setActive(true);
    refreshGabarito();
    notify('Gabarito de montagem · Esc fecha');
  }

  function closeGabarito() {
    const win = el('gabarito-window');
    if (win) win.classList.add('hidden');
    const back = el('gabarito-backdrop');
    if (back) back.classList.add('hidden');
    setActive(false);
  }

  function toggleGabarito() {
    if (isOpen()) closeGabarito();
    else openGabarito();
  }

  function getOptions() {
    return {
      origin: (el('gab-origin') && el('gab-origin').value) === 'editor' ? 'editor' : 'track',
      guides: !(el('gab-show-guides') && !el('gab-show-guides').checked),
      axes: !(el('gab-show-axes') && !el('gab-show-axes').checked),
      table: !(el('gab-show-table') && !el('gab-show-table').checked),
      scale: (el('gab-scale') && el('gab-scale').value) === 'real' ? 'real' : 'a4',
    };
  }

  function refreshGabarito() {
    const opts = getOptions();
    const data = buildAssemblyData({ origin: opts.origin, guides: opts.guides, axes: opts.axes });
    ui.data = data;

    const sub = el('gabarito-subtitle');
    const preview = el('gab-preview');
    const table = el('gab-table');

    if (!data) {
      if (sub) sub.textContent = 'Nenhum segmento de pista no desenho';
      if (preview) preview.innerHTML = '<div class="gab-empty">Desenhe a pista no editor para gerar o gabarito.<br>O gabarito usa os segmentos da pista, as linhas de construção e os centros das curvas.</div>';
      if (table) table.innerHTML = '<div class="gab-empty">Sem dados para a tabela.</div>';
      setDownloadsEnabled(false);
      return;
    }

    if (sub) {
      sub.textContent = `${fmt(data.bounds.width)} x ${fmt(data.bounds.height)} cm · ${data.counts.curves} curvas · ${data.counts.straights} retas · ${data.counts.guides} guias`;
    }

    if (preview) {
      preview.innerHTML = renderSVG(data, { mode: 'preview' });
    }
    if (table) {
      table.innerHTML = renderTableHTML(data);
    }
    setDownloadsEnabled(true);
  }

  function setDownloadsEnabled(on) {
    for (const id of ['gab-pdf', 'gab-svg', 'gab-csv', 'gab-json']) {
      const b = el(id);
      if (b) b.disabled = !on || ui.busy;
    }
  }

  function setBusy(on) {
    ui.busy = on;
    for (const id of ['gab-pdf', 'gab-svg', 'gab-csv', 'gab-json']) {
      const b = el(id);
      if (b) b.disabled = on || !ui.data;
    }
    const hint = el('gab-hint');
    if (hint) hint.textContent = on ? 'Gerando PDF…' : 'O desenho e a tabela são gerados a partir da pista atual.';
  }

  function setTab(tab) {
    ui.tab = tab === 'table' ? 'table' : 'drawing';
    document.querySelectorAll('[data-gab-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.gabTab === ui.tab);
    });
    const draw = el('gab-drawing-pane');
    const tabp = el('gab-table-pane');
    if (draw) draw.classList.toggle('hidden', ui.tab !== 'drawing');
    if (tabp) tabp.classList.toggle('hidden', ui.tab !== 'table');
  }

  function renderTableHTML(data) {
    const curveRows = data.curves.map(c => `
      <tr>
        <td class="gab-id">${esc(c.id)}</td>
        <td>${esc(kindLabel(c.kind))}</td>
        <td class="num">${fmt(c.r)}</td>
        <td class="num">${fmt(c.cx)}</td>
        <td class="num">${fmt(c.cy)}</td>
        <td class="num">${esc(fmtPt(c.start))}</td>
        <td class="num">${esc(fmtPt(c.end))}</td>
        <td class="num">${fmt(c.sweepDeg, 0)}°</td>
      </tr>`).join('');

    const straightRows = data.straights.map(s => `
      <tr>
        <td class="gab-id">${esc(s.id)}</td>
        <td>${esc(s.type)}</td>
        <td class="num">${fmt(s.x1)}</td>
        <td class="num">${fmt(s.y1)}</td>
        <td class="num">${fmt(s.x2)}</td>
        <td class="num">${fmt(s.y2)}</td>
        <td class="num">${fmt(s.length)}</td>
        <td class="num">${fmtAngle(s.angle)}</td>
      </tr>`).join('');

    const guideRows = data.guides.map(g => `
      <tr>
        <td class="gab-id">${esc(g.id)}</td>
        <td>${esc(guideLabel(g.kind))}</td>
        <td class="num">${fmt(g.x1)}</td>
        <td class="num">${fmt(g.y1)}</td>
        <td class="num">${fmt(g.x2)}</td>
        <td class="num">${fmt(g.y2)}</td>
        <td class="num">${fmt(g.length)}</td>
        <td class="num">${fmtAngle(g.angle)}</td>
      </tr>`).join('');

    return `
      <div class="gab-table-wrap">
        <div class="gab-sec-title">Curvas <span>${data.curves.length}</span></div>
        <table class="gab-table">
          <thead><tr>
            <th>ID</th><th>Tipo</th><th>Raio</th><th>Centro X</th><th>Centro Y</th>
            <th>Início</th><th>Fim</th><th>Arco</th>
          </tr></thead>
          <tbody>${curveRows || '<tr><td colspan="8" class="gab-none">Nenhuma curva</td></tr>'}</tbody>
        </table>

        <div class="gab-sec-title">Retas da pista <span>${data.straights.length}</span></div>
        <table class="gab-table">
          <thead><tr>
            <th>ID</th><th>Tipo</th><th>X1</th><th>Y1</th><th>X2</th><th>Y2</th><th>Comp.</th><th>Ângulo</th>
          </tr></thead>
          <tbody>${straightRows || '<tr><td colspan="8" class="gab-none">Nenhuma reta</td></tr>'}</tbody>
        </table>

        <div class="gab-sec-title">Guias <span>${data.guides.length}</span></div>
        <table class="gab-table">
          <thead><tr>
            <th>ID</th><th>Tipo</th><th>X1</th><th>Y1</th><th>X2</th><th>Y2</th><th>Comp.</th><th>Ângulo</th>
          </tr></thead>
          <tbody>${guideRows || '<tr><td colspan="8" class="gab-none">Nenhuma guia</td></tr>'}</tbody>
        </table>

        <div class="gab-table-note">Medidas em cm. Ângulos a partir do eixo X, no sentido do desenho.${data.warnings.length ? ' ' + esc(data.warnings.join(' ')) : ''}</div>
      </div>`;
  }

  // ── AÇÕES ───────────────────────────────────────────────
  function currentData() {
    const opts = getOptions();
    const data = buildAssemblyData({ origin: opts.origin, guides: opts.guides, axes: opts.axes });
    ui.data = data;
    return data;
  }

  async function onDownloadPDF() {
    const data = currentData();
    if (!data) { notify('Nenhum segmento para exportar', 'warn'); return; }
    const opts = getOptions();
    setBusy(true);
    try {
      const bytes = await buildPDFBytes(data, { real: opts.scale === 'real', includeTable: opts.table });
      downloadBlob(fileName('pdf'), new Blob([bytes], { type: 'application/pdf' }));
      notify('PDF do gabarito gerado', 'success');
    } catch (err) {
      console.error(err);
      notify('Erro ao gerar o PDF: ' + (err && err.message ? err.message : err), 'error');
    } finally {
      setBusy(false);
    }
  }

  function onDownloadSVG() {
    const data = currentData();
    if (!data) { notify('Nenhum segmento para exportar', 'warn'); return; }
    const opts = getOptions();
    const svg = renderSVG(data, { mode: opts.scale === 'real' ? 'real' : 'a4' });
    downloadText(fileName('svg'), svg, 'image/svg+xml');
    notify('SVG do gabarito baixado', 'success');
  }

  function onDownloadCSV() {
    const data = currentData();
    if (!data) { notify('Nenhum segmento para exportar', 'warn'); return; }
    downloadText(fileName('csv'), csvText(data), 'text/csv', true);
    notify('CSV do gabarito baixado', 'success');
  }

  function onDownloadJSON() {
    const data = currentData();
    if (!data) { notify('Nenhum segmento para exportar', 'warn'); return; }
    downloadText(fileName('json'), jsonText(data), 'application/json');
    notify('JSON do gabarito baixado', 'success');
  }

  // ── LIGAÇÕES ────────────────────────────────────────────
  function bind() {
    const win = el('gabarito-window');
    if (!win) return;

    const bindClick = (id, fn) => {
      const b = el(id);
      if (b) b.addEventListener('click', fn);
    };
    bindClick('btn-gabarito', toggleGabarito);
    bindClick('btn-export-gabarito', openGabarito);
    bindClick('gabarito-close', closeGabarito);
    bindClick('gab-refresh', refreshGabarito);
    bindClick('gab-pdf', onDownloadPDF);
    bindClick('gab-svg', onDownloadSVG);
    bindClick('gab-csv', onDownloadCSV);
    bindClick('gab-json', onDownloadJSON);

    document.querySelectorAll('[data-action="gabarito"]').forEach(b => {
      b.addEventListener('click', toggleGabarito);
    });

    const back = el('gabarito-backdrop');
    if (back) back.addEventListener('click', closeGabarito);

    document.querySelectorAll('[data-gab-tab]').forEach(b => {
      b.addEventListener('click', () => setTab(b.dataset.gabTab));
    });

    for (const id of ['gab-origin', 'gab-scale', 'gab-show-guides', 'gab-show-axes']) {
      const c = el(id);
      if (c) c.addEventListener('change', refreshGabarito);
    }

    // Atalhos do editor ficam bloqueados enquanto a janela está aberta.
    document.addEventListener('keydown', e => {
      if (!isOpen()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeGabarito();
        return;
      }
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.stopPropagation();
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  // API para depuração / testes
  window.Gabarito = {
    build: buildAssemblyData,
    renderSVG,
    open: openGabarito,
    close: closeGabarito,
    isOpen,
    getData: () => ui.data,
    buildPDFBytes,
  };
})();
