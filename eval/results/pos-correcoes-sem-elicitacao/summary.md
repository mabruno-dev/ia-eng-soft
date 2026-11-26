# Avaliação ReacTest-Agent — 2026-11-25

- Workspace: `C:\dev\ia-eng-soft\fixtures\sample-app`
- Modelo: `gpt-4o` · runs por configuração: 1 · maxIterations: 3 · maxAgentSteps: 8
- Arquivo de respostas (C2): `C:\dev\ia-eng-soft\eval\answers.json`
- Componentes: `src/components/Button.tsx`, `src/components/LoginForm.tsx`, `src/components/UserList.tsx`, `src/components/CartSummary.tsx`, `src/components/ThemeToggle.tsx`, `src/components/PasswordField.tsx`
- Total de runs: 12

**Configurações**

- **C1** — baseline estilo v1 (heal=false, elicit=false; Verificador só mede)
- **C2** — pipeline completa (heal=true, elicit=true com answersFile, verify=true)

Valores: média ± desvio-padrão amostral entre os runs. **n/d** = a métrica não existe nos RunRecords (ex.: agente ainda não implementado ou run com ERROR); nenhum valor é estimado.

## Status das execuções

| Componente | Config. | Runs | PASSED | FAILED | SUSPECTED_COMPONENT_BUG | ERROR |
|---|---|---|---|---|---|---|
| Button | C1 | 1 | 0 | 1 | 0 | 0 |
| Button | C2 | 1 | 1 | 0 | 0 | 0 |
| LoginForm | C1 | 1 | 1 | 0 | 0 | 0 |
| LoginForm | C2 | 1 | 0 | 0 | 0 | 1 |
| UserList | C1 | 1 | 0 | 1 | 0 | 0 |
| UserList | C2 | 1 | 1 | 0 | 0 | 0 |
| CartSummary | C1 | 1 | 0 | 1 | 0 | 0 |
| CartSummary | C2 | 1 | 1 | 0 | 0 | 0 |
| ThemeToggle | C1 | 1 | 0 | 1 | 0 | 0 |
| ThemeToggle | C2 | 1 | 0 | 1 | 0 | 0 |
| PasswordField | C1 | 1 | 0 | 1 | 0 | 0 |
| PasswordField | C2 | 1 | 0 | 1 | 0 | 0 |
| **Agregado** | C1 | 6 | 1 | 5 | 0 | 0 |
| **Agregado** | C2 | 6 | 3 | 2 | 0 | 1 |

<details><summary>Erros</summary>

- LoginForm C2 #1 (`20261125T033026546Z-1494e5`): AgentOutputError: Agente "generator.code" produziu uma resposta final inválida mesmo após a tentativa de reparo: ✖ chame typecheck_test com o código final EXATO que vai entregar (e corrija os erros) antes de responder   → at code

</details>

## RQ1 — Corretude

| Componente | Config. | Suítes que compilam e passam | Iterações até o sucesso | Reparos indevidos barrados | Expectativas alinhadas ao comportamento |
|---|---|---|---|---|---|
| Button | C1 | 0,0% (0/1) | n/d | 0,0 | 0,0 |
| Button | C2 | 100,0% (1/1) | 0,0 | 0,0 | 0,0 |
| LoginForm | C1 | 100,0% (1/1) | 0,0 | 0,0 | 0,0 |
| LoginForm | C2 | 0,0% (0/1) | n/d | 0,0 | 0,0 |
| UserList | C1 | 0,0% (0/1) | n/d | 0,0 | 0,0 |
| UserList | C2 | 100,0% (1/1) | 2,0 | 0,0 | 2,0 |
| CartSummary | C1 | 0,0% (0/1) | n/d | 0,0 | 0,0 |
| CartSummary | C2 | 100,0% (1/1) | 1,0 | 0,0 | 1,0 |
| ThemeToggle | C1 | 0,0% (0/1) | n/d | 0,0 | 0,0 |
| ThemeToggle | C2 | 0,0% (0/1) | n/d | 0,0 | 0,0 |
| PasswordField | C1 | 0,0% (0/1) | n/d | 0,0 | 0,0 |
| PasswordField | C2 | 0,0% (0/1) | n/d | 0,0 | 3,0 |
| **Agregado** | C1 | 16,7% (1/6) | 0,0 | 0,0 ± 0,0 | 0,0 ± 0,0 |
| **Agregado** | C2 | 50,0% (3/6) | 1,0 ± 1,0 | 0,0 ± 0,0 | 1,0 ± 1,3 |

