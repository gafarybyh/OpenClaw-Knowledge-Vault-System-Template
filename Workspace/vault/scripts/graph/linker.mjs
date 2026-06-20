/**
 * SEMANTIC LINKER WORKFLOW v16 OPTIMAL
 * =====================================
 * Fix 2-Hash: semanticHash exclude frontmatter + link section
 * 
 * Prinsip:
 * - semanticHash = hash(body saja, exclude frontmatter + Semantic Relations)
 * - fullHash     = hash(seluruh konten file)
 * 
 * Logic:
 * - semanticHash beda  → body berubah → embed baru + AI validate
 * - semanticHash sama, fullHash beda → hanya link berubah → reuse embed, skip AI
 * - keduanya sama → skip total
 */

import { logError } from '../core/logger.mjs';
import { callAIJson, getEmbedding as coreGetEmbedding, AI_CONFIG, sleep } from '../core/ai-client.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { globSync } from 'glob';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');


const VAULT_PATH = path.join(WORKSPACE_ROOT, 'vault');
const STATE_PATH = path.join(VAULT_PATH, '.system/state/.vault_state.json');
const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD) || 0.72;
const MAX_CANDIDATES_PER_FILE = parseInt(process.env.MAX_CANDIDATES_PER_FILE) || 5;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
const PRE_FILTER_MIN_SHARED = parseInt(process.env.PRE_FILTER_MIN_SHARED) || 1;
const EXCLUDED_FOLDERS = ['behavioral_rules', 'reflections'];
const EXCLUDED_FILES = ['AGENT-BEHAVIORAL-RULEBOOK.md'];

const DRY_RUN = process.argv.includes('--dry-run');
const DEEP_VERIFY = process.argv.includes('--deep-verify');
const CACHE_VERSION = 16;
const CACHE_FILE = path.join(VAULT_PATH, '.system/cache/embeddings_cache.json');
const VALIDATION_CACHE_FILE = path.join(VAULT_PATH, '.system/cache/validation_cache.json');

// ==================== UTILITAS ====================
function normalizeText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trimEnd();
}

function hashContent(text) {
  return crypto.createHash('md5').update(normalizeText(text)).digest('hex');
}

/**
 * ⭐ FIX v16: semanticHash = hash(body saja)
 * 
 * Exclude:
 * 1. Frontmatter (--- ... ---)
 * 2. Semantic Relations section (## Semantic Relations sampai ## berikutnya)
 * 
 * Hanya body asli yang di-hash: judul, paragraf, list, code block, dll.
 * Frontmatter dan link section di-exclude karena sering berubah tanpa
 * mengubah makna konten.
 */
function hashSemanticContent(text) {
  // Step 1: Hapus frontmatter
  const withoutFrontmatter = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

  // Step 2: Hapus Semantic Relations section
  const lines = withoutFrontmatter.split('\n');
  const bodyLines = [];
  let inSemanticSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '## Semantic Relations') {
      inSemanticSection = true;
      continue;
    }
    if (inSemanticSection && trimmed.startsWith('##')) {
      inSemanticSection = false;
    }
    if (!inSemanticSection) bodyLines.push(line);
  }

  return crypto.createHash('md5').update(normalizeText(bodyLines.join('\n'))).digest('hex');
}

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

function escapeRegex(string) {
  if (typeof string !== 'string') return '';
  return string.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

function sanitizeForPrompt(text) {
  return text.replace(/<\/user_content>/g, '').substring(0, 8000);
}

function logMetric(event, data) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}


function extractKeywords(name) {
  return name
    .toLowerCase()
    .replace(/^(ref|claim|concept|tool|moc|index|daily|weekly)-/, '')
    .replace(/\.md$/, '')
    .split(/[-_\s]+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'this', 'that'].includes(w));
}

function detectNoteType(name, content, linkCount) {
  const lower = name.toLowerCase();
  if (lower.includes('moc') || lower.includes('index') || lower.includes('dashboard')) return 'MOC';
  if (lower.startsWith('ref-')) return 'reference';
  if (lower.startsWith('concept-')) return 'concept';
  if (lower.startsWith('claim-')) return 'claim';
  if (lower.startsWith('tool-')) return 'tool';
  if (linkCount > 15) return 'hub';
  if (content.length < 300 && linkCount > 3) return 'stub';
  if (content.includes('## Action Items') || content.includes('## Tasks')) return 'task';
  return 'atomic';
}

