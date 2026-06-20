/**
 * INSIGHT SYNTHESIZER WORKFLOW (Evolutionary Engine)
 * =================================================
 * Skrip ini mengubah hubungan antar catatan menjadi pengetahuan baru (Sintesis).
 *
 * ALUR KERJA:
 * 1. INISIALISASI: Memuat konfigurasi AI dan membaca 'graph.json' serta 'embeddings_cache.json'.
 *
 * 2. FILTER DUPLIKASI: Memindai folder 'insights/' untuk memastikan node yang sudah
 *    disintesis tidak diproses ulang.
 *
 * 3. PRIORITAS & SKORING (Evolutionary Discovery):
 *    - Mengurutkan node berdasarkan 'updatedAt' (terbaru didahulukan).
 *    - Mencari cluster menggunakan pendekatan Hybrid:
 *        a. Link-based: Mencari koneksi eksplisit di graph.
 *        b. Semantic-based: Mencari kemiripan makna via Cosine Similarity (Embedding).
 *    - Menghitung Quality Score: (Rata-rata Kemiripan × Jumlah Koneksi).
 *
 * 4. BATCH PROCESSING:
 *    - Mengambil N cluster terbaik (berdasarkan skor tertinggi) untuk diproses dalam satu run.
 *    - Hal ini menjaga kualitas sintesis dan mengontrol biaya API.
 *
 * 5. SINTESIS AI:
 *    - Mengambil konten lengkap dari semua node dalam cluster.
 *    - AI menganalisis hubungan tersebut untuk menciptakan 'Insight' tingkat tinggi
 *      (bukan sekadar ringkasan).
 *
 * 6. IMPLEMENTASI & RECURSIVE LINKING:
 *    - Membuat file .md baru di folder 'insights/'.
 *    - Menambahkan link balik (backlink) dari catatan sumber ke file insight baru.
 *    - Hal ini memungkinkan terjadinya 'Recursive Synthesis' (Insight → Meta-Insight).
 *
 * 7. FINALISASI: Memicu update graph dan memory untuk sinkronisasi data.
 */

import { logError, log } from '../core/logger.mjs';
import { callAIJson, sleep } from '../core/ai-client.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');

// --- CONFIGURATION ---

const VAULT_PATH = path.join(WORKSPACE_ROOT, 'vault');
const INSIGHTS_DIR = path.join(VAULT_PATH, '01_thinking', 'insights');
const GRAPH_FILE = path.join(VAULT_PATH, '.system/graph/graph.json');
const CACHE_FILE = path.join(VAULT_PATH, '.system/cache/embeddings_cache.json');
const SIMILARITY_THRESHOLD = 0.8;
const BATCH_SIZE = 3;
const AI_MAX_RETRIES = 3;
const AI_RETRY_DELAY_MS = 3000;
const MAX_INPUT_CHARS = 25000;

const SYSTEM_PROMPT =
  'You are a Knowledge Architect specializing in Zettelkasten synthesis. ' +
  'Perform "Emergent Synthesis": analyze a cluster of connected notes to discover a higher-order principle, hidden pattern, or novel theoretical connection not explicitly stated in any single note. ' +
  'Your output must be a "Synthesis", not a "Summary". A summary describes what is there; a synthesis creates new meaning. ' +
  'Output ONLY valid JSON. No markdown, no explanation, no preamble.';

const USER_PROMPT = (notesContent) =>
  `Analyze this cluster of connected notes and perform emergent synthesis.

RULES:
- "insight_title": Use kebab-case, specific and claim-based (e.g., 'cognitive-load-theory-limits-ai-prompt-complexity').
- "insight_statement": One-sentence thesis asserting a new discovery or connection.
- "detailed_analysis": Rigorous markdown report synthesizing the notes with emergent connections.
- "confidence_score": Float 0.0–1.0.
- "reflection_score": Float 0.0–1.0.
- "tags": Array of relevant strings (max 5).

Example:
Connected Notes:
### Note: react-performance-patterns
React hooks optimize rendering. Memoization reduces re-renders. useCallback stabilizes function references.

### Note: cognitive-load-theory
Working memory is limited to 7±2 items. Extraneous cognitive load impairs learning. Germane load promotes understanding.

→ {"insight_title": "cognitive-load-theory-limits-ai-prompt-complexity", "insight_statement": "The 7±2 working memory limit constrains effective AI prompt design, requiring hierarchical decomposition of complex instructions.", "detailed_analysis": "## Emergent Connection\nBoth React performance optimization and cognitive load theory address the same fundamental constraint: limited processing capacity. React's memoization and hooks reduce computational overhead much like how cognitive load theory advocates reducing extraneous load. This suggests AI prompt engineering should adopt similar decomposition strategies...\n\n## Justification\nThe synthesis reveals that optimal instruction design for both human cognition and software architecture follows the same principle of managing limited processing resources.", "confidence_score": 0.88, "reflection_score": 0.85, "tags": ["reasoning", "architecture", "efficiency", "cognitive-science"]}

Connected Notes:
<<user_content>
${notesContent}
</user_content>

Output:`;

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch (e) {
      log.warn(`[Insight] ⚠️ Failed to read embeddings cache: ${e.message}`);
      logError('insight.mjs', e);
    }
  }
  return {};
}