_Iterações até o sucesso_: média só entre as suítes que passaram (0 = passou de primeira). _Reparos barrados_: patches recusados pelo guardrail do oráculo (`checkRepair`). _Expectativas alinhadas_: reparos que, sem evidência de defeito do componente, alinharam a expectativa ao comportamento observado (n/d em RunRecords gravados antes desse campo existir).

## RQ2 — Esforço

| Componente | Config. | MR automático (linhas alteradas pelo healing / geradas) | Linhas geradas | Tempo de revisão |
|---|---|---|---|---|
| Button | C1 | 0,0% | 60,0 | a preencher manualmente |
| Button | C2 | 0,0% | 56,0 | a preencher manualmente |
| LoginForm | C1 | 0,0% | 102,0 | a preencher manualmente |
| LoginForm | C2 | n/d | n/d | a preencher manualmente |
| UserList | C1 | 0,0% | 73,0 | a preencher manualmente |
| UserList | C2 | 5,5% | 73,0 | a preencher manualmente |
| CartSummary | C1 | 0,0% | 148,0 | a preencher manualmente |
| CartSummary | C2 | 6,0% | 134,0 | a preencher manualmente |
| ThemeToggle | C1 | 0,0% | 59,0 | a preencher manualmente |
| ThemeToggle | C2 | 0,0% | 68,0 | a preencher manualmente |
| PasswordField | C1 | 0,0% | 75,0 | a preencher manualmente |
| PasswordField | C2 | 42,2% | 64,0 | a preencher manualmente |
| **Agregado** | C1 | 0,0% ± 0,0% | 86,2 ± 34,0 | a preencher manualmente |
| **Agregado** | C2 | 10,7% ± 17,8% | 79,0 ± 31,4 | a preencher manualmente |

> ⚠️ O MR da ReacTest v1 foi medido **manualmente** (edições do desenvolvedor); aqui o MR é **automático** (diff do healing). C1 não tem healing, então seu MR é 0 por construção. Os números não são diretamente comparáveis com o TCC. O tempo de revisão fica **a preencher manualmente**.

## RQ3 — Eficácia

| Componente | Config. | Mutation score | Cobertura de branches | Cobertura de linhas |
|---|---|---|---|---|
| Button | C1 | n/d | 100,0% | 100,0% |
| Button | C2 | n/d | 100,0% | 100,0% |
| LoginForm | C1 | n/d | 96,5% | 100,0% |
| LoginForm | C2 | n/d | n/d | n/d |
| UserList | C1 | n/d | 65,0% | 91,7% |
| UserList | C2 | n/d | 85,0% | 100,0% |
| CartSummary | C1 | n/d | 100,0% | 100,0% |
| CartSummary | C2 | n/d | 100,0% | 100,0% |
| ThemeToggle | C1 | n/d | 50,0% | 100,0% |
| ThemeToggle | C2 | n/d | 50,0% | 100,0% |
| PasswordField | C1 | n/d | 68,4% | 92,8% |
| PasswordField | C2 | n/d | 78,9% | 100,0% |
| **Agregado** | C1 | n/d | 80,0% ± 21,6% | 97,4% ± 4,0% |
| **Agregado** | C2 | n/d | 82,8% ± 20,5% | 100,0% ± 0,0% |

_Cobertura_ do componente-alvo, lida do Jest (suítes que não chegaram a rodar contam 0%). _Mutation score_ vem do Verificador (Stryker).

## RQ4 — Regras de negócio

