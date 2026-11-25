# ia-eng-soft
Trabalho final da disciplina de mestrado em computação UFF de IA Generativa para engenharia de software

## ReacTest-Agent

Extensão do VS Code + CLI que gera testes Jest + React Testing Library por uma pipeline de 6 agentes de IA
(Contexto → Elicitação → Gerador → Executor ⇄ Reparador → Verificador). Detalhes em [CLAUDE.md](CLAUDE.md).

```
npm run build
npm test
npm run cli -- <componente> --workspace <dir> [--no-heal] [--no-elicit] [--no-verify] [--max-iter 3] [--model gpt-4o] [--provider openai|claude-cli] [--answers eval/answers.json] [--exclude-mutators StringLiteral]
npm run eval -- [--only LoginForm] [--runs 1] [--resume [dir]]
```

- **Modelo padrão:** `gpt-4o` (provider `openai`, chave em `OPENAI_API_KEY`). Troque com `--model`, a variável
  `OPENAI_MODEL` ou, na extensão, a configuração `reactest.model`.
- **Verificador (mutação):** os 6 agentes estão implementados. Com `verify` ligado e a suíte **PASSED**, o
  Verificador roda o Stryker do workspace só no arquivo do componente (`--mutate`), só com o teste gerado (jest,
  `coverageAnalysis: perTest`, concorrência 2, timeout total de 300 s), com config/relatório/temp em
  `.reactest/stryker/<runId>/` (ignorado pelo git). O score, os mortos e o total vêm do relatório JSON do Stryker;
  o LLM só sugere até 3 casos ligados a mutantes sobreviventes reais (`RunRecord.verification.suggestions`), sem
  alterar o teste. SUSPECTED_COMPONENT_BUG/FAILED não acionam o Verificador. Se o Stryker não rodar, a mutação fica
  n/d e o run segue. Na avaliação, C1 mede a mutação sem sugestões. Se a mutação ficar lenta, desative mutators
  com `--exclude-mutators StringLiteral`.
- **Elicitação não interativa:** `--answers <arquivo.json>` (formato por componente, ver `eval/answers.json`).
- **Avaliação:** um erro de infraestrutura (sem créditos/HTTP 429, chave recusada/HTTP 401, rede) aborta a avaliação
  sem gravar o run; retome com `npm run eval -- --resume <dir>` (runs com status ERROR são refeitos).
- **Avaliação com o Copilot (sem créditos de API):** na Extension Development Host (F5), rode
  "ReacTest: Listar modelos do Copilot" (lista os modelos e testa tool calling) e depois
  "ReacTest: Rodar avaliação (Copilot)". Lê `eval/config.json`/`eval/answers.json` da raiz do repo, grava em
  `eval/results/<data-hora>` e mostra os tokens por run e acumulados. O modelo vem de `reactest.model`
  (family do Copilot); vazio = escolha num QuickPick (famílias "mini" só com `reactest.allowMiniModels`). Limite de taxa: novas tentativas
  após 20 s, 60 s e 120 s; cota/sem modelo/limite persistente abortam sem gravar o run.
- **Claude Code (assinatura, sem chave de API):** `--provider claude-cli [--model sonnet]` no CLI, ou
  `reactest.provider = "claude-cli"` / o comando "ReacTest: Gerar testes (Claude CLI)" na extensão (componente do
  editor ativo, cura e elicitação ligadas). Usa o `claude` do PATH (build nativo; faça login uma vez) em modo headless
  (`-p --output-format json --no-session-persistence --tools ""`), numa pasta temporária vazia, uma chamada por vez,
  timeout de 180 s. Se o filtro de segurança do Claude recusar ("safeguards … reasoning_extraction"), faz 1 nova
  tentativa e depois usa o modelo de fallback (`--fallback-model` / `reactest.fallbackModel`, padrão `opus`); o modelo
  de cada chamada e o texto bruto das recusas ficam no `.trace.jsonl`. O tool calling é emulado: o prompt traz system, histórico e ferramentas, e o modelo responde só
  em JSON (`{"toolCalls":[...]}` ou `{"text":...}`). Tokens e custo vêm do `usage` do CLI; sem ele, são marcados
  como estimados.
