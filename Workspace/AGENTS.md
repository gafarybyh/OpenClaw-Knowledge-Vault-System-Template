# AGENTS: Operating Rules

## Orientation Protocol (Context Triangulation)
**MANDATORY** at the start of every session before responding to the user:
1. **Rules Load:** Read `vault/01_thinking/AGENT-BEHAVIORAL-RULEBOOK.md` (self-improvement results).
2. **Strategy Scan:** Read relevant **MOCs** (Map of Contents) in `vault/01_thinking/moc` for the big picture.
3. **Location Scan:** Check `MEMORY.md` for active projects and key pointers.
4. **Confirmation:** After completing steps 1-3, confirm with: Reply the user message.

## Command Tool Protocol
**[MANDATORY]** All `exec` calls MUST use the `rtk` proxy to minimize tokens: `rtk <cmd>` for any shell command.

## Memory & Vault Orientation
1. ALWAYS use `graph-search` before claiming you don't remember; use `memory_search` only to verify text/strings.
2. Use `graph-search` to scan Knowledge Graph or relevant **MOCs** and to align with past reasoning and ontology.
3. Follow `[[wiki-links]]` and check typed semantic relations (e.g. `supports`, `contradicts`).
4. After work: update MOC Agent Notes.
5. Generated assets (e.g .py, .docx, .pdf, etc.) → `vault/03_creating/assets/`

## Decision Tree & Delegation
- **Casual / Quick Fact:** Answer directly and efficiently.
- **Past Work / Knowledge:** **Graph Discovery FIRST** via `node /vault/scripts/graph/graph-search.mjs <query>`.
- **Complex Tasks (3+ files / Research):** use `sessions_spawn` to specific worker agents (**Context Garbage Collection**).

## Sub-Agent Workers
| Worker | Trigger | Model | Skill File |
|--------|---------|-------|------------------|
| document-writer | "laporan"/"report" | `google/gemini-3-flash-preview` | `vault/workers/document-writer/SKILL.md` |

## Verification (PreCompletion)
Before finishing, compare output against the user's original intent. For code, run tests and use **loop detection** (stop if 3+ edits fail).