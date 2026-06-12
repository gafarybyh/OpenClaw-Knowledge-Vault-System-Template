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
 *    - Hal ini memungkinkan terjadinya 'Recursive Synthesis' (Insight $\rightarrow$ Meta-Insight).
 *
 * 7. FINALISASI: Memicu update graph dan memory untuk sinkronisasi data.
 */

import { logError } from '../core/logger.mjs';
import { callAI } from '../core/ai-client.mjs';
import { parseAIJson } from '../core/json-parser.mjs';
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
const REQUEST_TIMEOUT_MS = 25_000;
const SIMILARITY_THRESHOLD = 0.8; // Threshold for semantic neighbors
const BATCH_SIZE = 3; // Process up to 3 best clusters per run

const SYSTEM_PROMPT = `You are a Knowledge Architect specializing in Zettelkasten synthesis. Your goal is to perform "Emergent Synthesis": analyzing a cluster of connected notes to discover a higher-order principle, a hidden pattern, or a novel theoretical connection that is not explicitly stated in any single note.

Your output must be a "Synthesis", not a "Summary". A summary describes what is there; a synthesis creates new meaning by connecting what is there.

Output format:
You must output a single, valid JSON object containing:
- "insight_title": string (a specific, claim-based title using kebab-case, e.g., 'cognitive-load-theory-limits-ai-prompt-complexity')
- "insight_statement": string (a strong, one-sentence thesis statement that asserts a new discovery or connection)
- "detailed_analysis": string (a rigorous markdown report that synthesizes the notes, explains the emergent connection, and justifies why this insight is a higher-level understanding)
- "confidence_score": number (float between 0 and 1)
- "reflection_score": number (float between 0 and 1)
- "tags": array of strings

CRITICAL: Output ONLY the JSON. No explanations, no markdown wrapper, no conversational text.`;



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
      console.warn('⚠️ Gagal membaca cache embeddings.');
      logError('insight.mjs', e);
    }
  }
  return {};
}

async function synthesizeInsight(notesContent) {
  try {
    const prompt = `${SYSTEM_PROMPT}\n\nConnected Notes:\n${notesContent}`;
    const content = await callAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ], { temperature: 0.1, timeoutMs: REQUEST_TIMEOUT_MS });

    if (typeof content === 'string') {
      const { data, error } = parseAIJson(content, 'insight.mjs');
      if (data) {
        console.log('✅ AI insight synthesis successful.');
        return data;
      }
      if (error) console.warn(`⚠️ Insight JSON parse failed: ${error}`);
    }
  } catch (err) {
    console.warn(`⚠️ AI synthesis failed: ${err.message}`);
    logError('insight.mjs', err);
  }

  return null;
}

function loadExistingInsights() {
  const existing = new Set();
  if (!fs.existsSync(INSIGHTS_DIR)) return existing;
  const files = fs.readdirSync(INSIGHTS_DIR).filter(f => f.endsWith('.md'));
  
  files.forEach(f => {
    try {
      const content = fs.readFileSync(path.join(INSIGHTS_DIR, f), 'utf8');
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        fmMatch[1].split(/\r?\n/).forEach(l => {
          if (l.startsWith('supporting_nodes:') || l.startsWith('derived_from:')) {
            const listStr = l.substring(l.indexOf(':') + 1).trim();
            // simple array parse e.g. [nodeA, nodeB]
            const nodes = listStr.replace(/[\[\]'"]/g, '').split(',').map(n => n.trim()).filter(Boolean);
            nodes.forEach(n => existing.add(n));
          }
        });
      }
    } catch (e) {}
  });
  return existing;
}

function safeWriteFile(filePath, content) {
  try {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    console.error(`❌ Atomic write failed for ${filePath}: ${e.message}`);
    logError('insight.mjs', e);
    throw e;
  }
}

async function main() {
  console.log('🚀 Starting Insight Synthesizer...');
  if (!fs.existsSync(GRAPH_FILE)) {
    console.warn(`⚠️ Graph file ${GRAPH_FILE} not found. Please run graph-indexer first.`);
    return;
  }

  try {
    const graphData = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const nodes = graphData.nodes || {};
    const nodeNames = Object.keys(nodes);
    
    if (nodeNames.length === 0) {
      console.log('Graph is empty. Skipping synthesis.');
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
        // Calculate Quality Score: (Avg Similarity of semantic neighbors) * (Total Connectivity)
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
      console.log('ℹ️ No new clusters found for synthesis.');
      return;
    }

    // 3. Batch Processing: Sort by score and take top BATCH_SIZE
    candidateClusters.sort((a, b) => b.score - a.score);
    const batch = candidateClusters.slice(0, BATCH_SIZE);
    console.log(`🎯 Found ${candidateClusters.length} potential clusters. Processing top ${batch.length} based on quality score.`);

    for (const cluster of batch) {
      const clusterNodes = [cluster.center, ...cluster.neighbors];
      console.log(`🔍 Processing cluster centering around "${cluster.center}" (Score: ${cluster.score.toFixed(2)}) with neighbors: ${cluster.neighbors.join(', ')}`);

      // Load contents of these nodes
      let notesContent = '';
      clusterNodes.forEach(name => {
        const node = nodes[name];
        // Resolve path
        const fullPath = path.resolve(WORKSPACE_ROOT, node.path);
        if (fs.existsSync(fullPath)) {
          const body = fs.readFileSync(fullPath, 'utf8').replace(/^---\r?\n([\s\S]*?)\r?\n---/, '').trim();
          notesContent += `\n### Note: ${name}\n${body}\n`;
        }
      });

      const result = await synthesizeInsight(notesContent);

      if (result) {
        if (!fs.existsSync(INSIGHTS_DIR)) {
          fs.mkdirSync(INSIGHTS_DIR, { recursive: true });
        }

      const sanitizeTitle = result.insight_title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const fileName = `${sanitizeTitle || 'insight'}.md`;
      const filePath = path.join(INSIGHTS_DIR, fileName);

      const dateStr = new Date().toISOString().split('T')[0];
      const supportingNodesStr = JSON.stringify(clusterNodes);

      const content = `---
type: insight
confidence: ${result.confidence_score || 0.85}
derived_from: ${supportingNodesStr}
supporting_nodes: ${supportingNodesStr}
reflection_score: ${result.reflection_score || 0.9}
validation_count: 1
created: ${dateStr}
tags: ${JSON.stringify(result.tags || ['insight'])}
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

      if (fs.existsSync(filePath)) {
        console.log(`ℹ️ Insight ${fileName} already exists. Skipping to avoid duplication.`);
      } else {
        safeWriteFile(filePath, content);
        console.log(`✅ Synthesized new insight: ${fileName}`);
      }

      // Mark nodes as processed to ensure cluster diversity in the same run
      clusterNodes.forEach(n => processedNodes.add(n));

      // Recursive Linking: Link supporting nodes back to this new insight
      clusterNodes.forEach(nodeName => {
        const node = nodes[nodeName];
        if (node) {
          const nodePath = path.resolve(WORKSPACE_ROOT, node.path);
          addInsightLink(nodePath, fileName.replace(/\.md$/, ''));
        }
      });
    } else {
      console.log('ℹ️ Failed to synthesize insight.');
    }
  }
  } catch (err) {
    console.error('Insight Synthesizer Error:', err.message);
    logError('insight.mjs', err);
    process.exit(1);
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
    console.warn(`⚠️ Failed to add recursive link to ${filePath}: ${e.message}`);
    logError('insight.mjs', e);
  }
}

main();
