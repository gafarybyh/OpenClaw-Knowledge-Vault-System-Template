# 🧠 .system/ — The Subconscious Layer

This directory contains the internal state, caches, and structural maps of the OpenClaw Knowledge Vault. It is the "subconscious" of the agent—data that is critical for AI operations but is not intended for manual human editing.

## 📂 Directory Structure

### 1. `/cache`
Stores high-latency AI results to optimize for speed and cost.
- `embeddings_cache.json`: Stores vector representations of notes. Prevents redundant API calls when calculating semantic similarity.
- `validation_cache.json`: Stores AI-verified relations. Ensures that once a link is validated as "meaningful," it doesn't need to be re-verified.

### 2. `/state`
Stores the global operational state of the vault.
- `.vault_state.json`: Tracks the last run times of scripts, processed file lists, and system versioning.

### 3. `/graph`
Stores the structural map of the knowledge base.
- `graph.json`: The master index of all nodes, links, backlinks, and metadata. This file is the primary source for `graph-search.mjs`.

## ⚠️ Maintenance Rules
- **Do Not Manually Edit**: Modifying these files manually can lead to desynchronization between the notes and the graph.
- **Safe to Delete**: If the graph becomes corrupted or embeddings are outdated, you can safely delete the contents of this folder. The `indexer.mjs` and `linker.mjs` will rebuild them from the source notes.
- **Backup**: This folder should be backed up along with the `vault/` directory to preserve the "learned" connections of the AI.
