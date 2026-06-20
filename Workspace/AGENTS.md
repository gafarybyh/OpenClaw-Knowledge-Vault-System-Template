# AGENTS: Operating Rules

## Orientation Protocol (Context Triangulation)
**MANDATORY** at the start of every session before responding to the user:
1. **Rules Load:** Read `vault/01_thinking/AGENT-BEHAVIORAL-RULEBOOK.md` (self-improvement results).
2. **Location Scan:** Check `MEMORY.md` for active projects (MOC) and key pointers.
3. **Strategy Scan:** Read relevant **MOCs** (Map of Contents) for the big picture.
4. **Confirmation:** After completing steps 1-3, confirm with: reply the user message.

## Tool Protocol
- **[MANDATORY]** All `exec` calls MUST use the `rtk` proxy to minimize tokens: `rtk <cmd>` for any shell command.
- **External Tools:** Read `TOOLS.md` for available external tools.
- **Document Build:** Use `python vault/scripts/build_document.py <input.md> [output.pdf]` for PDF generation with embedded diagrams. Diagrams auto-render from mermaid blocks to `vault/03_creating/media/`.

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
  - **Workflow:** Always perform research, data gathering, and synthesis first. Only delegate to sub-agents with a clear brief and pre-processed inputs (e.g., research results for `document-writer`).
- **`sessions_yield`:** Acknowledge task and end turn immediately, prioritize sub agent background execution to maintain uninterrupted conversation flow.
  - **Single-Message Rule (MANDATORY):** After spawning a sub-agent, send ONLY ONE message to the user before yielding. That message should combine: (1) brief spawn acknowledgment and (2) `sessions_yield`. Do NOT send a separate status update message followed by yield — this causes duplicate messages to the user.
- **Project Creation:** Use format template MOC `vault/06_system/template-MOC.md` and create a Map of Content (MOC) file inside `vault/01_thinking/moc`.

## Sub-Agent Workers
**[MANDATORY]** Worker must use their owned `SKILL.md`.
| Worker | When To Use | Model | Skill File |
|--------|---------|-------|------------------|
| document-writer | Reports, documentation, SOPs, proposals, summaries, polished deliverables | `google/gemma-4-31b-it` | `vault/workers/document-writer/SKILL.md` |
| data-analyst | Calculations, spreadsheet analysis, validation, trends, metrics, forecasting inputs | `google/gemma-4-31b-it` | `vault/workers/data-analyst/SKILL.md` |
| prd-creator | Creating comprehensive Product Requirements Documents (PRD) based on modular inputs | `google/gemma-4-31b-it` | `vault/workers/prd-creator/SKILL.md` |

## Verification (PreCompletion)
Before finishing, compare output against the user's original intent. For code, run tests and use **loop detection** (stop if 3+ edits fail).

## Tool Management
- Prioritize tools based on task efficiency. For real-time data, default to `web_search` or `tavily_search`; for historical context, use `graph-search` first.
- For tasks requiring more than 3 tool calls or 30 seconds of processing, default to `sessions_spawn` with clear objectives.

## Adaptive Communication
- Adapt communication style based on user feedback and context. If the user requests detailed explanations, provide them. Otherwise, default to brevity.
- Log user feedback and review weekly to adjust communication styles and tool usage patterns.

## Ethics and Privacy
- Never log or store personal user data without explicit permission. Use anonymized references where applicable.

## Error Handling
- For critical tasks, pre-emptively check dependencies (e.g., tool availability, file permissions) and notify the user of potential issues.
- For code or data tasks, run validation tests or sanity checks before presenting results to the user.

## Priority Protocol
- Prioritize tasks with explicit deadlines or user-flagged urgency. Reorganize workflow dynamically based on new inputs.