class AtomicWriteQueue {
  constructor() { this.queues = new Map(); }
  async enqueue(filePath, transformFn) {
    const existing = this.queues.get(filePath) || Promise.resolve();
    const task = existing.then(async () => {
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
      const result = await transformFn(content);
      if (result !== null && result !== content) {
        if (!DRY_RUN) {
          const tmpPath = filePath + '.tmp.' + Date.now();
          fs.writeFileSync(tmpPath, result, 'utf8');
          fs.renameSync(tmpPath, filePath);
        } else {
          logMetric('dry_run_write', { file: filePath });
        }
      }
      return result;
    }).catch(err => {
      logMetric('file_write_error', { file: filePath, error: err.message });
      throw err;
    });
    this.queues.set(filePath, task);
    // Cleanup completed promise to avoid memory leak
    task.finally(() => {
      if (this.queues.get(filePath) === task) {
        this.queues.delete(filePath);
      }
    });
    return task;
  }
}
const writeQueue = new AtomicWriteQueue();

async function withRetry(fn, maxRetries = MAX_RETRIES, baseDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === maxRetries - 1) throw e;
      const delay = baseDelay * Math.pow(2, i);
      logMetric('retry_attempt', { attempt: i + 1, delay, error: e.message });
      await sleep(delay);
    }
  }
}

async function processSequential(items, processor) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const res = await processor(item);
      results.push(res);
      // Throttling: give the API a small breather between requests
      await sleep(AI_CONFIG.requestDelay);
    } catch (err) {
      logMetric('batch_item_error', { item: item.name || item, error: err.message });
      results.push(null);
    }
  }
  return results;
}

async function getEmbedding(text) {
  return await coreGetEmbedding(text);
}

async function getEmbeddingWithRetry(text) {
  return withRetry(() => getEmbedding(text));
}

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      // Invalidate cache if version mismatch
      if (raw.__version && raw.__version !== CACHE_VERSION) {
        console.error(`⚠️ Cache version mismatch (got ${raw.__version}, need ${CACHE_VERSION}), rebuilding...`);
        return {};
      }
      const data = { ...raw };
      delete data.__version;
      // Validate cache entries have required fields
      for (const key of Object.keys(data)) {
        const entry = data[key];
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          // Ensure embedding is an array if present
          if (entry.embedding !== undefined && !Array.isArray(entry.embedding)) {
            delete data[key];
          }
        } else if (Array.isArray(entry)) {
          // Old format: entry is an array (embedding directly) — remove
          delete data[key];
        }
      }
      return data;
    } catch (e) {
      console.error(`⚠️ Cache corrupt (${e.message}), rebuilding...`);
    }
  }
  return {};
}

function saveCache(cache) {
  const toSave = { ...cache, __version: CACHE_VERSION };
  if (!DRY_RUN) fs.writeFileSync(CACHE_FILE, JSON.stringify(toSave, null, 2), 'utf8');
}

function loadValidationCache() {
  if (fs.existsSync(VALIDATION_CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(VALIDATION_CACHE_FILE, 'utf8')); }
    catch { return {}; }
  }
  return {};
}

function saveValidationCache(cache) {
  if (!DRY_RUN) fs.writeFileSync(VALIDATION_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

// ==================== STATE ====================
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { version: 1, stagedFiles: [], lastLink: null }; }
}

function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// ==================== INVERSE RELATIONS ====================
const INVERSE_RELATIONS = {
  supports: 'supported_by', contradicts: 'contradicted_by', causes: 'caused_by',
  related_to: 'related_to', extends: 'extended_by', depends_on: 'depended_on_by',
  derived_from: 'source_of', analogous_to: 'analogous_to',
  implementation_of: 'implemented_by', optimization_for: 'optimized_by',
  same_topic: 'same_topic', learned_from: 'taught_to', corrects: 'corrected_by',
  invalidates: 'invalidated_by', supported_by: 'supports', contradicted_by: 'contradicts',
  caused_by: 'causes', extended_by: 'extends', depended_on_by: 'depends_on',
  source_of: 'derived_from', implemented_by: 'implementation_of',
  optimized_by: 'optimization_for', taught_to: 'learned_from',
  corrected_by: 'corrects', invalidated_by: 'invalidates'
};

function inferRelationType(nameA, nameB) {
  const a = nameA.toLowerCase();
  const b = nameB.toLowerCase();
  if (a.startsWith('ref-') && !b.startsWith('ref-')) return 'derived_from';
  if (b.startsWith('ref-') && !a.startsWith('ref-')) return 'derived_from';
  if (a.startsWith('concept-') && b.startsWith('claim-')) return 'supports';
  if (a.startsWith('claim-') && b.startsWith('concept-')) return 'supported_by';
  if (a.startsWith('tool-')) return 'implementation_of';
  if (b.startsWith('tool-')) return 'implemented_by';
  return null;
}

