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
| LoginForm | C1 | 1 | 0 | 1 | 0 | 0 |
| LoginForm | C2 | 1 | 1 | 0 | 0 | 0 |
| UserList | C1 | 1 | 0 | 1 | 0 | 0 |
| UserList | C2 | 1 | 1 | 0 | 0 | 0 |
| CartSummary | C1 | 1 | 0 | 1 | 0 | 0 |
| CartSummary | C2 | 1 | 0 | 1 | 0 | 0 |
| ThemeToggle | C1 | 1 | 0 | 1 | 0 | 0 |
| ThemeToggle | C2 | 1 | 0 | 1 | 0 | 0 |
| PasswordField | C1 | 1 | 0 | 1 | 0 | 0 |
| PasswordField | C2 | 1 | 0 | 0 | 1 | 0 |
| **Agregado** | C1 | 6 | 0 | 6 | 0 | 0 |
| **Agregado** | C2 | 6 | 3 | 2 | 1 | 0 |

## RQ1 — Corretude

| Componente | Config. | Suítes que compilam e passam | Iterações até o sucesso | Reparos indevidos barrados |
|---|---|---|---|---|
| Button | C1 | 0,0% (0/1) | n/d | 0,0 |
| Button | C2 | 100,0% (1/1) | 1,0 | 0,0 |
| LoginForm | C1 | 0,0% (0/1) | n/d | 0,0 |
| LoginForm | C2 | 100,0% (1/1) | 1,0 | 0,0 |
| UserList | C1 | 0,0% (0/1) | n/d | 0,0 |
| UserList | C2 | 100,0% (1/1) | 2,0 | 0,0 |
| CartSummary | C1 | 0,0% (0/1) | n/d | 0,0 |
| CartSummary | C2 | 0,0% (0/1) | n/d | 0,0 |
| ThemeToggle | C1 | 0,0% (0/1) | n/d | 0,0 |
| ThemeToggle | C2 | 0,0% (0/1) | n/d | 0,0 |
| PasswordField | C1 | 0,0% (0/1) | n/d | 0,0 |
| PasswordField | C2 | 0,0% (0/1) | n/d | 0,0 |
| **Agregado** | C1 | 0,0% (0/6) | n/d | 0,0 ± 0,0 |
| **Agregado** | C2 | 50,0% (3/6) | 1,3 ± 0,6 | 0,0 ± 0,0 |

_Iterações até o sucesso_: média só entre as suítes que passaram (0 = passou de primeira). _Reparos barrados_: patches recusados pelo guardrail do oráculo (`checkRepair`).

## RQ2 — Esforço

| Componente | Config. | MR automático (linhas alteradas pelo healing / geradas) | Linhas geradas | Tempo de revisão |
|---|---|---|---|---|
| Button | C1 | 0,0% | 78,0 | a preencher manualmente |
| Button | C2 | 1,3% | 79,0 | a preencher manualmente |
| LoginForm | C1 | 0,0% | 105,0 | a preencher manualmente |
| LoginForm | C2 | 15,5% | 103,0 | a preencher manualmente |
| UserList | C1 | 0,0% | 67,0 | a preencher manualmente |
| UserList | C2 | 33,3% | 69,0 | a preencher manualmente |
| CartSummary | C1 | 0,0% | 112,0 | a preencher manualmente |
| CartSummary | C2 | 8,0% | 100,0 | a preencher manualmente |
| ThemeToggle | C1 | 0,0% | 66,0 | a preencher manualmente |
| ThemeToggle | C2 | 28,4% | 67,0 | a preencher manualmente |
| PasswordField | C1 | 0,0% | 55,0 | a preencher manualmente |
| PasswordField | C2 | 0,0% | 56,0 | a preencher manualmente |
| **Agregado** | C1 | 0,0% ± 0,0% | 80,5 ± 23,0 | a preencher manualmente |
| **Agregado** | C2 | 14,4% ± 14,0% | 79,0 ± 18,9 | a preencher manualmente |

> ⚠️ O MR da ReacTest v1 foi medido **manualmente** (edições do desenvolvedor); aqui o MR é **automático** (diff do healing). C1 não tem healing, então seu MR é 0 por construção. Os números não são diretamente comparáveis com o TCC. O tempo de revisão fica **a preencher manualmente**.

