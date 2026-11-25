/** Exemplo few-shot escrito à mão: componente (e dependências), contexto resumido e teste de referência. */
export interface FewShotExample {
  title: string;
  /** Arquivos de código do exemplo, com caminho relativo a uma pasta `src/` qualquer. */
  files: { path: string; source: string }[];
  componentName: string;
  test: { path: string; code: string };
  allowedImports: { name: string; specifier: string; kind: 'default' | 'named' | 'namespace' | 'side-effect' }[];
  mockTargets: string[];
  plan: { name: string; kind: string }[];
}