const REASON_MAX_WORDS = 15;

function truncateReason(reason) {
  if (!reason || typeof reason !== 'string') return '';
  const words = reason.replace(/[\r\n]+/g, ' ').trim().split(/\s+/);
  if (words.length <= REASON_MAX_WORDS) return words.join(' ');
  return words.slice(0, REASON_MAX_WORDS).join(' ');
}

// ==================== AI VALIDATOR ====================
const VALIDATION_SYSTEM_PROMPT =
  'You are a knowledge graph analyst. You determine semantic relationships between notes. ' +
  'Output ONLY valid JSON. No markdown, no explanation, no preamble.';

const VALIDATION_USER_PROMPT = (fileA, safeA, fileB, safeB, typeHint) =>
  `Analyze whether Note A and Note B have a STRONG semantic relationship.

Note A (${fileA}):
<<user_content>
${safeA}
</user_content>

Note B (${fileB}):
<<user_content>
${safeB}
</user_content>

${typeHint ? typeHint + '\n\n' : ''}RULES:
- Only return "related": true if the connection is EXPLICIT, MEANINGFUL, and DURABLE.
- If vague, trivial, or coincidental → {"related": false}
- "reason" MUST be ≤ ${REASON_MAX_WORDS} words. Describe the specific connection, not a general summary.

Relation types: supports, contradicts, causes, related_to, extends, depends_on, derived_from, analogous_to, implementation_of, optimization_for, same_topic, learned_from, corrects, invalidates

Examples:
→ {"related": true, "relation_type": "supports", "reason": "React hooks optimize rendering performance in component patterns"}
→ {"related": false}

Output:`;

async function validateRelation(fileA, contentA, fileB, contentB) {
  const safeA = sanitizeForPrompt(contentA);
  const safeB = sanitizeForPrompt(contentB);
  const inferredType = inferRelationType(fileA, fileB);
  const typeHint = inferredType ? `Likely relation: ${inferredType}` : '';

  const { data, error } = await callAIJson([
    { role: 'system', content: VALIDATION_SYSTEM_PROMPT },
    { role: 'user', content: VALIDATION_USER_PROMPT(fileA, safeA, fileB, safeB, typeHint) }
  ], { temperature: 0, promptLabel: 'linker.mjs' });

  if (data) return data;

  if (error) {
    logError('linker.mjs', `Relation validation failed: ${error}`);
  }

  return { related: false };
}

/**
 * Wrapper untuk validateRelation dengan caching (positif & negatif)
 */
async function getValidatedRelation(a, contentA, b, contentB, validationCache) {
  const hashA = hashSemanticContent(contentA);
  const hashB = hashSemanticContent(contentB);
  const pairKey = [a, b].sort().join('||');

  const cached = validationCache[pairKey];
  if (cached && cached.hashA === hashA && cached.hashB === hashB) {
    // Memberikan indikator visual bahwa AI tidak dipanggil ulang
    console.error(`⚡ [Cache Hit] AI skipped for ${a} <-> ${b}`);
    return cached.result;
  }

  const result = await validateRelation(a, contentA, b, contentB);

  // Simpan ke cache
  validationCache[pairKey] = {
    hashA,
    hashB,
    result,
    timestamp: new Date().toISOString()
  };

  return result;
}

// ==================== LINK OPERATIONS ====================
function parseExistingLinks(content, filePath) {
  if (!content) {
    logMetric('parse_existing_links_error', { file: filePath, error: 'No content provided' });
    return [];
  }
  const links = [];
  const sections = content.split('## Semantic Relations');
  if (sections.length < 2) return links;

  const lines = sections[1].split('\n');
  const typedRe = /^-\s*([\w-]+)::\s*\[\[(.*?)\]\](?:\s*\((.*?)\))?/;
  const wikiStartRe = /^-\s*\[\[(.*?)(?:\|.*?)?\]\]\s*\(/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line.startsWith('- ')) { i++; continue; }

    const typedMatch = line.match(typedRe);
    if (typedMatch) {
      links.push({ type: typedMatch[1], target: typedMatch[2].split('|')[0], reason: typedMatch[3] || '' });
      i++;
      continue;
    }

    const wikiMatch = line.match(wikiStartRe);
    if (wikiMatch) {
      let reason = line.substring(line.indexOf('(') + 1);
      let j = i + 1;
      while (j < lines.length && !reason.includes(')')) {
        reason += ' ' + lines[j].trim();
        j++;
      }
      reason = reason.replace(/\)$/, '').trim();
      links.push({ type: null, target: wikiMatch[1].split('|')[0], reason });
      i = j || i + 1;
      continue;
    }

    i++;
  }

  return links;
}

