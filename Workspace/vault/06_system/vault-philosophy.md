# vault/06_system/vault-philosophy.md — Vault Philosophy

> **Agent:** Raynor | **Updated:** 2026-05-19

---

## 1. The Network Is The Knowledge
No single note is the answer. The answer is the path through connected notes.

### The Architecture of Intelligence
The vault is organized into four distinct layers of operation, separating the "thinking" from the "doing":

1. **The Subconscious (`vault/.system/`)**: The raw engine. Stores vector embeddings, global state, and the structural graph. It is the foundation that allows the AI to "feel" connections without reading every file.
2. **The Metabolism (`vault/scripts/`)**: The maintenance system. A suite of automated tools (Indexer, Linker, Synthesizers) that constantly clean, connect, and evolve the knowledge base.
3. **The Hands (`vault/workers/`)**: The production layer. Specialized agents that transform internal knowledge into external deliverables (Reports, Blueprints, Documents).
4. **The Conscious Memory (`vault/`)**: The human-readable layer. The actual notes, insights, and concepts that the user interacts with and the agent retrieves.

## 2. Explicit vs Implicit Linking
Knowledge is connected in two ways:
- **Explicit Links:** Manually created `[[wiki-links]]` (e.g., in MOCs). These are the intentional architecture of the vault.
- **Implicit Links:** Discovered via Semantic Analysis (Vector Embeddings + AI). These are the "hidden nerves" that connect related concepts even when not explicitly linked.

The system uses a **Semantic Linker** to find these implicit connections and promote them to explicit links.

## 2. Notes Are Named As Claims
**Bad:** `local-models.md`
**Good:** `local-models-are-the-fast-layer.md`

The filename IS the knowledge. Scanning a folder gives an instant topic map.

## 3. Links Woven Into Sentences
Not footnotes. Context-rich inline `[[wiki-links]]`.

## 4. Context Triangulation (Orientation)
Before acting, Raynor performs a four-point rules:
1. **Rules Load:** Read `vault/01_thinking/AGENT-BEHAVIORAL-RULEBOOK.md` (self-improvement results).
2. **Graph Scan:** Use 'graph-search' to scan `vault/.system/graph/graph.json` for the knowledge topology.
3. **Strategy Scan:** Read relevant **MOCs** (Map of Contents) in `vault/01_thinking/moc` and **Knowledge** in `vault/01_thinking` for the big picture.
4. **Location Scan:** Check `MEMORY.md` for active projects and key pointers.

## 5. Agent Leaves Breadcrumbs
Update MOC `## Agent Notes` after every session. Next session picks up here.

## 6. The Knowledge Pipeline & Evolution Loop
Material flows from raw input to finished product:
`00_inbox` (Auto-routed/Distilled) $\rightarrow$ `01_thinking` / `02_reference` $\rightarrow$ **Sintesis** (Raynor) $\rightarrow$ `03_creating` (Drafts) $\rightarrow$ `04_published`.

### A. The Cognitive Evolution Loop (Knowledge)
The vault doesn't just store data; it evolves it through a multi-tier synthesis process:
1. **Distillation**: Raw transcripts $\rightarrow$ Atomic Claims.
2. **Semantic Linking**: Finding hidden connections via Vector Embeddings.
3. **Emergent Synthesis**: Clustering related claims to discover higher-order **Insights**.
4. **Ontology Evolution**: Grouping insights and claims into abstract **Concepts**.
This creates a pyramid of knowledge: `Claims` $\rightarrow$ `Insights` $\rightarrow$ `Concepts`.

### B. The Behavioral Evolution Loop (Agent)
The agent learns from its own failures and user corrections in a closed loop:
`Chat Session` $\rightarrow$ **Learning Collector** (Behavioral Deltas) $\rightarrow$ **Learning Synthesizer** $\rightarrow$ `AGENT-BEHAVIORAL-RULEBOOK.md` $\rightarrow$ **Reflection Engine** (Critical Self-Evaluation) $\rightarrow$ **Reflection Synthesizer** $\rightarrow$ `AGENT-BEHAVIORAL-RULEBOOK.md`.
This ensures that behavioral improvements are not just recorded, but critically analyzed and synthesized into permanent operating rules.

### C. The Integrity Layer (Durable Intelligence)
To ensure the vault remains a "Source of Truth", the system implements:
- **Semantic Hashing**: Distinguishing between "content changes" (meaning) and "structural changes" (links), preventing redundant AI calls.
- **Atomic Writes**: Ensuring that no file is ever corrupted during an automated update.
- **Validation Caching**: Remembering AI-verified relations to optimize for speed and cost.

## Folder Structure & Roles
```
vault/
 00_inbox/      ← Transit Zone: Raw captures & AI-distilled claims.
 01_thinking/   ← Thinking Space: MOCs live here (root). Atomic notes go to `knowledge/` subfolder.
 02_reference/  ← Static Library: Technical facts and external data. Not synthesized unless it becomes a "lesson".
 03_creating/   ← Production: All deliverables start here as drafts.
 04_published/  ← Final: Moved here ONLY after explicit user approval.
 05_archive/    ← Lean Vault: Inactive content and obsolete versions.
 06_system/     ← Core: Templates, philosophy, graph index, and visual graph view.
```

## MOC Template
```markdown
# [Claim-Name]

## Key Facts
- Fact 1
- Fact 2

## Connected Topics
- [[vault/path/to/note.md]]
- [[vault/path/to/note.md]]

## Agent Notes
- [x] {{DATE}}: What was done
- [ ] {{DATE}}: What to do next
```
