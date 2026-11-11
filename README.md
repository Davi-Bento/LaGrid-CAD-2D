# LaGrid CAD 2D — Editor de Pistas para Seguidor de Linha

O LaGrid CAD 2D é o editor CAD da **Liga LARI — Liga Acadêmica de Robótica e Inovação**, desenvolvido para desenhar, medir e exportar pistas de seguidor de linha. O projeto roda 100% no navegador, sem servidor e sem etapa de build, com unidade base em centímetros, renderização em Canvas 2D e cálculo de percurso por Dijkstra.

**GitHub Pages:** https://davi-bento.github.io/LaGrid-CAD-2D/

## 1. Funcionalidades

### Desenho e geometria

- Linha, arco circular definido por 3 pontos, retângulo e polilinha.
- Círculo com dois modos de criação: pelo centro ou pelos 4 lados (N/L/S/O), com pontos magnéticos nos quadrantes.
- Espiral parametrizável (raio inicial, passo angular, fator, quantidade, subdivisões, direção e âncora).
- Round/fillet com raio de concordância em centímetros.
- Linhas de construção para guias que não são exportadas no PDF.

### Edição

- Seleção por clique, box selection, Ctrl+clique e selecionar tudo.
- Mover por arrasto e mover com precisão (distância + ângulo).
- Copiar/colar com escala, rotação e troca de âncora.
- Trim, extend, join, break, offset, mirror, rotate, scale e array.
- Edição de vértices: arrastar, inserir com duplo clique e remover com Alt+clique.
- Desfazer/refazer com pilha de snapshots.

### Precisão e visualização

- Snap magnético em extremidades, vértices e quadrantes de círculos.
- Snap angular e snap de distância com passo configurável.
- Trava em 90° segurando Shift.
- HUDs de coordenadas polares/absolutas e de parâmetros das ferramentas.
- Grade de 1 cm/10 cm, zoom, pan e encaixe automático da vista.
- Imagem de fundo com opacidade, escala, rotação, ajuste e encaixe na área de trabalho.
- Tema visual inspirado na F1.

### Análise da pista

- Área de trabalho configurável (padrão 285 × 180 cm).
- Deadzone de alerta configurável (padrão 30 cm), com destaque dos trechos fora da margem.
- Alertas de raio crítico em vértices com ângulo abaixo do limite.
- Nós de largada e chegada ligados aos segmentos.
- Comprimento da pista por menor caminho (Dijkstra) ou por perímetro de loop fechado.
- Marcação de vértices para exportar coordenadas no PDF.

### Exportação e persistência

- Salvar e abrir o projeto em arquivo JSON (schema v11, com migração de projetos antigos).
- Exportar o desenho em PDF pela janela de impressão, incluindo opção de página no tamanho exato da área de trabalho em 1:1.
- Gabarito de montagem com exportação em PDF.
- Biblioteca com curvas de pistas famosas e curvas próprias salvas no navegador.

## 2. Estrutura do projeto

```text
Site/
├── index.html
├── style.css
├── app.js
├── gabarito.js
├── js/
│   ├── config.js
│   ├── state.js
│   ├── geometry.js
│   ├── model.js
│   ├── tools.js
│   ├── persistence.js
│   ├── render.js
│   ├── export.js
│   └── ui.js
├── curvas/
│   ├── minhas-curvas.js
│   └── README.md
├── assets/
│   └── lari.svg
├── fonts/
│   └── *.woff2
├── vendor/
│   └── pdf-lib.min.js
├── tests/
│   ├── run-all.js
│   ├── helpers.js
│   └── ... (15 testes)
├── package.json
└── README.md
```

### Organização do código

- `js/config.js`: constantes globais, identidade e chaves de armazenamento.
- `js/state.js`: estado da aplicação, UI, câmera, imagem de fundo e canvas.
- `js/geometry.js`: geometria pura (medidas, interseções, arcos, offset e mirror).
- `js/model.js`: modelo de dados, versão do schema e normalização de vértices.
- `js/tools.js`: ferramentas de desenho e edição, snap, seleção, arrasto e copy/paste.
- `js/persistence.js`: salvamento, carregamento e migração do JSON.
- `js/render.js`: renderização do canvas e funções de desenho.
- `js/export.js`: análise da pista (deadzone, Dijkstra e alertas) e exportação em PDF.
- `js/ui.js`: HUDs, painéis, biblioteca, eventos de mouse/teclado, menus, status e toasts.
- `app.js`: bootstrap da aplicação.

## 3. Como executar

O editor não precisa de instalação nem de build. Basta abrir o arquivo `index.html` em um navegador moderno.

Se preferir servir por HTTP local:

```bash
py -m http.server 8000
```

Depois acesse `http://localhost:8000`.

## 4. Testes automatizados

A suíte usa Playwright e cobre as principais ferramentas e fluxos do editor:

- Desenho, espiral, círculo com quadrantes e snap de distância.
- Biblioteca de curvas, gabarito e imagem de fundo.
- Navegação de HUDs, atalhos e toggles de grade/snap.
- Copiar/colar, arrasto de seleção e edição de vértices.
- Salvamento/carregamento em JSON e exportação em PDF.
- Deadzone, alertas e cálculo por Dijkstra (menor caminho e perímetro de loop).

Para instalar as dependências e rodar tudo:

```bash
npm install
npx playwright install chromium
npm test
```

O runner executa os 15 scripts em sequência e retorna erro se algum falhar.

## 5. Exportação e análise da pista

### Comprimento do percurso

O cálculo pode ser feito de duas formas, selecionáveis no painel "Comprimento da Pista":

- **Menor caminho:** usa Dijkstra no grafo de segmentos entre os nós de largada e chegada.
- **Perímetro do loop:** detecta um ciclo fechado e soma o comprimento dos segmentos do circuito.

### PDF e gabarito

A exportação do desenho é feita em PDF pela janela de impressão do navegador. Além dos formatos A4–A0, há a opção de gerar a página no tamanho exato da área de trabalho em escala 1:1.

O gabarito de montagem é uma vista separada, com desenho, guias e tabela de segmentos, também exportado em PDF.

### Coordenadas de vértices

Cada vértice pode ser marcado para exportar coordenadas no PDF. Vértices não marcados permanecem como referência visual e não entram na tabela.

## 6. Atalhos principais

| Atalho | Ação |
|---|---|
| `V` | Seleção |
| `L` / `A` | Linha / Arco 3 pontos |
| `C` / `B` / `P` | Círculo / Retângulo / Polilinha |
| `Shift+E` | Espiral |
| `R` | Round/Fillet |
| `T` / `E` | Trim / Extend |
| `J` / `K` | Join / Break |
| `O` / `X` | Offset / Mirror |
| `Shift+R` / `Shift+S` / `Shift+A` | Rotate / Scale / Array |
| `Shift+V` | Editar vértice |
| `M` | Mover com precisão |
| `Q` | HUD de coordenadas |
| `Ctrl+1` / `Ctrl+2` | Nó de largada / chegada |
| `F5` | Calcular comprimento da pista |
| `F` / `Home` | Encaixar vista / resetar zoom |
| `F1`–`F4` | Grade / Snap / Snap angular / Snap de distância |
| `Ctrl+Z` / `Ctrl+Y` | Desfazer / refazer |
| `Ctrl+C` / `Ctrl+V` | Copiar / colar |
| `Del` / `Backspace` | Excluir seleção |
| `Esc` | Cancelar ferramenta atual |
| `Enter` | Finalizar linha, polilinha ou colagem |