function validateInsight(data) {
  if (!data || typeof data !== 'object') return null;

  // Validate and sanitize insight_title
  if (typeof data.insight_title !== 'string' || !data.insight_title.trim()) {
    data.insight_title = 'untitled-insight';
  }
  data.insight_title = data.insight_title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);

  // Validate insight_statement
  if (typeof data.insight_statement !== 'string' || !data.insight_statement.trim()) {
    return null; // Statement is required
  }

  // Validate detailed_analysis
  if (typeof data.detailed_analysis !== 'string') data.detailed_analysis = '';

  // Validate scores
  if (typeof data.confidence_score !== 'number' || data.confidence_score < 0 || data.confidence_score > 1) {
    data.confidence_score = 0.85;
  }
  if (typeof data.reflection_score !== 'number' || data.reflection_score < 0 || data.reflection_score > 1) {
    data.reflection_score = 0.9;
  }

  // Validate tags
  if (!Array.isArray(data.tags)) data.tags = [];
  data.tags = data.tags.filter(t => typeof t === 'string').slice(0, 5);
  if (data.tags.length === 0) data.tags = ['insight'];

  return data;
}

async function synthesizeInsight(notesContent) {
  // Truncate if input exceeds token safety limit
  if (notesContent.length > MAX_INPUT_CHARS) {
    log.warn(`[Insight] ⚠️ Notes content truncated from ${notesContent.length} to ${MAX_INPUT_CHARS} chars.`);
    notesContent = notesContent.substring(0, MAX_INPUT_CHARS) + '\n\n[TRUNCATED]';
  }

  const { data, error, attempts } = await callAIJson([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT(notesContent) }
  ], { 
    temperature: 0.1, 
    maxRetries: AI_MAX_RETRIES, 
    retryDelayMs: AI_RETRY_DELAY_MS, 
    promptLabel: 'insight.mjs' 
  });

  if (data) {
    const validated = validateInsight(data);
    if (validated) {
      log.success(`[Insight] ✅ AI insight synthesis successful (${attempts} attempt(s)).`);
      return validated;
    }
  }

  if (error) {
    log.warn(`[Insight] ⚠️ AI synthesis failed after ${attempts} attempts: ${error}`);
    logError('insight.mjs', new Error(error));
  }

  return null;
}

function loadExistingInsights() {
  const existing = new Set();
  if (!fs.existsSync(INSIGHTS_DIR)) return existing;
  const files = fs.readdirSync(INSIGHTS_DIR).filter(f => f.endsWith('.md'));

  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(INSIGHTS_DIR, f), 'utf8');
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        for (const l of fmMatch[1].split(/\r?\n/)) {
          if (l.startsWith('supporting_nodes:') || l.startsWith('derived_from:')) {
            const listStr = l.substring(l.indexOf(':') + 1).trim();
            const nodes = listStr.replace(/[\[\]'"]/g, '').split(',').map(n => n.trim()).filter(Boolean);
            for (const n of nodes) existing.add(n);
          }
        }
      }
    } catch (e) { /* skip unreadable files */ }
  }
  return existing;
}

function safeWriteFile(filePath, content) {
  try {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    log.error(`[Insight] ❌ Atomic write failed for ${filePath}: ${e.message}`);
    logError('insight.mjs', e);
    throw e;
  }
}

