# 🛠️ vault/workers/ — The Execution Layer

This directory contains specialized **Worker Agents**. While `scripts/` handle the metabolism and maintenance of the vault, `workers/` are the "hands" of the system—designed to produce high-value, external-facing deliverables.

## 🤖 Workers vs. Scripts

| Feature | Scripts (`vault/scripts/`) | Workers (`vault/workers/`) |
| :--- | :--- | :--- |
| **Purpose** | Maintenance & Evolution | Production & Execution |
| **Input** | Vault Notes & Graph | Vault Knowledge $\rightarrow$ Target Format |
| **Output** | Updated Graph/Notes/Rules | Reports, Documents, Blueprints |
| **Trigger** | Hooks & Cron Jobs | Explicit User Request |
| **Role** | The "Metabolism" | The "Hands" |

## 📂 Worker Structure
Each worker is organized as a self-contained module:
`vault/workers/[worker-name]/`
- `SKILL.md`: Defines the worker's capabilities, prompt logic, and operational constraints.

## 🚀 Operational Flow
1. **Knowledge Retrieval**: The worker uses `graph-search.mjs` to gather all relevant claims, insights, and concepts from the vault.
2. **Synthesis**: The worker applies its specialized persona (e.g., `document-writer`) to structure the gathered knowledge.
3. **Production**: The worker generates the final deliverable (PDF, DOCX, Markdown Report) in `vault/03_creating/assets/`.

## ⚠️ Maintenance
When adding a new worker ensure the `SKILL.md` clearly defines the output format.
