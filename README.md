# ia-eng-soft
Trabalho final da disciplina de mestrado em computação UFF de IA Generativa para engenharia de software

## ReacTest-Agent

Extensão do VS Code + CLI que gera testes Jest + React Testing Library por uma pipeline de 6 agentes de IA
(Contexto → Elicitação → Gerador → Executor ⇄ Reparador → Verificador). Detalhes em [CLAUDE.md](CLAUDE.md).

```
npm run build
npm test
npm run cli -- <componente> --workspace <dir> [--no-heal] [--no-elicit] [--no-verify] [--max-iter 3] [--model gpt-4o] [--answers eval/answers.json]
npm run eval -- [--only LoginForm] [--runs 1] [--resume [dir]]
```

- **Modelo padrão:** `gpt-4o` (provider `openai`, chave em `OPENAI_API_KEY`). Troque com `--model`, a variável
  `OPENAI_MODEL` ou, na extensão, a configuração `reactest.model`.
- **Elicitação não interativa:** `--answers <arquivo.json>` (formato por componente, ver `eval/answers.json`).
- **Avaliação:** um erro de infraestrutura (sem créditos/HTTP 429, chave recusada/HTTP 401, rede) aborta a avaliação
  sem gravar o run; retome com `npm run eval -- --resume <dir>` (runs com status ERROR são refeitos).
- **Avaliação com o Copilot (sem créditos de API):** na Extension Development Host (F5), rode
  "ReacTest: Listar modelos do Copilot" (lista os modelos e testa tool calling) e depois
  "ReacTest: Rodar avaliação (Copilot)". Lê `eval/config.json`/`eval/answers.json` da raiz do repo, grava em
  `eval/results/<data-hora>` e mostra os tokens por run e acumulados. O modelo vem de `reactest.model`
  (family do Copilot); vazio = primeiro modelo que passar no teste de tool calling. Limite de taxa: novas tentativas
  após 20 s, 60 s e 120 s; cota/sem modelo/limite persistente abortam sem gravar o run.
