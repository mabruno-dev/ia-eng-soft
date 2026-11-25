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
