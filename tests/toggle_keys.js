const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const fails = [];
  const check = (name, ok, extra = '') => {
    if (!ok) fails.push(name + (extra ? ` (${extra})` : ''));
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ` — ${extra}` : ''));
  };

  await page.goto(require('./helpers').appUrl);
  await page.waitForTimeout(300);

  // ── A) PASSO ANGULAR PADRÃO 90° ──────────────────────────
  check('A1 estado angleStep = 90',
    await page.evaluate(() => eval('state.angleStep')) === 90);
  check('A2 input de passo angular = 90',
    await page.$eval('#angle-step-input', el => el.value) === '90');
  check('A3 constante ANGLE_STEP_DEFAULT = 90',
    await page.evaluate(() => eval('ANGLE_STEP_DEFAULT')) === 90);
  check('A4 fallback da espiral continua 15',
    await page.evaluate(() => eval('SPIRAL_ANGLE_DEFAULT')) === 15 &&
    await page.$eval('#spiral-angle', el => el.value) === '15');

  // ── B) ORTHO REMOVIDO ────────────────────────────────────
  check('B1 botão ORTHO não existe', await page.locator('#btn-toggle-ortho').count() === 0);
  check('B2 estado sem orthoLock',
    await page.evaluate(() => !('orthoLock' in eval('state'))));
  check('B3 status bar sem texto ORTHO',
    !(await page.$eval('#status-right', el => el.textContent)).toUpperCase().includes('ORTHO'));
  check('B4 JSON salvo não inclui orthoLock',
    await page.evaluate(() => {
      // espiona o Blob gerado por saveJSON sem baixar o arquivo
      let captured = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = blob => { captured = blob; return orig.call(URL, blob); };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      saveJSON();
      URL.createObjectURL = orig;
      HTMLAnchorElement.prototype.click = origClick;
      return captured ? captured.text().then(t => !('orthoLock' in JSON.parse(t))) : Promise.resolve(false);
    }));

  // ── C) F1–F4 ALTERNAM OS TOGGLES ─────────────────────────
  const stateOf = key => page.evaluate(k => eval(`state.${k}`), key);
  const hasActive = id => page.$eval('#' + id, el => el.classList.contains('active'));

  await page.evaluate(() => document.activeElement && document.activeElement.blur());

  const g0 = await stateOf('showGrid');
  await page.keyboard.press('F1');
  await page.waitForTimeout(60);
  check('C1 F1 alterna GRADE',
    (await stateOf('showGrid')) === !g0 && (await hasActive('btn-toggle-grid')) === !g0);
  await page.keyboard.press('F1');

  const s0 = await stateOf('snapEnabled');
  await page.keyboard.press('F2');
  await page.waitForTimeout(60);
  check('C2 F2 alterna SNAP',
    (await stateOf('snapEnabled')) === !s0 && (await hasActive('btn-toggle-snap')) === !s0);
  await page.keyboard.press('F2');

  const a0 = await stateOf('angleSnap');
  await page.keyboard.press('F3');
  await page.waitForTimeout(60);
  check('C3 F3 alterna ANG',
    (await stateOf('angleSnap')) === !a0 && (await hasActive('btn-toggle-angle')) === !a0);
  await page.keyboard.press('F3');

  const d0 = await stateOf('distSnap');
  await page.keyboard.press('F4');
  await page.waitForTimeout(60);
  check('C4 F4 alterna DIST',
    (await stateOf('distSnap')) === !d0 && (await hasActive('btn-toggle-dist')) === !d0);
  await page.keyboard.press('F4');

  // ── D) ATALHOS FUNCIONAM COM CAMPO FOCADO ────────────────
  await page.focus('#angle-step-input');
  const a1 = await stateOf('angleSnap');
  await page.keyboard.press('F3');
  await page.waitForTimeout(60);
  check('D1 F3 funciona com input focado', (await stateOf('angleSnap')) === !a1);
  await page.keyboard.press('F3');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());

  // ── E) ATALHOS ANTIGOS NÃO COLIDEM ───────────────────────
  const gBefore = await stateOf('showGrid');
  await page.keyboard.press('g');
  await page.waitForTimeout(60);
  check('E1 G não alterna mais a grade', (await stateOf('showGrid')) === gBefore);
  const sBefore = await stateOf('snapEnabled');
  await page.keyboard.press('s');
  await page.waitForTimeout(60);
  check('E2 S não alterna mais o snap', (await stateOf('snapEnabled')) === sBefore);

  // ── F) MENU VISTA ────────────────────────────────────────
  const menuItems = await page.$$eval('.menu-dropdown [data-action]', els =>
    els.map(el => ({ action: el.dataset.action, text: el.textContent.trim() })));
  const findItem = action => menuItems.find(i => i.action === action);
  check('F1 menu Grade F1', !!findItem('toggle-grid') && findItem('toggle-grid').text.includes('F1'));
  check('F2 menu Snap F2', !!findItem('toggle-snap') && findItem('toggle-snap').text.includes('F2'));
  check('F3 menu Snap Angular F3',
    !!findItem('toggle-angle') && findItem('toggle-angle').text.includes('F3'));
  check('F4 menu Snap de Distância F4',
    !!findItem('toggle-dist') && findItem('toggle-dist').text.includes('F4'));

  // ── G) SHIFT CONTINUA TRAVANDO EM 90° ────────────────────
  const constrained = await page.evaluate(() => {
    const o = { x: 0, y: 0 };
    const p = { x: 10, y: 2 };
    eval('ui.shiftKey = true');
    const r = eval('pointFromConstraint')(o, p);
    eval('ui.shiftKey = false');
    return r;
  });
  check('G1 Shift trava o ângulo em 90°',
    Math.abs(constrained.y) < 1e-6 && constrained.x > 0,
    `x=${constrained.x.toFixed(3)} y=${constrained.y.toFixed(3)}`);

  await browser.close();
  console.log(fails.length ? `\nFALHAS: ${fails.length}\n- ` + fails.join('\n- ') : '\nTODOS OS CHECKS OK');
  process.exit(fails.length ? 1 : 0);
})();