function addInsightLink(filePath, insightFileName) {
  try {
    if (!fs.existsSync(filePath)) return;
    let content = fs.readFileSync(filePath, 'utf8');

    // Avoid duplicate links
    if (content.includes(`[[${insightFileName}]]`)) return;

    const linkLine = `- synthesized_insight:: [[${insightFileName}]]`;

    if (!content.includes('## Semantic Relations')) {
      content += '\n\n## Semantic Relations\n';
    }

    content = content.replace(/## Semantic Relations\r?\n/, `## Semantic Relations\n${linkLine}\n`);
    safeWriteFile(filePath, content);
  } catch (e) {
    log.warn(`[Insight] ⚠️ Failed to add recursive link to ${filePath}: ${e.message}`);
    logError('insight.mjs', e);
  }
}

async function main() {
  log.step('🚀 Starting Insight Synthesizer...');
  if (!fs.existsSync(GRAPH_FILE)) {
    log.warn(`[Insight] ⚠️ Graph file not found. Please run graph-indexer first.`);
    return;
  }

  try {
    const graphData = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const nodes = graphData.nodes || {};
    const nodeNames = Object.keys(nodes);

    if (nodeNames.length === 0) {
      log.info('[Insight] Graph is empty. Skipping synthesis.');
      return;
    }

    const processedNodes = loadExistingInsights();
    const cache = loadCache();

    // 1. Priority Sorting: Sort nodes by updatedAt (descending) to prioritize recent thoughts
    const sortedNodeNames = [...nodeNames].sort((a, b) => {
      const dateA = nodes[a]?.updatedAt ? new Date(nodes[a].updatedAt).getTime() : 0;
      const dateB = nodes[b]?.updatedAt ? new Date(nodes[b].updatedAt).getTime() : 0;
      return dateB - dateA;
    });

    // 2. Cluster Quality Scoring
    const candidateClusters = [];

    for (const name of sortedNodeNames) {
      const node = nodes[name];
      if (processedNodes.has(name)) continue;

      const connections = [...(node.links || []), ...(node.backlinks || [])];
      const linkNeighbors = [...new Set(connections)].filter(c => c !== name && nodes[c]);

      const semanticNeighbors = [];
      const vecA = cache[name]?.embedding;
      if (vecA) {
        for (const otherName of nodeNames) {
          if (otherName === name) continue;
          const vecB = cache[otherName]?.embedding;
          if (vecB) {
            const sim = cosineSimilarity(vecA, vecB);
            if (sim > SIMILARITY_THRESHOLD) semanticNeighbors.push({ name: otherName, sim });
          }
        }
      }

      const allNeighbors = [...new Set([...linkNeighbors, ...semanticNeighbors.map(s => s.name)])].filter(n => nodes[n]);

      if (allNeighbors.length >= 2) {
        const avgSim = semanticNeighbors.length > 0
          ? semanticNeighbors.reduce((acc, curr) => acc + curr.sim, 0) / semanticNeighbors.length
          : SIMILARITY_THRESHOLD;

        candidateClusters.push({
          center: name,
          neighbors: allNeighbors,
          score: avgSim * allNeighbors.length
        });
      }
    }

    if (candidateClusters.length === 0) {
      log.info('[Insight] ℹ️ No new clusters found for synthesis.');
      return;
    }

    // 3. Batch Processing: Sort by score and take top BATCH_SIZE
    candidateClusters.sort((a, b) => b.score - a.score);
    const batch = candidateClusters.slice(0, BATCH_SIZE);
    log.info(`[Insight] 🎯 Found ${candidateClusters.length} potential clusters. Processing top ${batch.length}.`);

    for (const cluster of batch) {
      const clusterNodes = [cluster.center, ...cluster.neighbors];
      log.debug(`[Insight] 🔍 Processing "${cluster.center}" (Score: ${cluster.score.toFixed(2)}) with: ${cluster.neighbors.join(', ')}`);

      // Load contents of these nodes
      let notesContent = '';
      for (const name of clusterNodes) {
        const node = nodes[name];
        const fullPath = path.resolve(WORKSPACE_ROOT, node.path);
        if (fs.existsSync(fullPath)) {
          const body = fs.readFileSync(fullPath, 'utf8').replace(/^---\r?\n([\s\S]*?)\r?\n---/, '').trim();
          notesContent += `\n### Note: ${name}\n${body}\n`;
        }
      }

      const result = await synthesizeInsight(notesContent);

      if (result) {
        if (!fs.existsSync(INSIGHTS_DIR)) {
          fs.mkdirSync(INSIGHTS_DIR, { recursive: true });
        }

        const fileName = `${result.insight_title || 'insight'}.md`;
        const filePath = path.join(INSIGHTS_DIR, fileName);

        if (fs.existsSync(filePath)) {
          log.info(`[Insight] ℹ️ Insight ${fileName} already exists. Skipping.`);
        } else {
          const dateStr = new Date().toISOString().split('T')[0];
          const supportingNodesStr = JSON.stringify(clusterNodes);

          const content = `---
type: insight
confidence: ${result.confidence_score}
derived_from: ${supportingNodesStr}
supporting_nodes: ${supportingNodesStr}
reflection_score: ${result.reflection_score}
validation_count: 1
created: ${dateStr}
tags: ${JSON.stringify(result.tags)}
---

# Insight: ${result.insight_statement}

## Statement
${result.insight_statement}

## Detailed Analysis
${result.detailed_analysis}

## Supporting Evidence
This insight was synthesized from the following nodes:
${clusterNodes.map(n => `- [[${n}]]`).join('\n')}
`;

          safeWriteFile(filePath, content);
          log.success(`[Insight] ✅ Synthesized new insight: ${fileName}`);
        }

        // Mark nodes as processed to ensure cluster diversity in the same run
        for (const n of clusterNodes) processedNodes.add(n);

        // Recursive Linking: Link supporting nodes back to this new insight
        for (const nodeName of clusterNodes) {
          const node = nodes[nodeName];
          if (node) {
            const nodePath = path.resolve(WORKSPACE_ROOT, node.path);
            addInsightLink(nodePath, fileName.replace(/\.md$/, ''));
          }
        }
      } else {
        log.info('[Insight] ℹ️ Failed to synthesize insight.');
      }
    }
  } catch (err) {
    log.error(`[Insight] ❌ Insight Synthesizer Error: ${err.message}`);
    logError('insight.mjs', err);
    process.exit(1);
  }
}

main();
