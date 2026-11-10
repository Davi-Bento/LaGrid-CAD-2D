const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('./helpers').appUrl;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(url);
  await page.waitForTimeout(250);

  const results = [];
  const check = (n, ok, extra) => results.push({ n, ok, extra: extra ?? '' });
  const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

  const box = await page.locator('#main-canvas').boundingBox();
  const scr = (wx, wy) => page.evaluate(([x, y]) => eval(`w2s(${x},${y})`), [wx, wy]);
  const ppt = async (wx, wy) => { const s = await scr(wx, wy); return { x: box.x + s.x, y: box.y + s.y }; };
  const clickWorld = async (wx, wy) => { const p = await ppt(wx, wy); await page.mouse.click(p.x, p.y); await page.waitForTimeout(70); };
  const segs = () => page.evaluate(() => eval(
    'state.segments.map(s => ({ id:s.id, type:s.type, points:s.points.map(p=>({x:p.x,y:p.y})), radius:s.radius, selected:s.selected }))'
  ));
  const lastSeg = async () => (await segs()).slice(-1)[0] || null;
  const count = async () => (await segs()).length;
  const setNum = async (id, v) => { await page.fill('#' + id, String(v)); };

  const reset = async () => page.evaluate(() => eval(`(() => {
    state.segments = [];
    state.nextId = 1;
    state.dijkstraPath = [];
    state.nodes = { start: null, end: null };
    state.undoStack = [];
    state.redoStack = [];
    state.snapEnabled = false;
    ui.selection.clear();
    ui.spiralAnchor = null;
    ui.spiralAnchorSet = false;
    ui.snapTarget = null;
    document.getElementById('spiral-r1').value = '2.5';
    document.getElementById('spiral-angle').value = '15';
    document.getElementById('spiral-factor').value = '1.017';
    document.getElementById('spiral-count').value = '60';
    document.getElementById('spiral-subdiv').value = '4';
    document.getElementById('spiral-start').value = '90';
    document.getElementById('spiral-tail').value = '0';
    document.getElementById('spiral-dir').value = '1';
    document.getElementById('spiral-anchor').value = 'center';
    document.getElementById('spiral-center-start').checked = false;
    setTool('select');
    updatePanelInfo();
    updateSelectionPanel();
    updateSpiralInfo();
    render();
  })()`));
  const openSpiral = async () => {
    await page.evaluate(() => eval("setTool('spiral')"));
    await page.waitForTimeout(60);
  };
  const apply = async () => {
    await page.click('#spiral-confirm-btn');
    await page.waitForTimeout(120);
  };

  const R1 = 2.5, F = 1.017, A = 15, START = 90, SUB = 4;

  // ── A) UI / ATALHO ──────────────────────────────────────
  await reset();
  check('A1 botão Espiral na toolbar', await page.locator('#tool-spiral').count() === 1);
  check('A2 entrada no menu Ferramentas', await page.locator('[data-action="tool-spiral"]').count() === 1);
  check('A3 HUD começa oculto', await page.$eval('#spiral-hud', el => el.classList.contains('hidden')));
  check('A4 defaults do HUD',
    await page.$eval('#spiral-r1', el => el.value) === '2.5' &&
    await page.$eval('#spiral-angle', el => el.value) === '15' &&
    await page.$eval('#spiral-factor', el => el.value) === '1.017' &&
    await page.$eval('#spiral-count', el => el.value) === '60' &&
    await page.$eval('#spiral-subdiv', el => el.value) === '4' &&
    await page.$eval('#spiral-start', el => el.value) === '90' &&
    await page.$eval('#spiral-tail', el => el.value) === '0' &&
    await page.$eval('#spiral-dir', el => el.value) === '1' &&
    await page.$eval('#spiral-anchor', el => el.value) === 'center' &&
    await page.$eval('#spiral-center-start', el => el.checked) === false &&
    await page.$eval('#spiral-r1-label', el => el.textContent) === 'Raio inicial R1 (cm)');

  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Shift+E');
  await page.waitForTimeout(80);
  check('A5 Shift+E ativa a ferramenta',
    await page.evaluate(() => eval('ui.tool')) === 'spiral' &&
    await page.$eval('#tool-spiral', el => el.classList.contains('active')));
  check('A6 HUD aparece com Shift+E', !(await page.$eval('#spiral-hud', el => el.classList.contains('hidden'))));
  check('A7 status mostra ESPIRAL', await page.$eval('#status-tool', el => el.textContent) === 'ESPIRAL');

  // ── B) GEOMETRIA SUAVIZADA: r=R1·F^(i/sub), θ=90°+i·A/sub ──
  await reset();
  await openSpiral();
  await setNum('spiral-cx', 0);
  await setNum('spiral-cy', 0);
  await apply();
  let s = await lastSeg();
  check('B1 cria uma polilinha', !!s && s.type === 'polyline', JSON.stringify(s && s.type));
  check('B2 subdivisão 4× gera 241 pontos', !!s && s.points.length === 241, 'n=' + (s ? s.points.length : -1));
  let geomOk = !!s;
  let geomErr = '';
  if (s) {
    for (const i of [0, 1, 40, 80, 160, 240]) {
      const p = s.points[i];
      const r = Math.hypot(p.x, p.y);
      const ang = ((Math.atan2(p.y, p.x) * 180 / Math.PI) + 360) % 360;
      const expR = R1 * Math.pow(F, i / SUB);
      const expA = ((START - i * A / SUB) % 360 + 360) % 360;
      const dA = Math.min(Math.abs(ang - expA), 360 - Math.abs(ang - expA));
      if (!near(r, expR, 0.005) || !(dA < 0.05)) {
        geomOk = false;
        geomErr = `i=${i} r=${r.toFixed(4)}/${expR.toFixed(4)} ang=${ang.toFixed(2)}/${expA.toFixed(2)}`;
        break;
      }
    }
  }
  check('B3 pontos seguem a espiral suavizada', geomOk, geomErr);
  check('B4 primeiro ponto acima do centro (θ=90° = cima)',
    !!s && near(s.points[0].x, 0) && near(s.points[0].y, R1), JSON.stringify(s && s.points[0]));

  // suavidade: incremento angular constante e fino (A/sub)
  let smoothOk = !!s;
  let smoothErr = '';
  if (s) {
    for (const i of [10, 100, 200]) {
      const a0 = Math.atan2(s.points[i - 1].y, s.points[i - 1].x);
      const a1 = Math.atan2(s.points[i].y, s.points[i].x);
      let d = ((a0 - a1) * 180 / Math.PI + 360) % 360;
      if (!near(d, A / SUB, 0.05)) { smoothOk = false; smoothErr = `i=${i} d=${d.toFixed(3)}`; break; }
    }
  }
  check('B5 incremento angular = A/4 (3.75°)', smoothOk, smoothErr);
  check('B6 raio final ≈ 6.87 cm',
    !!s && near(Math.hypot(s.points[240].x, s.points[240].y), R1 * Math.pow(F, 60), 0.005),
    'r=' + (s ? Math.hypot(s.points[240].x, s.points[240].y).toFixed(3) : '—'));
  check('B7 espiral recém-criada fica selecionada',
    await page.evaluate(() => eval('ui.selection.size === 1 && ui.selection.has(state.segments[state.segments.length-1].id)')));

  // ── C) NÃO PARAMÉTRICA ─────────────────────────────────
  const before = JSON.stringify((await lastSeg()).points);
  await setNum('spiral-r1', 9);
  await setNum('spiral-count', 12);
  await page.waitForTimeout(80);
  const after = JSON.stringify((await lastSeg()).points);
  check('C1 mudar o HUD não altera a espiral já criada', before === after);

  // ── D) REFERÊNCIA PELO CANVAS ─────────────────────────
  await reset();
  await openSpiral();
  const follow = await ppt(-10, -8);
  await page.mouse.move(follow.x, follow.y);
  await page.waitForTimeout(80);
  const fcx = parseFloat(await page.$eval('#spiral-cx', el => el.value));
  const fcy = parseFloat(await page.$eval('#spiral-cy', el => el.value));
  check('D0 referência segue o mouse antes do clique',
    near(fcx, -10, 0.5) && near(fcy, -8, 0.5), `cx=${fcx} cy=${fcy}`);
  await clickWorld(-5, -5);
  const cx = parseFloat(await page.$eval('#spiral-cx', el => el.value));
  const cy = parseFloat(await page.$eval('#spiral-cy', el => el.value));
  check('D1 clique define o centro no HUD', near(cx, -5, 0.2) && near(cy, -5, 0.2), `cx=${cx} cy=${cy}`);
  await apply();
  s = await lastSeg();
  check('D2 espiral criada no centro clicado',
    !!s && near(s.points[0].x, -5, 0.2) && near(s.points[0].y, -5 + R1, 0.02),
    JSON.stringify(s && s.points[0]));

  // ── E) CAUDA TANGENTE ──────────────────────────────────
  await reset();
  await openSpiral();
  await setNum('spiral-cx', 0);
  await setNum('spiral-cy', 0);
  await setNum('spiral-tail', 5);
  await apply();
  s = await lastSeg();
  check('E1 cauda adiciona 1 ponto', !!s && s.points.length === 242, 'n=' + (s ? s.points.length : -1));
  check('E2 cauda mede exatamente 5 cm',
    !!s && near(Math.hypot(s.points[1].x - s.points[0].x, s.points[1].y - s.points[0].y), 5, 0.005),
    s ? Math.hypot(s.points[1].x - s.points[0].x, s.points[1].y - s.points[0].y).toFixed(4) : '—');
  check('E3 cauda fica deitada (horizontal)', !!s && near(s.points[0].y, s.points[1].y, 1e-9),
    JSON.stringify(s && [s.points[0], s.points[1]]));
  let tangentOk = false, tangentAng = '';
  if (s && s.points.length >= 3) {
    const v0 = { x: s.points[1].x - s.points[0].x, y: s.points[1].y - s.points[0].y };
    const v1 = { x: s.points[2].x - s.points[1].x, y: s.points[2].y - s.points[1].y };
    const l0 = Math.hypot(v0.x, v0.y), l1 = Math.hypot(v1.x, v1.y);
    const cross = Math.abs(v0.x * v1.y - v0.y * v1.x) / (l0 * l1);
    const dot   = (v0.x * v1.x + v0.y * v1.y) / (l0 * l1);
    tangentOk = cross < 0.12 && dot > 0.99;
    tangentAng = `cross=${cross.toFixed(6)} dot=${dot.toFixed(6)}`;
  }
  check('E4 cauda continua praticamente tangente (sem 90°)', tangentOk, tangentAng);

  // Ângulo inicial 0°: cauda em pé (vertical, para cima)
  await reset();
  await openSpiral();
  await setNum('spiral-cx', 0);
  await setNum('spiral-cy', 0);
  await setNum('spiral-tail', 5);
  await setNum('spiral-start', 0);
  await apply();
  s = await lastSeg();
  check('E5 ângulo 0° deixa a cauda em pé (vertical)',
    !!s && near(s.points[0].x, s.points[1].x, 1e-9) && s.points[0].y > s.points[1].y,
    JSON.stringify(s && [s.points[0], s.points[1]]));

  // Ângulo diagonal: a cauda ainda cai em um dos eixos
  await reset();
  await openSpiral();
  await setNum('spiral-cx', 0);
  await setNum('spiral-cy', 0);
  await setNum('spiral-tail', 5);
  await setNum('spiral-start', 45);
  await apply();
  s = await lastSeg();
  check('E6 ângulo diagonal mantém a cauda no eixo (sem diagonal)',
    !!s && (near(Math.abs(s.points[0].x - s.points[1].x), 0, 1e-9) ||
            near(Math.abs(s.points[0].y - s.points[1].y), 0, 1e-9)),
    JSON.stringify(s && [s.points[0], s.points[1]]));

  // ── F) SENTIDO ─────────────────────────────────────────
  await reset();
  await openSpiral();
  await setNum('spiral-cx', 0);
  await setNum('spiral-cy', 0);
  await page.selectOption('#spiral-dir', '-1');
  await page.waitForTimeout(60);
  await apply();
  s = await lastSeg();
  const idx6 = s ? s.points[24] : null; // 6 passos * subdiv 4
  const expAng6 = ((START + 6 * A) % 360 + 360) % 360;
  const gotAng6 = idx6 ? ((Math.atan2(idx6.y, idx6.x) * 180 / Math.PI) + 360) % 360 : -1;
  const d6 = Math.min(Math.abs(gotAng6 - expAng6), 360 - Math.abs(gotAng6 - expAng6));
  check('F1 sentido anti-horário inverte θ', d6 < 0.05, `ang=${gotAng6.toFixed(2)} exp=${expAng6.toFixed(2)}`);

  // ── G) REFERÊNCIA DO PONTO DE CRIAÇÃO ──────────────────
  await reset();
  await openSpiral();
  await page.selectOption('#spiral-anchor', 'start');
  await setNum('spiral-cx', 5);
  await setNum('spiral-cy', 5);
  await page.waitForTimeout(60);
  check('G1 rótulo muda para Início X/Y',
    (await page.$eval('#spiral-cx-label', el => el.textContent)) === 'Início X (cm)' &&
    (await page.$eval('#spiral-cy-label', el => el.textContent)) === 'Início Y (cm)');
  await apply();
  s = await lastSeg();
  check('G2 início da espiral cai no ponto informado (5,5)',
    !!s && near(s.points[0].x, 5, 0.01) && near(s.points[0].y, 5, 0.01),
    JSON.stringify(s && s.points[0]));
  // centro fica 2.5 cm abaixo do início (θ=90° = cima): (5, 2.5)
  check('G3 centro derivado do início', !!s && near(s.points[0].y - R1, 2.5, 0.01),
    'centroY≈' + (s ? (s.points[0].y - R1).toFixed(2) : '—'));

  await reset();
  await openSpiral();
  await page.selectOption('#spiral-anchor', 'tail');
  await setNum('spiral-cx', -3);
  await setNum('spiral-cy', 7);
  await setNum('spiral-tail', 4);
  await page.waitForTimeout(60);
  check('G4 rótulo muda para Cauda X/Y',
    (await page.$eval('#spiral-cx-label', el => el.textContent)) === 'Cauda X (cm)');
  await apply();
  s = await lastSeg();
  check('G5 ponta da cauda cai no ponto informado (-3,7)',
    !!s && near(s.points[0].x, -3, 0.01) && near(s.points[0].y, 7, 0.01),
    JSON.stringify(s && s.points[0]));
  check('G6 espiral começa 4 cm depois da ponta',
    !!s && near(Math.hypot(s.points[1].x - s.points[0].x, s.points[1].y - s.points[0].y), 4, 0.005));

  // Cauda = 0: a ponta da cauda coincide com o início (não cai no centro)
  await reset();
  await openSpiral();
  await page.selectOption('#spiral-anchor', 'tail');
  await setNum('spiral-cx', 3);
  await setNum('spiral-cy', -2);
  await setNum('spiral-tail', 0);
  await apply();
  s = await lastSeg();
  check('G7 sem cauda, referência da ponta = início da espiral',
    !!s && near(s.points[0].x, 3, 0.01) && near(s.points[0].y, -2, 0.01),
    JSON.stringify(s && s.points[0]));

  // ── H) UNDO / REDO ─────────────────────────────────────
  await page.evaluate(() => eval('undo()'));
  await page.waitForTimeout(80);
  check('H1 undo remove a espiral', await count() === 0);
  await page.evaluate(() => eval('redo()'));
  await page.waitForTimeout(80);
  check('H2 redo restaura a espiral', await count() === 1 && !!(await lastSeg()));

  // ── I) VALIDAÇÃO ───────────────────────────────────────
  await reset();
  await openSpiral();
  await setNum('spiral-r1', 0);
  await apply();
  check('I1 R1 inválido não cria polilinha', await count() === 0);
  await setNum('spiral-r1', 2.5);
  await setNum('spiral-angle', 0);
  await apply();
  check('I2 passo angular inválido não cria polilinha', await count() === 0);
  await setNum('spiral-angle', 15);
  await setNum('spiral-factor', 0);
  await apply();
  check('I3 fator inválido não cria polilinha', await count() === 0);

  // ── J) INFO EM TEMPO REAL ──────────────────────────────
  await setNum('spiral-factor', 1.017);
  await setNum('spiral-count', 48);
  await setNum('spiral-subdiv', 4);
  await setNum('spiral-angle', 15);
  await page.waitForTimeout(60);
  const info = await page.$eval('#spiral-info', el => el.textContent);
  check('J1 info mostra 2.00 voltas e 193 pontos',
    /2\.00 volta/.test(info) && /193 pontos/.test(info), info);

  // ── K) PERSISTÊNCIA ────────────────────────────────────
  await page.evaluate(() => eval(`(() => {
    const data = {
      version: 11,
      segments: [], nodes: { start:null, end:null }, nextId: 1,
      workspace: { w: 285, h: 180 }, lineWidth: 1.9,
      angleSnap: false, angleStep: 15, distSnap: false, distStep: 1,
      spiral: { r1: 4.2, angle: 20, factor: 1.05, count: 30, subdiv: 6,
                start: 45, dir: -1, tail: 2.5, anchor: 'start', centerStart: true },
    };
    const file = new File([JSON.stringify(data)], 's.json', { type: 'application/json' });
    loadJSON(file);
  })()`));
  await page.waitForTimeout(300);
  check('K1 load restaura parâmetros da espiral',
    await page.$eval('#spiral-r1', el => el.value) === '4.2' &&
    await page.$eval('#spiral-angle', el => el.value) === '20' &&
    await page.$eval('#spiral-factor', el => el.value) === '1.05' &&
    await page.$eval('#spiral-count', el => el.value) === '30' &&
    await page.$eval('#spiral-subdiv', el => el.value) === '6' &&
    await page.$eval('#spiral-start', el => el.value) === '45' &&
    await page.$eval('#spiral-tail', el => el.value) === '2.5' &&
    await page.$eval('#spiral-dir', el => el.value) === '-1' &&
    await page.$eval('#spiral-anchor', el => el.value) === 'start' &&
    await page.$eval('#spiral-center-start', el => el.checked) === true &&
    await page.$eval('#spiral-r1-label', el => el.textContent) === 'Raio externo (cm)');

  let saved = null;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.evaluate(() => eval('saveJSON()')),
    ]);
    const out = path.join(os.tmpdir(), 'spiral_save_' + Date.now() + '.json');
    await dl.saveAs(out);
    saved = JSON.parse(fs.readFileSync(out, 'utf8'));
    fs.unlinkSync(out);
  } catch (e) { saved = null; }
  check('K2 saveJSON grava versão 11 com subdiv/âncora/centro',
    !!saved && saved.version === 11 && !!saved.spiral &&
    saved.spiral.r1 === 4.2 && saved.spiral.subdiv === 6 &&
    saved.spiral.anchor === 'start' && saved.spiral.centerStart === true,
    saved ? JSON.stringify(saved.spiral) : 'sem download');

  // ── L) ESC / CANCELAR ──────────────────────────────────
  await reset();
  await openSpiral();
  await apply();
  await page.click('#spiral-cancel-btn');
  await page.waitForTimeout(80);
  check('L1 Cancelar fecha o HUD e volta para seleção',
    await page.evaluate(() => eval('ui.tool')) === 'select' &&
    await page.$eval('#spiral-hud', el => el.classList.contains('hidden')));
  check('L2 espiral criada continua no desenho após cancelar', await count() === 1);

  // ── M) COMEÇAR NO CENTRO ───────────────────────────────
  await reset();
  await openSpiral();
  await page.check('#spiral-center-start');
  await page.waitForTimeout(80);
  const r1Out = parseFloat(await page.$eval('#spiral-r1', el => el.value));
  check('M1 ao ligar, R1 vira o raio externo (2.5 × F^60)',
    near(r1Out, 2.5 * Math.pow(1.017, 60), 0.02), 'r1=' + r1Out);
  check('M2 rótulo muda para Raio externo',
    (await page.$eval('#spiral-r1-label', el => el.textContent)) === 'Raio externo (cm)');
  await setNum('spiral-cx', 0);
  await setNum('spiral-cy', 0);
  await setNum('spiral-tail', 0);
  await apply();
  s = await lastSeg();
  check('M3 espiral começa exatamente no centro',
    !!s && near(s.points[0].x, 0, 1e-9) && near(s.points[0].y, 0, 1e-9),
    JSON.stringify(s && s.points[0]));
  check('M4 raio externo confere com o campo',
    !!s && near(Math.hypot(s.points[s.points.length - 1].x, s.points[s.points.length - 1].y), r1Out, 0.01),
    s ? Math.hypot(s.points[s.points.length - 1].x, s.points[s.points.length - 1].y).toFixed(3) : '—');

  // Cauda saindo do centro (como na foto)
  await reset();
  await openSpiral();
  await page.check('#spiral-center-start');
  await setNum('spiral-cx', 0);
  await setNum('spiral-cy', 0);
  await setNum('spiral-tail', 8);
  await setNum('spiral-start', 90);
  await apply();
  s = await lastSeg();
  check('M5 cauda sai do centro, em pé, passando por ele',
    !!s && near(s.points[1].x, 0, 1e-9) && near(s.points[1].y, 0, 1e-9) &&
    near(s.points[0].x, 0, 1e-9) && near(s.points[0].y, -8, 0.005),
    JSON.stringify(s && [s.points[0], s.points[1]]));

  // ── RESUMO ─────────────────────────────────────────────
  const ok = results.filter(r => r.ok).length;
  results.forEach(r => console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.n}${r.extra ? ' :: ' + r.extra : ''}`));
  console.log(`\nRESULT: ${ok}/${results.length} OK`);
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ERRORS: none');

  await browser.close();
  process.exit(ok === results.length && errors.length === 0 ? 0 : 1);
})();
