# Referência da API HTTP

Todos os endpoints são servidos na mesma porta do servidor (padrão `3010`). Todas as respostas são JSON, exceto `GET /*` que serve a SPA.

---

## `GET /*`

Serve a aplicação React (SPA). Qualquer rota não reconhecida retorna `index.html`, permitindo que o roteamento do lado do cliente funcione.

---

## `GET /api/units`

Retorna a lista de unidades do SENAI SP que possuem ao menos um curso de T.I. catalogado.

**Resposta de sucesso `200`:**

```json
[
  { "id": 403, "name": "Alumínio" },
  { "id": 499, "name": "Mairinque" },
  ...
]
```

Os itens são ordenados alfabeticamente pelo nome (locale `pt-BR`). A lista inclui apenas unidades presentes no catálogo — unidades sem cursos de T.I. são excluídas.

**Resposta de erro `500`:**

```json
{ "error": "Falha ao buscar unidades" }
```

---

## `GET /api/courses?unit={unitId}`

Retorna os cursos **gratuitos** presenciais de T.I. da unidade informada.

**Parâmetros:**

| Parâmetro | Tipo | Obrigatório | Padrão |
| --------- | ---- | ----------- | ------ |
| `unit` | `number` | não | `403` |

**Resposta de sucesso `200`:**

```json
{
  "courses": [
    {
      "name": "Excel Avançado",
      "slug": "excel-avancado",
      "id": 1234,
      "hours": 20,
      "vagas": 11,
      "turmas": 2,
      "startDates": ["10/06/2025", "24/06/2025"],
      "schedules": [
        { "periodo": "Noturno", "horario": "19h00 – 22h00" }
      ],
      "prices": []
    }
  ],
  "lastUpdated": "2025-06-01T14:30:00.000Z"
}
```

**Comportamento de cache:**

- Se os dados da unidade já estão em cache e não estão expirados (< 30 min), retorna imediatamente.
- Se estão expirados, retorna o cache stale **e** dispara uma atualização em background.
- Se não há cache, aguarda o scraping completo antes de responder.

**Filtro aplicado:** apenas cursos com `vagas > 0` são incluídos.

---

## `GET /api/paid-courses?unit={unitId}`

Retorna os cursos **pagos** presenciais de T.I. da unidade informada.

**Parâmetros:** idênticos a `/api/courses`.

**Resposta de sucesso `200`:** estrutura idêntica a `/api/courses`, com a diferença que `prices` sempre tem ao menos um elemento:

```json
{
  "courses": [
    {
      "name": "Microsoft Power BI",
      "slug": "microsoft-power-bi",
      "id": 5678,
      "hours": 16,
      "vagas": 122,
      "turmas": 5,
      "startDates": ["15/06/2025"],
      "schedules": [
        { "periodo": "Manhã", "horario": "08h00 – 12h00" }
      ],
      "prices": ["R$ 604,46"]
    }
  ],
  "lastUpdated": "2025-06-01T14:30:00.000Z"
}
```

**Filtro aplicado:** apenas cursos onde `prices.length > 0`. O endpoint `/cursosturmas/` com `bolsa=0/gratuito=0` retorna todas as turmas (gratuitas e pagas) — a presença do bloco de preço no HTML é o único sinal confiável de que é pago.

---

## `POST /api/refresh?unit={unitId}`

Força a atualização dos dados de cursos **gratuitos** da unidade, ignorando o cache.

**Parâmetros:** idênticos a `/api/courses`.

**Resposta:** mesma estrutura de `/api/courses`, com dados frescos.

---

## `POST /api/paid-refresh?unit={unitId}`

Força a atualização dos dados de cursos **pagos** da unidade, ignorando o cache.

**Parâmetros:** idênticos a `/api/courses`.

**Resposta:** mesma estrutura de `/api/paid-courses`, com dados frescos.

---

## Tipos TypeScript

Os tipos dos dados são exportados pelo `src/index.ts` e espelhados no `src/App.tsx`:

```ts
interface Schedule {
  periodo: string;   // ex: "Noturno"
  horario: string;   // ex: "19h00 – 22h00"
}

interface Course {
  name: string;
  slug: string;
  id: number;
  hours: number;
  vagas: number;
  turmas: number;
  startDates: string[];  // "DD/MM/YYYY", ordenado cronologicamente
  schedules: Schedule[];
  prices: string[];      // ex: ["R$ 604,46"]; vazio para gratuitos
}

interface CoursesData {
  courses: Course[];
  lastUpdated: string;   // ISO 8601
}

interface UnitInfo {
  id: number;
  name: string;
}
```
