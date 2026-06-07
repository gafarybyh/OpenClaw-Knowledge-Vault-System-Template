/**
 * GRAPH SEARCH SEMANTIC — AGENT TOOL v8
 * ======================================
 * Output: JSON minimal untuk agent dengan tool read-file
 * 
 * Agent menerima:
 *   - node name (untuk referensi)
 *   - path (untuk tool read-file)
 *   - depth (untuk prioritas)
 *   - preview + metadata (untuk seleksi sebelum read)
 * 
 * Agent bertanggung jawab:
 *   - Pilih file mana yang dibaca (via preview)
 *   - Read file via tool built-in
 *   - Susun context sendiri
 */

import fs from 'fs';
import path from 'path';
import { logError } from '../core/logger.mjs';
import { getEmbedding as coreGetEmbedding } from '../core/ai-client.mjs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');
const VAULT_PATH = path.join(WORKSPACE_ROOT, 'vault');

const SEMANTIC_THRESHOLD = parseFloat(process.env.SEMANTIC_THRESHOLD) || 0.3;
const TOP_K = parseInt(process.env.TOP_K) || 5;
const MAX_NODES = parseInt(process.env.MAX_NODES) || 10;
const HUB_DEGREE_LIMIT = parseInt(process.env.HUB_DEGREE_LIMIT) || 25;

const CACHE_FILE = path.join(VAULT_PATH, '.system/cache/embeddings_cache.json');
const GRAPH_FILE = path.join(VAULT_PATH, '.system/graph/graph.json');
const QUERY_CACHE_FILE = path.join(VAULT_PATH, '.system/cache/query_embed_cache.json');

const args = process.argv.slice(2);
let query = "";
let depth = 2;

if (args.length > 0) {
  const lastArg = args[args.length - 1];
  if (!isNaN(lastArg) && args.length > 1) {
    depth = parseInt(lastArg);
    query = args.slice(0, -1).join(' ');
  } else {
    query = args.join(' ');
  }
}

if (!query) {
  console.log(JSON.stringify({ 
    status: "error", 
    error: "No query. Usage: node <file> <query> [depth]" 
  }, null, 2));
  process.exit(1);
}

// ==================== UTILITAS ====================
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    na += vecA[i] * vecA[i];
    nb += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function getEmbedding(text) {
  return await coreGetEmbedding(text);
}

function loadQueryCache() {
  try { return JSON.parse(fs.readFileSync(QUERY_CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveQueryCache(c) {
  try {
    // Cap cache size to prevent unbounded growth
    const entries = Object.entries(c);
    if (entries.length > 500) {
      entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      const trimmed = Object.fromEntries(entries.slice(0, 300));
      fs.writeFileSync(QUERY_CACHE_FILE, JSON.stringify(trimmed, null, 2));
      return;
    }
    fs.writeFileSync(QUERY_CACHE_FILE, JSON.stringify(c, null, 2));
  } catch (e) {
    console.error(`⚠️ Failed to save query cache: ${e.message}`);
  }
}

function getQueryHash(text) {
  return crypto.createHash('md5').update(text.toLowerCase().trim()).digest('hex');
}

async function getCachedOrFreshEmbedding(text) {
  const cache = loadQueryCache();
  const h = getQueryHash(text);
  const now = Date.now();
  if (cache[h] && (now - cache[h].ts) < 86400000 && Array.isArray(cache[h].embedding)) {
    console.error(`♻️ Query embed cache hit`);
    return cache[h].embedding;
  }
  const emb = await getEmbedding(text);
  if (!Array.isArray(emb) || emb.length === 0) {
    throw new Error('Empty embedding returned from API');
  }
  cache[h] = { embedding: emb, ts: now };
  saveQueryCache(cache);
  return emb;
}

// ==================== LOAD DATA ====================
let graph = {};
try {
  const d = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
  graph = d.nodes || d;
  // Validate graph structure
  if (typeof graph !== 'object' || Array.isArray(graph)) {
    console.error('⚠️ Invalid graph structure, treating as empty');
    graph = {};
  }
} catch (e) {
  if (e.code === 'ENOENT') {
    console.log(JSON.stringify({
      status: "error",
      error: "Graph index not found. Run graph indexer first."
    }, null, 2));
  } else {
    logError('search.mjs', e);
    console.log(JSON.stringify({
      status: "error",
      error: "Failed .system/graph/graph.json",
      detail: e.message
    }, null, 2));
  }
  process.exit(1);
}

let embeddings = {};
try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('__') && v?.embedding?.length) embeddings[k] = v.embedding;
    }
  }
} catch (e) {
  // Silently continue with empty embeddings — title/exact match still works
  console.error(JSON.stringify({ 
    status: "warning", 
    msg: `Embeddings cache load failed: ${e.message}` 
  }));
}

