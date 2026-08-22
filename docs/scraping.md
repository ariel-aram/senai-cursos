# Motor de Raspagem

## Visão geral

O scraper opera em duas fases: **descoberta de catálogo** (quais cursos existem em quais unidades) e **busca de turmas** (vagas, horários e preços por curso×unidade).

---

## Fase 1 — Catálogo

### `detectTotalPages()`

Antes de baixar as páginas, o scraper descobre quantas existem usando busca binária sobre o intervalo `[1, 25]`. Uma página é considerada "com conteúdo" se o HTML contiver a string `openModalTurmas`.

Isso evita baixar páginas em branco e se adapta automaticamente se o SENAI adicionar ou remover cursos.

### `buildCatalog()`

Baixa todas as páginas em paralelo (`CATALOG_CONCURRENCY = 12`) e extrai os pares `(courseId, unitId)` via regex:

```bash
openModalTurmas('NOME', 'slug', courseId, unitId, ...)
```

Para cada entrada, também extrai:

- **Nome do curso**: decodificando entidades HTML via `decodeEntities()`
- **Carga horária**: buscando `<strong>N horas</strong>` no contexto próximo
- **Nome da unidade**: buscando `<strong>CIDADE</strong> - BAIRRO` próximo ao `openModalTurmas`

Entradas duplicadas `(courseId, unitId)` são ignoradas via `Set`.

**Resultado típico:** ~464 entradas, ~98 cursos, ~75 unidades em ~10 páginas.

### `getCatalog()`

Wrapper com cache single-flight. Retorna o catálogo em cache se válido (< 2 h); caso contrário inicia um único rebuild e todas as chamadas concorrentes aguardam a mesma promise.

---

## Fase 2 — Turmas

### `postTurmas(slug, courseId, unitId, bolsa, gratuito)`

Faz POST para `https://www.sp.senai.br/cursosturmas/` com os parâmetros:

```bash
nomeCurso=slug
cursoId=courseId
escolaId=unitId
estrategia=Presencial
bolsa=1|0
gratuito=1|0
turno=0
pos=0
```

O endpoint retorna HTML com os cartões de cada turma. Se retornar HTTP não-OK, retorna string vazia (silently fail).

### Filtros de turma

| Modo | `bolsa` | `gratuito` | Resultado |
| ---- | ------- | ---------- | --------- |
| Gratuito | `1` | `1` | Apenas turmas com bolsa integral |
| Pago | `0` | `0` | **Todas as turmas** — gratuitas e pagas juntas |

**Por isso, a identificação de cursos pagos é feita por `prices.length > 0`**, não pelos parâmetros do POST. O filtro `bolsa=0/gratuito=0` é necessário para obter as turmas pagas, mas também traz as gratuitas.

---

## Parsing de HTML — `parseTurmasHtml(html)`

Extrai quatro tipos de dados do HTML de resposta:

### Vagas

```bash
/Vagas:\s*(?:<\/span>\s*)?(\d+)/g
```

Soma todas as ocorrências para obter o total de vagas e conta as turmas.

### Datas de início

```bash
/Início\s*<br\s*\/?>\s*<strong>\s*(\d{2}\/\d{2}\/\d{4})\s*<\/strong>/g
```

Deduplicadas e ordenadas cronologicamente (por chave `YYYYMMDD`).

### Horários

```bash
/Hor[aá]rio<\/strong>(?:<\/div>\s*)+<div[^>]*>\s*<div[^>]*>\s*([\s\S]*?)\s*<\/div>\s*<div[^>]*>\s*([\s\S]*?)\s*<\/div>/gi
```

Extrai `periodo` (ex: "Noturno") e `horario` (ex: "19h00 – 22h00"). Deduplicados por chave `periodo|horario`.

### Preços

```bash
/Investimento[\s\S]{0,150}?<strong>\s*(R\$\s*[\d.,]+)\s*<\/strong>/gi
```

Normaliza espaços e NBSP (`[\s ]+` → `" "`). Ordenados numericamente (menor para maior).

---

## Unidades — `scrapeUnits()`

Busca `https://www.sp.senai.br/unidades` e extrai IDs de unidade via padrão de e-mail:

```bash
/secretaria(\d+)@sp\.senai\.br/gi
```

Para cada ID encontrado, busca o `<h1>`–`<h4>` mais próximo antes do e-mail como nome da unidade.

Este scraping é complementar: o catálogo já extrai os nomes das unidades presentes em cursos de T.I. O `scrapeUnits()` serve como fallback para unidades cujos nomes não foram capturados pelo catálogo.

### `getUnits()`

Combina os nomes do catálogo (`catalogUnitNames`) com o scraping de `/unidades`, dando preferência ao catálogo. Filtra no final para retornar apenas unidades com cursos de T.I. catalogados.

---

## Resiliência

### `withRetry(fn, retries = 3)`

Envolve qualquer função async com retry automático e backoff exponencial:

```bash
tentativa 0 → falha → aguarda 300 ms
tentativa 1 → falha → aguarda 600 ms
tentativa 2 → falha → aguarda 1200 ms
tentativa 3 → lança o erro
```

### Timeout por requisição

Todas as chamadas HTTP usam `AbortSignal.timeout(12000)` — 12 segundos. O SENAI costuma demorar em algumas unidades durante horários de pico.

### Falha silenciosa

`get()` e `postTurmas()` retornam string vazia (`""`) em caso de erro, em vez de propagar exceções. Cursos sem resposta do servidor aparecem com `vagas = 0` e são filtrados da exibição — não quebram a resposta da API.

---

## Notas sobre o SENAI SP

- O site retorna HTTP 200 com body vazio para cursos sem turmas abertas — isso **não é** um bug do scraper.
- A mesma combinação `(courseId, unitId)` pode aparecer em cursos gratuitos **e** pagos simultaneamente (ex: Alumínio unidade 403 tem Excel Avançado nas duas modalidades).
- Os preços podem variar entre turmas do mesmo curso na mesma unidade — o campo `prices` é um array com todos os preços únicos encontrados.
