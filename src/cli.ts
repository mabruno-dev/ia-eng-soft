import { Command } from 'commander';

// Esqueleto do CLI: a pipeline será conectada nas próximas etapas.
const program = new Command()
  .name('reactest')
  .description('Gera testes Jest + RTL para um componente React com pipeline agêntica.')
  .argument('<component>', 'caminho do componente (.tsx)')
  .option('--workspace <dir>', 'raiz do workspace do app React', process.cwd())
  .option('--no-heal', 'desativa o self-healing (Executor ⇄ Reparador)')
  .option('--no-elicit', 'desativa a elicitação de regras de negócio')
  .option('--no-verify', 'desativa o Verificador (mutation testing / smells)')
  .option('--max-iter <n>', 'máximo de iterações de reparo', (v: string) => Number.parseInt(v, 10), 3)
  .action((component: string, opts: Record<string, unknown>) => {
    console.log('ReacTest-Agent: pipeline ainda não implementada.');
    console.log(JSON.stringify({ component, ...opts }, null, 2));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