// ==================== SEARCH FUNCTIONS ====================
function getNodeDegree(nodeName) {
  const data = graph[nodeName];
  if (!data) return 0;
  return (data.links?.length || 0) + (data.backlinks?.length || 0) + (data.typedLinks?.length || 0);
}

function isHubNode(nodeName) {
  return getNodeDegree(nodeName) > HUB_DEGREE_LIMIT;
}

function isMOC(nodeName) {
  const lower = nodeName.toLowerCase();
  return lower.includes('moc') || lower.includes('index') || lower.includes('dashboard');
}

function findTitleMatch(q) {
  const queryTokens = q.toLowerCase().split(/[-_\s]+/).filter(t => t.length > 1);
  if (!queryTokens.length) return null;

  const cands = Object.keys(graph).map(k => {
    const lk = k.toLowerCase();
    const keyTokens = lk.split(/[-_\s]+/).filter(t => t.length > 1);
    
    let score = 0;
    let exactTokens = 0;
    
    for (const qt of queryTokens) {
      let found = false;
      for (const kt of keyTokens) {
        if (kt === qt) { score += 100; exactTokens++; found = true; break; }
        else if (kt.includes(qt)) { score += 60; found = true; break; }
        else if (qt.includes(kt)) { score += 30; found = true; break; }
      }
      if (!found) score -= 20;
    }
    
    if (score <= 0) return null;
    if (exactTokens === queryTokens.length) score += 200;
    if (exactTokens === 1 && queryTokens.length === 1 && keyTokens.length === 1) score += 500;
    if (lk.startsWith(queryTokens[0])) score += 50;
    
    return { k, score, p: graph[k]?.path || null, exactTokens, totalTokens: queryTokens.length };
  }).filter(Boolean);

  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  return cands[0];
}

async function findNode() {
  const lq = query.toLowerCase().trim();

  // Tier 1: Exact
  if (graph[query]) {
    return { 
      method: "exact", 
      matches: [{ node: query, path: graph[query]?.path || null }] 
    };
  }

  // Tier 2: Title Match
  const t = findTitleMatch(lq);
  if (t) {
    const matchRatio = t.exactTokens / t.totalTokens;
    // Only return title match if it's strong (>= 70% tokens match exactly)
    // or if the absolute score is very high (near-perfect match)
    if (matchRatio >= 0.7 || t.score > 400) {
      return {
        method: "title",
        matches: [{ node: t.k, path: t.p }]
      };
    }
    console.error(`⚠️ Weak title match (${(matchRatio * 100).toFixed(1)}%), falling through to semantic...`);
  }

  // Tier 3: Semantic
  if (!Object.keys(embeddings).length) {
    return { 
      method: "none", 
      error: "No embeddings. Run semantic-linker first.", 
      matches: [] 
    };
  }

  try {
    const queryKeywords = lq.split(/[-_\s]+/).filter(t => t.length > 2).join(', ');
    const enrichedQuery = queryKeywords.length > query.length * 0.5
      ? `${query}\nKeywords: ${queryKeywords}`
      : query;
      
    const qv = await getCachedOrFreshEmbedding(enrichedQuery);
    const scored = [];
    for (const [name, vec] of Object.entries(embeddings)) {
      if (!graph[name]) continue;
      const s = cosineSimilarity(qv, vec);
      if (s >= SEMANTIC_THRESHOLD) scored.push({ 
        node: name, 
        score: s, 
        path: graph[name]?.path || null 
      });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length) {
      return { 
        method: "semantic", 
        matches: scored.slice(0, TOP_K).map(m => ({ 
          node: m.node, 
          path: m.path 
        })) 
      };
    }

    return { 
      method: "none", 
      error: `No match above ${SEMANTIC_THRESHOLD}`, 
      matches: [] 
    };
  } catch (e) {
    return { 
      method: "none", 
      error: `Semantic failed: ${e.message}`, 
      matches: [] 
    };
  }
}

