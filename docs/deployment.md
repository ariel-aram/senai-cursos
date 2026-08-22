# Deploy e Configuração

## Variáveis de ambiente

| Variável | Padrão | Descrição |
| -------- | ------ | --------- |
| `PORT` | `3010` | Porta em que o servidor escuta |
| `HOST` | `0.0.0.0` | Interface de rede |
| `NODE_ENV` | — | Defina `production` para desabilitar HMR e logs de desenvolvimento |

As variáveis são lidas em `config/config.ts`:

```ts
export const config = {
  port: Number(process.env["PORT"] ?? 3010),
  host: process.env["HOST"] ?? "0.0.0.0",
};
```

Para alterar os padrões sem variável de ambiente, edite `config/config.ts` diretamente. O arquivo `config/config.example.ts` serve como template.

---

## Modos de execução

### Desenvolvimento

```sh
bun dev
# equivalente a: bun --hot src/index.ts
```

Inicia o servidor com HMR (Hot Module Replacement) habilitado. Mudanças em arquivos TypeScript/TSX são recarregadas sem reiniciar o processo.

### Produção (direto)

```sh
bun start
# equivalente a: NODE_ENV=production bun src/index.ts
```

Desabilita HMR e logs de desenvolvimento do Bun.

### Build estático do frontend

```sh
bun run build
```

Compila o React + CSS para `dist/`. Útil se você quiser servir o frontend por um CDN ou servidor estático separado. O resultado em `dist/` inclui:

- `index.html`
- `chunk-*.js` (bundle do React + App, minificado, com sourcemap)
- `chunk-*.css` (Tailwind compilado)
- `logo-*.svg`

> Em produção normal você **não precisa** do build estático — o Bun serve o React diretamente via `import index from "./index.html"`.

---

## Comportamento na inicialização

Ao iniciar, o servidor passa pelas seguintes fases:

1. **HTTP server up** — começa a responder imediatamente (antes do warmup)
2. **`getCatalog()`** — raspa as páginas de listagem (~10 páginas em paralelo). Leva ~5–15 s.
3. **`getUnits()`** — raspa `/unidades` para complementar nomes de unidades. Paralelo ao catálogo.
4. **Warmup** — pre-aquece todas as 75 unidades com `WARMUP_UNIT_CONCURRENCY = 6`. Leva ~2–5 min dependendo da latência do SENAI.

Durante as fases 2–4, requisições à API já funcionam — mas unidades que ainda não foram pré-aquecidas terão latência mais alta (~5–30 s) na primeira consulta, e o `LoadingCard` será exibido no frontend.

Após o warmup, todas as unidades respondem instantaneamente (dados do cache em memória).

---

## Logs esperados na inicialização

```bash
🚀 Servidor operando em http://0.0.0.0:3010/
[catalog] scraping 10 page(s)…
[catalog] 464 entries · 98 courses · 75 units
[warmup] pré-aquecendo 75 unidades…
[warmup] 10/75 unidades carregadas
[warmup] 20/75 unidades carregadas
…
[warmup] 75/75 unidades carregadas
[warmup] todas as unidades carregadas ✓
```

---

## Dependências de produção

Todas as dependências estão em `dependencies` (não `devDependencies`) porque o Bun as usa tanto em tempo de execução quanto para bundling. Não há separação entre runtime e build-time nesta stack.

| Pacote | Uso |
| ------ | --- |
| `react` / `react-dom` | Framework de UI |
| `lucide-react` | Ícones SVG |
| `bun-plugin-tailwind` | Processamento de CSS Tailwind no bundler do Bun |
| `@radix-ui/react-slot` | Primitivo de composição (usado pelo Button do shadcn) |
| `class-variance-authority` | Variantes de classes CSS tipadas |
| `clsx` + `tailwind-merge` | Merge de classes condicional sem conflitos |
| `tw-animate-css` | Animações Tailwind adicionais |
| `@biomejs/biome` | Linter + formatter |
