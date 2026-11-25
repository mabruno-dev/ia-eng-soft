import { z } from 'zod';
import type { AgentTool } from '../agent/runtime';
import { validateImports } from '../importValidator';
import type { ContextResult } from '../types';

/** Ferramenta `validate_imports`: confere se todo módulo referenciado no código do teste existe. */
export function validateImportsTool(ctx: ContextResult, workspaceRoot: string): AgentTool<{ code: string }> {
  return {
    spec: {
      name: 'validate_imports',
      description:
        'Valida os imports, require e jest.mock do código de teste: cada módulo precisa resolver para arquivo existente, ' +
        'ser dependência do package.json, builtin do Node ou constar em allowedImports. Devolve os não resolvidos com a linha.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'Código completo do arquivo de teste' } },
        required: ['code'],
        additionalProperties: false,
      },
    },
    argsSchema: z.object({ code: z.string() }),
    run: async ({ code }) => validateImports(code, ctx, workspaceRoot),
  };
}
