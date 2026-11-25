# sample-app (fixture do ReacTest-Agent)

App React + TypeScript (Vite) usado para demonstrar e avaliar a pipeline. **Não tem testes de propósito**: eles são gerados pelo ReacTest-Agent.

```
npm install
npm test            # Jest + RTL (passWithNoTests)
npx tsc --noEmit
npm run mutation    # Stryker (jest-runner)
```

Stack de testes: Jest 30, ts-jest, jest-environment-jsdom, @testing-library/react, user-event e jest-dom (já carregado em `jest.setup.ts`). O alias `@/` → `src/` está configurado no `tsconfig.json`, no `jest.config.cjs` (`moduleNameMapper`) e no `vite.config.ts`.

## Componentes e o que cada um exercita

| Componente | Caso | O que exercita (limitações da v1) |
|---|---|---|
| `Button.tsx` | Controle | Caso fácil: props `variant`/`disabled`/`onClick`, sem dependências. |
| `LoginForm.tsx` | **MC2** (formulário + API) | Validação (e-mail, senha ≥ 8), estados idle/loading/erro de API/sucesso, `fetch` via `services/authApi.ts` → `services/http.ts` (o que mockar). Mistura alias (`@/services/authApi`) e relativos (`../utils/validation`, `./Button`). |
| `UserList.tsx` | Assíncrono | `useEffect` + `services/userApi.ts`, estados loading/vazio/erro, filtro por texto; exige `findBy`/`waitFor`. |
| `CartSummary.tsx` | **MC4** (estado global) | Context + reducer (`state/CartContext.tsx` → `state/cartReducer.ts` → `types/cart.ts`): dependência indireta; precisa de `CartProvider` no teste. Cupom `PROMO10` = 10% de desconto. |
| `ThemeToggle.tsx` | Store global | Zustand (`state/themeStore.ts`) com `persist` em `localStorage`; o estado vaza entre testes se não for resetado. |
| `PasswordField.tsx` | **Regra oculta** (elicitação) | Indicador de força e mostrar/ocultar. A regra de "forte" não está documentada no código — só o dev sabe; serve para a Elicitação. |
