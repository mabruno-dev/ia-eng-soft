import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../types';
import { cleanMessage, clip, coverageFor, execForLLM, findJestBin, JestNotFoundError, parseJestJson, runJest, runJestTool, stripAnsi } from './jest';

const ZERO = { statements: 0, branches: 0, functions: 0, lines: 0 };

describe('parse do resultado do Jest', () => {
  it('stripAnsi e cleanMessage removem cores e frames de node_modules', () => {
    expect(stripAnsi('\u001b[31mexpect\u001b[39m(received)')).toBe('expect(received)');
    const msg = 'TypeError: x is not a function\n    at Object.<anonymous> (C:\\app\\src\\A.test.tsx:4:65)\n    at run (C:\\app\\node_modules\\jest-circus\\build\\x.js:1:1)\n    at processTicksAndRejections (node:internal/process/task_queues:103:5)';
    expect(cleanMessage(msg)).toBe('TypeError: x is not a function\n    at Object.<anonymous> (C:\\app\\src\\A.test.tsx:4:65)');
  });

  it('parseJestJson: falhas por teste e suiteError quando nenhuma asserção rodou', () => {
    const r = parseJestJson(
      {
        success: false,
        numTotalTests: 2,
        numFailedTests: 1,
        testResults: [
          {
            status: 'failed',
            message: 'resumo',
            assertionResults: [
              { fullName: 'Button ok', status: 'passed', failureMessages: [] },
              { fullName: 'Button erro', status: 'failed', failureMessages: ['\u001b[2mexpect(received)\u001b[22m.toBe(1)'] },
            ],
          },
        ],
      },
      ZERO,
      'raw',
    );
    expect(r).toEqual({ passed: false, numTests: 2, numFailed: 1, failures: [{ testName: 'Button erro', message: 'expect(received).toBe(1)' }], coverage: ZERO, rawOutput: 'raw' });

    const s = parseJestJson({ success: false, numTotalTests: 0, numFailedTests: 0, testResults: [{ status: 'failed', message: '● Test suite failed to run\n\n  Cannot find module', assertionResults: [] }] }, ZERO, '');
    expect(s.passed).toBe(false);
    expect(s.suiteError).toContain('Cannot find module');
  });

  it('suíte sem testes não conta como passed', () => {
    expect(parseJestJson({ success: true, numTotalTests: 0, numFailedTests: 0, testResults: [] }, ZERO, '').passed).toBe(false);
  });

  it('coverageFor acha o componente pelo caminho absoluto, ignora "total" e trata pct "Unknown"', () => {
    const abs = resolve('/ws/src/components/Button.tsx');
    const summary = {
      total: { statements: { pct: 1 }, branches: { pct: 1 }, functions: { pct: 1 }, lines: { pct: 1 } },
      [abs]: { statements: { pct: 80 }, branches: { pct: 'Unknown' }, functions: { pct: 100 }, lines: { pct: 75.5 } },
    };
    expect(coverageFor(summary, abs)).toEqual({ statements: 80, branches: 0, functions: 100, lines: 75.5 });
    expect(coverageFor(summary, resolve('/ws/src/Outro.tsx'))).toEqual(ZERO);
    expect(coverageFor(undefined, abs)).toEqual(ZERO);
  });

  it('clip mantém começo e fim', () => {
    const s = 'a'.repeat(50) + 'b'.repeat(50);
    const c = clip(s, 20);
    expect(c.startsWith('aaaaaaaa')).toBe(true);
    expect(c.endsWith('bbbbbbbbbbbb')).toBe(true);
    expect(c).toContain('omitidos');
  });
});

describe('ferramenta run_jest', () => {
  it('entrega o ExecResult completo ao onResult e uma versão resumida ao LLM', async () => {
    const big: ExecResult = { passed: false, numTests: 1, numFailed: 1, failures: [{ testName: 't', message: 'x'.repeat(5000) }], coverage: ZERO, rawOutput: 'y'.repeat(20000) };
    const seen: ExecResult[] = [];
    const tool = runJestTool('/ws', { runner: async () => big, onResult: (e) => seen.push(e) });
    const forLLM = (await tool.run({ testFile: 'a.test.tsx', componentFile: 'a.tsx' })) as ExecResult;
    expect(seen).toEqual([big]);
    expect(forLLM.rawOutput.length).toBeLessThan(3200);
    expect(forLLM.failures[0]!.message.length).toBeLessThan(1700);
    expect(JSON.stringify(forLLM).length).toBeLessThan(8000);
    expect(execForLLM(big).numFailed).toBe(1);
  });

  it('Jest ausente no workspace → erro claro em pt-BR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reactest-nojest-'));
    try {
      writeFileSync(join(dir, 'a.test.tsx'), '');
      if (findJestBin(dir)) return; // há um jest instalado acima do tmpdir: não dá para testar aqui
      await expect(runJest(dir, { testFile: 'a.test.tsx', componentFile: 'a.tsx' })).rejects.toThrow(JestNotFoundError);
      await expect(runJest(dir, { testFile: 'a.test.tsx', componentFile: 'a.tsx' })).rejects.toThrow(/Jest não encontrado no workspace/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
