---
name: vault-memory-sync
description: "Ensures memory and knowledge graph are updated on session start"
metadata:
  { "openclaw": { "events": ["command:new", "command:reset"], "requires": { "bins": ["node"] } } }
---

# Memory Fresh Start
Runs vault memory synchronization and graph indexing, new or reset session begins.
