# 🛠️ Vault Maintenance Guide

This document serves as the official technical reference for the automated maintenance systems (Cron Jobs & Hooks) governing this workspace.

## 🧩 System Architecture Overview

The maintenance system is designed as a **Knowledge Lifecycle Loop**, ensuring that raw interactions are converted into durable, structured intelligence.

The system is divided into two main layers:
1. **Event-Driven (Hooks)**: Reactive scripts that trigger based on Gateway events (Immediate).
2. **Time-Driven (Cron)**: Scheduled scripts that ensure long-term data integrity (Periodic).

---

## 🗺️ System Directory Map
To maintain the vault, understand the role of each directory:
- `vault/.system/` $\rightarrow$ **The Subconscious**: Internal state, embeddings, and the master graph.
- `vault/scripts/` $\rightarrow$ **The Metabolism**: Automated tools for indexing, linking, and synthesis.
- `vault/workers/` $\rightarrow$ **The Hands**: Specialized agents for producing final deliverables.
- `vault/01_thinking/` $\rightarrow$ **The Conscious Memory**: The active space for notes, insights, and concepts.

---

## ⚡ Event-Driven Layer (Hooks)

These hooks ensure that the agent's memory is updated in real-time as sessions evolve.

| Hook Name | Event Trigger | Script Path | Primary Function |
| :--- | :--- | :--- | :--- |
| **Vault Memory Sync** | `command:new`, `command:reset` | `hooks/vault-memory-sync/handler.js` | **Sequence:** Distiller $\rightarrow$ Learning (Collector $\rightarrow$ Synthesizer $\rightarrow$ Reflection $\rightarrow$ Reflection Synthesizer) $\rightarrow$ Inbox Processor $\rightarrow$ Linker (Standard) $\rightarrow$ Graph Indexer. Immediate session harvest and structural update. |

### Detailed Component Paths:
- **Learning Collector:** `vault/scripts/learning/learning-collector.mjs` (Harvests behavioral deltas $\rightarrow$ `vault/.system/temp_learnings/`. Includes **AI Fallback** support.)
- **Learning Synthesizer:** `vault/scripts/learning/learning-synthesizer.mjs` (Summarizes behavioral deltas $\rightarrow$ `AGENT-BEHAVIORAL-RULEBOOK.md` and `vault/01_thinking/behavioral_rules/`.)
- **Reflection Engine:** `vault/scripts/learning/reflection.mjs` (Evaluates session reasoning and gaps $\rightarrow$ `vault/01_thinking/reflections/`.)
- **Reflection Synthesizer:** `vault/scripts/learning/reflection-synthesizer.mjs` (Synthesizes systemic failure patterns $\rightarrow$ `AGENT-BEHAVIORAL-RULEBOOK.md`.)
- **Distiller:** `vault/scripts/graph/distiller.mjs` (Extracts claims $\rightarrow$ `00_inbox/`. Includes **AI Fallback** support.)
- **Inbox Processor:** `vault/scripts/maintenance/process-inbox.mjs` (Triage $\rightarrow$ `01_thinking/`)
- **Memory Sync:** `vault/scripts/maintenance/update-memory.mjs` (Syncs MOCs $\rightarrow$ `MEMORY.md`)
- **Semantic Linker:** `vault/scripts/graph/linker.mjs` (Finds implicit relations via Vector Embeddings and adds typed links. Uses **Validation Cache** for speed.)
- **Insight Synthesizer:** `vault/scripts/graph/insight.mjs` (Synthesizes higher-order insights from connected node clusters $\rightarrow$ `vault/01_thinking/insights/`.)
- **Ontology Evolver:** `vault/scripts/graph/evolver.mjs` (Constructs high-level parent concept hierarchies $\rightarrow$ `vault/01_thinking/concepts/`.)
- **Conflict Resolver:** `vault/scripts/maintenance/conflict-resolver.mjs` (Detects contradictory claims $\rightarrow$ applies nuance or deprecation.)
- **Graph Indexer:** `vault/scripts/graph/indexer.mjs` (Builds `graph.json` in `.system/graph/` with metadata and backlinks.)
- **Graph Visualizer:** `vault/scripts/maintenance/generate-graph-html.mjs` (Transforms `graph.json` $\rightarrow$ `vault/06_system/graph_view.html` for human-readable topology inspection.)

---

## 📅 Time-Driven Layer (Cron Jobs)

Managed by the OpenClaw Gateway scheduler to prevent data decay.

