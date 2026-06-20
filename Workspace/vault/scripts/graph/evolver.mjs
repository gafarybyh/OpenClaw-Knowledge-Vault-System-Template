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
const CONCEPTS_DIR = path.join(VAULT_PATH, '01_thinking', 'concepts');
const GRAPH_FILE = path.join(VAULT_PATH, '.system/graph/graph.json');
const AI_MAX_RETRIES = 3;
const AI_RETRY_DELAY_MS = 3000;

const SYSTEM_PROMPT =
  'You are an Ontology Architect specializing in conceptual engineering for a Zettelkasten knowledge vault. ' +
  'Identify emergent higher-order concepts from provided notes. ' +
  'Output ONLY valid JSON. No markdown, no explanation, no preamble.';

const USER_PROMPT = (notesSummary) =>
  `Analyze this list of notes and discover a new, abstract CONCEPT that can serve as a parent category for a group of related notes.

The concept should not be a simple category, but a theoretical abstraction that provides a new way of organizing the knowledge.

RULES:
- "concept_title": Professional title using Title-Case-With-Hyphens (e.g., 'Agentic-Observability-Framework').
- "definition": Rigorous, formal definition (≤50 words).
- "explanation": Detailed justification of why this concept unifies the grouped notes (≤100 words).
- "grouped_notes": Must be a subset of the input note names. At least 2 notes required.
- "confidence_score": Float 0.0–1.0.
- "tags": Array of relevant strings (max 5).

Example:
Available Notes:
[{"name":"react-hooks-patterns","type":"knowledge","tags":["react","hooks"]},{"name":"lifecycle-management","type":"reference","tags":["react","components"]},{"name":"memory-leak-prevention","type":"claim","tags":["react","performance"]}]

→ {"concept_title": "Component-Lifecycle-Orchestration", "definition": "A systematic framework for managing resource initialization, state synchronization, and cleanup across reactive component hierarchies.", "explanation": "The grouped notes all address different facets of managing component lifecycle — hooks provide the mechanism, lifecycle management provides the structure, and memory leak prevention ensures correctness. This concept unifies them under a single orchestration framework.", "grouped_notes": ["react-hooks-patterns", "lifecycle-management", "memory-leak-prevention"], "confidence_score": 0.88, "tags": ["ontology", "react", "lifecycle", "conceptual-framework"]}

Available Notes:
<<user_content>
${notesSummary}
</user_content>

Output:`;

function validateConcept(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.concept_title !== 'string' || !data.concept_title.trim()) return null;

  // Sanitize title
  data.concept_title = data.concept_title
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  if (typeof data.definition !== 'string' || !data.definition.trim()) return null;
  if (typeof data.explanation !== 'string') data.explanation = '';

  // Validate grouped_notes
  if (!Array.isArray(data.grouped_notes) || data.grouped_notes.length < 2) return null;
  data.grouped_notes = data.grouped_notes.filter(n => typeof n === 'string');

  // Validate scores
  if (typeof data.confidence_score !== 'number' || data.confidence_score < 0 || data.confidence_score > 1) {
    data.confidence_score = 0.85;
  }

  // Validate tags
  if (!Array.isArray(data.tags)) data.tags = [];
  data.tags = data.tags.filter(t => typeof t === 'string').slice(0, 5);
  if (data.tags.length === 0) data.tags = ['ontology', 'concept'];

  return data;
}

async function evolveOntology(notesList) {
  const { data, error, attempts } = await callAIJson([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT(JSON.stringify(notesList, null, 2)) },
  ], { 
    temperature: 0.1, 
    maxRetries: AI_MAX_RETRIES, 
    retryDelayMs: AI_RETRY_DELAY_MS, 
    promptLabel: 'evolver.mjs' 
  });

  if (data) {
    const validated = validateConcept(data);
    if (validated) {
      log.success(`[Evolver] ✅ AI ontology evolution successful (${attempts} attempt(s)).`);
      return validated;
    }
  }

  if (error) {
    log.warn(`[Evolver] ⚠️ AI evolution failed after ${attempts} attempts: ${error}`);
    logError('evolver.mjs', new Error(error));
  }

  return null;
}

function loadExistingConcepts() {
  const existing = new Set();
  if (!fs.existsSync(CONCEPTS_DIR)) return existing;
  const files = fs.readdirSync(CONCEPTS_DIR).filter(f => f.endsWith('.md'));
  for (const f of files) {
    const conceptName = f.replace(/^concept-/, '').replace(/\.md$/, '').toLowerCase();
    existing.add(conceptName);
  }
  return existing;
}

