const { spawnSync } = require('child_process');
const path = require('path');

// Suíte de regressão. Cada teste é um script Playwright independente.
const tests = [
  'ghost_image.js',
  'library.js',
  'gabarito.js',
  'hud_nav.js',
  'dist_snap.js',
  'spiral.js',
  'paste_shortcuts.js',
  'grid_static.js',
  'toggle_keys.js',
  'workspace_pdf.js',
  'circle_quads.js',
  'persist.js',
  'deadzone.js',
  'dijkstra_modes.js',
  'drag_clipboard.js',
];

const SUMMARY = /(RESULT(?:ADO)?:.*|FALHAS:.*|TODOS OS CHECKS OK|\d+\/\d+ (?:checks|verificações OK))/g;

let failed = 0;
const started = Date.now();

for (const file of tests) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const matches = out.match(SUMMARY);
  const summary = matches ? matches[matches.length - 1].trim() : '';
  const ms = Date.now() - t0;

  if (res.status === 0) {
    console.log(`OK   ${file} (${ms} ms)${summary ? ' — ' + summary : ''}`);
  } else {
    failed++;
    console.log(`FAIL ${file} (exit ${res.status}, ${ms} ms)${summary ? ' — ' + summary : ''}`);
    console.log(out.trim().split('\n').slice(-25).join('\n'));
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${tests.length - failed}/${tests.length} testes OK em ${total}s`);
process.exit(failed ? 1 : 0);
