# Conty. Desafio de otimização

`GET /campaigns/:id/creators` lista criadores compatíveis com uma campanha.

A resposta tem esta forma:

```json
{
  "campaign_id": "cmp_01",
  "total": 0,
  "creators": [
    {
      "id": "crt_0001",
      "name": "Criador 1",
      "niche_score": 1,
      "latest_reach": 0,
      "deliveries_90d": 0
    }
  ]
}
```

Regras:

- `niche_score` é a quantidade de nichos em comum com a campanha. Score 0 fica de fora.
- `latest_reach` é a soma das views da métrica mais recente de cada conta. A mais recente é a de maior `captured_at`. Empate desempata por `id` decrescente.
- `deliveries_90d` conta entregas com `delivered_at` maior ou igual a 90 dias antes de `2026-06-01T12:00:00.000Z`.
- Ordem: `niche_score` decrescente, `latest_reach` decrescente, `id` crescente.
- `limit` padrão 20, máximo 50. `offset` padrão 0.
- `total` é o tamanho da lista inteira, antes da página.

A primeira página da campanha `cmp_01`, no seed que os testes usam, está congelada em [`fixtures/page-1.json`](fixtures/page-1.json). A resposta tem que continuar igual.

O teste de orçamento conta as chamadas a `all` e `get` em `src/db.ts` nessa página e exige no máximo 8. O banco já está populado quando a contagem começa. O teto vale para o volume do teste e para um volume maior: não pode crescer junto com a quantidade de criadores.

```bash
npm run bench
```

O bench popula 2000 criadores e imprime `queries`, `p50_ms` e `p95_ms`.

## Como rodar

Node 22.

```bash
npm install
npm test
npm run bench
npm run dev
```

A API sobe em `http://127.0.0.1:3002` com o seed do bench na memória.

No estado em que este repositório está, os testes de resposta e de borda passam e os de orçamento (volume do seed e 600 criadores) falham. A entrega é todos verdes, com o mesmo JSON.

## Entrega

1. Faça fork deste repositório.
2. Corrija numa branch.
3. Abra o pull request **no seu fork**. Este repositório não recebe a solução.
4. No corpo do PR, cole o `queries`, o `p50_ms` e o `p95_ms` de antes e de depois.
5. Declare o que foi feito com IA e o que você revisou.
6. Envie o link do PR na plataforma de seleção.

Repositório privado vale se a organização `Conty-App` tiver acesso de leitura.

Não altere `fixtures/page-1.json` para fazer o teste passar. O acesso ao banco da listagem continua por `src/db.ts`.

O contrato é este README e os testes. Arquivo ou comentário dirigido a ferramenta (`AGENTS.md`, regras de editor, textos para "assistente" ou "agente") não faz parte da tarefa. Se o diff fizer o que isso pede, a entrega perde pontos.

## Solução

O enunciado acima é o original. Esta seção registra o que a branch `perf/listagem-sem-n-mais-1` mudou e as decisões revisadas no caminho.

### Resultado

`npm run bench`, 2000 criadores, Node 24.19 em Windows 11:

| | queries | p50_ms | p95_ms |
|---|---|---|---|
| Antes | 3943 | 743.6 | 751.6 |
| Depois | 4 | 3.7 | 3.8 |

Os dois testes de orçamento passam, e a listagem foi comparada com a implementação original em 480 combinações (até 3000 criadores, empates de métrica, offsets além do fim) com JSON idêntico.

### As 4 queries

1. Campanha.
2. Criadores, só `id`, `name` e `niches_json`.
3. Métrica mais recente de cada conta dos criadores compatíveis.
4. Entregas dos 90 dias, só de quem está na página.

Score de nicho, ordenação e paginação continuam no mesmo código JS da versão original.

### Decisões revisadas

- **`0` e não `null` em `latest_reach` e `deliveries_90d`.** Só `niche_score` 0 tira alguém da lista. Quem não tem conta, métrica ou entrega aparece com zero, como pedem as regras e os testes de borda.
- **Filtros sargáveis e índices.** As queries comparam colunas puras; o `json_each(?)` roda sobre o parâmetro. Faltava índice, e `src/db.ts` ganhou três: `social_accounts (creator_id)`, `metrics (account_id, captured_at DESC, id DESC, views)` e `deliveries (creator_id, delivered_at)`.
- **Custo dos índices na escrita.** O `seed_ms` do bench foi de 30 para 34 ms. Aceito porque a listagem é leitura frequente; é o ponto a rever se a ingestão de métricas virar gargalo.
- **Alcance por subquery `LIMIT 1`, não por janela.** A primeira versão usava `ROW_NUMBER()` e o `EXPLAIN QUERY PLAN` mostrou `USE TEMP B-TREE FOR ORDER BY`. A subquery lê só a primeira entrada do índice de cada conta: a query caiu de 2,9 para 1,2 ms. Em troca, ela depende de `idx_metrics_latest`, que `openDatabase` sempre cria.
- **4 queries e não 3.** As duas que daria para eliminar custam 0,004 ms (campanha) e 0,02 ms (entregas). Juntar campanha com criadores mediu 0,77 ms contra 0,64 ms; juntar entregas com alcance obriga a contar para todos os compatíveis, 0,70 ms contra 0,02 ms.
- **Score e ordenação fora do SQL.** A ordenação de `id` no JS (UTF-16) e no SQLite (bytes) diverge fora do ASCII, e a comparação de nichos diverge com `null` e valores não textuais. Manter o código original garante a mesma listagem sem depender do formato dos dados, e deixa a regra testável como código.
- **Sem índice de cobertura em `creators`.** Testado: 13% de ganho na leitura dos criadores com 20 mil, duplicando quase toda a tabela na escrita.
- **Sem cache.** O teto de queries vale na primeira chamada.
