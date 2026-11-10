const { chromium } = require('playwright');
const url = require('./helpers').appUrl;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(url);
  await page.waitForTimeout(300);

  const results = [];
  const check = (n, ok, extra) => results.push({ n, ok, extra: extra ?? '' });
  const box = await page.locator('#main-canvas').boundingBox();

  // Intercepta os moveTo usados por drawGridLines para medir a posição
  // real (em cm) de cada linha da grade, sem depender de pixels.
  const gridWorld = (cellPx) => page.evaluate((cell) => eval(`(() => {
    const orig = ctx.moveTo.bind(ctx);
    const xs = [], ys = [];
    ctx.moveTo = (x, y) => { if (y === 0) xs.push(x); if (x === 0) ys.push(y); orig(x, y); };
    drawGridLines(${cell});
    ctx.moveTo = orig;
    return {
      xs: xs.map(x => (x - cam.x) / (37.795 * cam.scale)),
      ys: ys.map(y => (y - cam.y) / (37.795 * cam.scale)),
      cam: { x: cam.x, y: cam.y, scale: cam.scale },
    };
  })()`), cellPx);

  const nearInt = (v, eps = 0.02) => Math.abs(v - Math.round(v)) <= eps;
  const badValues = (vals, test) => vals.filter(v => !test(v)).slice(0, 5)
    .map(v => Number(v.toFixed(3)));

  const minorPx = await page.evaluate(() => eval('cm2px(1)'));
  const majorPx = await page.evaluate(() => eval('cm2px(10)'));

  // ── A) ESTADO INICIAL: reticulado ancorado ao mundo ─────
  const g0 = await gridWorld(minorPx);
  const badMinor0 = badValues(g0.xs, v => nearInt(v));
  const badMinor0y = badValues(g0.ys, v => nearInt(v));
  check('A1 linhas de 1 cm em coordenadas inteiras',
    g0.xs.length > 5 && g0.ys.length > 5 && badMinor0.length === 0 && badMinor0y.length === 0,
    `x=${g0.xs.length}/${JSON.stringify(badMinor0)} y=${g0.ys.length}/${JSON.stringify(badMinor0y)}`);

  const gm0 = await page.evaluate((cell) => eval(`(() => {
    const orig = ctx.moveTo.bind(ctx);
    const xs = [];
    ctx.moveTo = (x, y) => { if (y === 0) xs.push(x); orig(x, y); };
    drawGridLines(${cell});
    ctx.moveTo = orig;
    return xs.map(x => (x - cam.x) / (37.795 * cam.scale));
  })()`), majorPx);
  const badMajor0 = badValues(gm0, v => nearInt(v / 10));
  check('A2 linhas de 10 cm em múltiplos de 10',
    gm0.length >= 2 && badMajor0.length === 0,
    `n=${gm0.length} fora=${JSON.stringify(badMajor0)}`);

  // ── B) PAN: a grade não pode deslizar em relação ao mundo ─
  await page.mouse.move(box.x + 600, box.y + 300);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + 733, box.y + 361, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(120);
  const g1 = await gridWorld(minorPx);
  const badMinor1 = badValues(g1.xs, v => nearInt(v));
  const badMinor1y = badValues(g1.ys, v => nearInt(v));
  check('B1 pan realmente moveu a câmera',
    g1.cam.x !== g0.cam.x || g1.cam.y !== g0.cam.y,
    `cam0=${JSON.stringify(g0.cam)} cam1=${JSON.stringify(g1.cam)}`);
  check('B2 após pan as linhas continuam em cm inteiros',
    g1.xs.length > 5 && g1.ys.length > 5 && badMinor1.length === 0 && badMinor1y.length === 0,
    `x=${g1.xs.length}/${JSON.stringify(badMinor1)} y=${g1.ys.length}/${JSON.stringify(badMinor1y)}`);

  // ── C) ZOOM: mesma âncora de mundo ──────────────────────
  await page.mouse.move(box.x + 500, box.y + 400);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(120);
  const minorPx2 = await page.evaluate(() => eval('cm2px(1)'));
  const g2 = await gridWorld(minorPx2);
  const badMinor2 = badValues(g2.xs, v => nearInt(v));
  const badMinor2y = badValues(g2.ys, v => nearInt(v));
  check('C1 após zoom as linhas continuam em cm inteiros',
    g2.xs.length > 5 && g2.ys.length > 5 && badMinor2.length === 0 && badMinor2y.length === 0,
    `x=${g2.xs.length}/${JSON.stringify(badMinor2)} y=${g2.ys.length}/${JSON.stringify(badMinor2y)}`);

  // ── D) MINOR E MAJOR ALINHADAS ──────────────────────────
  // Cada linha de 10 cm deve coincidir com uma linha de 1 cm.
  const minorSet = new Set(g0.xs.map(v => Math.round(v)));
  const majorAligned = gm0.every(v => minorSet.has(Math.round(v)));
  check('D1 grade de 10 cm alinhada com a de 1 cm', majorAligned,
    `major=${JSON.stringify(gm0.map(v => Number(v.toFixed(2))))}`);

  // ── RESUMO ───────────────────────────────────────────────
  const ok = results.filter(r => r.ok).length;
  results.forEach(r => console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.n}${r.extra ? ' :: ' + r.extra : ''}`));
  console.log(`\nRESULT: ${ok}/${results.length} OK`);
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ERRORS: none');

  await browser.close();
  process.exit(ok === results.length && errors.length === 0 ? 0 : 1);
})();
