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

  // ── A) OPÇÃO NO PAINEL ───────────────────────────────────
  const options = await page.$$eval('#exp-format option', els =>
    els.map(el => ({ value: el.value, text: el.textContent.trim() })));
  const wsOpt = options.find(o => o.value === 'workspace');
  check('A1 opção Área de trabalho existe', !!wsOpt);
  check('A2 opção indica 1:1', !!wsOpt && /1:1/.test(wsOpt.text), wsOpt && wsOpt.text);

  // ── B) PDF 1:1 NO TAMANHO DA ÁREA DE TRABALHO ────────────
  const pdf = await page.evaluate(() => {
    state.workspace = { w: 285, h: 180 };
    state.segments = [{ id: 1, type: 'line', points: [{ x: 10, y: 10 }, { x: 60, y: 10 }] }];
    state.nextId = 2;
    state.nodes = { start: null, end: null };
    state.dijkstraPath = [];
    document.getElementById('exp-format').value = 'workspace';
    document.getElementById('exp-margin').value = '10';
    const orig = window.open;
    let html = '';
    window.open = () => ({ document: { write: h => { html += h; }, close() {} } });
    try { exportPDF(); } finally { window.open = orig; }
    return html;
  });

  check('B1 @page tem o tamanho da área de trabalho',
    pdf.includes('@page { size: 285cm 180cm; margin: 0; }'));
  check('B2 body usa as medidas da área de trabalho',
    pdf.includes('body { width:285cm; height:180cm;'));

  // Decodifica o SVG embutido no data URL.
  const svgMatch = pdf.match(/<img src="data:image\/svg\+xml;charset=utf-8,([^"]+)"/);
  const svg = svgMatch ? decodeURIComponent(svgMatch[1]) : '';
  check('B3 SVG gerado', !!svgMatch && svg.includes('<svg'));

  const wPx = Math.round(285 * 37.795); // 10772
  const hPx = Math.round(180 * 37.795); // 6803
  check('B4 largura do SVG em px = 285cm',
    svg.includes(`width="${wPx}"`), `esperado ${wPx}`);
  check('B5 altura do SVG em px = 180cm',
    svg.includes(`height="${hPx}"`), `esperado ${hPx}`);

  // Coordenadas 1:1: (10,10) → x=377.95, y=(180-10)*37.795=6425.15
  const expY = (180 - 10) * 37.795;
  check('B6 desenho em escala 1:1 sem margem',
    svg.includes('M377.95,6425.15 L2267.70,6425.15'),
    'M377.95,' + expY.toFixed(2) + ' L2267.70,' + expY.toFixed(2));

  check('B7 rodapé identifica área de trabalho',
    svg.includes('Área de trabalho 285×180 cm · 1:1'));

  // ── C) DIMENSÕES PERSONALIZADAS ──────────────────────────
  const pdfCustom = await page.evaluate(() => {
    state.workspace = { w: 200, h: 120 };
    document.getElementById('exp-format').value = 'workspace';
    const orig = window.open;
    let html = '';
    window.open = () => ({ document: { write: h => { html += h; }, close() {} } });
    try { exportPDF(); } finally { window.open = orig; }
    return html;
  });
  check('C1 respeita área personalizada 200×120',
    pdfCustom.includes('@page { size: 200cm 120cm; margin: 0; }'));

  // ── D) OUTROS FORMATOS CONTINUAM IGUAIS ──────────────────
  const pdfA4 = await page.evaluate(() => {
    state.workspace = { w: 285, h: 180 };
    document.getElementById('exp-format').value = 'A4';
    const orig = window.open;
    let html = '';
    window.open = () => ({ document: { write: h => { html += h; }, close() {} } });
    try { exportPDF(); } finally { window.open = orig; }
    return html;
  });
  check('D1 A4 continua com margem e paisagem',
    pdfA4.includes('@page { size: 29.7cm 21cm; margin: 0; }') &&
    !pdfA4.includes('Área de trabalho'));

  // ── E) AVISO DE CONTEÚDO FORA DA ÁREA ────────────────────
  const warned = await page.evaluate(() => {
    state.workspace = { w: 50, h: 40 };
    state.segments = [{ id: 1, type: 'line', points: [{ x: 10, y: 10 }, { x: 90, y: 10 }] }];
    state.nextId = 2;
    document.getElementById('exp-format').value = 'workspace';
    const orig = window.open;
    window.open = () => ({ document: { write() {}, close() {} } });
    try { exportPDF(); } finally { window.open = orig; }
    const cont = document.getElementById('toast-container');
    return cont ? cont.textContent : '';
  });
  check('E1 avisa quando a pista sai da área de trabalho',
    /fora da área de trabalho/.test(warned), warned.trim());

  await browser.close();
  console.log(fails.length ? `\nFALHAS: ${fails.length}\n- ` + fails.join('\n- ') : '\nTODOS OS CHECKS OK');
  process.exit(fails.length ? 1 : 0);
})();
