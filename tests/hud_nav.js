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
  const reset = async () => {
    await page.evaluate(() => eval("setTool('select')"));
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await page.waitForTimeout(40);
  };
  const open = async (tool) => {
    await page.evaluate(t => eval(`setTool('${t}')`), tool);
    await page.waitForTimeout(90);
  };
  const blur = async () => {
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await page.waitForTimeout(20);
  };
  const val = id => page.$eval('#' + id, el => el.value);
  const focused = () => page.evaluate(() => document.activeElement ? document.activeElement.id : null);
  const press = async (k, wait = 60) => { await page.keyboard.press(k); await page.waitForTimeout(wait); };

  // ── LINHA ────────────────────────────────────────────────
  await open('line');
  await blur();
  await press('5');
  check('linha: primeira tecla zera e escreve', (await val('polar-dist-input')) === '5', await val('polar-dist-input'));
  check('linha: foco vai para o parâmetro principal', (await focused()) === 'polar-dist-input', await focused());
  await page.keyboard.type('6');
  await page.waitForTimeout(60);
  check('linha: teclas seguintes continuam o valor', (await val('polar-dist-input')) === '56', await val('polar-dist-input'));

  await page.waitForTimeout(2700);
  await press('9');
  check('linha: pausa re-arma o reset', (await val('polar-dist-input')) === '9', await val('polar-dist-input'));

  await press('Tab');
  check('linha: Tab vai para o ângulo', (await focused()) === 'polar-angle-input', await focused());
  await press('Tab');
  check('linha: Tab dá a volta nos parâmetros', (await focused()) === 'polar-start-x-input', await focused());

  await blur();
  await press('Control+Tab', 120);
  check('linha: Ctrl+Tab alterna para absolutas',
    await page.evaluate(() => document.getElementById('polar-mode-select').value === 'absolute' && ui.polarInputMode === 'absolute'));
  await press('Control+Tab', 120);
  check('linha: Ctrl+Tab volta para polar',
    await page.evaluate(() => document.getElementById('polar-mode-select').value === 'polar' && ui.polarInputMode === 'polar'));

  // ── CÍRCULO ──────────────────────────────────────────────
  await open('circle');
  await page.waitForTimeout(60);
  await press('3');
  check('círculo: primeira tecla zera o diâmetro', (await val('circle-diameter-input')) === '3', await val('circle-diameter-input'));

  await press('Control+Tab', 140);
  check('círculo: Ctrl+Tab alterna para 4 lados',
    await page.evaluate(() => ui.circleMode === 'side' && document.getElementById('circle-mode-select').value === 'side'));
  check('círculo: foco acompanha a aba visível', (await focused()) === 'circle-diameter-input-side', await focused());
  await press('4');
  check('círculo: diâmetro do modo 4 lados recebe a tecla', (await val('circle-diameter-input-side')) === '4', await val('circle-diameter-input-side'));

  await press('Control+Tab', 140);
  check('círculo: Ctrl+Tab volta ao centro', await page.evaluate(() => ui.circleMode === 'center'));
  check('círculo: foco volta ao diâmetro do centro', (await focused()) === 'circle-diameter-input', await focused());
  await press('Tab');
  check('círculo: Tab vai do diâmetro para o centro X', (await focused()) === 'circle-cx-input', await focused());

  // ── ESPIRAL ──────────────────────────────────────────────
  await open('spiral');
  await blur();
  await press('7');
  check('espiral: primeira tecla zera a referência X', (await val('spiral-cx')) === '7', await val('spiral-cx'));
  await page.waitForTimeout(2700);
  await press('8');
  check('espiral: pausa re-arma o reset', (await val('spiral-cx')) === '8', await val('spiral-cx'));
  await press('Tab');
  check('espiral: Tab vai para a referência Y', (await focused()) === 'spiral-cy', await focused());

  await press('Control+Tab', 120);
  check('espiral: Ctrl+Tab muda a referência para Início',
    (await val('spiral-anchor')) === 'start', await val('spiral-anchor'));
  await press('Control+Tab', 120);
  check('espiral: Ctrl+Tab segue para a Cauda', (await val('spiral-anchor')) === 'tail', await val('spiral-anchor'));

  // ── FILLET ───────────────────────────────────────────────
  await open('fillet');
  await blur();
  await press('1');
  check('fillet: primeira tecla zera o raio', (await val('fillet-radius')) === '1', await val('fillet-radius'));

  // ── OFFSET ───────────────────────────────────────────────
  await open('offset');
  await blur();
  await press('2');
  check('offset: primeira tecla zera a distância', (await val('offset-dist')) === '2', await val('offset-dist'));
  await page.waitForTimeout(2700);
  await press('6');
  check('offset: pausa re-arma o reset', (await val('offset-dist')) === '6', await val('offset-dist'));

  // ── ROTATE / SCALE / ARRAY ───────────────────────────────
  await open('rotate');
  await blur();
  await press('4');
  check('rotate: primeira tecla zera o ângulo', (await val('rotate-angle')) === '4', await val('rotate-angle'));

  await open('scale');
  await blur();
  await press('3');
  check('scale: primeira tecla zera o fator', (await val('scale-factor')) === '3', await val('scale-factor'));

  await open('array');
  await blur();
  await press('2');
  check('array: primeira tecla zera as cópias', (await val('array-count')) === '2', await val('array-count'));
  await press('Tab');
  check('array: Tab vai para DX', (await focused()) === 'array-dx', await focused());
  await press('5');
  check('array: DX zera o valor padrão na primeira tecla', (await val('array-dx')) === '5', await val('array-dx'));

  // ── COORDENADAS ──────────────────────────────────────────
  await reset();
  await page.evaluate(() => eval('showCoordHud()'));
  await page.waitForTimeout(80);
  await press('1');
  check('coordenadas: primeira tecla zera o X', (await val('coord-x-input')) === '1', await val('coord-x-input'));
  await press('Control+Tab', 120);
  check('coordenadas: Ctrl+Tab alterna para relativa',
    await page.evaluate(() => document.getElementById('coord-mode').value === 'rel' && ui.coordMode === 'rel'));
  await press('Tab');
  check('coordenadas: Tab vai para Y', (await focused()) === 'coord-y-input', await focused());

  // ── MOVER ────────────────────────────────────────────────
  await reset();
  await page.evaluate(() => document.getElementById('move-hud').classList.remove('hidden'));
  await blur();
  await press('5');
  check('mover: primeira tecla zera a distância', (await val('move-dist-input')) === '5', await val('move-dist-input'));
  await press('Tab');
  check('mover: Tab vai para o ângulo', (await focused()) === 'move-angle-input', await focused());
  await press('2');
  check('mover: ângulo zera o valor padrão na primeira tecla', (await val('move-angle-input')) === '2', await val('move-angle-input'));

  await reset();
  check('sem erros de runtime', errors.length === 0, errors.join(' | '));

  console.log(JSON.stringify(results, null, 2));
  const fails = results.filter(r => !r.ok);
  console.log('RESULT:', (results.length - fails.length) + '/' + results.length, 'OK');
  console.log('ERRORS:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