## RQ3 — Eficácia

| Componente | Config. | Mutation score | Cobertura de branches | Cobertura de linhas |
|---|---|---|---|---|
| Button | C1 | n/d | 0,0% | 0,0% |
| Button | C2 | n/d | 100,0% | 100,0% |
| LoginForm | C1 | n/d | 0,0% | 0,0% |
| LoginForm | C2 | n/d | 96,5% | 100,0% |
| UserList | C1 | n/d | 65,0% | 91,7% |
| UserList | C2 | n/d | 85,0% | 100,0% |
| CartSummary | C1 | n/d | 0,0% | 0,0% |
| CartSummary | C2 | n/d | 100,0% | 100,0% |
| ThemeToggle | C1 | n/d | 50,0% | 100,0% |
| ThemeToggle | C2 | n/d | 50,0% | 100,0% |
| PasswordField | C1 | n/d | 63,1% | 92,8% |
| PasswordField | C2 | n/d | 47,4% | 92,8% |
| **Agregado** | C1 | n/d | 29,7% ± 32,9% | 47,4% ± 52,0% |
| **Agregado** | C2 | n/d | 79,8% ± 24,8% | 98,8% ± 2,9% |

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
| Button | C1 | 18266 | 3168 | 9,0 | 41,5 |
| Button | C2 | 34492 | 6118 | 16,0 | 52,0 |
| LoginForm | C1 | 33463 | 3944 | 12,0 | 35,2 |
| LoginForm | C2 | 106891 | 15908 | 20,0 | 139,1 |
| UserList | C1 | 30345 | 2890 | 12,0 | 27,4 |
| UserList | C2 | 70674 | 9498 | 22,0 | 89,3 |
| CartSummary | C1 | 35678 | 4206 | 11,0 | 40,0 |
| CartSummary | C2 | 113852 | 16047 | 30,0 | 133,8 |
| ThemeToggle | C1 | 28025 | 2384 | 12,0 | 24,4 |
| ThemeToggle | C2 | 110076 | 13403 | 30,0 | 124,6 |
| PasswordField | C1 | 21886 | 2372 | 10,0 | 23,6 |
| PasswordField | C2 | 43100 | 5442 | 13,0 | 61,0 |
| **Agregado** | C1 | 27944 ± 6729 | 3161 ± 775 | 11,0 ± 1,3 | 32,0 ± 7,9 |
| **Agregado** | C2 | 79848 ± 35477 | 11069 ± 4739 | 21,8 ± 7,1 | 100,0 ± 38,0 |

**Passos e chamadas de ferramenta por agente (agregado, por run)**

| Agente | C1 passos | C1 tool calls | C2 passos | C2 tool calls |
|---|---|---|---|---|
| Contexto | 5,3 ± 0,8 | 6,2 ± 3,1 | 5,8 ± 0,8 | 6,0 ± 2,8 |
| Elicitação | n/d | n/d | n/d | n/d |
| Gerador/plano | 1,0 ± 0,0 | 0,0 ± 0,0 | 1,2 ± 0,4 | 0,0 ± 0,0 |
| Gerador/código | 2,7 ± 0,5 | 3,0 ± 1,1 | 2,7 ± 0,5 | 3,0 ± 1,1 |
| Executor | 2,0 ± 0,0 | 1,0 ± 0,0 | 5,3 ± 2,4 | 2,7 ± 1,2 |
| Reparador | n/d | n/d | 6,8 ± 3,9 | 5,3 ± 3,3 |
| Verificador | n/d | n/d | n/d | n/d |

**Tempo por agente (s, agregado, por run em que o agente rodou)**

| Agente | C1 | C2 |
|---|---|---|
| Contexto | 6,6 ± 1,6 | 6,0 ± 0,5 |
| Elicitação | n/d | n/d |
| Gerador | 15,2 ± 3,4 | 15,4 ± 2,5 |
| Executor | 10,2 ± 4,2 | 21,4 ± 10,5 |
| Reparador | n/d | 57,2 ± 31,0 |
| Verificador | n/d | n/d |

_Passos_ = chamadas ao LLM dentro do loop do agente; detalhes por componente e por run em `runs.csv`.
