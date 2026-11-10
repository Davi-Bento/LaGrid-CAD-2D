const { chromium } = require('playwright');
const url = require('./helpers').appUrl;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(url);
  await page.waitForTimeout(250);
  await page.evaluate(() => localStorage.removeItem('linetrack.curveLibrary.v1'));

  const results = [];
  const check = (n, ok, extra) => results.push({ n, ok: !!ok, extra: extra ?? '' });
  const near = (a, b, eps = 0.08) => Math.abs(a - b) <= eps;

  const box = await page.locator('#main-canvas').boundingBox();
  const ppt = async (wx, wy) => {
    const s = await page.evaluate(([x, y]) => eval(`w2s(${x},${y})`), [wx, wy]);
    return { x: box.x + s.x, y: box.y + s.y };
  };
  const moveWorld = async (wx, wy) => {
    const p = await ppt(wx, wy);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(80);
  };
  const bbox = async () => page.evaluate(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of state.segments) s.points.forEach(p => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    });
    if (!isFinite(minX)) return null;
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY, minX, minY, maxX, maxY };
  });
  const pasteInfo = async () => page.evaluate(() => ui.pasteMode ? {
    scale: ui.pasteMode.scale,
    rotation: ui.pasteMode.rotation,
    anchorKind: ui.pasteMode.anchor.kind,
    anchorIndex: ui.pasteMode.anchorIndex,
    anchors: ui.pasteMode.anchors.length,
    tool: ui.tool,
  } : null);
  const reset = async () => page.evaluate(() => eval(`(() => {
    state.segments = [];
    state.nextId = 1;
    state.nodes = { start: null, end: null };
    state.dijkstraPath = [];
    state.undoStack = [];
    state.redoStack = [];
    ui.selection.clear();
    ui.pasteMode = null;
    ui.pasteLabel = null;
    ui.snapTarget = null;
    closeCurveLibrary();
    cam.scale = 1;
    cam.x = canvas.width / 2;
    cam.y = canvas.height / 2;
    setTool('select');
    updatePanelInfo();
    updateSelectionPanel();
    render();
  })()`));

  // ── A) COLAR DA BIBLIOTECA ─────────────────────────────
  await reset();
  await page.click('#btn-curve-library');
  await page.waitForTimeout(120);
  await page.click('.lib-card[data-curve="bico-de-pato"]');
  await page.waitForTimeout(120);
  await moveWorld(10, 10);

  let info = await pasteInfo();
  check('A1 biblioteca entra no modo colagem com centro',
    !!info && info.anchorKind === 'centro' && info.anchors === 3 && near(info.scale, 1),
    JSON.stringify(info));

  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(60);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(60);
  info = await pasteInfo();
  check('A2 ↑ aumenta a escala', near(info.scale, 1.21, 0.01), String(info.scale));

  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(60);
  info = await pasteInfo();
  check('A3 ↓ diminui a escala', near(info.scale, 1.1, 0.01), String(info.scale));

  await page.keyboard.press('r');
  await page.waitForTimeout(80);
  info = await pasteInfo();
  check('A4 R gira 90° sem virar ferramenta fillet',
    near(info.rotation, Math.PI / 2, 0.001) && info.tool === 'select',
    JSON.stringify(info));
  check('A5 HUD do fillet continua oculto durante a colagem',
    await page.$eval('#fillet-hud', el => el.classList.contains('hidden')));

  await page.keyboard.press('Tab');
  await page.waitForTimeout(80);
  info = await pasteInfo();
  check('A6 Tab troca a âncora para a ponta inicial',
    info.anchorKind === 'início' && info.anchorIndex === 1,
    JSON.stringify(info));

  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const b = await bbox();
  const firstPt = await page.evaluate(() => {
    const s = state.segments[0];
    return { x: s.points[0].x, y: s.points[0].y };
  });
  check('A7 ponta inicial fica no cursor ao confirmar',
    near(firstPt.x, 10) && near(firstPt.y, 10),
    JSON.stringify(firstPt));
  check('A8 peça girada e escalada na inserção',
    !!b && near(b.w, 24 * 1.1, 0.5) && near(b.h, 37 * 1.1, 0.5),
    b ? `${b.w.toFixed(2)} x ${b.h.toFixed(2)}` : 'sem bbox');
  check('A9 após confirmar volta para Seleção',
    await page.evaluate(() => ui.tool === 'select' && !ui.pasteMode));

  // R fora da colagem continua abrindo o fillet
  await page.keyboard.press('r');
  await page.waitForTimeout(80);
  check('A10 R fora da colagem continua abrindo o fillet',
    await page.evaluate(() => ui.tool === 'fillet'));

  // ── B) COLAR NORMAL (Ctrl+C / Ctrl+V) ─────────────────
  await reset();
  await page.evaluate(() => {
    state.segments = [{
      id: 1, type: 'line', selected: false,
      points: [{ x: -10, y: 0 }, { x: 10, y: 0 }],
    }];
    state.nextId = 2;
    ui.selection.add(1);
    copySelection();
    startPasteMode();
  });
  await moveWorld(5, 5);
  info = await pasteInfo();
  check('B1 colar normal também usa as novas âncoras',
    !!info && info.anchorKind === 'centro' && info.anchors === 3,
    JSON.stringify(info));

  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('r');
  await page.waitForTimeout(100);
  info = await pasteInfo();
  check('B2 Tab + ↑ + R funcionam no colar normal',
    info.anchorKind === 'início' && near(info.scale, 1.21, 0.01) &&
    near(info.rotation, Math.PI / 2, 0.001) && info.tool === 'select',
    JSON.stringify(info));

  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const linePts = await page.evaluate(() => {
    const s = state.segments[state.segments.length - 1];
    return s.points.map(p => ({ x: p.x, y: p.y }));
  });
  check('B3 linha colada sai da ponta inicial no cursor',
    near(linePts[0].x, 5) && near(linePts[0].y, 5),
    JSON.stringify(linePts));
  check('B4 linha girada 90° e escalada 1,21×',
    near(linePts[1].x, 5, 0.2) && near(linePts[1].y, 5 + 20 * 1.21, 0.2),
    JSON.stringify(linePts));

  // ── C) CTRL+TAB NÃO CONFLITA COM A FERRAMENTA CÍRCULO ──────
  await reset();
  const circleModeBefore = await page.evaluate(() => { setTool('circle'); return ui.circleMode; });
  await page.keyboard.press('Control+Tab');
  await page.waitForTimeout(120);
  const circleModeAfter = await page.evaluate(() => ui.circleMode);
  check('C1 Ctrl+Tab alterna o modo do círculo sem colagem',
    circleModeBefore !== circleModeAfter && await page.evaluate(() => !ui.pasteMode),
    `${circleModeBefore} → ${circleModeAfter}`);

  // ── D) LIMITES E CICLO ────────────────────────────────
  await reset();
  await page.evaluate(() => {
    state.segments = [{
      id: 1, type: 'line', selected: false,
      points: [{ x: -10, y: 0 }, { x: 10, y: 0 }],
    }];
    state.nextId = 2;
    ui.selection.add(1);
    copySelection();
    startPasteMode();
  });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(80);
  info = await pasteInfo();
  check('D1 Tab percorre centro → início → fim → centro',
    info.anchorKind === 'centro' && info.anchorIndex === 0,
    JSON.stringify(info));

  // ── RESUMO ─────────────────────────────────────────────
  const ok = results.filter(r => r.ok).length;
  for (const r of results) console.log((r.ok ? 'OK  ' : 'FAIL') + ' ' + r.n +
    (r.extra ? ' :: ' + r.extra : ''));
  console.log(`\n${ok}/${results.length} verificações OK`);
  if (errors.length) {
    console.log('\nERROS DE PÁGINA:');
    errors.forEach(e => console.log(' ' + e));
  }
  await browser.close();
  process.exit(ok === results.length && errors.length === 0 ? 0 : 1);
})();
