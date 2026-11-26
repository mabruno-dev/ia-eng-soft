# Resultados da avaliação (C1 × C2)

Execuções em lote de `npm run eval` sobre `fixtures/sample-app` (6 componentes: Button, LoginForm, UserList,
CartSummary, ThemeToggle, PasswordField), provedor **OpenAI `gpt-4o`**, **runs=1** por configuração,
maxIterations 3, maxAgentSteps 8. C1 = baseline estilo v1 (sem healing, sem elicitação); C2 = pipeline completa.
Cada pasta tem o `summary.md` (tabelas RQ1–RQ5) e os RunRecords em `records/`. Traces (`.trace.jsonl`),
`runs.csv` e execuções inválidas não são versionados.

O commit de cada pasta foi identificado pelo horário dos `runId` (UTC) comparado ao horário dos commits (UTC−3).

## `baseline-antes-correcoes/`

- Código: **antes das correções de `3e64cc3`** (árvore de trabalho sobre `48229dc`, com o runner de avaliação
  ainda não commitado; ele entrou em `4c84e4e`). Runs entre 03:03 e 03:15 UTC de 25/11/2026.
- 12 runs. Status: C1 0/6 PASSED; C2 3/6 PASSED, 2 FAILED, 1 SUSPECTED_COMPONENT_BUG.
- ⚠️ **Button C1 está contaminada por uma execução concorrente**. Trate esta pasta como **11 execuções válidas**:

## `pos-correcoes-sem-elicitacao/`

- Código: **`4c84e4e`** (com as correções de `3e64cc3`). Runs entre 03:28 e 03:38 UTC de 25/11/2026.
- 12 runs. Status: C1 1/6 PASSED; C2 3/6 PASSED, 2 FAILED, 1 ERROR (LoginForm C2: resposta final inválida do
  `generator.code`, detalhada no `summary.md`).
- "Sem elicitação": o agente de Elicitação (`41e22c7`) ainda não existia, então RQ4 é n/d em C2.

## Observações comuns

- Mutation score é **n/d** nas duas pastas: o Verificador (Stryker) só foi implementado depois (`0376ad1`).
- Tempo de revisão (RQ2) e relevância Likert (RQ4) ficam a preencher manualmente.
