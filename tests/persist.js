const { chromium } = require('playwright');
const url = require('./helpers').appUrl;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(url);
  await page.waitForTimeout(200);

  const data = {
    version: 6,
    segments: [
      { id: 1, type: 'circle', points: [{ x: 20, y: 20 }], radius: 5, selected: false },
      { id: 2, type: 'polyline', points: [{ x: 30, y: 10 }, { x: 40, y: 20 }, { x: 50, y: 10 }], selected: false },
      { id: 3, type: 'arc', points: [{ x: 60, y: 30 }, { x: 65, y: 25 }, { x: 70, y: 30 }], selected: false },
      { id: 4, type: 'line', points: [{ x: 10, y: 50 }, { x: 60, y: 50 }], selected: false },
    ],
    nodes: { start: { x: 10, y: 50, segId: 4, t: 0 }, end: null },
    nextId: 5,
    workspace: { w: 285, h: 180 },
    lineWidth: 1.9,
    angleSnap: true,
    angleStep: 30,
    dijkstraMode: 'shortest_path',
  };

  await page.evaluate((d) => {
    const file = new File([JSON.stringify(d)], 't.json', { type: 'application/json' });
    loadJSON(file);
  }, data);
  await page.waitForTimeout(400);

  const results = [];
  const check = (n, ok, extra) => results.push({ n, ok, extra: extra ?? '' });
  const count = () => page.$eval('#info-seg-count', el => parseInt(el.textContent, 10));
  check('load: 4 segmentos', await count() === 4, 'count=' + await count());
  check('load: workspace 285x180', await page.$eval('#workspace-w', el => el.value) === '285');
  check('load: ANG ativo', await page.$eval('#btn-toggle-angle', el => el.classList.contains('active')));
  check('load: passo 30', await page.$eval('#angle-step-input', el => el.value) === '30');
  check('load: modo dijkstra default', await page.$eval('#dijkstra-mode-select', el => el.value) === 'shortest_path');

  // seleciona tudo e testa painel de seleção múltipla
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(60);
  check('selecionar tudo', (await page.$eval('#sel-type', el => el.textContent)).includes('segmentos'), await page.$eval('#sel-type', el => el.textContent));

  // saveJSON download
  let downloadOk = false;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.evaluate(() => eval('saveJSON()')),
    ]);
    downloadOk = !!dl && /lagrid-pista\.json/.test(dl.suggestedFilename());
  } catch (e) { downloadOk = false; }
  check('saveJSON gera download', downloadOk);

  // export PDF (popup + SVG com circle/polyline/arc)
  let exportOk = false, exportErr = '';
  try {
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 5000 }),
      page.click('#btn-export-pdf'),
    ]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    const html = await popup.evaluate(() => document.body.innerHTML);
    const m = html.match(/data:image\/svg\+xml;charset=utf-8,([^"]+)/);
    if (m) {
      const svg = decodeURIComponent(m[1]);
      exportOk = svg.includes('<circle') && svg.includes('<path');
    }
    await popup.close();
  } catch (e) { exportErr = e.message; }
  check('exportPDF inclui tipos novos', exportOk, exportErr);

  // versão antiga sem angleSnap e sem dijkstraMode
  await page.evaluate(() => {
    const old = {
      version: 3,
      segments: [{ id: 1, type: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], selected: false }],
      nodes: { start: null, end: null }, nextId: 2,
      workspace: { w: 200, h: 150 }, lineWidth: 1.9,
    };
    const file = new File([JSON.stringify(old)], 'old.json', { type: 'application/json' });
    loadJSON(file);
  });
  await page.waitForTimeout(300);
  check('load v3 sem campos novos', await count() === 1, 'count=' + await count());
  check('v3 mantém defaults angleStep', await page.$eval('#angle-step-input', el => el.value) === '30');
  check('v3 mantém default dijkstraMode', await page.$eval('#dijkstra-mode-select', el => el.value) === 'shortest_path');

  await page.waitForTimeout(200);
  check('sem erros de runtime', errors.length === 0, errors.join(' | '));
  console.log(JSON.stringify(results, null, 2));
  console.log('ERRORS:', errors.length ? errors : 'none');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
