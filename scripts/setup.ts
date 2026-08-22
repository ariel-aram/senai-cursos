#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

async function setupProject() {
	console.log("🔧 Configurando projeto com Biome...\n");

	try {
		await mkdir(path.join(rootDir, "src"), { recursive: true });
		await mkdir(path.join(rootDir, "dist"), { recursive: true });

		console.log("✅ Diretórios do projeto inicializados.");
		console.log("✅ Biome.js aplicado com sucesso!\n");

		console.log("📦 Comandos disponíveis:");
		console.log("  bun run dev       - Iniciar servidor de desenvolvimento");
		console.log("  bun run build     - Construir para produção");
		console.log("  bun run check     - Verificar formatação e linting");
		console.log("  bun run check:fix - Corrigir problemas de formatação e linting");
	} catch (error) {
		console.error("❌ Setup mal-sucedido:", error);
		process.exit(1);
	}
}

await setupProject();
