# Arquitetura do Sistema

## Visão geral

O projeto é uma aplicação **fullstack de processo único** executada no runtime Bun. O mesmo processo serve a SPA React e os endpoints de API na mesma porta (padrão 3010).

```bash
┌─────────────────────────────────────────────────────────┐
│              Processo Bun (src/index.ts)                │
│                                                         │
│  ┌──────────────────┐   ┌────────────────────────────┐  │
│  │  HTTP Server     │   │  Scraping / Data Layer     │  │
│  │  (Bun.serve)     │   │                            │  │
│  │                  │   │  buildCatalog()            │  │
│  │  GET /*     ─────┼───┼→ React SPA (index.html)    │  │
│  │  GET /api/units  │   │  scrapeUnits()             │  │
│  │  GET /api/courses│   │  scrapeUnitData()          │  │
│  │  GET /api/paid.. │   │  scrapeUnitPaidData()      │  │
│  │  POST /api/ref.. │   │  parseTurmasHtml()         │  │
│  └──────────────────┘   └────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
          ↕                          ↕
    Navegador do usuário       sp.senai.br
```

## Fluxo de dados

```bash
sp.senai.br (páginas de listagem)
    ↓
buildCatalog()        → catalogCache (TTL 2 h)
    ↓ extrai (courseId × unitId) pairs
fetchTurmas() [POST /cursosturmas/ com bolsa=1,gratuito=1]
    ↓
parseTurmasHtml()     → vagas, turmas, startDates, schedules
    ↓
scrapeUnitData()      → unitDataCache (TTL 30 min)
    ↓
GET /api/courses?unit=N → React frontend

fetchTurmasPaid() [POST /cursosturmas/ com bolsa=0,gratuito=0]
    ↓
parseTurmasHtml()     → prices (R$ X,YY)
    ↓  (filtra: prices.length > 0)
scrapeUnitPaidData()  → unitPaidDataCache (TTL 30 min)
    ↓
GET /api/paid-courses?unit=N → React frontend
```

## Camadas

### 1. Catálogo (`buildCatalog`)

Descobre todos os pares `(courseId, unitId)` disponíveis varrendo as páginas de listagem do SENAI SP. Usa `detectTotalPages()` (busca binária) para saber quantas páginas existem antes de baixá-las em paralelo.

- URL base: `https://www.sp.senai.br/cursos/cursos-livres/tecnologia-da-informacao-e-informatica?pag=N`
- Regex de extração: `openModalTurmas('name', 'slug', courseId, unitId, ...)`
- Filtros implícitos na listagem: somente TI, somente presencial
- Resultado típico: ~464 entradas, ~98 cursos distintos, ~75 unidades

### 2. Turmas (`postTurmas`)

Endpoint POST do SENAI que retorna o HTML com as turmas de um curso em uma unidade específica.

```bash
POST https://www.sp.senai.br/cursosturmas/
Body: nomeCurso=slug&cursoId=N&escolaId=N&estrategia=Presencial&bolsa=B&gratuito=G&turno=0&pos=0
```

**Parâmetros de filtragem:**

| Uso | `bolsa` | `gratuito` | Semântica real |
| --- | ------- | ---------- | -------------- |
| Cursos gratuitos | `1` | `1` | Retorna turmas com bolsa integral |
| Cursos pagos | `0` | `0` | **Retorna todas as turmas** — use `prices.length > 0` para identificar pagos |

> `bolsa=0/gratuito=0` **não** é um filtro de "somente pagos". O único sinal confiável de que uma turma é paga é a presença de um bloco de preço (`R$ NNN,NN`) no HTML.

### 3. Cache em memória

| Cache | Tipo | TTL | Chave |
| ----- | ---- | --- | ----- |
| `catalogCache` | objeto único | 2 horas | — |
| `unitDataCache` | `Map<unitId, data>` | 30 minutos | `unitId` |
| `unitPaidDataCache` | `Map<unitId, data>` | 30 minutos | `unitId` |
| `unitsRegistry` | array | permanente (sessão) | — |

Todos os caches usam o padrão "single-flight": se uma requisição já está em andamento para a mesma chave, as demais aguardam a mesma promise em vez de disparar requisições duplicadas.

### 4. Pre-aquecimento (warmup)

Na inicialização, após construir o catálogo, o servidor pre-aquece **todas as 75 unidades** em paralelo com concorrência limitada (`WARMUP_UNIT_CONCURRENCY = 6`). Isso garante que a maioria das unidades responda instantaneamente quando selecionadas na interface.

```bash
[warmup] pré-aquecendo 75 unidades…
[warmup] 10/75 unidades carregadas
…
[warmup] todas as unidades carregadas ✓
```

## Constantes de configuração

| Constante | Valor padrão | Significado |
| --------- | ------------ | ----------- |
| `CATALOG_TTL_MS` | 2 horas | Validade do catálogo em cache |
| `UNIT_TTL_MS` | 30 minutos | Validade dos dados de turmas por unidade |
| `FETCH_TIMEOUT_MS` | 12 000 ms | Timeout por requisição HTTP |
| `MAX_RETRIES` | 3 | Tentativas antes de desistir |
| `CATALOG_CONCURRENCY` | 12 | Páginas de catálogo baixadas em paralelo |
| `TURMAS_CONCURRENCY` | 12 | Requisições de turmas em paralelo por unidade |
| `WARMUP_UNIT_CONCURRENCY` | 6 | Unidades pre-aquecidas simultaneamente |

## Utilitários de concorrência

### `withConcurrency(tasks, limit)`

Executa um array de tarefas async com no máximo `limit` em paralelo, preservando a ordem dos resultados. Equivalente a um semáforo de N slots.

```ts
const results = await withConcurrency(
  unitIds.map(id => () => fetchData(id)),
  6
);
```

### `withRetry(fn, retries)`

Executa `fn` até `retries` vezes com backoff exponencial (300ms × 2^tentativa). Engole erros na última tentativa retornando string vazia (via `.catch(() => "")`).

## Decisões de design

- **Processo único**: simplifica deploy e elimina a necessidade de filas ou workers externos. O Bun lida bem com I/O concorrente.
- **Sem banco de dados**: os dados têm TTL curto e são re-scraped regularmente; manter em memória é suficiente.
- **Busca binária para detectar páginas**: evita fazer N requisições de "descoberta" — termina em O(log N) chamadas.
- **Pre-aquecimento de todas as unidades**: a maioria das unidades fica "fria" se apenas Alumínio (403) é a padrão. O warmup garante latência próxima de zero para qualquer unidade selecionada.