function buildFlatGraph(matches, maxDepth) {
  const seen = new Set();
  const result = [];
  const queue = [];

  // Seed primary matches (depth 0)
  for (const m of matches) {
    if (!seen.has(m.node) && graph[m.node]) {
      seen.add(m.node);
      const nodeData = graph[m.node];
      result.push({
        node: m.node,
        path: m.path,
        depth: 0,
        primary: true,
        preview: nodeData?.contentPreview || null,
        noteType: nodeData?.noteType || 'atomic',
        wordCount: nodeData?.wordCount || 0,
        // ⭐ Relasi untuk agent reasoning
        relations: (nodeData?.typedLinks || []).map(t => ({
          target: t.target,
          type: t.type,
          reason: t.reason,
          inferred: t.inferred
        }))
      });
      queue.push([m.node, 1]);
    }
  }

  // BFS traversal
  while (queue.length && result.length < MAX_NODES) {
    const [curNode, curDepth] = queue.shift();
    if (curDepth > maxDepth) continue;

    const data = graph[curNode];
    if (!data) continue;

    const regularLinks = [...(data.links || []), ...(data.backlinks || [])];
    const typedTargets = (data.typedLinks || []).map(t => t.target);
    const allLinks = [...new Set([...regularLinks, ...typedTargets])];

    for (const nxt of allLinks) {
      if (seen.has(nxt)) continue;
      if (result.length >= MAX_NODES) break;

      const nxtIsMOC = isMOC(nxt);

      // Skip hub nodes (>25 links) kecuali MOC atau depth 1
      if (isHubNode(nxt) && !nxtIsMOC && curDepth > 1) continue;

      seen.add(nxt);
      const nxtData = graph[nxt];
      result.push({
        node: nxt,
        path: nxtData?.path || null,
        depth: curDepth,
        primary: false,
        preview: nxtData?.contentPreview || null,
        noteType: nxtData?.noteType || 'atomic',
        wordCount: nxtData?.wordCount || 0,
        // ⭐ Relasi dari parent ke node ini
        via: curNode,
        relation: data.typedLinks?.find(t => t.target === nxt)?.type || 'linked',
        relationReason: data.typedLinks?.find(t => t.target === nxt)?.reason || ''
      });

      if (!nxtIsMOC) {
        queue.push([nxt, curDepth + 1]);
      }
    }
  }

  return result;
}

// ==================== MAIN ====================
async function main() {
  const t0 = Date.now();
  const res = await findNode();

  if (res.method === "none") {
    console.log(JSON.stringify({
      status: "no_match",
      query,
      error: res.error,
      nodes: []
    }, null, 2));
    process.exit(0);
  }

  const flatNodes = buildFlatGraph(res.matches, depth);

  // ⭐ Group by tier untuk agent
  const primary = flatNodes.filter(n => n.depth === 0);
  const supporting = flatNodes.filter(n => n.depth === 1);
  const related = flatNodes.filter(n => n.depth === 2);

  const output = {
    status: "success",
    query,
    method: res.method,
    tiers: {
      primary: {
        description: "Most relevant — read these first",
        nodes: primary.map(n => ({
          node: n.node,
          path: n.path,
          noteType: n.noteType,
          wordCount: n.wordCount,
          preview: n.preview,
          relations: n.relations
        }))
      },
      supporting: {
        description: "Related context — read if primary insufficient",
        nodes: supporting.map(n => ({
          node: n.node,
          path: n.path,
          noteType: n.noteType,
          wordCount: n.wordCount,
          preview: n.preview,
          via: n.via,
          relation: n.relation,
          relationReason: n.relationReason
        }))
      },
      related: {
        description: "Weakly related — mention only if relevant",
        nodes: related.map(n => ({
          node: n.node,
          path: n.path,
          noteType: n.noteType,
          preview: n.preview
        }))
      }
    },
    meta: {
      ms: Date.now() - t0,
      max_nodes: MAX_NODES,
      depth,
      total: flatNodes.length
    }
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.log(JSON.stringify({ 
    status: "error", 
    error: err.message,
    stack: err.stack 
  }, null, 2));
  process.exit(1);
});