| Componente | Config. | Perguntas | Respondidas | Casos derivados das respostas | Mutantes mortos em validações | Relevância (Likert) |
|---|---|---|---|---|---|---|
| Button | C1 | n/d | n/d | n/d | n/d | a preencher manualmente |
| Button | C2 | n/d | n/d | n/d | n/d | a preencher manualmente |
| LoginForm | C1 | n/d | n/d | n/d | n/d | a preencher manualmente |
| LoginForm | C2 | n/d | n/d | n/d | n/d | a preencher manualmente |
| UserList | C1 | n/d | n/d | n/d | n/d | a preencher manualmente |
| UserList | C2 | n/d | n/d | n/d | n/d | a preencher manualmente |
| CartSummary | C1 | n/d | n/d | n/d | n/d | a preencher manualmente |
| CartSummary | C2 | n/d | n/d | n/d | n/d | a preencher manualmente |
| ThemeToggle | C1 | n/d | n/d | n/d | n/d | a preencher manualmente |
| ThemeToggle | C2 | n/d | n/d | n/d | n/d | a preencher manualmente |
| PasswordField | C1 | n/d | n/d | n/d | n/d | a preencher manualmente |
| PasswordField | C2 | n/d | n/d | n/d | n/d | a preencher manualmente |
| **Agregado** | C1 | n/d | n/d | n/d | n/d | a preencher manualmente |
| **Agregado** | C2 | n/d | n/d | n/d | n/d | a preencher manualmente |

_Mutantes mortos em validações_: o RunRecord ainda não detalha mutantes por cenário, por isso fica n/d. A relevância das regras (Likert) fica **a preencher manualmente**.

## RQ5 — Custo

| Componente | Config. | Tokens de entrada | Tokens de saída | Chamadas ao LLM | Tempo total (s) |
|---|---|---|---|---|---|
| Button | C1 | 20871 | 3236 | 9,0 | 32,2 |
| Button | C2 | 20011 | 3115 | 9,0 | 29,7 |
| LoginForm | C1 | 72886 | 9713 | 14,0 | 66,1 |
| LoginForm | C2 | 72415 | 9826 | 12,0 | 58,8 |
| UserList | C1 | 38886 | 4490 | 12,0 | 37,0 |
| UserList | C2 | 60832 | 9077 | 20,0 | 78,0 |
| CartSummary | C1 | 56794 | 9159 | 13,0 | 66,2 |
| CartSummary | C2 | 88334 | 14812 | 20,0 | 97,3 |
| ThemeToggle | C1 | 23683 | 3024 | 10,0 | 26,6 |
| ThemeToggle | C2 | 88052 | 8544 | 17,0 | 72,6 |
| PasswordField | C1 | 22611 | 3544 | 9,0 | 29,6 |
| PasswordField | C2 | 64794 | 10785 | 22,0 | 85,5 |
| **Agregado** | C1 | 39289 ± 21430 | 5528 ± 3074 | 11,2 ± 2,1 | 43,0 ± 18,3 |
| **Agregado** | C2 | 65740 ± 25175 | 9360 ± 3787 | 16,7 ± 5,1 | 70,3 ± 23,7 |

**Passos e chamadas de ferramenta por agente (agregado, por run)**

| Agente | C1 passos | C1 tool calls | C2 passos | C2 tool calls |
|---|---|---|---|---|
| Contexto | 4,8 ± 0,8 | 6,0 ± 2,8 | 5,0 ± 1,1 | 6,2 ± 3,1 |
| Elicitação | n/d | n/d | n/d | n/d |
| Gerador/plano | 1,0 ± 0,0 | 0,0 ± 0,0 | 1,0 ± 0,0 | 0,0 ± 0,0 |
| Gerador/código | 3,3 ± 1,6 | 3,0 ± 1,3 | 3,3 ± 1,5 | 3,3 ± 1,2 |
| Executor | 2,0 ± 0,0 | 1,0 ± 0,0 | 3,7 ± 2,9 | 1,8 ± 1,5 |
| Reparador | n/d | n/d | 3,7 ± 3,0 | 2,7 ± 2,1 |
| Verificador | n/d | n/d | n/d | n/d |

**Tempo por agente (s, agregado, por run em que o agente rodou)**

| Agente | C1 | C2 |
|---|---|---|
| Contexto | 6,4 ± 1,2 | 6,1 ± 1,9 |
| Elicitação | n/d | n/d |
| Gerador | 27,3 ± 14,7 | 27,5 ± 15,9 |
| Executor | 9,3 ± 3,8 | 16,2 ± 9,2 |
| Reparador | n/d | 34,9 ± 6,5 |
| Verificador | n/d | n/d |

_Passos_ = chamadas ao LLM dentro do loop do agente; detalhes por componente e por run em `runs.csv`.
