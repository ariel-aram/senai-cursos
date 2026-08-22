# SENAI SP — Cursos de T.I

Monitor em tempo real de vagas em cursos presenciais de Tecnologia da Informação do SENAI São Paulo. Raspa o site oficial e apresenta um painel visual com cursos gratuitos e pagos por unidade.

![Stack](https://img.shields.io/badge/Bun-1.x-black?logo=bun) ![React](https://img.shields.io/badge/React-19-blue?logo=react) ![Tailwind](https://img.shields.io/badge/Tailwind-v4-06B6D4?logo=tailwindcss) ![Biome](https://img.shields.io/badge/Biome-2.x-60A5FA)

---

## Funcionalidades

- **Todas as 75 unidades** do SENAI SP com cursos de T.I. cadastrados
- **Cursos gratuitos e pagos** em seções separadas, com vagas, turmas, datas de início e horários
- **Barras clicáveis** que levam diretamente à página oficial do curso em sp.senai.br
- **Cache com TTL** (catálogo 2 h, turmas 30 min) e pre-aquecimento de todas as unidades na inicialização
- **Auto-refresh** a cada 5 minutos com contagem regressiva visível
- **Design glassmorphism** escuro com efeito 3D tilt no mouse

## Instalação

```sh
# Instalar dependências
bun install

# Copiar e ajustar configuração
cp config/config.example.ts config/config.ts
```

## Comandos

| Comando | Descrição |
| ------- | --------- |
| `bun dev` | Servidor de desenvolvimento com HMR (porta 3010) |
| `bun start` | Servidor de produção (`NODE_ENV=production`) |
| `bun run build` | Compila o frontend para `dist/` (export estático) |
| `bun check` | Lint + formatação via Biome (auto-fix) |
| `bunx tsc --noEmit` | Verificação de tipos TypeScript sem emitir arquivos |

## Configuração

Edite `config/config.ts` para alterar a porta e o host:

```ts
export const config = {
  port: Number(process.env["PORT"] ?? 3010),
  host: process.env["HOST"] ?? "0.0.0.0",
};
```

Ou use variáveis de ambiente:

```bash
PORT=8080 bun start
```

## Documentação completa

| Documento | Conteúdo |
| --------- | -------- |
| [Arquitetura do sistema](docs/architecture.md) | Fluxo de dados, camadas, decisões de design |
| [API HTTP](docs/api.md) | Referência de todos os endpoints |
| [Motor de raspagem](docs/scraping.md) | Como o SENAI é raspado, filtros, parsing |
| [Frontend React](docs/frontend.md) | Componentes, hooks, estado, animações |

## Tecnologias

- **Runtime**: [Bun](https://bun.sh) — servidor HTTP + bundler integrado
- **Frontend**: React 19, Tailwind CSS v4, lucide-react
- **Linting/Formatting**: [Biome](https://biomejs.dev)
- **CSS utilities**: shadcn/ui (button, card), class-variance-authority, tailwind-merge
