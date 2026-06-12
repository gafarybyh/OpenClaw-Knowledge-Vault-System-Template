# AGENTS: Operating Rules

## Orientation Protocol (Context Triangulation)
**MANDATORY** at the start of every session before responding to the user:
1. **Rules Load:** Read `vault/01_thinking/AGENT-BEHAVIORAL-RULEBOOK.md` (self-improvement results).
2. **Location Scan:** Check `MEMORY.md` for active projects (MOC) and key pointers.
3. **Strategy Scan:** Read relevant **MOCs** (Map of Contents) for the big picture.
4. **Confirmation:** After completing steps 1-3, confirm with: reply the user message.

## Tool Protocol
- **[MANDATORY]** All `exec` calls MUST use the `rtk` proxy to minimize tokens: `rtk <cmd>` for any shell command.
- **Tools:** Read `TOOLS.md` for available tools

## Memory & Vault Orientation
1. Use `graph-search` before claiming information is unavailable when the task may relate to previous work, projects (MOCs), notes, or stored knowledge.
2. Use `memory_search` only to verify text/strings.
3. Follow `[[wiki-links]]` and check typed semantic relations (e.g. `supports`, `contradicts`).
4. After project work: update MOC and execute `node vault/scripts/graph/indexer.mjs` to synchronize `graph.json`.
5. Generated files (e.g .py, .docx, .pdf, etc.) should inside `vault/03_creating/assets/`

## Decision Tree & Delegation
- **Casual / Quick Fact:** Answer directly and efficiently.
- **Past Work / Knowledge:** **Graph Discovery FIRST** via `node /vault/scripts/graph/graph-search.mjs <query>`.
- **Sub Agents:** Use `sessions_spawn` **only for tasks explicitly listed in the *Sub-Agent Workers* table**—no ad-hoc spawns without user approval (**Context Garbage Collection**).
- **`sessions_yield`:** Acknowledge task and end turn immediately, prioritize sub agent background execution to maintain uninterrupted conversation flow.
- **Project Creation:** Use format template MOC `vault/06_system/template-MOC.md` and create a Map of Content (MOC) file inside `vault/01_thinking/moc`.

## Sub-Agent Workers
**[MANDATORY]** Always use worker `SKILL.md`.
| Worker | When To Use | Model | Skill File |
|--------|---------|-------|------------------|
| document-writer | Reports, documentation, SOPs, proposals, summaries, polished deliverables | `google/gemma-4-31b-it` | `vault/workers/document-writer/SKILL.md` |
| data-analyst | Calculations, spreadsheet analysis, validation, trends, metrics, forecasting inputs | `mistral/mistral-medium-2508` | `vault/workers/data-analyst/SKILL.md` |

## Verification (PreCompletion)
Before finishing, compare output against the user's original intent. For code, run tests and use **loop detection** (stop if 3+ edits fail).
