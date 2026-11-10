const { chromium } = require('playwright');
const url = require('./helpers').appUrl;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(url);
  await page.waitForTimeout(250);

  const results = [];
  const check = (n, ok, extra) => results.push({ n, ok, extra: extra ?? '' });
  const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

  const box = await page.locator('#main-canvas').boundingBox();
  const scr = (wx, wy) => page.evaluate(([x, y]) => eval(`w2s(${x},${y})`), [wx, wy]);
  const ppt = async (wx, wy) => { const s = await scr(wx, wy); return { x: box.x + s.x, y: box.y + s.y }; };
  const clickWorld = async (wx, wy) => { const p = await ppt(wx, wy); await page.mouse.click(p.x, p.y); await page.waitForTimeout(70); };
  const moveWorld = async (wx, wy) => { const p = await ppt(wx, wy); await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); };
  const dragWorld = async (x0, y0, x1, y1) => {
    const a = await ppt(x0, y0), b = await ppt(x1, y1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.waitForTimeout(40);
    await page.mouse.up();
    await page.waitForTimeout(80);
  };
  const segs = () => page.evaluate(() => eval(
    'state.segments.map(s => ({ id:s.id, type:s.type, points:s.points.map(p=>({x:p.x,y:p.y})), radius:s.radius }))'
  ));
  const reset = (segments = []) => page.evaluate((s) => eval(`(() => {
    state.segments = ${JSON.stringify(s)};
    state.nextId = state.segments.length ? Math.max(...state.segments.map(x => x.id)) + 1 : 1;
    state.dijkstraPath = [];
    state.nodes = { start: null, end: null };
    state.undoStack = [];
    state.redoStack = [];
    state.distSnap = false;
    state.distStep = 1;
    state.angleSnap = false;
    state.angleStep = 15;
    ui.selection.clear();
    ui.dragMove = null;
    ui.pasteMode = null;
    ui.boxSelStart = null;
    ui.snapTarget = null;
    ui.mouseWorld = { x: 0, y: 0 };
    document.getElementById('dist-step-input').value = '1';
    document.getElementById('angle-step-input').value = '15';
    document.getElementById('btn-toggle-dist').classList.remove('active');
    document.getElementById('btn-toggle-angle').classList.remove('active');
    setTool('select');
    updatePanelInfo();
    updateSelectionPanel();
    render();
  })()`), segments);

  const drawLineWorld = async (x0, y0, x1, y1) => {
    await page.evaluate(() => eval("setTool('line')"));
    await clickWorld(x0, y0);
    await clickWorld(x1, y1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
  };

  // ── A) UI E ATALHO F4 ────────────────────────────────────
  check('A1 botão DIST existe', await page.locator('#btn-toggle-dist').count() === 1);
  check('A2 input passo de distância existe',
    await page.$eval('#dist-step-input', el => el.value) === '1');
  check('A3 DIST começa desligado',
    !(await page.$eval('#btn-toggle-dist', el => el.classList.contains('active'))));
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('F4');
  await page.waitForTimeout(50);
  check('A4 F4 liga DIST', await page.evaluate(() => eval('state.distSnap === true')) &&
    await page.$eval('#btn-toggle-dist', el => el.classList.contains('active')));
  await page.keyboard.press('F4');
  await page.waitForTimeout(50);
  check('A5 F4 desliga DIST', await page.evaluate(() => eval('state.distSnap === false')));

  // ── B) LINHA: DISTÂNCIA ARREDONDADA EM CM ───────────────
  await reset();
  await page.evaluate(() => eval('state.distSnap = true; document.getElementById("btn-toggle-dist").classList.add("active"); render();'));
  // cursor a ~5.924 cm do início (-5,0): deve virar 6 cm
  await drawLineWorld(-5, 0, 0.5, 2.2);
  let s = await segs();
  let len = s.length ? Math.hypot(s[0].points[1].x - s[0].points[0].x, s[0].points[1].y - s[0].points[0].y) : -1;
  check('B1 comprimento vira múltiplo de 1 cm', near(len, 6, 0.02), 'len=' + len.toFixed(4));

  // ── C) DIST + ANG: 6 cm a 15° ───────────────────────────
  await reset();
  await page.evaluate(() => eval(`(() => {
    state.distSnap = true; state.angleSnap = true; state.angleStep = 15;
    document.getElementById('btn-toggle-dist').classList.add('active');
    document.getElementById('btn-toggle-angle').classList.add('active');
    render();
  })()`));
  await drawLineWorld(-5, 0, 0.5, 2.2); // ângulo ~21.8° → 15°
  s = await segs();
  const p0 = s[0].points[0], p1 = s[0].points[1];
  len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  let ang = Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI;
  check('C1 distância 6 cm com ângulo 15°',
    near(len, 6, 0.02) && near(ang, 15, 0.05),
    `len=${len.toFixed(3)} ang=${ang.toFixed(2)} pts=${JSON.stringify([p0, p1])}`);

  // ── D) HUD MOSTRA A DISTÂNCIA JÁ ARREDONDADA ────────────
  await reset();
  await page.evaluate(() => eval('state.distSnap = true; document.getElementById("btn-toggle-dist").classList.add("active"); setTool("line");'));
  await clickWorld(-5, 0);          // define início
  await moveWorld(-1.3, 0);         // ~3.7 cm do início
  const hudDist = await page.$eval('#polar-dist-input', el => el.value);
  check('D1 HUD polar mostra 4.00', hudDist === '4.00', 'hud=' + hudDist);
  await page.keyboard.press('Escape');

  // ── E) DESLIGADO: NÃO ARREDONDA ─────────────────────────
  await reset();
  await drawLineWorld(-5, 0, 0.5, 2.2);
  s = await segs();
  len = Math.hypot(s[0].points[1].x - s[0].points[0].x, s[0].points[1].y - s[0].points[0].y);
  check('E1 sem DIST mantém comprimento livre', near(len, 5.924, 0.15), 'len=' + len.toFixed(4));

  // ── F) PASSO CONFIGURÁVEL (0.5 cm) ──────────────────────
  await reset();
  await page.fill('#dist-step-input', '0.5');
  await page.dispatchEvent('#dist-step-input', 'change');
  await page.evaluate(() => eval('state.distSnap = true; document.getElementById("btn-toggle-dist").classList.add("active"); render();'));
  await drawLineWorld(-5, 0, -2.7, 0); // 2.3 cm → 2.5 cm
  s = await segs();
  len = Math.hypot(s[0].points[1].x - s[0].points[0].x, s[0].points[1].y - s[0].points[0].y);
  check('F1 passo 0.5 cm arredonda para 2.5', near(len, 2.5, 0.02), 'len=' + len.toFixed(4));

  // ── G) ARRASTO DE OBJETO COM DIST ───────────────────────
  await reset([{ id: 1, type: 'line', points: [{ x: -5, y: 0 }, { x: 5, y: 0 }], selected: false }]);
  await page.evaluate(() => eval('state.distSnap = true; document.getElementById("btn-toggle-dist").classList.add("active"); setTool("select"); render();'));
  await clickWorld(0, 0); // seleciona
  await dragWorld(0, 0, 2.9, 0); // deslocamento 2.9 cm → 3 cm
  s = await segs();
  check('G1 arrasto de objeto em passos de 1 cm',
    near(s[0].points[0].x, -2, 0.02) && near(s[0].points[0].y, 0, 0.02),
    JSON.stringify(s[0].points));

  // ── H) PERSISTÊNCIA ─────────────────────────────────────
  await page.evaluate(() => eval(`(() => {
    state.distSnap = true; state.distStep = 0.5;
    const data = { version: 9, segments: [], nodes: { start:null, end:null }, nextId: 1,
      workspace: { w: 285, h: 180 }, lineWidth: 1.9, angleSnap: false, angleStep: 15,
      distSnap: true, distStep: 0.5 };
    const file = new File([JSON.stringify(data)], 't.json', { type: 'application/json' });
    loadJSON(file);
  })()`));
  await page.waitForTimeout(300);
  check('H1 load restaura DIST ativo',
    await page.evaluate(() => eval('state.distSnap === true')) &&
    await page.$eval('#btn-toggle-dist', el => el.classList.contains('active')));
  check('H2 load restaura passo 0.5',
    await page.$eval('#dist-step-input', el => el.value) === '0.5' &&
    await page.evaluate(() => eval('state.distStep === 0.5')));

  // ── RESUMO ───────────────────────────────────────────────
  const ok = results.filter(r => r.ok).length;
  results.forEach(r => console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.n}${r.extra ? ' :: ' + r.extra : ''}`));
  console.log(`\nRESULT: ${ok}/${results.length} OK`);
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ERRORS: none');

  await browser.close();
  process.exit(ok === results.length && errors.length === 0 ? 0 : 1);
})();
