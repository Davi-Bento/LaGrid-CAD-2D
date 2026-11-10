const { chromium } = require('playwright');
const fs = require('fs');
const url = require('./helpers').appUrl;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(500);

  const results = [];
  const check = (n, ok, extra) => results.push({ n, ok, extra: extra ?? '' });
  const count = () => page.evaluate(() => state.segments.length);
  const scr = (x, y) => page.evaluate(([wx, wy]) => {
    const r = canvas.getBoundingClientRect();
    const s = w2s(wx, wy);
    return { x: r.x + s.x, y: r.y + s.y };
  }, [x, y]);
  const move = async (x, y) => { const p = await scr(x, y); await page.mouse.move(p.x, p.y); };
  const clickW = async (x, y) => { const p = await scr(x, y); await page.mouse.click(p.x, p.y); await page.waitForTimeout(90); };

  // Base: um círculo conhecido
  await page.evaluate(() => {
    state.segments = [{ id: 1, type: 'circle', points: [{ x: 20, y: 10 }], radius: 10, selected: false }];
    state.nextId = 2;
    setTool('circle');
    fitView();
    render();
  });
  await page.waitForTimeout(200);

  // 1) Pontos N/L/S/O expostos como snap (checkbox ligado por padrão)
  const quads = await page.evaluate(() => {
    const qs = getAllEndpoints().filter(p => p.segId === 1 && p.idx >= 100);
    return {
      enabled: state.showCircleQuads,
      count: qs.length,
      pts: qs.map(q => [q.quad, +q.x.toFixed(2), +q.y.toFixed(2)]).sort(),
    };
  });
  check('quadrantes ligados por padrão', quads.enabled === true);
  check('4 quadrantes magnéticos no círculo', quads.count === 4, JSON.stringify(quads.pts));
  check('coordenadas N/L/S/O corretas',
    JSON.stringify(quads.pts) === JSON.stringify([['E', 30, 10], ['N', 20, 20], ['S', 20, 0], ['W', 10, 10]]),
    JSON.stringify(quads.pts));

  await page.screenshot({ path: 'tests/artifacts/circle_quads_markers.png' });

  // 2) Ctrl+Tab alterna centro -> 4 lados
  await page.keyboard.press('Control+Tab');
  await page.waitForTimeout(120);
  check('Ctrl+Tab alterna para 4 lados', await page.evaluate(() => ui.circleMode === 'side'));

  // 3) Modo 4 lados: lado E (mouse para a direita), início na borda e diâmetro
  await move(5, 10);
  await move(10, 10);
  check('mouse à direita escolhe lado Leste', await page.evaluate(() => ui.circleSide === 'E'));

  await clickW(10, 10);
  const started = await page.evaluate(() => ({ c: ui.circleCenter, side: ui.circleSide }));
  check('1º clique define início na borda', started.c && Math.hypot(started.c.x - 10, started.c.y - 10) < 0.01,
    JSON.stringify(started.c));

  await move(30, 10);
  await page.screenshot({ path: 'tests/artifacts/circle_quads_preview.png' });
  const preview = await page.evaluate(() => ({ side: ui.circleSide }));
  check('mouse define o lado do centro', preview.side === 'E', preview.side);

  const before = await count();
  await clickW(30, 10);
  check('círculo criado no modo 4 lados', await count() === before + 1);
  const cE = await page.evaluate(() => {
    const s = state.segments[state.segments.length - 1];
    return { type: s.type, center: s.points[0], radius: s.radius, start: s.startPoint, side: s.startSide };
  });
  check('centro fica no lado escolhido',
    cE.type === 'circle' && Math.hypot(cE.center.x - 20, cE.center.y - 10) < 0.01,
    JSON.stringify(cE.center));
  check('raio = metade do diâmetro', Math.abs(cE.radius - 10) < 0.01, 'R=' + cE.radius);
  check('ponto de início guardado', cE.start && Math.hypot(cE.start.x - 10, cE.start.y - 10) < 0.01,
    JSON.stringify(cE.start));

  // 4) Lado N: mover para cima depois do início
  await clickW(10, 10);
  await move(10, 15);
  check('mouse para cima escolhe Norte', await page.evaluate(() => ui.circleSide === 'N'));
  await clickW(10, 15);
  const cN = await page.evaluate(() => {
    const s = state.segments[state.segments.length - 1];
    return { center: s.points[0], radius: s.radius };
  });
  check('curva para Norte: centro acima do início',
    Math.hypot(cN.center.x - 10, cN.center.y - 12.5) < 0.01, JSON.stringify(cN.center));
  check('curva para Norte: R=2.5', Math.abs(cN.radius - 2.5) < 0.01, 'R=' + cN.radius);

  // 5) Ctrl+clique em quadrante de círculo existente inicia ali
  await page.evaluate(() => { fitView(); doZoom(0.5, canvas.width / 2, canvas.height / 2); });
  await page.waitForTimeout(120);
  const qScreen = await scr(30, 10);
  await page.mouse.move(qScreen.x, qScreen.y);
  await page.keyboard.down('Control');
  await page.mouse.click(qScreen.x, qScreen.y);
  await page.keyboard.up('Control');
  await page.waitForTimeout(120);
  const ctrlStart = await page.evaluate(() => ({ mode: ui.circleMode, c: ui.circleCenter, side: ui.circleSide }));
  check('Ctrl+clique muda para 4 lados', ctrlStart.mode === 'side');
  check('Ctrl+clique inicia no quadrante Leste',
    ctrlStart.c && Math.hypot(ctrlStart.c.x - 30, ctrlStart.c.y - 10) < 0.01, JSON.stringify(ctrlStart.c));

  await move(45, 10);
  await clickW(45, 10);
  const cCtrl = await page.evaluate(() => {
    const s = state.segments[state.segments.length - 1];
    return { center: s.points[0], radius: s.radius };
  });
  check('círculo continua a partir do quadrante',
    Math.hypot(cCtrl.center.x - 37.5, cCtrl.center.y - 10) < 0.01 && Math.abs(cCtrl.radius - 7.5) < 0.01,
    JSON.stringify(cCtrl));

  // 6) Desligar checkbox remove os ímãs e os marcadores
  await page.click('#circle-quads-toggle');
  await page.waitForTimeout(100);
  const off = await page.evaluate(() => ({
    state: state.showCircleQuads,
    quads: getAllEndpoints().filter(p => p.idx >= 100).length,
  }));
  check('checkbox desliga quadrantes', off.state === false);
  check('sem ímãs de quadrante desligado', off.quads === 0, 'quads=' + off.quads);

  // 7) Persistência no JSON
  let saved = null;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.evaluate(() => saveJSON()),
    ]);
    const p = await dl.path();
    saved = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { saved = { error: e.message }; }
  check('saveJSON grava showCircleQuads', saved && saved.showCircleQuads === false,
    saved && saved.error ? saved.error : String(saved && saved.showCircleQuads));

  // 8) loadJSON restaura o checkbox
  await page.evaluate(() => {
    const d = {
      version: 7,
      segments: [{ id: 1, type: 'circle', points: [{ x: 20, y: 10 }], radius: 10, selected: false }],
      nodes: { start: null, end: null }, nextId: 2,
      workspace: { w: 285, h: 180 }, lineWidth: 1.9,
      showCircleQuads: false,
    };
    loadJSON(new File([JSON.stringify(d)], 'q.json', { type: 'application/json' }));
  });
  await page.waitForTimeout(300);
  check('loadJSON desliga quadrantes', await page.evaluate(() => state.showCircleQuads === false));
  check('loadJSON atualiza checkbox', await page.$eval('#circle-quads-toggle', el => el.checked === false));

  await page.click('#circle-quads-toggle');
  await page.waitForTimeout(80);
  check('religar quadrantes volta a expor 4 ímãs',
    await page.evaluate(() => getAllEndpoints().filter(p => p.idx >= 100).length === 4));

  // 9) Ctrl+Tab volta para o modo centro
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.keyboard.press('Control+Tab');
  await page.waitForTimeout(120);
  check('Ctrl+Tab volta ao modo centro', await page.evaluate(() => ui.circleMode === 'center'));

  check('sem erros de runtime', errors.length === 0, errors.join(' | '));

  console.log(JSON.stringify(results, null, 2));
  const fails = results.filter(r => !r.ok);
  console.log('RESULT:', (results.length - fails.length) + '/' + results.length, 'OK');
  console.log('ERRORS:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
