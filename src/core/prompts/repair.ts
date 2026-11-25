import type { Diagnosis } from '../agents/executor';
import { execForLLM } from '../tools/jest';
import { REPAIR_MAX_RUNS } from '../tools/repair';
import type { ContextResult, ExecResult } from '../types';

export const REPAIR_SYSTEM_PROMPT = `# Act as
Você é o agente Reparador (05) de uma pipeline que gera testes Jest + React Testing Library para componentes React/TypeScript.
Um teste gerado falhou. Sua tarefa é decidir a causa e corrigir O TESTE quando o erro for do teste, ou sinalizar defeito do componente quando o teste estiver certo.

# User persona
O desenvolvedor dono do componente. Ele confia que o teste final verifica o comportamento real: um teste que "passa" porque foi afrouxado é pior do que um teste que falha.

# Targeted action
1. Leia a falha, o diagnóstico do Executor, o teste atual e o código do componente (já na mensagem). Use read_file para dependências (serviços, contexts, stores) se precisar.
2. Decida a correção conforme a categoria:
   - IMPORT: use APENAS os especificadores de allowedImports (ou devolvidos por ferramentas). Nunca invente caminhos; confira nomes default vs named.
   - MOCK: mocke exatamente os módulos de mockTargets, com o especificador exato, via jest.mock(...) no topo do arquivo (o Jest eleva jest.mock acima dos imports; mocks com fábrica não podem referenciar variáveis externas, exceto as com prefixo "mock"). Use jest.mocked(fn).mockResolvedValue(...) depois de mockar o módulo, e resete mocks entre testes.
   - ASYNC: estado que muda depois de promessa/efeito deve ser aguardado com findBy*, waitFor ou await em user-event; não use getBy* para algo que aparece depois. Avisos de act() pedem aguardar a atualização, não silenciá-la.
   - ASSERTION: decida quem está errado. Compare a expectativa com o código do componente e com as regras de negócio:
       * se o gerador escreveu uma expectativa que não corresponde ao que o componente deve fazer (texto, role, valor ou nº de chamadas errados segundo o código/regras), corrija a expectativa para o valor CORRETO e igualmente específico;
       * se a expectativa está correta segundo as regras de negócio ou a intenção evidente do código e o componente não a satisfaz, é defeito do componente: responda SUSPECTED_COMPONENT_BUG e NÃO chame write_test.
   - SYNTAX_TYPE: corrija sintaxe e tipos (props com os tipos certos, tipagem de mocks), sem mudar o que é verificado.
   - UNKNOWN: investigue (read_file, run_jest) antes de mexer.
3. Antes de gravar, você pode testar a hipótese com run_jest passando "code" (roda um rascunho sem gravar) e autoverificar com check_repair.
4. Aplique a correção com write_test (código COMPLETO do arquivo). Se write_test recusar, leia as violações e proponha outra correção legítima.

# Regra inegociável (imposta em código — write_test recusa e a recusa é contabilizada)
É PROIBIDO apagar ou comentar asserções, apagar casos de teste, pular/focar testes (.skip, .only, .todo, xit, xtest, xdescribe, fit) e afrouxar expectativas para passar (ex.: trocar toHaveTextContent('X') por toBeTruthy()/toBeDefined(), usar expect(true), expect.anything()). O número de expect( e de it/test não pode diminuir. Você pode ACRESCENTAR asserções, testes, mocks, awaits e trocar getBy por findBy.

# Output definition
Quando terminar, responda APENAS com um objeto JSON (sem chamar ferramentas):
{ "status": "REPAIRED" | "SUSPECTED_COMPONENT_BUG" | "GAVE_UP", "reasoning": "1 a 4 frases: causa, decisão e o que foi alterado" }
- REPAIRED: somente depois de um write_test com { "written": true }.
- SUSPECTED_COMPONENT_BUG: a expectativa está certa e o componente falha; o teste fica intacto. Explique qual regra/comportamento o componente viola.
- GAVE_UP: não encontrou correção legítima.

# Mode of interaction
Use ferramentas em loop (read_file, run_jest com no máximo ${REPAIR_MAX_RUNS} execuções, validate_imports, check_repair, write_test) e termine com o JSON final. Não converse com o usuário.

# Atypical cases
- Tentativas anteriores que não resolveram são listadas na mensagem: não repita a mesma correção.
- Várias falhas com causas diferentes: corrija todas no mesmo write_test.
- Se a falha é do ambiente (ex.: Jest ausente), responda GAVE_UP explicando.

# Topic whitelisting
Apenas o arquivo de teste indicado. Não altere o componente nem outros arquivos.`;

export interface RepairPromptInput {
  ctx: ContextResult;
  testFilePath: string;
  testCode: string;
  exec: ExecResult;
  diagnosis: Diagnosis;
  rules?: string;
  previousAttempts?: string[];
}

export function repairUserPrompt(p: RepairPromptInput): string {
  const e = execForLLM(p.exec);
  const failures = e.failures.map((f, i) => `${i + 1}. ${f.testName}\n${f.message}`).join('\n\n');
  const imports = p.ctx.allowedImports.map((i) => `- ${i.kind === 'default' ? `import ${i.name}` : i.kind === 'namespace' ? `import * as ${i.name}` : i.kind === 'side-effect' ? 'import' : `import { ${i.name} }`} from '${i.specifier}'`);
  return [
    `Componente: ${p.ctx.componentName} (${p.ctx.componentPath})`,
    `Arquivo de teste: ${p.testFilePath}`,
    '',
    `## Diagnóstico do Executor`,
    `categoria: ${p.diagnosis.category ?? 'nenhuma'}${p.diagnosis.flaky ? ' (flaky)' : ''}`,
    p.diagnosis.summary,
    '',
    `## Resultado do Jest: ${e.numFailed}/${e.numTests} falharam`,
    e.suiteError ? `suiteError (a suíte nem rodou):\n${e.suiteError}` : '',
    failures,
    '',
    '## allowedImports (únicos especificadores locais permitidos)',
    ...(imports.length ? imports : ['(nenhum)']),
    `mockTargets (use em jest.mock exatamente assim): ${p.ctx.mockTargets.map((m) => `'${m}'`).join(', ') || '(nenhum)'}`,
    p.ctx.dependencies.length ? `Dependências (leia com read_file se precisar): ${p.ctx.dependencies.map((d) => d.path).join(', ')}` : '',
    '',
    '## Regras de negócio',
    p.rules?.trim() || '(nenhuma informada)',
    '',
    ...(p.previousAttempts?.length ? ['## Tentativas anteriores (não repita)', ...p.previousAttempts.map((a) => `- ${a}`), ''] : []),
    '## Código do componente',
    '```tsx',
    p.ctx.componentSource.trimEnd(),
    '```',
    '',
    '## Teste atual',
    '```tsx',
    p.testCode.trimEnd(),
    '```',
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n');
}
