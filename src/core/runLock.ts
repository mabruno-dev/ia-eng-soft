// Trava por arquivo de teste: duas execuções (CLI, extensão, avaliação) no mesmo componente gravariam e
// apagariam o mesmo `<Componente>.test.tsx`, contaminando uma à outra. A trava fica em
// `.reactest/locks/<arquivo>.lock` com { pid, runId, testFilePath, startedAt }.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export class RunLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunLockError';
  }
}

export interface LockInfo {
  pid: number;
  runId: string;
  testFilePath: string;
  startedAt: string;
}

const slug = (testFilePath: string) => testFilePath.replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '-');
export const lockPath = (workspaceRoot: string, testFilePath: string) => join(workspaceRoot, '.reactest', 'locks', `${slug(testFilePath)}.lock`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // existe, mas é de outro usuário
  }
}

/** Dono atual da trava, se ela existir e o processo dono ainda estiver vivo (trava órfã = undefined). */
export function currentLock(workspaceRoot: string, testFilePath: string): LockInfo | undefined {
  const file = lockPath(workspaceRoot, testFilePath);
  if (!existsSync(file)) return undefined;
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
    return typeof info.pid === 'number' && alive(info.pid) ? info : undefined;
  } catch {
    return undefined;
  }
}

export function describeLock(info: LockInfo): string {
  return `outra execução (runId ${info.runId}, pid ${info.pid}, desde ${info.startedAt}) está usando o arquivo de teste ${info.testFilePath}`;
}

/**
 * Adquire a trava do arquivo de teste ou lança RunLockError. Trava órfã (processo morto ou arquivo ilegível)
 * é assumida. Devolve a função que libera a trava (idempotente; só apaga se ainda for nossa).
 */
export function acquireTestFileLock(workspaceRoot: string, testFilePath: string, runId: string): () => void {
  const file = lockPath(workspaceRoot, testFilePath);
  mkdirSync(join(workspaceRoot, '.reactest', 'locks'), { recursive: true });
  const info: LockInfo = { pid: process.pid, runId, testFilePath, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx'); // criação exclusiva: atômica entre processos
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const cur = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
          if (cur.runId === runId && cur.pid === process.pid) rmSync(file, { force: true });
        } catch {
          /* já removida */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = currentLock(workspaceRoot, testFilePath);
      if (owner) throw new RunLockError(`Não é possível iniciar: ${describeLock(owner)}. Aguarde ela terminar.`);
      rmSync(file, { force: true }); // órfã
    }
  }
  throw new RunLockError(`Não foi possível adquirir a trava de ${testFilePath}.`);
}