function hasAnyLinkToTarget(content, target) {
  const p = '^-\\s*\\w+::\\s*\\[\\[' + escapeRegex(target) + '(\\|.*?)?\\]\\]';
  return new RegExp(p, 'm').test(content);
}

async function addSemanticLink(filePath, target, type, reason) {
  reason = truncateReason(reason);
  const res = await writeQueue.enqueue(filePath, (c) => {
    const exactRegex = new RegExp(`^-\\s*${escapeRegex(type)}::\\s*\\[\\[${escapeRegex(target)}`, 'm');
    if (exactRegex.test(c)) {
      console.error(`      ⏭️ Already correct: ${type}:: [[${target}]]`);
      return null;
    }

    const anyTypedRegex = new RegExp(`^-\\s*(\\w+)::\\s*\\[\\[${escapeRegex(target)}`, 'm');
    const anyMatch = c.match(anyTypedRegex);
    if (anyMatch) {
      const oldType = anyMatch[1];
      const clean = reason.replace(/[\r\n]+/g, ' ').trim();
      const newLine = `- ${type}:: [[${target}]] (${clean})`;
      console.error(`      🔄 Updated: ${oldType} → ${type}`);
      return c.replace(anyMatch[0], newLine);
    }

    const clean = reason.replace(/[\r\n]+/g, ' ').trim();
    const line = `- ${type}:: [[${target}]] (${clean})`;

    const wikiStart = new RegExp(`^-\\s*\\[\\[${escapeRegex(target)}(?:\\|.*?)?\\]\\]\\s*\\(`);
    const lines = c.split('\n');
    const out = [];
    let i = 0;
    let replaced = false;

    while (i < lines.length) {
      if (wikiStart.test(lines[i]) && !replaced) {
        let block = lines[i];
        let j = i + 1;
        while (j < lines.length && !block.includes(')')) {
          block += ' ' + lines[j].trim();
          j++;
        }
        if (!block.includes('::')) {
          out.push(line);
          replaced = true;
          i = j;
          continue;
        }
      }
      out.push(lines[i]);
      i++;
    }

    if (replaced) {
      console.error(`      🔄 Replaced wiki link`);
      return out.join('\n');
    }

    if (!c.includes('## Semantic Relations')) c += '\n\n## Semantic Relations\n';
    return c.replace('## Semantic Relations\n', `## Semantic Relations\n${line}\n`);
  });

  return res !== null;
}

