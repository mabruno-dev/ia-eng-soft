// Confere que os exemplos few-shot do Gerador passam no Jest do fixture.
// Grava os MESMOS textos do prompt em fixtures/sample-app/src/__fewshot_tmp__/, roda o Jest e apaga a pasta.
// Uso: npm run verify:fewshot   (requer `npm install` em fixtures/sample-app)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FEW_SHOT_EXAMPLES } from '../src/core/prompts/fewshot';

const fixture = resolve('fixtures/sample-app');
const tmp = join(fixture, 'src', '__fewshot_tmp__');

/** Remoção recursiva manual: fs.rmSync({ recursive }) falha em silêncio em pastas do OneDrive no Windows. */
function removeDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) removeDir(p);
    else unlinkSync(p);
  }
  rmdirSync(dir);
}

removeDir(tmp);
try {
  for (const ex of FEW_SHOT_EXAMPLES) {
    for (const f of [...ex.files, { path: ex.test.path, source: ex.test.code }]) {
      const out = join(tmp, f.path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, f.source, 'utf8');
    }
  }
  const res = spawnSync('npx jest src/__fewshot_tmp__ --colors=false', {
    cwd: fixture,
    stdio: 'inherit',
    shell: true,
  });
  process.exitCode = res.status ?? 1;
} finally {
  removeDir(tmp);
}
