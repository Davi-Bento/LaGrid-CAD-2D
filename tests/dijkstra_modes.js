const { chromium } = require('playwright');
const url = require('./helpers').appUrl;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(url);
  await page.waitForTimeout(200);

  const results = [];
  const check = (n, ok, extra) => results.push({ n, ok, extra: extra ?? '' });
  const countSegs = () => page.$eval('#info-seg-count', el => parseInt(el.textContent, 10));
  const getDijkstraDist = () => page.$eval('#dijk-dist', el => parseFloat(el.textContent));
  const getDijkstraSegs = () => page.$eval('#dijk-segs', el => parseInt(el.textContent, 10));
  const getToastText = async () => page.evaluate(() => {
  const toasts = document.querySelectorAll('#toast-container .toast');
  if (toasts.length > 0) return toasts[toasts.length - 1].textContent;
  return '';
});

  check('modo Dijkstra padrão é menor caminho', await page.$eval('#dijkstra-mode-select', el => el.value) === 'shortest_path');

  // Criar um loop simples (quadrado)
  await page.evaluate(() => {
    state.segments = [
      { id: 1, type: 'line', points: [{ x: 10, y: 10 }, { x: 20, y: 10 }], selected: false },
      { id: 2, type: 'line', points: [{ x: 20, y: 10 }, { x: 20, y: 20 }], selected: false },
      { id: 3, type: 'line', points: [{ x: 20, y: 20 }, { x: 10, y: 20 }], selected: false },
      { id: 4, type: 'line', points: [{ x: 10, y: 20 }, { x: 10, y: 10 }], selected: false },
    ];
    state.nextId = 5;
    render();
    updatePanelInfo();
    updateDijkstraPanel();
  });
  await page.waitForTimeout(100);
  check('4 segmentos criados', await countSegs() === 4);

  // Mudar para modo perímetro e calcular
  await page.selectOption('#dijkstra-mode-select', 'perimeter_loop');
  await page.waitForTimeout(50);
  await page.click('#btn-dijkstra');
  await page.waitForTimeout(100);
  check('perímetro calculado (40.0 cm)', Math.abs(await getDijkstraDist() - 40.0) < 0.01);
  check('loop com 4 segmentos', await getDijkstraSegs() === 4);

  // Criar geometria sem loop (linha reta)
  await page.evaluate(() => {
    state.segments = [
      { id: 1, type: 'line', points: [{ x: 10, y: 10 }, { x: 20, y: 10 }], selected: false },
    ];
    state.nextId = 2;
    render();
    updatePanelInfo();
    updateDijkstraPanel();
  });
  await page.waitForTimeout(100);
  check('linha única criada', await countSegs() === 1);

  // Tentar calcular perímetro sem loop (apenas uma linha)
  await page.selectOption('#dijkstra-mode-select', 'perimeter_loop');
  await page.waitForTimeout(50);
  await page.click('#btn-dijkstra');
  await page.waitForTimeout(300);
  const toastText = await getToastText();
  console.log('DEBUG toast text:', toastText);
  check('toast nenhum loop encontrado', toastText.includes('Nenhum loop fechado'));

  // Criar um novo projeto para o próximo teste
  await page.evaluate(() => { window.confirm = () => true; newProject(); });
  await page.waitForTimeout(100);
  check('novo projeto criado', await countSegs() === 0);

  // Criar um loop e uma linha extra (não conectada ao loop)
  await page.evaluate(() => {
    state.segments = [
      { id: 1, type: 'line', points: [{ x: 10, y: 10 }, { x: 20, y: 10 }], selected: false },
      { id: 2, type: 'line', points: [{ x: 20, y: 10 }, { x: 20, y: 20 }], selected: false },
      { id: 3, type: 'line', points: [{ x: 20, y: 20 }, { x: 10, y: 20 }], selected: false },
      { id: 4, type: 'line', points: [{ x: 10, y: 20 }, { x: 10, y: 10 }], selected: false },
      { id: 5, type: 'line', points: [{ x: 30, y: 30 }, { x: 40, y: 30 }], selected: false }, // linha extra
    ];
    state.nextId = 6;
    render();
  });
  await page.waitForTimeout(100);
  await page.selectOption('#dijkstra-mode-select', 'perimeter_loop');
  await page.waitForTimeout(50);
  await page.click('#btn-dijkstra');
  await page.waitForTimeout(100);
  check('perímetro de loop com linha extra', Math.abs(await getDijkstraDist() - 40.0) < 0.01);
  check('loop com 4 segmentos (ignora linha extra)', await getDijkstraSegs() === 4);

  // Mudar para menor caminho, definir nós e calcular
  await page.selectOption('#dijkstra-mode-select', 'shortest_path');
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    // Definir nós diretamente: seg 4 (10,20 -> 10,10) t=1 é 10,10; seg 1 (10,10 -> 20,10) t=1 é 20,10
    state.nodes.start = { x: 10, y: 10, segId: 4, t: 1 };
    state.nodes.end = { x: 20, y: 10, segId: 1, t: 1 };
    updateDijkstraPanel();
  });
  await page.waitForTimeout(100);
  await page.click('#btn-dijkstra');
  await page.waitForTimeout(100);
  check('caminho calculado (10.0 cm)', Math.abs(await getDijkstraDist() - 10.0) < 0.01);
  check('caminho com 1 segmento', await getDijkstraSegs() === 1);

  await page.waitForTimeout(200);
  check('sem erros de runtime', errors.length === 0, errors.join(' | '));
  console.log(JSON.stringify(results, null, 2));
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  const failed = results.filter(r => !r.ok).length;
  console.log(`RESULT: ${results.length - failed}/${results.length} OK`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
