// ── Minhas curvas ─────────────────────────────────────────
// Curvas próprias do LaGrid CAD 2D. Cada bloco abaixo adiciona uma curva à
// biblioteca (botão LIB). Na própria biblioteca, use "Código" e depois
// "Baixar .js" para gerar o bloco; cole o conteúdo aqui e recarregue a
// página para a curva ficar disponível sempre, mesmo em outro navegador.
//
// Formato do bloco:
// TRACK_LIBRARY.push({
//   id: 'minha-curva',
//   name: 'Minha Curva',
//   track: 'Minha pista',
//   custom: true,
//   build: () => ([
//     { type: 'line', points: [libPt(0, 0), libPt(10, 0)] },
//   ]),
// });
//
// libPt(x, y) usa coordenadas matemáticas (Y para cima), como as curvas
// que já vêm no app.js. Linhas e arcos viram objetos separados e podem
// ser editados com as ferramentas normais do editor.
