const { chromium } = require('playwright');
const fs = require('fs');
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
  const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

  const box = await page.locator('#main-canvas').boundingBox();
  const ppt = async (wx, wy) => {
    const s = await page.evaluate(([x, y]) => eval(`w2s(${x},${y})`), [wx, wy]);
    return { x: box.x + s.x, y: box.y + s.y };
  };
  const clickWorld = async (wx, wy) => {
    const p = await ppt(wx, wy);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(120);
  };
  const segs = () => page.evaluate(() => state.segments.map(s => ({
    id: s.id, type: s.type, points: s.points.map(p => ({ x: p.x, y: p.y })), radius: s.radius,
  })));
  const count = async () => (await segs()).length;
  const bbox = async () => page.evaluate(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of state.segments) s.points.forEach(p => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    });
    if (!isFinite(minX)) return null;
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
  });
  const reset = async () => page.evaluate(() => eval(`(() => {
    state.segments = [];
    state.nextId = 1;
    state.dijkstraPath = [];
    state.nodes = { start: null, end: null };
    state.undoStack = [];
    state.redoStack = [];
    state.snapEnabled = false;
    ui.selection.clear();
    ui.pasteMode = null;
    ui.pasteLabel = null;
    ui.snapTarget = null;
    closeCurveLibrary();
    cam.scale = 1;
    cam.x = canvas.width / 2;
    cam.y = canvas.height / 2;
    setTool('select');
    document.getElementById('curve-library-scale').value = '1.0';
    updatePanelInfo();
    updateSelectionPanel();
    render();
  })()`));
  const open = async () => { await page.click('#btn-curve-library'); await page.waitForTimeout(120); };
  const choose = async (id) => { await page.click(`.lib-card[data-curve="${id}"]`); await page.waitForTimeout(120); };
  const isHidden = () => page.$eval('#curve-library', el => el.classList.contains('hidden'));

  // ── A) JANELA / ENTRADAS ───────────────────────────────
  check('A1 botão Biblioteca na toolbar', await page.$( '#btn-curve-library') !== null);
  check('A2 entrada no menu Ferramentas',
    await page.$('[data-action="curve-library"]') !== null);
  check('A3 janela começa oculta', await isHidden());
  check('A4 escala padrão 1.0',
    (await page.$eval('#curve-library-scale', el => el.value)) === '1.0');

  await open();
  check('A5 botão abre a janela', !(await isHidden()));
  check('A6 janela mostra 10 curvas',
    (await page.$$('.lib-card')).length === 10,
    String((await page.$$('.lib-card')).length));

  await page.click('#curve-library-close');
  await page.waitForTimeout(80);
  check('A7 botão X fecha a janela', await isHidden());

  await open();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  check('A8 Esc fecha a janela', await isHidden());

  await page.evaluate(() => document.querySelector('[data-action="curve-library"]').click());
  await page.waitForTimeout(100);
  check('A9 menu Ferramentas abre a janela', !(await isHidden()));

  check('A10 miniaturas têm traço desenhado',
    await page.$$eval('.lib-thumb', canvases => canvases.every(cv => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    })));

  // ── B) CONTEÚDO DA BIBLIOTECA ──────────────────────────
  const lib = await page.evaluate(() => TRACK_LIBRARY.map(item => {
    const s = item.build();
    let arcOk = true, contOk = true, maxGap = 0;
    for (const seg of s) if (seg.type === 'arc' && !arcGeometry(seg)) arcOk = false;
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i].points[s[i].points.length - 1];
      const b = s[i + 1].points[0];
      const gap = Math.hypot(a.x - b.x, a.y - b.y);
      maxGap = Math.max(maxGap, gap);
      if (gap > 1e-6) contOk = false;
    }
    return {
      id: item.id, name: item.name, track: item.track,
      n: s.length, types: [...new Set(s.map(x => x.type))],
      arcOk, contOk, maxGap, pointsOk: s.every(x => x.points.length >= 2 &&
        x.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))),
    };
  }));
  check('B1 biblioteca tem 10 curvas', lib.length === 10);
  check('B2 nomes e pistas preenchidos',
    lib.every(i => i.name.length > 2 && i.track.length > 2));
  check('B3 todas usam apenas linhas e arcos',
    lib.every(i => i.types.every(t => t === 'line' || t === 'arc')),
    lib.map(i => i.id + ':' + i.types.join('/')).join(' '));
  check('B4 todas têm pelo menos um arco e uma linha',
    lib.every(i => i.types.includes('arc') && i.types.includes('line')));
  check('B5 arcos com geometria válida', lib.every(i => i.arcOk));
  check('B6 trechos encaixados sem fresta', lib.every(i => i.contOk && i.maxGap < 1e-9),
    lib.map(i => i.id + ':' + i.maxGap).join(' '));
  check('B7 pontos numéricos em todas as curvas', lib.every(i => i.pointsOk));

  // ── C) INSERÇÃO ────────────────────────────────────────
  await reset();
  await open();
  await choose('hairpin-loews');
  check('C1 escolher a curva fecha a janela', await isHidden());
  check('C2 modo de posicionamento ativo',
    await page.evaluate(() => !!ui.pasteMode && ui.pasteLabel === 'Hairpin Loews'));

  await clickWorld(0, 0);
  let s = await segs();
  check('C3 inseriu os 3 trechos do hairpin', s.length === 3,
    s.map(x => x.type).join(','));
  check('C4 trechos são linha + arco + linha',
    s[0].type === 'line' && s[1].type === 'arc' && s[2].type === 'line',
    s.map(x => x.type).join(','));
  check('C5 curva inserida fica selecionada',
    await page.evaluate(() => ui.selection.size === state.segments.length));
  check('C6 status confirma a inserção',
    (await page.$eval('#status-msg', el => el.textContent)).includes('Hairpin Loews inserida'));
  let b = await bbox();
  check('C7 centro da curva cai no ponto clicado',
    !!b && near(b.cx, 0) && near(b.cy, 0),
    b ? JSON.stringify(b) : 'sem bbox');
  const sweep = await page.evaluate(() => {
    const arc = state.segments.find(x => x.type === 'arc');
    return arc ? Math.abs(arcGeometry(arc).sweep * 180 / Math.PI) : 0;
  });
  check('C8 arco do hairpin tem 180°', near(sweep, 180, 0.5), sweep.toFixed(2));
  check('C9 após inserir volta para a ferramenta Seleção',
    await page.evaluate(() => ui.tool === 'select'));

  // Esc durante o posicionamento cancela
  await reset();
  await open();
  await choose('parabolica');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('C10 Esc cancela antes de inserir', await count() === 0 &&
    await page.evaluate(() => ui.pasteMode === null));

  // Enter confirma no cursor
  await open();
  await choose('bico-de-pato');
  const pEnter = await ppt(10, 5);
  await page.mouse.move(pEnter.x, pEnter.y);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  b = await bbox();
  check('C11 Enter insere no cursor', await count() === 3 && !!b && near(b.cx, 10) && near(b.cy, 5),
    b ? JSON.stringify(b) : 'sem bbox');

  // ── D) ESCALA ──────────────────────────────────────────
  await reset();
  await open();
  await page.fill('#curve-library-scale', '2');
  await choose('senna-s');
  await clickWorld(0, 0);
  const b2 = await bbox();
  check('D1 escala 2× dobra a largura', !!b2 && near(b2.w, 80, 0.2),
    b2 ? b2.w.toFixed(2) : '—');

  await reset();
  await open();
  await page.fill('#curve-library-scale', '0.5');
  await choose('senna-s');
  await clickWorld(0, 0);
  const b05 = await bbox();
  check('D2 escala 0,5× reduz pela metade', !!b05 && near(b05.w, 20, 0.2),
    b05 ? b05.w.toFixed(2) : '—');

  // ── E) DESFAZER ────────────────────────────────────────
  await page.evaluate(() => undo());
  await page.waitForTimeout(100);
  check('E1 um Ctrl+Z remove a curva inteira', await count() === 0);

  // ── F) EDITÁVEL ────────────────────────────────────────
  await reset();
  await open();
  await choose('senna-s');
  await clickWorld(0, 0);
  const tipos = await page.evaluate(() => state.segments.map(x => x.type));
  check('F1 cada trecho é um objeto separado (não polilinha única)',
    tipos.length === 9 && tipos.every(t => t === 'line' || t === 'arc'),
    tipos.join(','));

  const vtx = await page.evaluate(() => {
    const W = canvas.width, H = canvas.height;
    for (let si = 0; si < state.segments.length; si++) {
      const seg = state.segments[si];
      for (let pi = 0; pi < seg.points.length; pi++) {
        const p = seg.points[pi];
        const sp = w2s(p.x, p.y);
        if (sp.x > 50 && sp.x < W - 50 && sp.y > 50 && sp.y < H - 50) {
          return { si, pi, x: sp.x, y: sp.y, wx: p.x, wy: p.y };
        }
      }
    }
    return null;
  });
  await page.evaluate(() => setTool('vertex-edit'));
  if (vtx) {
    await page.mouse.move(box.x + vtx.x, box.y + vtx.y);
    await page.mouse.down();
    await page.mouse.move(box.x + vtx.x + 34, box.y + vtx.y + 22, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  }
  const moved = vtx ? await page.evaluate(sel => {
    const p = state.segments[sel.si].points[sel.pi];
    return { x: p.x, y: p.y };
  }, { si: vtx.si, pi: vtx.pi }) : { x: NaN, y: NaN };
  check('F2 vértice pode ser arrastado (ferramenta V)',
    !!vtx && Math.hypot(moved.x - vtx.wx, moved.y - vtx.wy) > 0.5,
    JSON.stringify({ before: vtx, after: moved }));

  const arcsOk = await page.evaluate(() => state.segments
    .filter(s => s.type === 'arc')
    .every(s => !!arcGeometry(s)));
  check('F3 arcos continuam válidos após a edição', arcsOk);

  // ── G) MINHAS CURVAS ───────────────────────────────────
  await reset();
  await open();
  await choose('hairpin-loews');
  await clickWorld(0, 0);

  check('G1 formulário Minhas curvas existe',
    await page.$('#custom-curve-name') !== null &&
    await page.$('#custom-curve-save') !== null);

  await open();
  await page.fill('#custom-curve-name', 'Curva de Teste');
  await page.fill('#custom-curve-track', 'Pista Teste');
  await page.click('#custom-curve-save');
  await page.waitForTimeout(200);
  check('G2 salvar seleção cria cartão MEU',
    await page.$$eval('.lib-card .lib-badge', els => els.length) === 1 &&
    (await page.$$eval('.lib-card .lib-name', els => els.map(e => e.textContent))).includes('Curva de Teste'));

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('linetrack.curveLibrary.v1') || '[]'));
  check('G3 curva fica salva no navegador',
    stored.length === 1 && stored[0].name === 'Curva de Teste' && stored[0].segs.length === 3,
    JSON.stringify(stored.map(c => ({ name: c.name, n: c.segs.length }))));

  await page.fill('#custom-curve-name', '');
  const beforeBad = (await page.$$('.lib-card')).length;
  await page.click('#custom-curve-save');
  await page.waitForTimeout(100);
  check('G4 não salva curva sem nome',
    (await page.$$('.lib-card')).length === beforeBad);

  await page.click('.lib-code-btn');
  await page.waitForTimeout(100);
  const generated = await page.$eval('#lib-code-text', el => el.textContent);
  check('G5 código gerado tem TRACK_LIBRARY.push e build',
    generated.includes('TRACK_LIBRARY.push({') &&
    generated.includes('build: () =>') &&
    generated.includes('custom: true'));

  const codeBuild = await page.evaluate(code => {
    const temp = [];
    new Function('TRACK_LIBRARY', 'libPt', 'libLine', 'libArc', 'libRoundedPath', code)
      (temp, libPt, libLine, libArc, libRoundedPath);
    return temp.length ? temp[0].build().map(s => s.type) : [];
  }, generated);
  check('G6 código executado reconstrói os 3 trechos',
    codeBuild.join(',') === 'line,arc,line', codeBuild.join(','));

  const dl = page.waitForEvent('download');
  await page.evaluate(() => document.getElementById('lib-code-download').click());
  const download = await dl;
  const dlPath = 'tests/artifacts/' + download.suggestedFilename();
  await download.saveAs(dlPath);
  check('G7 botão Baixar .js gera arquivo da curva',
    /^curva-.*\.js$/.test(download.suggestedFilename()) &&
    fs.readFileSync(dlPath, 'utf8').includes('TRACK_LIBRARY.push'),
    download.suggestedFilename());
  await page.evaluate(() => closeCurveCode());

  await page.evaluate(() => {
    state.segments = [];
    state.nextId = 1;
    ui.selection.clear();
    render();
  });
  await page.click('.lib-card[data-curve^="custom-"]');
  await page.waitForTimeout(120);
  await clickWorld(0, 0);
  const customTypes = await page.evaluate(() => state.segments.map(s => s.type).join(','));
  const customB = await bbox();
  check('G8 curva própria insere centralizada no clique',
    customTypes === 'line,arc,line' && !!customB && near(customB.cx, 0, 0.2) && near(customB.cy, 0, 0.2),
    customTypes + ' ' + JSON.stringify(customB));
  check('G9 curva própria entra selecionada',
    await page.evaluate(() => ui.selection.size === 3));

  await open();
  await page.evaluate(() => document.querySelector('.lib-del').click());
  await page.waitForTimeout(150);
  check('G10 excluir remove o cartão e o storage',
    (await page.$$('.lib-card')).length === 10 &&
    await page.evaluate(() => JSON.parse(localStorage.getItem('linetrack.curveLibrary.v1') || '[]').length === 0));

  await page.setInputFiles('#custom-curve-import', dlPath);
  await page.waitForTimeout(250);
  check('G11 importar .js recria a curva no navegador',
    (await page.$$('.lib-card')).length === 11 &&
    await page.evaluate(() => JSON.parse(localStorage.getItem('linetrack.curveLibrary.v1') || '[]').length === 1));

  await page.reload();
  await page.waitForTimeout(300);
  await open();
  check('G12 curva própria continua após recarregar',
    (await page.$$('.lib-card')).length === 11 &&
    (await page.$$eval('.lib-card .lib-name', els => els.map(e => e.textContent))).includes('Curva de Teste'));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  await page.evaluate(() => localStorage.removeItem('linetrack.curveLibrary.v1'));

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
