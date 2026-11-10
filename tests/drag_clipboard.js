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

  const box = await page.locator('#main-canvas').boundingBox();
  const scr = (wx, wy) => page.evaluate(([x, y]) => eval(`w2s(${x},${y})`), [wx, wy]);
  const ppt = async (wx, wy) => { const s = await scr(wx, wy); return { x: box.x + s.x, y: box.y + s.y }; };
  const clickWorld = async (wx, wy) => { const p = await ppt(wx, wy); await page.mouse.click(p.x, p.y); await page.waitForTimeout(70); };
  const moveWorld = async (wx, wy) => { const p = await ppt(wx, wy); await page.mouse.move(p.x, p.y); await page.waitForTimeout(40); };
  const dragWorld = async (x0, y0, x1, y1) => {
    const a = await ppt(x0, y0), b = await ppt(x1, y1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.waitForTimeout(40);
    await page.mouse.up();
    await page.waitForTimeout(80);
  };
  const count = () => page.$eval('#info-seg-count', el => parseInt(el.textContent, 10));
  const segs = () => page.evaluate(() => eval(
    'state.segments.map(s => ({ id:s.id, type:s.type, points:s.points.map(p=>({x:p.x,y:p.y})), radius:s.radius, originalCircle:s.originalCircle ? { c:{x:s.originalCircle.c.x,y:s.originalCircle.c.y}, r:s.originalCircle.r } : null }))'
  ));
  const info = () => page.evaluate(() => eval(
    '({ undo: state.undoStack.length, sel: [...ui.selection], drag: !!ui.dragMove, paste: !!ui.pasteMode, clip: ui.clipboard ? ui.clipboard.segs.length : 0, status: document.getElementById("status-sel").textContent })'
  ));
  const reset = (segments, nextId) => page.evaluate(([s, n]) => eval(`(() => {
    state.segments = ${JSON.stringify(s)};
    state.nextId = ${n};
    state.dijkstraPath = [];
    state.nodes = { start: null, end: null };
    state.undoStack = [];
    state.redoStack = [];
    ui.selection.clear();
    ui.dragMove = null;
    ui.pasteMode = null;
    ui.clipboard = null;
    ui.snapTarget = null;
    ui.mouseWorld = { x: 0, y: 0 };
    ui.boxSelStart = null;
    cam.scale = 1;
    cam.x = canvas.width / 2;
    cam.y = canvas.height / 2;
    setTool('select');
    updatePanelInfo();
    updateSelectionPanel();
    render();
  })()`), [segments, nextId]);

  const near = (a, b, eps = 0.25) => Math.abs(a - b) <= eps;

  // ── A) ARRASTAR OBJETO JÁ SELECIONADO ────────────────────
  await reset([{ id: 1, type: 'line', points: [{ x: -5, y: 0 }, { x: 5, y: 0 }], selected: false }], 2);
  await clickWorld(0, 0);
  check('A1 clique seleciona linha', (await info()).sel.length === 1);
  await clickWorld(0, 0); // clique sem mover: não deve mover nem criar undo
  check('A2 clique sem mover não altera', (await info()).undo === 0 && (await segs())[0].points[0].x === -5);

  await dragWorld(0, 0, 2, 2);
  let s = await segs();
  let inf = await info();
  check('A3 arrasto moveu +2/+2', near(s[0].points[0].x, -3) && near(s[0].points[0].y, 2) &&
        near(s[0].points[1].x, 7) && near(s[0].points[1].y, 2),
        JSON.stringify(s[0].points));
  check('A4 seleção não mudou', inf.sel.length === 1 && inf.sel[0] === 1);
  check('A5 um único passo de undo', inf.undo === 1, 'undo=' + inf.undo);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(90);
  s = await segs();
  check('A6 Ctrl+Z desfaz o arrasto', near(s[0].points[0].x, -5) && near(s[0].points[0].y, 0), JSON.stringify(s[0].points));

  // ── B) CLIQUE EM OBJETO NÃO SELECIONADO NÃO MOVE ─────────
  await reset([
    { id: 1, type: 'line', points: [{ x: -5, y: 0 }, { x: 5, y: 0 }], selected: false },
    { id: 2, type: 'line', points: [{ x: 0, y: -5 }, { x: 0, y: 5 }], selected: false },
  ], 3);
  await clickWorld(-3, 0); // seleciona A
  await dragWorld(0, -4, 3, -4); // começa em B (não selecionada) e arrasta
  s = await segs();
  inf = await info();
  check('B1 objeto não selecionado não move', near(s[1].points[0].x, 0) && near(s[1].points[0].y, -5), JSON.stringify(s[1].points));
  check('B2 clique selecionou apenas B', inf.sel.length === 1 && inf.sel[0] === 2, JSON.stringify(inf.sel));
  check('B3 sem undo espúrio', inf.undo === 0, 'undo=' + inf.undo);

  // ── C) ESC CANCELA ARRASTO ───────────────────────────────
  {
    const a = await ppt(0, -4), b = await ppt(3, -4);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.waitForTimeout(40);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(80);
  }
  s = await segs();
  inf = await info();
  check('C1 Esc restaura posição', near(s[1].points[0].x, 0) && near(s[1].points[0].y, -5), JSON.stringify(s[1].points));
  check('C2 Esc remove estado de arrasto', inf.drag === false);
  check('C3 Esc não deixa undo', inf.undo === 0, 'undo=' + inf.undo);

  // ── D) CTRL+C / CTRL+V COM CLIQUE ────────────────────────
  await clickWorld(-3, 0); // seleciona A
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(60);
  inf = await info();
  check('D1 Ctrl+C guarda 1 objeto', inf.clip === 1, 'clip=' + inf.clip);
  check('D2 Ctrl+C não altera cena', (await count()) === 2);

  await moveWorld(2, 4);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(60);
  check('D3 Ctrl+V entra em modo colocação', (await info()).paste === true);
  await moveWorld(3, 5);
  await clickWorld(3, 5);
  await page.waitForTimeout(80);
  s = await segs();
  inf = await info();
  const pasted = s.find(x => x.id === 3);
  check('D4 clique confirma colagem (novo id)', !!pasted, JSON.stringify(s.map(x => x.id)));
  check('D5 cópia deslocada para o cursor',
    pasted && near((pasted.points[0].x + pasted.points[1].x) / 2, 3) &&
    near((pasted.points[0].y + pasted.points[1].y) / 2, 5),
    pasted ? JSON.stringify(pasted.points) : 'sem cópia');
  check('D6 cópia fica selecionada', inf.sel.length === 1 && inf.sel[0] === 3, JSON.stringify(inf.sel));
  check('D7 modo colocação encerrado', inf.paste === false && inf.undo === 1, 'paste=' + inf.paste + ' undo=' + inf.undo);

  // ── E) ENTER CONFIRMA NO CURSOR ──────────────────────────
  await moveWorld(-4, -2);
  await page.keyboard.press('Control+v');
  await moveWorld(-4, -2);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  s = await segs();
  const pasted2 = s.find(x => x.id === 4);
  check('E1 Enter cola no cursor',
    pasted2 && near((pasted2.points[0].x + pasted2.points[1].x) / 2, -4) &&
    near((pasted2.points[0].y + pasted2.points[1].y) / 2, -2),
    pasted2 ? JSON.stringify(pasted2.points) : 'sem cópia');
  check('E2 Enter encerra colocação', (await info()).paste === false);

  // ── F) ESC CANCELA COLAGEM ───────────────────────────────
  const beforeEsc = await count();
  await page.keyboard.press('Control+v');
  await moveWorld(5, 5);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  inf = await info();
  check('F1 Esc cancela colagem', inf.paste === false);
  check('F2 Esc não cria objeto', (await count()) === beforeEsc);
  check('F3 Esc não limpa o clipboard', inf.clip === 1, 'clip=' + inf.clip);

  // ── G) CTRL+C/V IGNORADOS EM INPUT ───────────────────────
  await page.evaluate(() => document.getElementById('line-width-input').focus());
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(60);
  inf = await info();
  check('G1 Ctrl+V em input não cola', inf.paste === false && (await count()) === beforeEsc);
  await page.evaluate(() => document.activeElement.blur());

  // ── H) CÍRCULO: CÓPIA PRESERVA RAIO ──────────────────────
  await reset([{ id: 1, type: 'circle', points: [{ x: 0, y: 0 }], radius: 3, selected: false }], 2);
  await clickWorld(3, 0); // borda do círculo
  check('H1 clique na borda seleciona círculo', (await info()).sel.length === 1);
  await page.keyboard.press('Control+c');
  await moveWorld(0, 8);
  await page.keyboard.press('Control+v');
  await moveWorld(0, 8);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  s = await segs();
  const c2 = s.find(x => x.id === 2);
  check('H2 círculo colado preserva raio e centro',
    c2 && c2.type === 'circle' && near(c2.radius, 3) && near(c2.points[0].x, 0) && near(c2.points[0].y, 8),
    c2 ? JSON.stringify({ r: c2.radius, c: c2.points[0] }) : 'sem cópia');

  // ── I) ARCO APARADO: ORIGINALCIRCLE ACOMPANHA ────────────
  await reset([
    { id: 1, type: 'circle', points: [{ x: 0, y: 0 }], radius: 5, selected: false },
    { id: 2, type: 'line', points: [{ x: -10, y: 0 }, { x: 10, y: 0 }], selected: false },
  ], 3);
  const arcInfo = await page.evaluate(() => eval(`(() => {
    trimClick(0, 5);
    const arc = state.segments[0];
    ui.selection.clear(); ui.selection.add(arc.id);
    copySelection();
    startPasteMode();
    const a = ui.pasteMode.anchor;
    ui.pasteMode.position = { x: a.x + 10, y: a.y + 10 };
    commitPaste();
    const created = state.segments.find(x => x.id !== 1 && x.id !== 2);
    return {
      type: created.type,
      oc: created.originalCircle ? { c: { x: created.originalCircle.c.x, y: created.originalCircle.c.y }, r: created.originalCircle.r } : null,
      mid: created.points[1],
      n: state.segments.length,
    };
  })()`));
  check('I1 trim gerou arco com originalCircle', arcInfo.type === 'arc' && !!arcInfo.oc, JSON.stringify(arcInfo));
  check('I2 colagem move originalCircle junto',
    arcInfo.oc && near(arcInfo.oc.c.x, 10) && near(arcInfo.oc.c.y, 10) && near(arcInfo.oc.r, 5) && arcInfo.n === 3,
    JSON.stringify(arcInfo.oc));

  // ── J) ARRASTO COM ÍMÃ MAGNÉTICO ────────────────────────
  await reset([
    { id: 1, type: 'line', points: [{ x: -5, y: 0 }, { x: 5, y: 0 }], selected: false },
    { id: 2, type: 'line', points: [{ x: 0, y: -5 }, { x: 0, y: 5 }], selected: false },
  ], 3);
  await clickWorld(-3, 0); // seleciona A
  await dragWorld(-5, 0, 0.2, 5.2); // cursor perto do endpoint (0,5) de B
  s = await segs();
  check('J1 arrasto encaixa no ímã de outro objeto',
    near(s[0].points[0].x, 0, 0.01) && near(s[0].points[0].y, 5, 0.01),
    JSON.stringify(s[0].points));

  // ── K) ÍMÃ IGNORA OS PRÓPRIOS PONTOS ARRASTADOS ─────────
  await reset([{ id: 1, type: 'line', points: [{ x: -5, y: 0 }, { x: 5, y: 0 }], selected: false }], 2);
  await clickWorld(0, 0); // seleciona
  await dragWorld(-5, 0, 5.2, 0.2); // cursor perto do outro endpoint da MESMA linha
  s = await segs();
  check('K1 não encaixa nos próprios vértices',
    near(s[0].points[0].x, 5.2, 0.15) && near(s[0].points[0].y, 0.2, 0.15),
    JSON.stringify(s[0].points));

  // ── L) ARRASTO COM MÚLTIPLOS SELECIONADOS ───────────────
  await reset([
    { id: 1, type: 'line', points: [{ x: -5, y: 0 }, { x: 5, y: 0 }], selected: false },
    { id: 2, type: 'line', points: [{ x: 0, y: -5 }, { x: 0, y: 5 }], selected: false },
  ], 3);
  await clickWorld(-3, 0);              // seleciona A
  await page.keyboard.down('Control');
  await clickWorld(0, -4);              // Ctrl+clique adiciona B
  await page.keyboard.up('Control');
  check('L1 dois objetos selecionados', (await info()).sel.length === 2);
  await dragWorld(-3, 0, -1, 2);        // arrasta A (já selecionada)
  s = await segs();
  inf = await info();
  check('L2 ambos moveram +2/+2',
    near(s[0].points[0].x, -3) && near(s[0].points[0].y, 2) &&
    near(s[1].points[0].x, 2) && near(s[1].points[0].y, -3),
    JSON.stringify(s.map(x => x.points[0])));
  check('L3 seleção múltipla preservada', inf.sel.length === 2, JSON.stringify(inf.sel));

  // ── M) NÓS INÍCIO/CHEGADA ACOMPANHAM O ARRASTO ──────────
  await reset([{ id: 1, type: 'line', points: [{ x: -5, y: 0 }, { x: 5, y: 0 }], selected: false }], 2);
  await page.evaluate(() => eval(`(() => {
    state.nodes.start = { x: -5, y: 0, segId: 1, t: 0 };
    state.nodes.end   = { x:  5, y: 0, segId: 1, t: 1 };
    updateDijkstraPanel();
    render();
  })()`));
  await clickWorld(0, 0);
  await dragWorld(0, 0, 2, 2);
  const nodes = await page.evaluate(() => eval('({ s: { ...state.nodes.start }, e: { ...state.nodes.end } })'));
  check('M1 nós acompanham o movimento',
    near(nodes.s.x, -3) && near(nodes.s.y, 2) && near(nodes.e.x, 7) && near(nodes.e.y, 2),
    JSON.stringify(nodes));

  // ── RESUMO ───────────────────────────────────────────────
  const ok = results.filter(r => r.ok).length;
  results.forEach(r => console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.n}${r.extra ? ' :: ' + r.extra : ''}`));
  console.log(`\nRESULT: ${ok}/${results.length} OK`);
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ERRORS: none');

  await browser.close();
  process.exit(ok === results.length && errors.length === 0 ? 0 : 1);
})();