| Job Name | Schedule | Script Path | Primary Function |
| :--- | :--- | :--- | :--- |
| **Deep Semantic Linking** | Daily (01:00 UTC) | `vault/scripts/graph/linker.mjs` | Runs with `--deep-verify` to re-validate all semantic relations. |
| **Insight Synthesis** | Daily (02:00 UTC) | `vault/scripts/graph/insight.mjs` | Discovers higher-order insights from connected clusters. |
| **Ontology Evolution** | Weekly (Sun 03:00 UTC) | `vault/scripts/graph/evolver.mjs` | Proposes new abstract conceptual hierarchies. |
| **Full Graph Index** | Weekly (Sun 04:00 UTC) | `vault/scripts/graph/indexer.mjs` | Performs a full rebuild of `graph.json` using `--full` mode. |
| **Conflict Resolution** | Weekly (Sun 05:00 UTC) | `vault/scripts/maintenance/conflict-resolver.mjs` | Validates knowledge integrity by resolving contradictory claims. |

---

## 🔄 Agent Knowledge Lifecycle Flow

### A. The Fact Path (Durable Knowledge)
`Chat Transcript` $\rightarrow$ **Distiller** $\rightarrow$ `vault/00_inbox/` $\rightarrow$ **Inbox Processor** $\rightarrow$ `vault/01_thinking/knowledge/` $\rightarrow$ **Linker** $\rightarrow$ **Insight Synthesizer** $\rightarrow$ **Ontology Evolver** $\rightarrow$ **Indexer** $\rightarrow$ `graph.json` $\rightarrow$ **Graph Search** $\rightarrow$ `Agent Response`

### B. The Growth Path (Behavioral Learning)
`User Correction / Error` $\rightarrow$ **Learning Collector** $\rightarrow$ **Learning Synthesizer** $\rightarrow$ `AGENT-BEHAVIORAL-RULEBOOK.md` & `vault/01_thinking/behavioral_rules/` $\rightarrow$ `Agent Behavior`

### C. The Reflection Path (Self-Evaluation)
`Chat Transcript` $\rightarrow$ **Reflection Engine** $\rightarrow$ `vault/01_thinking/reflections/` $\rightarrow$ **Reflection Synthesizer** $\rightarrow$ `AGENT-BEHAVIORAL-RULEBOOK.md` $\rightarrow$ **Indexer** $\rightarrow$ `graph.json`

---

## 🧠 Memory Retrieval Strategy (Tiered)

When retrieving past context, the agent follows this priority to ensure recency and accuracy:
1. **Level 1 (Graph Discovery):** Use `graph-search.mjs` as the primary instrument to traverse the Knowledge Connection Map. Focus on `metadata.lastIndexed`, node-level `updatedAt`, and typed semantic links (`supports`, `contradicts`, etc.).
2. **Level 2 (Cognitive Context):** Check `vault/`, to align with past reasoning and ontology structures.
3. **Level 3 (Verification):** Use `memory_search` to validate specific details, exact strings, or quotes within notes found through the graph.
4. **Level 4 (Raw Truth):** Use `read` to inspect raw transcripts in `memory/` only if Levels 1-3 do not provide sufficient results.

## 🛠️ Troubleshooting & Maintenance

### 🛡️ System Resilience (AI Fallback & Integrity)
To ensure 100% uptime and data safety, the system implements:
1. **Multi-tier AI Fallback**: Key scripts (`collector`, `reflection`, `distiller`, `linker`, `insight`, `evolver`, `conflict-resolver`) automatically switch from Primary $\rightarrow$ Fallback (Gemini) to prevent chain breakage.
2. **Atomic Writes**: All scripts use a `.tmp` $\rightarrow$ `rename` pattern to prevent file corruption during automated updates.
3. **Semantic Hashing**: `linker.mjs` uses content-only hashing to avoid redundant AI calls when only links are added.

### Manual Execution
To trigger any of these tasks manually, use the `exec` tool or run via CLI:
`node vault/scripts/<path-to-script>.mjs`

### Data Integrity Rules
- **Inbox:** `vault/00_inbox/` is a transit zone for AI-distilled claims. Files are moved to `/01_thinking` or `/02_reference` folders after processing.
- **Thinking Space:** `vault/01_thinking/` is the active "Thinking Space". **DO NOT** delete file `AGENT-BEHAVIORAL-RULEBOOK.md` and files inside `reflections/`, `insights/`, `concepts/`, or `behavioral_rules/`. Notes are considered "processed" once indexed and connected.
- **Reference:** `vault/02_reference/` is a "Static Library". Do not synthesize into MOCs unless the data evolves into a behavioral lesson.
- **Learnings:** `vault/.system/temp_learnings/` are processed via the Learning Synthesizer and extracted to `AGENT-BEHAVIORAL-RULEBOOK`.

### Log Inspection
Check system logs for script errors:
`vault/logs/errors.log`