async function removeSemanticLink(filePath, target) {
  const res = await writeQueue.enqueue(filePath, (c) => {
    const lines = c.split('\n');
    const out = [];
    let inSec = false, removed = false;
    for (const line of lines) {
      const t = line.trim();
      if (t === '## Semantic Relations') { inSec = true; out.push(line); continue; }
      if (inSec) {
        if (t.startsWith('##')) inSec = false;
        if (t.startsWith('- ') && t.includes(`[[${target}`) && /^-\s*\w+::\s*\[\[/.test(t)) {
          removed = true; continue;
        }
      }
      out.push(line);
    }
    return removed ? out.join('\n') : null;
  });
  return res !== null;
}

async function updateSemanticLinkType(filePath, target, oldType, newType, newReason) {
  const res = await writeQueue.enqueue(filePath, (c) => {
    const p = '^-\\s*' + escapeRegex(oldType) + '::\\s*\\[\\[' + escapeRegex(target) + '(\\|.*?)?\\]\\].*$';
    const re = new RegExp(p, 'm');
    if (!re.test(c)) return null;
    const clean = newReason.replace(/[\r\n]+/g, ' ').trim();
    return c.replace(re, `- ${newType}:: [[${target}]] (${clean})`);
  });
  return res !== null;
}

// ==================== PRE-FILTER ENGINE ====================
function shouldCompare(aName, bName, aKeywords, bKeywords, aFolder, bFolder, aType, bType) {
  // 1. Shared Keywords (Exact or Substring)
  const shared = aKeywords.filter(ak =>
    bKeywords.some(bk => ak.includes(bk) || bk.includes(ak))
  );
  if (shared.length >= PRE_FILTER_MIN_SHARED) return true;

  // 2. Folder Proximity
  if (aFolder === bFolder && aFolder !== '') return true;

  // 3. Complementary Note Types
  const complementary = [
    ['reference', 'atomic'], ['concept', 'claim'], ['tool', 'atomic'],
    ['MOC', 'atomic'], ['MOC', 'reference'], ['MOC', 'concept'],
    ['reference', 'concept'], ['tool', 'concept'], ['tool', 'reference']
  ];
  if (complementary.some(pair =>
    (pair[0] === aType && pair[1] === bType) || (pair[0] === bType && pair[1] === aType)
  )) return true;

  // 4. Name Overlap
  const aStr = aName.toLowerCase().replace(/\.md$/, '');
  const bStr = bName.toLowerCase().replace(/\.md$/, '');
  if (aStr.includes(bStr) || bStr.includes(aStr)) return true;

  // 5. Hub-to-Hub exclusion (too generic)
  if ((aType === 'MOC' || aType === 'hub') && (bType === 'MOC' || bType === 'hub')) return false;

  return false;
}

// ==================== MAIN ====================
async function main() {
  const t0 = Date.now();
  console.error(`🚀 Linker v${CACHE_VERSION} OPTIMAL | DryRun: ${DRY_RUN} | DeepVerify: ${DEEP_VERIFY}`);
  logMetric('workflow_start', { model: AI_CONFIG.embedding.model, dry_run: DRY_RUN, deep_verify: DEEP_VERIFY, version: CACHE_VERSION });

  const allFiles = globSync(`${VAULT_PATH}/**/*.md`);
  const allFileBasenames = new Set(allFiles.map(f => path.basename(f, '.md')));
  const scopeFiles = allFiles.filter(f => {
    const inScope = f.includes('01_thinking') || f.includes('02_reference');
    const fileName = path.basename(f);
    const isExcluded = EXCLUDED_FOLDERS.some(folder => f.includes(folder)) ||
      EXCLUDED_FILES.includes(fileName);
    return inScope && !isExcluded;
  });

  // === MODE DETECTION ===
  const IS_DEEP_VERIFY = DEEP_VERIFY;
  const IS_FULL = process.argv.includes('--full') || IS_DEEP_VERIFY;
  const state = loadState();

  let files = [];
  let isIncremental = false;

  if (!IS_FULL && state.stagedFiles?.length > 0) {
    files = state.stagedFiles
      .map(f => path.join(VAULT_PATH, '00_inbox', f))
      .filter(f => fs.existsSync(f));
    if (files.length > 0) {
      isIncremental = true;
      console.error(`🚀 INCREMENTAL LINK | ${files.length} staged files`);
    }
  }

  if (!isIncremental) {
    files = scopeFiles;
    console.error(`🔄 FULL LINK | ${files.length} files${IS_DEEP_VERIFY ? ' | DEEP VERIFY' : ''}`);
  }

  const nameToPath = {};
  for (const f of files) nameToPath[path.basename(f, '.md')] = f;
  for (const f of scopeFiles) {
    const n = path.basename(f, '.md');
    if (!nameToPath[n]) nameToPath[n] = f;
  }

  const embeddings = {};
  const contents = {};
  const cache = loadCache();
  const validationCache = loadValidationCache();
  const fileMeta = {};
  const semanticHashCache = {};
  const dirtyFiles = new Set();
  const newFiles = new Set();
  let cacheUpdated = false;

  console.error(`📁 Processing ${files.length} files | Cache: ${Object.keys(cache).filter(k => !k.startsWith('__')).length} entries`);

  const tasks = [];
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      tasks.push({
        file,
        name: path.basename(file, '.md'),
        folder: path.relative(VAULT_PATH, path.dirname(file)).split(path.sep)[0] || '',
        text
      });
    } catch (e) {
      logMetric('file_read_error', { file, error: e.message });
      console.error(`⚠️ Cannot read ${file}: ${e.message}`);
    }
  }

  tasks.forEach(t => {
    contents[t.name] = t.text;
    const linkCount = (t.text.match(/\[\[/g) || []).length;
    const type = detectNoteType(t.name, t.text, linkCount);
    const keywords = extractKeywords(t.name);
    fileMeta[t.name] = { folder: t.folder, type, keywords, linkCount };
  });

  // BUG1 FIX: Load all scopeFiles into contents map so pruning can access
  // content of files not in the current processing batch (e.g., incremental mode)
  for (const f of scopeFiles) {
    const n = path.basename(f, '.md');
    if (!contents[n]) {
      try { contents[n] = fs.readFileSync(f, 'utf8'); } catch {}
    }
  }

  // === EMBEDDING CLASSIFICATION ===
  let skipped = 0, need = 0, linkOnlyChange = 0;
  const needsEmbedding = [];

  for (const t of tasks) {
    const fullHash = hashContent(t.text);
    const semanticHash = hashSemanticContent(t.text);
    semanticHashCache[t.name] = semanticHash;
    const c = cache[t.name];

    // CASE A: Cache valid, semantic hash sama → embedding reusable
    if (c && c.semanticHash === semanticHash && Array.isArray(c.embedding) && c.embedding.length > 0) {
      embeddings[t.name] = c.embedding;
      skipped++;
      continue;
    }

    // CASE B: Semantic hash sama, full hash beda → HANYA link berubah, reuse embedding
    if (c && c.semanticHash === semanticHash && c.fullHash !== fullHash && Array.isArray(c.embedding) && c.embedding.length > 0) {
      console.error(`   📝 ${t.name}: link-only change, reusing embedding`);
      embeddings[t.name] = c.embedding;
      cache[t.name] = {
        fullHash,
        semanticHash,
        embedding: c.embedding,
        meta: fileMeta[t.name]
      };
      cacheUpdated = true;
      linkOnlyChange++;
      continue;
    }

    // CASE C: Butuh embed baru (file baru atau konten berubah)
    needsEmbedding.push(t);
    need++;
    // Track truly new files (no prior cache = new from distiller)
    if (!cache[t.name]) newFiles.add(t.name);
  }

  console.error(`⏭️  Cached: ${skipped} | Link-only: ${linkOnlyChange} | Need embed: ${need}`);

  // ==================== EMBEDDING PHASE ====================
  const tEmbed = Date.now();
  if (needsEmbedding.length > 0) {
    console.error(`\n⚡ Embedding ${needsEmbedding.length} files...`);
    await processSequential(needsEmbedding, async (item) => {
      try {
        console.error(`\n🔹 ${item.name}`);
        const readableName = item.name.replace(/\.md$/, '').replace(/-/g, ' ').replace(/_/g, ' ');
        const lines = item.text.split('\n');
        const h1 = lines.find(l => l.startsWith('# '))?.replace('# ', '').trim() || '';
        const firstPara = lines.slice(1, 25).filter(l => {
          const t = l.trim();
          return t && !t.startsWith('#') && !t.startsWith('-') && !t.startsWith('[') && !t.startsWith('![');
        }).join(' ').substring(0, 600);
        const tags = lines.filter(l => l.match(/^#\w+/) || l.match(/^tags:/i)).slice(0, 5).join(' ');

        const noteType = fileMeta[item.name].type;
        const keywords = fileMeta[item.name].keywords.join(', ');
        const embedText = [
          `Note: ${readableName}`,
          `Type: ${noteType}`,
          `Keywords: ${keywords}`,
          h1 ? `Title: ${h1}` : '',
          tags ? `Tags: ${tags}` : '',
          firstPara ? `Content: ${firstPara}` : ''
        ].filter(Boolean).join('\n');

        console.error(`   📝 Embed: ${embedText.substring(0, 120)}...`);

        const emb = await getEmbeddingWithRetry(embedText);
        if (!Array.isArray(emb) || emb.length === 0) throw new Error('Empty embedding');
        embeddings[item.name] = emb;
        cache[item.name] = {
          fullHash: hashContent(item.text),
          semanticHash: hashSemanticContent(item.text),
          embedding: emb,
          meta: fileMeta[item.name]
        };
        dirtyFiles.add(item.name);
        console.error(`   💾 Dim: ${emb.length}`);
        logMetric('embedding_generated', { file: item.name, dim: emb.length, type: noteType });
      } catch (e) {
        console.error(`   ❌ ${e.message}`);
        logMetric('embedding_failed', { file: item.name, error: e.message });
      }
    });
    cacheUpdated = true;
  } else {
    console.error(`\n⏭️  No files need embedding.`);
  }
  console.error(`⏱️  Embedding phase: ${((Date.now() - tEmbed) / 1000).toFixed(1)}s`);

  // ==================== CACHE CLEANING ====================
  const current = new Set(Object.keys(embeddings));
  const cleaned = {};
  let removed = 0;
  for (const k of Object.keys(cache)) {
    if (current.has(k)) cleaned[k] = cache[k];
    else removed++;
  }
  if (removed > 0) { console.error(`🧹 Removed ${removed} obsolete cache entries`); cacheUpdated = true; }

  const ok = Object.entries(cleaned).filter(([_, v]) => Array.isArray(v.embedding) && v.embedding.length > 0).length;
  console.error(`📦 Cache: ${ok}/${Object.keys(cleaned).length} have embeddings`);
  if (cacheUpdated) {
    saveCache(cleaned);
    console.error(`✅ Saved: ${ok} cache entries`);
  }

  // ==================== PRUNING PHASE ====================
  const tPrune = Date.now();
  let added = 0, updated = 0, pruned = 0;
  let structuralPruned = 0, semanticPruned = 0;
  let filesChecked = 0, linksChecked = 0;

  const semanticDirtyFiles = new Set();

  for (const t of tasks) {
    const c = cache[t.name];
    const semanticHash = semanticHashCache[t.name] || hashSemanticContent(t.text);
    if (!c || c.semanticHash !== semanticHash) {
      semanticDirtyFiles.add(t.name);
    }
  }

  console.error(`\n🧹 Pruning phase...`);
  console.error(`   Semantic-dirty files: ${semanticDirtyFiles.size}`);
  console.error(`   Deep Verify: ${IS_DEEP_VERIFY}`);

  for (const file of files) {
    const a = path.basename(file, '.md');
    const existingLinks = parseExistingLinks(contents[a], file);

    // PHASE 1: Structural Pruning (target missing) — ALWAYS run
    for (const link of existingLinks) {
      const b = link.target;
      if (!allFileBasenames.has(b)) {
        console.error(`🗑️ ${a} -X-> ${b} (TARGET FILE MISSING)`);
        await removeSemanticLink(file, b);
        pruned++;
        structuralPruned++;
      }
    }

    // PHASE 2: Semantic Pruning — hanya untuk file yang konten asli berubah
    const needsPruning = semanticDirtyFiles.has(a) || IS_DEEP_VERIFY;
    if (!needsPruning) continue;

    filesChecked++;
    for (const link of existingLinks) {
      linksChecked++;
      const b = link.target;
      if (!allFileBasenames.has(b)) continue;

      // ⭐ Deep-verify: skip link yang sudah AI-validated (inferred: false)
      // kecuali jika source atau target konten berubah
      if (IS_DEEP_VERIFY && !link.inferred) {
        const sourceSemanticDirty = semanticDirtyFiles.has(a);
        const targetSemanticDirty = semanticDirtyFiles.has(b);

        if (!sourceSemanticDirty && !targetSemanticDirty) {
          console.error(`      ⏭️ Stable link, skip: ${link.type}:: [[${b}]]`);
          continue;
        }
      }

      try {
        const r = await getValidatedRelation(a, contents[a], b, contents[b], validationCache);
        if (!r.related) {
          console.error(`🗑️ ${a} -X-> ${b} (stale)`);
          await removeSemanticLink(file, b);
          pruned++;
          semanticPruned++;
        } else if (r.relation_type && r.relation_type !== link.type) {
          console.error(`🔄 ${a} [${link.type}]-> ${b} → [${r.relation_type}]`);
          await updateSemanticLinkType(file, b, link.type, r.relation_type, r.reason);
          updated++;
        }
      } catch (e) {
        logMetric('pruning_error', { source: a, target: b, error: e.message });
      }
    }
  }
  console.error(`📊 Structural pruned: ${structuralPruned} | Semantic pruned: ${semanticPruned}`);
  console.error(`   Files AI-checked: ${filesChecked} | Links checked: ${linksChecked}`);
  console.error(`⏱️  Pruning phase: ${((Date.now() - tPrune) / 1000).toFixed(1)}s`);

  // ==================== DISCOVERY PHASE ====================
  const tDisc = Date.now();
  let pairsChecked = 0, preFiltered = 0, cosineChecked = 0;

  if (dirtyFiles.size === 0 && !IS_DEEP_VERIFY && newFiles.size === 0) {
    console.error(`\n⏭️  No dirty/new files. Skipping discovery.`);
  } else {
    console.error(`\n🔍 Discovery (pre-filter + cosine)...`);
    if (newFiles.size > 0) console.error(`   📌 New files (no pre-filter): ${[...newFiles].join(', ')}`);
    const names = Object.keys(embeddings);

    const sourceNames = (isIncremental && !IS_DEEP_VERIFY)
      ? names.filter(n => dirtyFiles.has(n) || semanticDirtyFiles.has(n) || newFiles.has(n))
      : names;

    console.error(`   Source files for discovery: ${sourceNames.length}`);

    await processSequential(sourceNames, async (a) => {
      const isAnew = newFiles.has(a);
      const dirtyA = semanticDirtyFiles.has(a) || IS_DEEP_VERIFY;
      const vecA = embeddings[a];
      const cands = [];

      const isFull = !isIncremental;
      const aIdx = names.indexOf(a);

      for (let j = 0; j < names.length; j++) {
        const b = names[j];
        if (a === b) continue;
        if (isFull && j <= aIdx) continue;

        if (!dirtyA && !semanticDirtyFiles.has(b) && !IS_DEEP_VERIFY && !isAnew && !newFiles.has(b)) continue;

        if (hasAnyLinkToTarget(contents[a], b) && hasAnyLinkToTarget(contents[b], a)) continue;

        preFiltered++;
        const metaA = fileMeta[a];
        const metaB = fileMeta[b];

        // New files bypass shouldCompare — check ALL candidates via cosine
        if (!isAnew && !newFiles.has(b)) {
          if (!shouldCompare(a, b, metaA.keywords, metaB.keywords, metaA.folder, metaB.folder, metaA.type, metaB.type)) {
            continue;
          }
        }

        const sim = cosineSimilarity(vecA, embeddings[b]);
        cosineChecked++;
        if (sim > SIMILARITY_THRESHOLD) cands.push({ name: b, score: sim });
      }

      cands.sort((x, y) => y.score - x.score);
      const top = cands.slice(0, MAX_CANDIDATES_PER_FILE);
      pairsChecked += top.length;

      for (const cand of top) {
        const b = cand.name;
        const pa = nameToPath[a];
        const pb = nameToPath[b];
        if (!pa || !pb) return;

        const isNewPair = isAnew || newFiles.has(b);
        console.error(`🔎 ${a} <-> ${b} (sim: ${cand.score.toFixed(3)})${isNewPair ? ' [NEW]' : ''}`);
        try {
          const r = await getValidatedRelation(a, contents[a], b, contents[b], validationCache);
          if (r.related) {
            const rt = r.relation_type || 'related_to';
            const inv = INVERSE_RELATIONS[rt] || 'related_to';
            console.error(`✅ ${a} -[${rt}]-> ${b}`);
            logMetric('relation_discovered', { source: a, target: b, type: rt, sim: cand.score });
            if (await addSemanticLink(pa, b, rt, r.reason)) added++;
            if (await addSemanticLink(pb, a, inv, r.reason)) added++;
          } else {
            logMetric('relation_rejected', { source: a, target: b, sim: cand.score });
          }
        } catch (e) {
          logMetric('validation_error', { source: a, target: b, error: e.message });
          console.error(`❌ ${a} <-> ${b}: ${e.message}`);
        }
      }
    });
    console.error(`📊 Pre-filtered: ${preFiltered} | Cosine: ${cosineChecked} | AI validated: ${pairsChecked} | New: ${newFiles.size}`);
  }
  console.error(`⏱️  Discovery phase: ${((Date.now() - tDisc) / 1000).toFixed(1)}s`);

  // ==================== SUMMARY & SYNC ====================
  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`\n✨ Done in ${totalTime}s. Added: ${added} | Updated: ${updated} | Pruned: ${pruned} | New files: ${newFiles.size}`);
  logMetric('workflow_complete', { added, updated, pruned, total_seconds: parseFloat(totalTime) });

  // Update state
  if (!DRY_RUN) {
    saveValidationCache(validationCache);
    state.lastLink = {
      timestamp: new Date().toISOString(),
      mode: isIncremental ? 'incremental' : (IS_DEEP_VERIFY ? 'deep-verify' : 'full'),
      processedFiles: files.map(f => path.basename(f))
    };
    if (isIncremental) state.stagedFiles = [];
    saveState(state);
  }

  // Sync downstream
  const needsUpgrade = !DRY_RUN && tasks.some(t => {
    const section = t.text.split('## Semantic Relations')[1] || '';
    return /-\s*\[\[.*?\]\]\s*\(/.test(section) && !/^\s*-\s*\w+::\s*\[\[/m.test(section);
  });

  if (DRY_RUN) {
    console.error('\n🏃 Dry run: skipped sync.');
  } else if (added === 0 && pruned === 0 && updated === 0 && !needsUpgrade) {
    console.error('\nℹ️ No changes: skipped sync.');
  } else {
    console.error(`\n✨ Linker finished. Changes detected (Added: ${added}, Updated: ${updated}, Pruned: ${pruned}). Please run Graph Indexer to sync changes.`);
  }
}

main().catch(err => {
  logMetric('workflow_fatal_error', { error: err.message, stack: err.stack });
  console.error('💥 Fatal:', err);
  process.exit(1);
});
