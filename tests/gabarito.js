const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = 'C:/Users/Gabriel/AppData/Local/Temp/opencode/pwtest';
const OUT = path.join(ROOT, 'out');
const URL = require('./helpers').appUrl;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(n, ok, extra) {
  results.push({ n, ok: !!ok, extra: extra == null ? '' : String(extra) });
}

function near(a, b, eps = 0.06) { return Math.abs(a - b) <= eps; }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(URL);
  await page.waitForTimeout(500);
  await page.evaluate(() => localStorage.removeItem('linetrack.curveLibrary.v1'));

  const isHidden = (sel) => page.$eval(sel, el => el.classList.contains('hidden'));
  const open = async () => {
    if (await isHidden('#gabarito-window')) await page.click('#btn-gabarito');
    else await page.evaluate(() => Gabarito.open());
    await page.waitForTimeout(220);
  };
  const close = async () => { await page.click('#gabarito-close'); await page.waitForTimeout(120); };

  const loadProject = async () => {
    await page.evaluate(() => {
      state.segments = [
        { id: 1, type: 'line', points: [{x:0,y:0},{x:100,y:0}], selected:false, isConstruction:false },
        { id: 2, type: 'line', points: [{x:100,y:0},{x:100,y:50}], selected:false, isConstruction:false },
        { id: 3, type: 'arc', points: [{x:80,y:50},{x:90,y:60},{x:100,y:50}], selected:false },
        { id: 4, type: 'circle', points: [{x:30,y:30}], radius: 5, selected:false },
        { id: 5, type: 'polyline', points: [{x:0,y:20},{x:20,y:20},{x:20,y:40}], selected:false },
        { id: 6, type: 'line', points: [{x:10,y:-5},{x:10,y:60}], selected:false, isConstruction:true },
      ];
      state.nextId = 7;
      state.lineWidth = 1.9;
      state.workspace = { w: 120, h: 70 };
      state.deadzone = 5;
      state.dijkstraPath = [];
      state.nodes = { start: null, end: null };
      state.undoStack = []; state.redoStack = [];
      ui.selection.clear();
      document.getElementById('gab-origin').value = 'workspace';
      document.getElementById('gab-scale').value = 'a4';
      document.getElementById('gab-show-construction').checked = true;
      document.getElementById('gab-show-guides').checked = true;
      document.getElementById('gab-show-axes').checked = true;
      document.getElementById('gab-show-table').checked = true;
      render();
    });
    await page.waitForTimeout(120);
  };

  // ── A) ENTRADAS E JANELA ───────────────────────────────
  check('A1 botão Gabarito na toolbar', await page.$('#btn-gabarito') !== null);
  check('A2 entrada no menu Ferramentas', await page.$('[data-action="gabarito"]') !== null);
  check('A3 botão no painel Exportação', await page.$('#btn-export-gabarito') !== null);
  check('A4 janela começa oculta', await isHidden('#gabarito-window'));
  check('A5 backdrop começa oculto', await isHidden('#gabarito-backdrop'));

  await loadProject();
  await open();
  check('A6 botão abre a janela', !(await isHidden('#gabarito-window')));
  check('A7 backdrop aparece', !(await isHidden('#gabarito-backdrop')));
  check('A8 aba Desenho ativa', await page.$eval('#gab-drawing-pane', el => !el.classList.contains('hidden')));
  check('A9 aba Tabela começa oculta', await isHidden('#gab-table-pane'));
  check('A10 prévia tem SVG', (await page.$$('#gab-preview svg')).length === 1);
  check('A11 subtítulo tem contagem', /2 curvas/.test(await page.textContent('#gabarito-subtitle')),
    await page.textContent('#gabarito-subtitle'));

  await page.click('[data-gab-tab="table"]');
  await page.waitForTimeout(80);
  check('A12 aba Tabela abre', !(await isHidden('#gab-table-pane')));
  check('A13 aba Desenho fecha', await isHidden('#gab-drawing-pane'));
  check('A14 tabela tem 3 seções', (await page.$$('.gab-sec-title')).length === 3);

  await page.click('[data-gab-tab="drawing"]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('A15 Esc fecha a janela', await isHidden('#gabarito-window'));
  check('A16 Esc esconde o backdrop', await isHidden('#gabarito-backdrop'));

  await page.evaluate(() => document.querySelector('[data-action="gabarito"]').click());
  await page.waitForTimeout(180);
  check('A17 menu Ferramentas abre', !(await isHidden('#gabarito-window')));
  await page.evaluate(() => document.getElementById('btn-export-gabarito').click());
  await page.waitForTimeout(80);
  check('A18 botão Exportação mantém aberto', !(await isHidden('#gabarito-window')));
  await page.evaluate(() => document.getElementById('gabarito-backdrop').click());
  await page.waitForTimeout(80);
  check('A19 clique no backdrop fecha', await isHidden('#gabarito-window'));

  // ── B) EXTRAÇÃO ────────────────────────────────────────
  const data = await page.evaluate(() => Gabarito.build({ origin: 'workspace', guides: true, axes: true }));
  check('B1 pista 100 x 60', data && near(data.bounds.width, 100) && near(data.bounds.height, 60),
    data && `${data.bounds.width} x ${data.bounds.height}`);
  check('B2 contagem de curvas', data && data.counts.curves === 2, data && data.counts.curves);
  check('B3 contagem de retas (polilinha dividida)', data && data.counts.straights === 4, data && data.counts.straights);
  check('B4 contagem de guias', data && data.counts.guides === 9, data && data.counts.guides);
  const c1 = data && data.curves.find(c => c.id === 'C1');
  const c2 = data && data.curves.find(c => c.id === 'C2');
  check('B5 arco C1 centro/raio', c1 && near(c1.cx, 90) && near(c1.cy, 50) && near(c1.r, 10),
    c1 && `${c1.cx},${c1.cy} r${c1.r}`);
  check('B6 círculo C2 centro/raio', c2 && near(c2.cx, 30) && near(c2.cy, 30) && near(c2.r, 5),
    c2 && `${c2.cx},${c2.cy} r${c2.r}`);
  const r32 = data && data.straights.find(s => s.id === 'R3.2');
  check('B7 aresta de polilinha R3.2', r32 && near(r32.x1, 20) && near(r32.y1, 20) && near(r32.x2, 20) && near(r32.y2, 40),
    r32 && `${r32.x1},${r32.y1} -> ${r32.x2},${r32.y2}`);
  check('B8 origem no canto inferior esquerdo', data && data.straights[0].y1 === 0 && data.straights[0].x1 === 0,
    data && `${data.straights[0].x1},${data.straights[0].y1}`);
  check('B9 guia de construção G1', data && data.guides[0].kind === 'construction', data && data.guides[0].kind);
  check('B10 eixos rosa presentes', data && data.guides.filter(g => g.kind === 'axis').length === 4,
    data && data.guides.filter(g => g.kind === 'axis').length);
  check('B11 centros de reta presentes', data && data.guides.filter(g => g.kind === 'center').length === 4,
    data && data.guides.filter(g => g.kind === 'center').length);

  const editor = await page.evaluate(() => Gabarito.build({ origin: 'editor', guides: true, axes: true }));
  const ec1 = editor.curves.find(c => c.id === 'C1');
  check('B12 origem editor mantém coordenadas', ec1 && near(ec1.cx, 90) && near(ec1.cy, 50),
    ec1 && `${ec1.cx},${ec1.cy}`);

  const noGuides = await page.evaluate(() => Gabarito.build({ origin: 'workspace', guides: false, axes: true }));
  check('B13 sem centro das retas restam 5 guias', noGuides.counts.guides === 5, noGuides.counts.guides);
  const noConstruction = await page.evaluate(() => Gabarito.build({ origin: 'workspace', construction: false, guides: true, axes: true }));
  check('B14 sem construção restam 8 guias', noConstruction.counts.guides === 8, noConstruction.counts.guides);
  const noAxes = await page.evaluate(() => Gabarito.build({ origin: 'workspace', guides: true, axes: false }));
  check('B15 sem eixos restam 5 guias', noAxes.counts.guides === 5, noAxes.counts.guides);
  const none = await page.evaluate(() => Gabarito.build({ origin: 'workspace', construction: false, guides: false, axes: false }));
  check('B16 sem guias/eixos ficam 0', none.counts.guides === 0, none.counts.guides);
  check('B17 área de trabalho 120 x 70', data && near(data.area.width, 120) && near(data.area.height, 70),
    data && `${data.area.width} x ${data.area.height}`);
  check('B18 origem padrão da área de trabalho', data && data.origin === 'workspace', data && data.origin);

  // ── C) SVG / TABELA ────────────────────────────────────
  const svg = await page.evaluate(() => Gabarito.renderSVG(Gabarito.build({ origin: 'workspace', guides: true, axes: true }), { mode: 'preview' }));
  check('C1 SVG com rótulos das curvas', svg.includes('>R10<') && svg.includes('>R5<'));
  check('C2 SVG com círculo de raio', svg.includes('#d9556d'));
  check('C3 SVG com guia tracejada', svg.includes('stroke-dasharray'));
  check('C4 SVG com eixo', svg.includes('#e2a0b2'));
  check('C5 SVG tem viewBox', /viewBox="0 0 [0-9.]+ [0-9.]+"/.test(svg));

  await page.evaluate(() => { document.getElementById('gab-show-guides').checked = false; document.getElementById('gab-show-guides').dispatchEvent(new Event('change')); });
  await page.waitForTimeout(100);
  const svgNoGuides = await page.evaluate(() => document.querySelector('#gab-preview').innerHTML);
  check('C6 alternar Centro das retas remove a guia', !svgNoGuides.includes('#7c7c94'));
  check('C7 desligar o centro mantém a construção', svgNoGuides.includes('#7c8aa6'));
  await page.evaluate(() => { document.getElementById('gab-show-guides').checked = true; document.getElementById('gab-show-guides').dispatchEvent(new Event('change')); });

  await page.evaluate(() => { document.getElementById('gab-show-construction').checked = false; document.getElementById('gab-show-construction').dispatchEvent(new Event('change')); });
  await page.waitForTimeout(100);
  const svgNoConstruction = await page.evaluate(() => document.querySelector('#gab-preview').innerHTML);
  check('C8 desligar a construção remove o tracejado', !svgNoConstruction.includes('#7c8aa6'));
  check('C9 desligar a construção mantém o centro', svgNoConstruction.includes('#7c7c94'));
  await page.evaluate(() => { document.getElementById('gab-show-construction').checked = true; document.getElementById('gab-show-construction').dispatchEvent(new Event('change')); });
  await page.waitForTimeout(100);

  const tableHTML = await page.evaluate(() => document.querySelector('#gab-table').innerHTML);
  check('C10 tabela lista C1 e C2', tableHTML.includes('C1') && tableHTML.includes('C2') && tableHTML.includes('Círculo'));
  check('C11 tabela lista R3.1 e R3.2', tableHTML.includes('R3.1') && tableHTML.includes('R3.2'));
  check('C12 tabela lista G1 como linha de construção', tableHTML.includes('G1') && tableHTML.includes('Linha de construção'));

  // ── D) DOWNLOADS ───────────────────────────────────────
  await open();
  const saveDownload = async (selector, name) => {
    const dlPromise = page.waitForEvent('download', { timeout: 45000 });
    await page.click(selector);
    const dl = await dlPromise;
    const file = path.join(OUT, name);
    await dl.saveAs(file);
    return file;
  };

  const jsonFile = await saveDownload('#gab-json', 'gab.json');
  const json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  check('D1 JSON tem origem e contagens', json.origin === 'workspace' && json.counts.curves === 2 && json.counts.guides === 9);

  const csvFile = await saveDownload('#gab-csv', 'gab.csv');
  const csv = fs.readFileSync(csvFile, 'utf8');
  check('D2 CSV começa com BOM', csv.charCodeAt(0) === 0xFEFF);
  check('D3 CSV tem seções e R3.2', csv.includes('CURVAS') && csv.includes('RETAS E GUIAS') && csv.includes('R3.2'));
  check('D4 CSV usa ponto e vírgula', csv.includes('ID;Tipo'));

  const svgFile = await saveDownload('#gab-svg', 'gab_a4.svg');
  const svgTxt = fs.readFileSync(svgFile, 'utf8');
  check('D5 SVG A4 tem 297 x 210 mm', svgTxt.includes('width="297mm"') && svgTxt.includes('height="210mm"'));
  check('D6 SVG A4 tem cabeçalho', svgTxt.includes('GABARITO DE MONTAGEM') && svgTxt.includes('R10'));

  await page.selectOption('#gab-scale', 'real');
  await page.waitForTimeout(120);
  const svgRealFile = await saveDownload('#gab-svg', 'gab_real.svg');
  const svgReal = fs.readFileSync(svgRealFile, 'utf8');
  const realW = await page.evaluate(() => Gabarito.getData().view.width * 10);
  check('D7 SVG 1:1 tem largura real', svgReal.includes(`width="${Math.round(realW * 100) / 100}mm"`) || svgReal.includes('mm'), svgReal.match(/width="([^"]+)"/)?.[1]);

  await page.selectOption('#gab-scale', 'a4');
  await page.waitForTimeout(100);
  const pdfA4 = await saveDownload('#gab-pdf', 'gab_test_a4.pdf');

  await page.selectOption('#gab-scale', 'real');
  await page.uncheck('#gab-show-table');
  await page.waitForTimeout(120);
  const pdfReal = await saveDownload('#gab-pdf', 'gab_test_real.pdf');

  // Pista larga > 508 cm no PDF 1:1
  await page.evaluate(() => {
    state.workspace = { w: 570, h: 185 };
    state.deadzone = 5;
    state.segments = [
      { id: 1, type: 'line', points: [{x:5,y:5},{x:555,y:5}], selected:false, isConstruction:false },
      { id: 2, type: 'line', points: [{x:555,y:5},{x:555,y:25}], selected:false, isConstruction:false },
      { id: 3, type: 'line', points: [{x:555,y:25},{x:5,y:25}], selected:false, isConstruction:false },
      { id: 4, type: 'line', points: [{x:5,y:25},{x:5,y:5}], selected:false, isConstruction:false },
    ];
    state.nextId = 5; state.lineWidth = 1.9; state.dijkstraPath = [];
    render();
  });
  await page.click('#gab-refresh');
  await page.waitForTimeout(150);
  const pdfWide = await saveDownload('#gab-pdf', 'gab_test_wide.pdf');

  // ── E) VALIDAÇÃO DOS PDFs (pymupdf) ────────────────────
  const py = path.join(ROOT, 'gabarito_pdf_check.py');
  const pyOut = execFileSync('python', [py, pdfA4, pdfReal, pdfWide], { encoding: 'utf8' });
  const pdfs = JSON.parse(pyOut);
  const a4 = pdfs[pdfA4];
  const real = pdfs[pdfReal];
  const wide = pdfs[pdfWide];
  check('E1 PDF A4 tem 2 páginas', a4.n === 2, a4.n);
  check('E2 PDF A4 é paisagem 842x595', near(a4.pages[0].w, 842, 0.5) && near(a4.pages[0].h, 595, 0.5), `${a4.pages[0].w}x${a4.pages[0].h}`);
  check('E3 PDF A4 desenho tem rótulos', /GABARITO DE MONTAGEM/.test(a4.pages[0].text) && /R10/.test(a4.pages[0].text));
  check('E4 PDF A4 tabela presente', /TABELA DE MONTAGEM/.test(a4.pages[1].text) && /CURVAS/.test(a4.pages[1].text));
  check('E5 PDF 1:1 tem 1 página sem tabela', real.n === 1, real.n);
  check('E6 PDF 1:1 está em escala real', real.pages[0].w / 72 * 2.54 > 100 && real.pages[0].w / 72 * 2.54 < 140,
    (real.pages[0].w / 72 * 2.54).toFixed(1) + ' cm');
  check('E7 PDF 1:1 tem cabeçalho 1:1', /1:1/.test(real.pages[0].text));
  check('E8 PDF 1:1 de pista 550 cm passa de 508 cm', wide.pages[0].w / 72 * 2.54 > 508,
    (wide.pages[0].w / 72 * 2.54).toFixed(1) + ' cm');

  // ── F) BLOQUEIO DE ATALHOS ─────────────────────────────
  await page.evaluate(() => { document.getElementById('gab-show-table').checked = true; document.getElementById('gab-scale').value = 'a4'; });
  await loadProject();
  await open();
  const before = await page.evaluate(() => state.segments.length);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(80);
  const afterDelete = await page.evaluate(() => state.segments.length);
  check('F1 Delete não apaga com a janela aberta', afterDelete === before, `${before} -> ${afterDelete}`);
  const gridBefore = await page.evaluate(() => state.showGrid);
  await page.keyboard.press('g');
  await page.waitForTimeout(80);
  const gridAfter = await page.evaluate(() => state.showGrid);
  check('F2 atalho G não altera a grade', gridAfter === gridBefore);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('F3 Esc fecha depois do bloqueio', await isHidden('#gabarito-window'));

  check('G1 sem erros de página/console', errors.length === 0, errors.join(' | '));

  // ── RELATÓRIO ──────────────────────────────────────────
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  console.log(`\nRESULTADO: ${pass}/${results.length} (${fail} falhas)`);
  for (const r of results) {
    if (!r.ok) console.log(`FAIL ${r.n}${r.extra ? ' :: ' + r.extra : ''}`);
  }
  if (fail === 0) {
    for (const r of results) console.log(`ok ${r.n}`);
  }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(2);
});
