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

  const results = [];
  const check = (n, ok, extra) => results.push({ n, ok, extra: extra ?? '' });
  const dzCount = () => page.$eval('#info-dz-count', el => parseInt(el.textContent, 10));

  check('workspace padrão 285', await page.$eval('#workspace-w', el => el.value) === '285');
  check('workspace padrão 180', await page.$eval('#workspace-h', el => el.value) === '180');
  check('deadzone padrão 30', await page.$eval('#deadzone-input', el => el.value) === '30');
  check('deadzone sem pista = 0', await dzCount() === 0, 'count=' + await dzCount());

  // Linha no centro da área segura: 285x180, deadzone 30 -> seguro 30..255 / 30..150
  await page.evaluate(() => {
    state.segments = [
      { id: 1, type: 'line', points: [{ x: 80, y: 80 }, { x: 150, y: 80 }], selected: false },
    ];
    state.nextId = 2;
    render();
  });
  await page.waitForTimeout(80);
  check('linha segura = 0 alertas', await dzCount() === 0, 'count=' + await dzCount());

  // Linha dentro da deadzone (x=15 < 30)
  await page.evaluate(() => {
    state.segments = [
      { id: 1, type: 'line', points: [{ x: 15, y: 80 }, { x: 100, y: 80 }], selected: false },
    ];
    state.nextId = 2;
    render();
  });
  await page.waitForTimeout(80);
  check('linha na deadzone = 1 alerta', await dzCount() === 1, 'count=' + await dzCount());

  // Muda deadzone para 10 e a mesma linha fica segura
  await page.fill('#deadzone-input', '10');
  await page.dispatchEvent('#deadzone-input', 'change');
  await page.waitForTimeout(80);
  check('deadzone 10 aplicada', await page.$eval('#deadzone-input', el => el.value) === '10');
  check('linha x=15 segura com dz=10', await dzCount() === 0, 'count=' + await dzCount());

  // Círculo que cruza a borda da deadzone
  await page.evaluate(() => {
    state.segments = [
      { id: 1, type: 'circle', points: [{ x: 25, y: 90 }], radius: 20, selected: false },
    ];
    state.nextId = 2;
    render();
  });
  await page.waitForTimeout(80);
  check('círculo na deadzone = 1 alerta', await dzCount() === 1, 'count=' + await dzCount());

  // Aplicar workspace com deadzone válida
  await page.fill('#workspace-w', '300');
  await page.fill('#workspace-h', '200');
  await page.fill('#deadzone-input', '25');
  await page.click('#btn-apply-workspace');
  await page.waitForTimeout(80);
  check('workspace aplicado 300x200', await page.$eval('#workspace-w', el => el.value) === '300');
  check('deadzone aplicada 25', await page.$eval('#deadzone-input', el => el.value) === '25');

  // Deadzone inválida (maior que metade da menor dimensão) não aplica
  await page.fill('#deadzone-input', '150');
  await page.dispatchEvent('#deadzone-input', 'change');
  await page.waitForTimeout(80);
  check('deadzone inválida revertida', await page.$eval('#deadzone-input', el => el.value) === '25');

  // Load v5 com deadzone
  await page.evaluate(() => {
    const d = {
      version: 5,
      segments: [{ id: 1, type: 'line', points: [{ x: 50, y: 50 }, { x: 100, y: 50 }], selected: false }],
      nodes: { start: null, end: null },
      nextId: 2,
      workspace: { w: 285, h: 180 },
      deadzone: 12,
      lineWidth: 1.9,
      angleSnap: false,
      angleStep: 15,
    };
    const file = new File([JSON.stringify(d)], 'dz.json', { type: 'application/json' });
    loadJSON(file);
  });
  await page.waitForTimeout(300);
  check('load: deadzone 12', await page.$eval('#deadzone-input', el => el.value) === '12');
  check('load: linha segura com dz=12', await dzCount() === 0, 'count=' + await dzCount());

  // Novo projeto volta ao padrão
  await page.evaluate(() => { window.confirm = () => true; newProject(); });
  await page.waitForTimeout(100);
  check('novo projeto: workspace 285', await page.$eval('#workspace-w', el => el.value) === '285');
  check('novo projeto: deadzone 30', await page.$eval('#deadzone-input', el => el.value) === '30');

  await page.waitForTimeout(100);
  check('sem erros de runtime', errors.length === 0, errors.join(' | '));
  console.log(JSON.stringify(results, null, 2));
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  const failed = results.filter(r => !r.ok).length;
  console.log(`RESULT: ${results.length - failed}/${results.length} OK`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
