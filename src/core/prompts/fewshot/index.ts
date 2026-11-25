import { contextComponentExample } from './contextComponent';
import { formWithApiExample } from './formWithApi';
import type { FewShotExample } from './types';

export type { FewShotExample } from './types';
export const FEW_SHOT_EXAMPLES: FewShotExample[] = [formWithApiExample, contextComponentExample];

function renderExample(ex: FewShotExample, i: number): string {
  const files = ex.files.map((f) => `Arquivo src/${f.path}:\n\`\`\`tsx\n${f.source.trimEnd()}\n\`\`\``).join('\n\n');
  return [
    `### Exemplo ${i + 1}: ${ex.title}`,
    files,
    `Arquivo de teste: src/${ex.test.path}`,
    `allowedImports: ${JSON.stringify(ex.allowedImports)}`,
    `mockTargets: ${JSON.stringify(ex.mockTargets)}`,
    `Plano: ${ex.plan.map((s) => `[${s.kind}] ${s.name}`).join('; ')}`,
    `Teste de referência (passa no Jest):\n\`\`\`tsx\n${ex.test.code.trimEnd()}\n\`\`\``,
  ].join('\n\n');
}

/** Bloco de exemplos few-shot para o prompt do Gerador. */
export function renderFewShot(examples: FewShotExample[] = FEW_SHOT_EXAMPLES): string {
  return examples.map(renderExample).join('\n\n');
}
