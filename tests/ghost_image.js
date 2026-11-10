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
  const near = (a, b, eps = 0.15) => Math.abs(a - b) <= eps;

  const bgState = () => page.evaluate(() => eval(`({
    has: !!bg.image,
    name: bg.name,
    w: bg.widthCm,
    h: bgHeightCm(),
    x: bg.x,
    y: bg.y,
    rot: bg.rotation,
    op: bg.opacity,
    vis: bg.visible,
    adjust: bg.adjust,
    imgW: bg.image ? bg.image.width : 0,
    imgH: bg.image ? bg.image.height : 0,
    cam: cam.scale
  })`));

  const pixel = (wx, wy) => page.evaluate(([x, y]) => {
    const p = eval(`w2s(${x},${y})`);
    const c = document.getElementById('main-canvas');
    const d = c.getContext('2d').getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }, [wx, wy]);

  const screenOf = async (wx, wy) => {
    const box = await page.locator('#main-canvas').boundingBox();
    const s = await page.evaluate(([x, y]) => eval(`w2s(${x},${y})`), [wx, wy]);
    return { x: box.x + s.x, y: box.y + s.y };
  };

  const setRange = async (id, value) => {
    await page.evaluate(([id, v]) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [id, value]);
  };

  const rotateHandleWorld = () => page.evaluate(() => eval('bgRotationHandleWorld()'));
  const cornersWorld = () => page.evaluate(() => eval('bgCornersWorld()'));

  // ── 1. Estado inicial ──
  check('seção imagem de fundo existe', await page.locator('.bg-section').count() === 1);
  check('ajustar desabilitado sem imagem', await page.locator('#btn-bg-adjust').isDisabled());
  check('remover desabilitado sem imagem', await page.locator('#btn-bg-remove').isDisabled());
  check('meta vazia', (await page.textContent('#bg-meta')).includes('Nenhuma imagem'));
  check('opacidade inicial 40%', (await page.textContent('#bg-opacity-val')).trim() === '40%');

  // ── 2. Importa um PNG 400x200 magenta ──
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#ff00ff';
    g.fillRect(0, 0, 400, 200);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.setInputFiles('#bg-image-input', {
    name: 'ghost.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64')
  });
  await page.waitForFunction(() => eval('!!bg.image'), null, { timeout: 5000 });
  await page.waitForTimeout(120);

  let s = await bgState();
  check('imagem importada', s.has && s.name === 'ghost.png', s.name);
  check('pixels reduzidos/iguais', s.imgW === 400 && s.imgH === 200, `${s.imgW}x${s.imgH}`);
  check('opacidade padrão 40%', near(s.op, 0.4, 0.001), String(s.op));
  check('visível por padrão', s.vis === true);
  check('encaixe 90% da largura', near(s.w, 285 * 0.9, 0.2), String(s.w));
  check('altura proporcional', near(s.h, s.w / 2, 0.05), String(s.h));
  check('centralizada na área', near(s.x, 142.5, 0.05) && near(s.y, 90, 0.05), `${s.x},${s.y}`);
  check('rotação inicial 0', near(s.rot, 0, 0.001));
  check('controles habilitados', !(await page.locator('#bg-width').isDisabled()) &&
    !(await page.locator('#bg-opacity').isDisabled()) && !(await page.locator('#btn-bg-fit').isDisabled()));
  check('campo largura preenchido', (await page.inputValue('#bg-width')).replace(',', '.') === s.w.toFixed(1),
    await page.inputValue('#bg-width'));
  check('meta com nome', (await page.textContent('#bg-meta')).includes('ghost.png'));

  // ── 3. Renderização e opacidade ──
  await setRange('bg-opacity', 100);
  await page.waitForTimeout(60);
  let px = await pixel(142.5, 90);
  check('imagem desenhada no canvas', px[0] > 240 && px[1] < 30 && px[2] > 240, px.join(','));
  check('opacidade 100% aplicada', (await bgState()).op === 1);
  check('rótulo opacidade 100%', (await page.textContent('#bg-opacity-val')).trim() === '100%');

  await setRange('bg-opacity', 40);
  await page.waitForTimeout(60);
  px = await pixel(142.5, 90);
  check('opacidade 40% mistura com o fundo', px[0] > 80 && px[0] < 160 && px[2] > 70 && px[2] < 160, px.join(','));

  // ── 4. Mostrar/ocultar ──
  await page.uncheck('#bg-visible');
  await page.waitForTimeout(60);
  px = await pixel(142.5, 90);
  check('oculta não desenha imagem', !(px[0] > 90 && px[2] > 80 && px[1] < 40), px.join(','));
  await page.check('#bg-visible');
  await page.waitForTimeout(60);
  px = await pixel(142.5, 90);
  check('mostrar volta a desenhar', px[0] > 80 && px[2] > 70 && px[1] < 40, px.join(','));

  // ── 5. Imagem fica atrás dos segmentos ──
  await page.evaluate(() => eval(`(() => {
    state.segments = [{ id: 99, type: 'line', points: [{x:100,y:90},{x:200,y:90}], selected: false }];
    state.nextId = 100;
    state.dijkstraPath = [];
    ui.selection.clear();
    ui.selection.add(99);
    render();
  })()`));
  await page.waitForTimeout(60);
  const overPx = await page.evaluate(() => {
    const p = eval('w2s(142.5, 90)');
    const c = document.getElementById('main-canvas');
    const d = c.getContext('2d').getImageData(Math.round(p.x) - 3, Math.round(p.y) - 3, 7, 7).data;
    let best = [0, 0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 1] > best[1]) best = [d[i], d[i + 1], d[i + 2], d[i + 3]];
    }
    return best;
  });
  check('segmento desenha sobre a imagem', overPx[1] > 150 && overPx[2] > 150 && overPx[0] < 100,
    overPx.join(','));
  await page.evaluate(() => eval('state.segments = []; state.nextId = 1; ui.selection.clear(); render();'));

  // ── 6. Campos numéricos ──
  await page.fill('#bg-width', '100');
  await page.fill('#bg-rotation', '90');
  await page.fill('#bg-x', '50');
  await page.fill('#bg-y', '60');
  await page.waitForTimeout(60);
  s = await bgState();
  check('largura editável', near(s.w, 100, 0.01), String(s.w));
  check('altura acompanha proporção', near(s.h, 50, 0.01), String(s.h));
  check('rotação editável', near(s.rot, 90, 0.01), String(s.rot));
  check('centro X editável', near(s.x, 50, 0.01), String(s.x));
  check('centro Y editável', near(s.y, 60, 0.01), String(s.y));

  // ── 7. Encaixar / centralizar ──
  await page.click('#btn-bg-fit');
  await page.waitForTimeout(60);
  s = await bgState();
  check('encaixar volta a 90%', near(s.w, 285 * 0.9, 0.2), String(s.w));
  check('encaixar centraliza', near(s.x, 142.5, 0.05) && near(s.y, 90, 0.05), `${s.x},${s.y}`);
  check('encaixar preserva rotação', near(s.rot, 90, 0.01), String(s.rot));

  await page.fill('#bg-rotation', '0');
  await page.fill('#bg-x', '5');
  await page.fill('#bg-y', '7');
  await page.click('#btn-bg-center');
  await page.waitForTimeout(60);
  s = await bgState();
  check('centralizar', near(s.x, 142.5, 0.05) && near(s.y, 90, 0.05), `${s.x},${s.y}`);

  // ── 8. Modo ajustar: arrastar ──
  await page.click('#btn-bg-adjust');
  await page.waitForTimeout(60);
  s = await bgState();
  check('modo ajustar ativo', s.adjust === true);
  check('botão ajustar com estado ativo', await page.locator('#btn-bg-adjust').evaluate(el => el.classList.contains('active')));
  check('status do modo ajustar', (await page.textContent('#status-msg')).includes('Imagem de fundo'));

  const startCenter = await screenOf(s.x, s.y);
  await page.mouse.move(startCenter.x, startCenter.y);
  await page.mouse.down();
  await page.mouse.move(startCenter.x + 60, startCenter.y + 30, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  let s2 = await bgState();
  check('arrastar move a imagem', near(s2.x - s.x, 60 / (37.795 * s.cam), 0.2) &&
    near(s2.y - s.y, -30 / (37.795 * s.cam), 0.2), `${(s2.x - s.x).toFixed(2)},${(s2.y - s.y).toFixed(2)}`);

  // ── 9. Modo ajustar: redimensionar pelo canto ──
  const beforeResize = await bgState();
  const c0 = (await cornersWorld())[0];
  const cs = await screenOf(c0.x, c0.y);
  const cc = await screenOf(beforeResize.x, beforeResize.y);
  const outX = cs.x + (cs.x - cc.x) * 0.3;
  const outY = cs.y + (cs.y - cc.y) * 0.3;
  await page.mouse.move(cs.x, cs.y);
  await page.mouse.down();
  await page.mouse.move(outX, outY, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  const afterResize = await bgState();
  check('canto redimensiona', afterResize.w > beforeResize.w + 1,
    `${beforeResize.w.toFixed(1)} → ${afterResize.w.toFixed(1)}`);
  check('redimensionar mantém proporção', near(afterResize.h / afterResize.w, 0.5, 0.005),
    String(afterResize.h / afterResize.w));

  // ── 10. Modo ajustar: girar ──
  await page.fill('#bg-rotation', '0');
  await page.waitForTimeout(40);
  const rotW = await rotateHandleWorld();
  const rh = await screenOf(rotW.x, rotW.y);
  s = await bgState();
  const centerScreen = await screenOf(s.x, s.y);
  await page.mouse.move(rh.x, rh.y);
  await page.mouse.down();
  await page.mouse.move(centerScreen.x + 120, centerScreen.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  s = await bgState();
  check('alça gira a imagem', near(s.rot, 270, 2), String(s.rot));

  // Shift trava em 15°
  await page.fill('#bg-rotation', '0');
  await page.waitForTimeout(40);
  const rotW2 = await rotateHandleWorld();
  const rh2 = await screenOf(rotW2.x, rotW2.y);
  const c2 = await bgState();
  const ctr2 = await screenOf(c2.x, c2.y);
  const rpx = 120;
  const targetX = ctr2.x + rpx * Math.cos(100 * Math.PI / 180);
  const targetY = ctr2.y - rpx * Math.sin(100 * Math.PI / 180);
  await page.keyboard.down('Shift');
  await page.mouse.move(rh2.x, rh2.y);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(80);
  s = await bgState();
  check('Shift trava rotação em 15°', near(s.rot % 15, 0, 0.001) && s.rot === 15, String(s.rot));

  // ── 11. Saídas do modo ajustar ──
  await page.click('#btn-bg-adjust');
  await page.waitForTimeout(40);
  check('clicar ajustar desliga', (await bgState()).adjust === false);

  await page.click('#btn-bg-adjust');
  await page.waitForTimeout(40);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  check('Esc sai do ajuste', (await bgState()).adjust === false);

  await page.click('#btn-bg-adjust');
  await page.waitForTimeout(40);
  const box = await page.locator('#main-canvas').boundingBox();
  await page.mouse.click(box.x + 30, box.y + 30, { button: 'right' });
  await page.waitForTimeout(60);
  check('clique direito sai do ajuste', (await bgState()).adjust === false);

  await page.click('#btn-bg-adjust');
  await page.waitForTimeout(40);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(60);
  check('Enter sai do ajuste', (await bgState()).adjust === false);

  // Ferramenta de desenho encerra o ajuste
  await page.click('#btn-bg-adjust');
  await page.waitForTimeout(40);
  await page.evaluate(() => eval("setTool('line')"));
  await page.waitForTimeout(40);
  check('trocar de ferramenta sai do ajuste', (await bgState()).adjust === false);
  await page.evaluate(() => eval("setTool('select')"));

  // ── 12. Novo projeto preserva a imagem ──
  await page.evaluate(() => eval('newProject()'));
  await page.waitForTimeout(80);
  s = await bgState();
  check('novo projeto mantém a imagem', s.has === true && s.name === 'ghost.png');

  // ── 13. JSON não guarda a imagem ──
  let saved = null;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.evaluate(() => eval('saveJSON()')),
    ]);
    const out = path.join(os.tmpdir(), 'ghost_save_' + Date.now() + '.json');
    await dl.saveAs(out);
    saved = fs.readFileSync(out, 'utf8');
    fs.unlinkSync(out);
  } catch (e) { saved = null; }
  check('JSON exportado', !!saved);
  if (saved) {
    check('JSON sem dados da imagem', !/"bg"/.test(saved) && !/ghost\.png/.test(saved) &&
      !/data:image/.test(saved) && !/base64/.test(saved));
    let parsed = null;
    try { parsed = JSON.parse(saved); } catch (_) {}
    check('JSON continua válido', !!parsed && parsed.version === 11 && Array.isArray(parsed.segments));
  }

  // ── 14. PDF não inclui a imagem ──
  const pdfHtml = await page.evaluate(() => {
    state.segments = [{ id: 1, type: 'line', points: [{ x: 100, y: 90 }, { x: 200, y: 90 }] }];
    state.nextId = 2;
    const orig = window.open;
    let html = '';
    window.open = () => ({ document: { write: h => { html += h; }, close() {} } });
    try { exportPDF(); } finally { window.open = orig; }
    return html;
  });
  check('PDF gerado', pdfHtml.includes('<svg') || pdfHtml.includes('%3Csvg'));
  check('PDF sem imagem fantasma', !/data:image\/png/.test(pdfHtml) && !/ghost\.png/.test(pdfHtml) &&
    !/<image\b/.test(pdfHtml));

  // ── 15. Imagem grande é reduzida para 2400 px ──
  const bigB64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 3000; c.height = 1500;
    const g = c.getContext('2d');
    g.fillStyle = '#00ff88';
    g.fillRect(0, 0, 3000, 1500);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.setInputFiles('#bg-image-input', {
    name: 'grande.png', mimeType: 'image/png', buffer: Buffer.from(bigB64, 'base64')
  });
  await page.waitForFunction(() => eval('bg.name === "grande.png"'), null, { timeout: 5000 });
  await page.waitForTimeout(100);
  s = await bgState();
  check('imagem grande reduzida no maior lado', s.imgW === 2400 && s.imgH === 1200, `${s.imgW}x${s.imgH}`);

  // ── 16. Remover ──
  await page.click('#btn-bg-remove');
  await page.waitForTimeout(80);
  s = await bgState();
  check('remover limpa a imagem', s.has === false && s.name === '');
  check('campos desabilitados após remover', await page.locator('#bg-width').isDisabled());
  check('meta volta ao vazio', (await page.textContent('#bg-meta')).includes('Nenhuma imagem'));

  // ── Resultado ──
  const pass = results.filter(r => r.ok).length;
  console.log(`\nghost_image: ${pass}/${results.length} checks`);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.extra ? '  [' + r.extra + ']' : ''}`);
  }
  if (errors.length) {
    console.log('\nERROS DE PÁGINA:');
    errors.forEach(e => console.log('  ' + e));
  }
  await browser.close();
  process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
})();
