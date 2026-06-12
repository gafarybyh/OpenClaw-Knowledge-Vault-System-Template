import { logError, log } from '../core/logger.mjs';
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
const CONCEPTS_DIR = path.join(VAULT_PATH, '01_thinking', 'concepts');
const GRAPH_FILE = path.join(VAULT_PATH, '.system/graph/graph.json');
const REQUEST_TIMEOUT_MS = 25_000;

const SYSTEM_PROMPT = `You are an Ontology Architect specializing in conceptual engineering for a Zettelkasten knowledge vault. Your goal is to evolve the vault's ontology by identifying emergent higher-order concepts.

Analyze the provided list of notes (including their types and tags) to discover a new, abstract CONCEPT that can serve as a parent category for a group of related notes. This concept should not be a simple category, but a theoretical abstraction that provides a new way of organizing the knowledge.

Output format:
You must output a single, valid JSON object containing:
- "concept_title": string (a concise, professional title for the abstract concept, e.g., 'Agentic-Observability-Framework')
- "definition": string (a rigorous, formal definition of this concept)
- "explanation": string (a detailed justification of why this concept is necessary and how it unifies the grouped notes)
- "grouped_notes": array of strings (the node names from the input list that fit under this concept)
- "confidence_score": number (float between 0 and 1)
- "tags": array of strings (e.g. ["ontology", "conceptual-framework", "abstraction"])

CRITICAL: Output ONLY the JSON. No explanations, no markdown wrapper, no conversational text.`;



async function evolveOntology(notesList) {
  try {
    const prompt = `${SYSTEM_PROMPT}\n\nList of Available Notes:\n${JSON.stringify(notesList, null, 2)}`;
    const content = await callAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], { temperature: 0.1, timeoutMs: REQUEST_TIMEOUT_MS });

    if (typeof content === 'string') {
      const { data, error } = parseAIJson(content, 'evolver.mjs');
      if (data) {
        log.success('✅ AI ontology evolution successful.');
        return data;
      }
      if (error) console.warn(`⚠️ Evolver JSON parse failed: ${error}`);
    }
  } catch (err) {
    console.warn(`⚠️ AI evolution failed: ${err.message}`);
    logError('evolver.mjs', err);
  }

  return null;
}

function loadExistingConcepts() {
  const existing = new Set();
  if (!fs.existsSync(CONCEPTS_DIR)) return existing;
  const files = fs.readdirSync(CONCEPTS_DIR).filter(f => f.endsWith('.md'));
  files.forEach(f => {
    const conceptName = f.replace(/^concept-/, '').replace(/\.md$/, '').toLowerCase();
    existing.add(conceptName);
  });
  return existing;
}

function safeWriteFile(filePath, content) {
  try {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    log.error(`❌ Atomic write failed for ${filePath}: ${e.message}`);
    logError('evolver.mjs', e);
    throw e;
  }
}

async function main() {
  log.step('🚀 Starting Ontology Evolver...');
  if (!fs.existsSync(GRAPH_FILE)) {
    console.warn(`⚠️ Graph file ${GRAPH_FILE} not found. Please run graph-indexer first.`);
    logError('evolver.mjs', new Error(`Graph file ${GRAPH_FILE} not found`));
    return;
  }

  try {
    const graphData = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const nodes = graphData.nodes || {};
    const nodeNames = Object.keys(nodes);

    if (nodeNames.length === 0) {
      log.info('Graph is empty. Skipping ontology evolution.');
      return;
    }

    const existingConcepts = loadExistingConcepts();

    // Prepare list of nodes to feed to AI
    // Token Guard: Sort by updatedAt and limit to top 500 nodes to prevent context overflow
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
      const sanitizeTitle = result.concept_title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      
      if (existingConcepts.has(sanitizeTitle)) {
        log.info(`ℹ️ Concept "${result.concept_title}" already exists. Skipping.`);
        return;
      }

      if (!fs.existsSync(CONCEPTS_DIR)) {
        fs.mkdirSync(CONCEPTS_DIR, { recursive: true });
      }

      const fileName = `concept-${sanitizeTitle}.md`;
      const filePath = path.join(CONCEPTS_DIR, fileName);
      const dateStr = new Date().toISOString().split('T')[0];

      const content = `---
type: concept
created: ${dateStr}
confidence: ${result.confidence_score || 0.85}
grouped_notes: ${JSON.stringify(result.grouped_notes)}
tags: ${JSON.stringify(result.tags || ['ontology', 'concept'])}
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
      log.success(`✅ Proposed and created new concept node: ${fileName}`);

      // Recursive Linking: Link grouped notes back to this new concept
      result.grouped_notes.forEach(nodeName => {
        const node = nodes[nodeName];
        if (node) {
          const nodePath = path.resolve(WORKSPACE_ROOT, node.path);
          addConceptLink(nodePath, fileName.replace(/\.md$/, ''));
        }
      });
    } else {
      log.info('ℹ️ No new ontology evolution proposed.');
    }
  } catch (err) {
    console.error('Ontology Evolver Error:', err.message);
    logError('evolver.mjs', err);
    process.exit(1);
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
    console.warn(`⚠️ Failed to add recursive link to ${filePath}: ${e.message}`);
    logError('evolver.mjs', e);
  }
}

main();