function safeWriteFile(filePath, content) {
  try {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    log.error(`[Evolver] ❌ Atomic write failed for ${filePath}: ${e.message}`);
    logError('evolver.mjs', e);
    throw e;
  }
}

function addConceptLink(filePath, conceptFileName) {
  try {
    if (!fs.existsSync(filePath)) return;
    let content = fs.readFileSync(filePath, 'utf8');

    // Avoid duplicate links
    if (content.includes(`[[${conceptFileName}]]`)) return;

    const linkLine = `- conceptual_parent:: [[${conceptFileName}]]`;

    if (!content.includes('## Semantic Relations')) {
      content += '\n\n## Semantic Relations\n';
    }

    content = content.replace(/## Semantic Relations\r?\n/, `## Semantic Relations\n${linkLine}\n`);
    safeWriteFile(filePath, content);
  } catch (e) {
    log.warn(`[Evolver] ⚠️ Failed to add recursive link to ${filePath}: ${e.message}`);
    logError('evolver.mjs', e);
  }
}

async function main() {
  log.step('🚀 Starting Ontology Evolver...');
  if (!fs.existsSync(GRAPH_FILE)) {
    log.warn(`[Evolver] ⚠️ Graph file not found. Please run graph-indexer first.`);
    logError('evolver.mjs', new Error(`Graph file ${GRAPH_FILE} not found`));
    return;
  }

  try {
    const graphData = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const nodes = graphData.nodes || {};
    const nodeNames = Object.keys(nodes);

    if (nodeNames.length === 0) {
      log.info('[Evolver] Graph is empty. Skipping ontology evolution.');
      return;
    }

    const existingConcepts = loadExistingConcepts();

    // Prepare list of nodes to feed to AI
    // Token Guard: Sort by updatedAt and limit to top 500 nodes
    const sortedNodes = [...nodeNames].sort((a, b) => {
      const dateA = nodes[a]?.updatedAt ? new Date(nodes[a].updatedAt).getTime() : 0;
      const dateB = nodes[b]?.updatedAt ? new Date(nodes[b].updatedAt).getTime() : 0;
      return dateB - dateA;
    });

    const notesSummary = sortedNodes.slice(0, 500).map(name => {
      const node = nodes[name];
      const metadata = node.metadata || {};
      return {
        name,
        type: metadata.type || 'knowledge',
        tags: metadata.tags || []
      };
    });

    const result = await evolveOntology(notesSummary);

    if (result && result.concept_title) {
      if (existingConcepts.has(result.concept_title)) {
        log.info(`[Evolver] ℹ️ Concept "${result.concept_title}" already exists. Skipping.`);
        return;
      }

      if (!fs.existsSync(CONCEPTS_DIR)) {
        fs.mkdirSync(CONCEPTS_DIR, { recursive: true });
      }

      const fileName = `concept-${result.concept_title}.md`;
      const filePath = path.join(CONCEPTS_DIR, fileName);
      const dateStr = new Date().toISOString().split('T')[0];

      const content = `---
type: concept
created: ${dateStr}
confidence: ${result.confidence_score}
grouped_notes: ${JSON.stringify(result.grouped_notes)}
tags: ${JSON.stringify(result.tags)}
---

# Concept: ${result.concept_title}

## Definition
${result.definition}

## Ontology Explanation
${result.explanation}

## Members of this Concept
${result.grouped_notes.map(n => `- [[${n}]]`).join('\n')}
`;

      safeWriteFile(filePath, content);
      log.success(`[Evolver] ✅ Created new concept node: ${fileName}`);

      // Recursive Linking: Link grouped notes back to this new concept
      for (const nodeName of result.grouped_notes) {
        const node = nodes[nodeName];
        if (node) {
          const nodePath = path.resolve(WORKSPACE_ROOT, node.path);
          addConceptLink(nodePath, fileName.replace(/\.md$/, ''));
        }
      }
    } else {
      log.info('[Evolver] ℹ️ No new ontology evolution proposed.');
    }
  } catch (err) {
    log.error(`[Evolver] ❌ Ontology Evolver Error: ${err.message}`);
    logError('evolver.mjs', err);
    process.exit(1);
  }
}

main();
