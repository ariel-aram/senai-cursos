# Frontend React

O frontend é uma SPA React 19 em arquivo único (`src/App.tsx`). Não usa roteador — é uma única tela.

---

## Estrutura de componentes

```bash
App
├── <header>          (glassmorphism + tilt 3D)
├── UnitSearch        (dropdown de busca de unidade)
├── [error banner]    (se houver erro de rede)
├── StatCard ×4       (cursos, vagas, turmas abertas, countdown)
├── renderFreeChart() (card de cursos gratuitos)
│   ├── LoadingCard   (se slowLoad = true)
│   └── CourseBar ×N  (um por curso)
│       └── SkeletonBar ×N (enquanto loading = true)
└── renderPaidChart() (card de cursos pagos)
    ├── LoadingCard variant="paid"
    └── CourseBar ×N variant="paid"
```

---

## Componentes

### `App`

Componente raiz. Gerencia todo o estado da aplicação.

**Estado principal:**

| Estado | Tipo | Descrição |
| ------ | ---- | --------- |
| `units` | `UnitInfo[]` | Lista de unidades carregadas da API |
| `selectedUnit` | `number` | ID da unidade atualmente selecionada |
| `data` | `ApiResponse \| null` | Dados de cursos gratuitos |
| `paidData` | `ApiResponse \| null` | Dados de cursos pagos |
| `loading` / `paidLoading` | `boolean` | Requisição em andamento |
| `slowLoad` / `paidSlowLoad` | `boolean` | True após 800 ms de loading (aciona `LoadingCard`) |
| `refreshing` / `paidRefreshing` | `boolean` | Refresh manual em andamento |
| `countdown` | `number` | Segundos até o próximo auto-refresh |

**Refs importantes:**

| Ref | Uso |
| --- | --- |
| `countdownRef` | Valor atual do countdown (evita closures stale no `setInterval`) |
| `slowLoadTimerRef` | Handle do `setTimeout` de 800 ms para slow load |
| `slowPaidLoadTimerRef` | Mesmo para cursos pagos |

**Auto-refresh:** um `setInterval` de 1 segundo decrementa `countdownRef`. Ao chegar a zero, reinicia o contador e chama `fetchData(selectedUnit)`.

**Slow load detection:** ao iniciar um fetch não-forçado, agenda um `setTimeout` de 800 ms para ligar `slowLoad`. Se o fetch terminar antes disso, o timer é cancelado e `LoadingCard` nunca aparece. Isso evita flash desnecessário para unidades pre-aquecidas.

---

### `UnitSearch`

Dropdown de busca com filtro em tempo real. Filtra por nome (case-insensitive) ou por ID numérico da unidade.

**Props:**

```ts
{
  units: UnitInfo[];
  selectedId: number;
  onSelect: (id: number) => void;
}
```

**Comportamento:**

- Fecha ao clicar fora (listener `mousedown` no `document`)
- `Escape` fecha sem selecionar
- `Enter` seleciona o primeiro item filtrado
- Foca o `<input>` automaticamente ao abrir

---

### `StatCard`

Card de métrica individual com efeito tilt 3D.

**Props:**

```ts
{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string | number;
  sub?: string;
  highlight?: boolean;  // adiciona ring vermelho
  delay?: number;       // delay de animação em ms
}
```

Usa internamente `useTilt(8)` para o efeito 3D no mouse.

---

### `CourseBar`

Barra horizontal representando um curso. É um `<a>` clicável que abre a página oficial do curso no SENAI.

**Props:**

```ts
{
  course: Course;
  maxVagas: number;    // usado para calcular a largura proporcional da barra
  index: number;       // delay de animação = index * 55ms
  variant?: "free" | "paid";
}
```

**Elementos exibidos:**

1. Nome do curso (truncado) + carga horária
2. Barra de progresso com contagem de vagas e turmas
3. Datas de início (até 3, com "+N datas" para o resto) — ícone verde
4. Horários (período + horário) — ícone cinza
5. Preço (somente `variant="paid"`) — ícone âmbar

**URL do curso:** `https://www.sp.senai.br/curso/{slug}/{id}`

**Cores por variant:**

- `free`: gradiente `from-red-800 via-red-600 to-rose-400`
- `paid`: gradiente `from-blue-800 via-blue-600 to-sky-400`

---

### `LoadingCard`

Exibido quando `slowLoad = true` (fetch demorou mais de 800 ms). Indica que a unidade não estava pre-aquecida.

**Props:**

```ts
{ unitName: string; variant?: "free" | "paid" }
```

Animação de anéis concêntricos pulsantes + barra shimmer.

---

### `NoCoursesCard`

Exibido quando a unidade selecionada não tem nenhum curso (nem gratuito, nem pago).

Condição: `noCourses && paidNoCourses`.

---

### `SkeletonBar`

Placeholder animado exibido enquanto `loading = true` (antes dos dados chegarem).

---

## Hooks

### `useTilt(strength = 10)`

Hook que aplica transformação CSS 3D (`perspective + rotateY/X`) proporcionalmente à posição do mouse dentro do elemento.

```ts
const { ref, onMouseMove, onMouseLeave } = useTilt(8);
// Aplique ref, onMouseMove, onMouseLeave ao elemento
```

Ao sair do mouse, limpa `transform` e `boxShadow` inline.

---

## Funções utilitárias

| Função | Uso |
| ------ | --- |
| `formatTime(isoString)` | Converte ISO 8601 para `HH:MM` (locale `pt-BR`) |
| `formatCountdown(seconds)` | Converte segundos para `M:SS` |

---

## Estilização

### Arquivos CSS

| Arquivo | Conteúdo |
| ------- | -------- |
| `src/index.css` | Importa `globals.css`; aplica `font-sans` e `bg-background` ao `body` |
| `styles/globals.css` | Tokens de cor HSL, variáveis de raio, animações customizadas e utilitários de glassmorphism |

### Animações customizadas (`styles/globals.css`)

| Nome | Uso |
| ---- | --- |
| `bar-fill` | Expansão da barra de vagas da esquerda para direita |
| `shimmer-sweep` | Brilho deslizante na barra de loading |
| `slide-in` | Entrada suave de baixo para cima dos `CourseBar` |
| `logo-float` | Flutuação suave do logo no header |

### Classes utilitárias

| Classe | Efeito |
| ------ | ------ |
| `glass-card` | Fundo semitransparente + blur + borda sutil |
| `glass-card-scan` | Adiciona linha de "scan" animada ao glass-card |
| `aero-root` | Container raiz com fundo escuro |
| `aero-bg-glow` | Brilho difuso central |
| `aero-orb` | Orbes de luz colorida decorativas |
| `section-3d` | Entrada animada com delay baseado no index |

### Tailwind v4

O projeto usa Tailwind v4 com tema customizado em `tailwind.config.ts`. Tokens de cor são definidos como variáveis CSS HSL em `styles/globals.css` e referenciados pelo Tailwind. O `bun-plugin-tailwind` processa o CSS tanto em dev (HMR) quanto no build de produção — não há necessidade de PostCSS separado.
