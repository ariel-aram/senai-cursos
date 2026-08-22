# Contributing to SENAI-SP Course Intelligence

Welcome! Thank you for your interest in contributing to **SENAI-SP Course Intelligence**.

This project is an open-source platform designed to aggregate, normalize, and visualize public course offerings across SENAI São Paulo units. We welcome contributions from software engineers, data engineers, UX/UI designers, researchers, and tech enthusiasts.

---

## Before You Start

- Review existing [GitHub Issues](https://github.com/ariel-aram/senai-cursos/issues) and [Pull Requests](https://github.com/ariel-aram/senai-cursos/pulls) before starting substantial new work.
- Ensure your changes strictly respect upstream data sources (`sp.senai.br`).
- Maintain respectful and constructive communication across all interactions.

---

## Development Environment Setup

### Prerequisites

- [Bun](https://bun.sh) (v1.1.0 or higher)
- Git

### Local Setup Steps

```bash
# 1. Clone the repository
git clone https://github.com/ariel-aram/senai-cursos.git
cd senai-cursos

# 2. Install dependencies
bun install

# 3. Create local configuration from template
cp config/config.example.ts config/config.ts

# 4. Start the development server with Hot Module Reloading
bun dev
```

The application will be accessible at `http://localhost:3010`.

> **Note on Storage:** By default, SurrealDB runs embedded using SurrealKV (`surrealkv://./data/senai.db`). If the database connection fails, the server continues operating seamlessly in-memory without persistent storage.

---

## Project Structure

```bash
senai-cursos/
├── config/
│   └── config.example.ts       # Centralized runtime configuration template
├── data/                       # Embedded SurrealKV database files (local)
├── docs/                       # Technical architecture, API, and module documentation
│   ├── api.md                  # HTTP REST endpoints documentation
│   ├── architecture.md         # System design and data flow specifications
│   ├── deployment.md           # Production deployment procedures
│   ├── frontend.md             # UI component architecture and state management
│   └── scraping.md             # Upstream ingestion and parsing mechanics
├── src/
│   ├── components/ui/          # Reusable UI primitives (Button, Card)
│   ├── lib/                    # Shared client utilities (cn helper)
│   ├── App.tsx                 # Main React frontend component
│   ├── db.ts                   # SurrealDB connection, schema queries, and upserts
│   ├── frontend.tsx            # React client-side entry point
│   ├── index.html              # Base HTML template for the SPA
│   ├── index.ts                # Bun server entry point, ingestion logic, and API routes
│   └── types.ts                # Shared TypeScript interfaces (Course, Unit, Schedules)
├── build.ts                    # Production frontend bundler script
└── package.json                # Project scripts, dependencies, and metadata
```

---

## Areas for Contribution

We welcome contributions across several domains:

1. **Bug Fixes:** Resolving parsing errors, UI anomalies, or edge cases.
2. **Data Pipeline & Reliability:** Optimizing ingestion throughput, refining regex safety, and improving cache invalidation strategies.
3. **Frontend & UX:** Enhancing accessibility (a11y), responsive layouts, and filter usability.
4. **Documentation:** Improving code comments, architecture guides, and API documentation.
5. **Testing & QA:** Introducing unit and integration tests for data normalizers and API endpoints.

---

## Data Collection & Scraping Guidelines

Because this platform processes public upstream data from `sp.senai.br`, all changes touching data ingestion must adhere to strict ethical and operational principles:

- **Polite Upstream Concurrency:** Maintain concurrency limiters (`CATALOG_CONCURRENCY`, `TURMAS_CONCURRENCY`, `WARMUP_CONCURRENCY`) to prevent overwhelming the source portal.
- **Cache-First Ingestion:** Always check and utilize local caches (`catalogCache`, `unitDataCache`, `unitPaidDataCache`, or SurrealDB) before issuing network requests.
- **Defensive Parsing:** Upstream HTML structures may change without notice. All parsing logic must fail gracefully (e.g. defaulting to safe fallbacks or empty arrays) without throwing uncaught exceptions.
- **Public Data Only:** Only collect publicly accessible course catalog and schedule data. Never attempt to circumvent access controls or collect private/restricted data.
- **No Data Hoarding:** Do not store redundant or non-essential HTML payloads. Persist only normalized schema entities (`Course`, `UnitInfo`, `Schedule`).

---

## Development Workflow

### Branch Conventions

Use short, descriptive branch names prefixed by task type:

- `feature/<description>`
- `fix/<description>`
- `docs/<description>`
- `refactor/<description>`

### Commit Messages

We recommend following the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `feat: add export functionality for course schedules`
- `fix: handle empty schedule table in unit parser`
- `docs: update API response examples in docs/api.md`
- `refactor: extract schedule deduplication helper`
- `chore: update Biome configuration rules`

---

## Code Quality & Verification

Before submitting a Pull Request, ensure your code passes static analysis and type checks:

```bash
# Format and lint code with Biome
bun check

# Type-check TypeScript without emitting files
bun run tsc

# Test production build bundling
bun run build
```

### Testing Notice

The repository currently relies on static type verification and manual runtime testing against real or mocked unit queries. When introducing modifications:

1. Verify endpoint responses manually via `curl` or browser (e.g. `GET /api/units`, `GET /api/courses?unit=403`).
2. Test client UI behavior across both desktop and mobile viewports.
3. If writing new helper functions, ensure comprehensive edge-case handling.

---

## Pull Request Submission Checklist

When opening a Pull Request:

1. **Title:** Clear, imperative summary following conventional commit conventions.
2. **Context & Motivation:** Explain *why* this change is necessary and *what* problem it solves.
3. **Implementation Details:** Summarize key structural or algorithmic changes.
4. **Verification Evidence:** Describe steps taken to test the change (include terminal output or screenshots for UI changes).
5. **Quality Checks:** Confirm that `bun check` and `bun run tsc` passed without warnings or errors.

---

## Code of Conduct

All contributors and maintainers are expected to maintain an inclusive, professional, and respectful environment. Constructive criticism, open collaboration, and clear technical communication are prioritized.

---

## License

By contributing to **SENAI-SP Course Intelligence**, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
