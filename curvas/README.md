# Minhas curvas

Pasta para guardar curvas próprias do LaGrid CAD 2D em forma de código.

## Como adicionar uma curva

1. No editor, desenhe ou insira a curva.
2. Selecione os trechos (linhas, arcos e círculos).
3. Abra a **Biblioteca de Curvas** (botão **LIB**).
4. Em **Minhas curvas**, dê um nome, informe a pista e clique em **Salvar seleção**.
5. O cartão aparece com o selo **MEU**.
6. Clique em **Código** no cartão e depois em **Baixar .js** (ou **Baixar todas**).
7. Cole o conteúdo no fim de `curvas/minhas-curvas.js`.
8. Recarregue o editor: a curva passa a existir sempre, sem depender do navegador.

## Importar pelo site

Na janela da biblioteca, use **Importar .js** e escolha um arquivo gerado pelo
editor. As curvas são validadas e copiadas para o `localStorage`, continuando
disponíveis após recarregar a página até o navegador ser limpo/resetado.

## Observações

- Curvas salvas pelo site ficam no `localStorage` (chave legada `linetrack.curveLibrary.v1`).
- Curvas definidas neste arquivo têm prioridade se o `id` for igual.
- O bloco gerado usa `libPt(x, y)` com Y para cima, igual às curvas nativas.
