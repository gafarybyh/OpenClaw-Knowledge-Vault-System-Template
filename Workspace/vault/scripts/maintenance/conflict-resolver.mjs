import { logError, log } from '../core/logger.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { globSync } from 'glob';
import crypto from 'crypto';
import { callAI } from '../core/ai-client.mjs';
import { parseAIJson } from '../core/json-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');

// --- CONFIGURATION ---

const VAULT_PATH = path.join(WORKSPACE_ROOT, 'vault');
const KNOWLEDGE_PATH = path.join(VAULT_PATH, '01_thinking/knowledge');

// --- UTILITIES ---

async function analyzeConflict(fileA, contentA, fileB, contentB) {
  const SYSTEM_PROMPT = `You are a Knowledge Integrity Architect. Your goal is to detect and resolve contradictions between two claims in a Zettelkasten vault.
  
  A contradiction occurs if:
  1. One claim asserts a fact that the other explicitly denies.
  2. They make mutually exclusive claims about the same topic.
  3. One claim is a general rule that the other presents as a universal exception without nuance.

  If a conflict is found, you must propose a resolution:
  - "RESOLVE_NUANCE": Both are true but apply to different contexts. Provide a concise explanation of the nuance.
  - "RESOLVE_DEPRECATE": One claim is clearly outdated, incorrect, or superseded. Specify which one (A or B) should be deprecated.
  - "RESOLVE_MERGE": The claims are complementary and should be combined into a single, more comprehensive claim.

  Output ONLY valid JSON:
  {"conflict": true, "resolution_type": "RESOLVE_NUANCE|RESOLVE_DEPRECATE|RESOLVE_MERGE", "suggestion": "explanation", "deprecated_file": "A|B|none"}
  or {"conflict": false}.`;

  const prompt = `Analyze these two claims for contradictions:
  
  Note A (${fileA}):
  ${contentA}
  
  Note B (${fileB}):
  ${contentB}`;

  try {
    const content = await callAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], { temperature: 0 });

    if (content) {
      const { data, error } = parseAIJson(content, 'conflict-resolver.mjs');
      if (data) return data;
      if (error) log.warn(`⚠️ Conflict resolver JSON parse failed: ${error}`);
    }
  } catch (err) {
    console.warn(`⚠️ Conflict analysis failed: ${err.message}`);
    logError('conflict-resolver.mjs', err);
  }

  return { conflict: false };
}

function applyResolution(fileA, fileB, resolution) {
  const pathA = path.join(KNOWLEDGE_PATH, fileA + '.md');
  const pathB = path.join(KNOWLEDGE_PATH, fileB + '.md');

  if (resolution.resolution_type === 'RESOLVE_NUANCE') {
    log.info(`📝 Adding nuance to ${fileA} and ${fileB}...`);
    [pathA, pathB].forEach(p => {
      if (fs.existsSync(p)) {
        let content = fs.readFileSync(p, 'utf8');
        if (!content.includes('## Conflict Resolution')) {
          content += '\n\n## Conflict Resolution\n- ' + resolution.suggestion;
          safeWriteFile(p, content);
        }
      }
    });
  } else if (resolution.resolution_type === 'RESOLVE_DEPRECATE') {
    const target = resolution.deprecated_file === 'A' ? pathA : pathB;
    const targetName = resolution.deprecated_file === 'A' ? fileA : fileB;
    
    if (fs.existsSync(target) && !targetName.startsWith('[DEPRECATED]')) {
      log.warn(`🚫 Deprecating ${targetName}...`);
      const newPath = path.join(KNOWLEDGE_PATH, '[DEPRECATED]' + targetName + '.md');
      fs.renameSync(target, newPath);
    }
  } else if (resolution.resolution_type === 'RESOLVE_MERGE') {
    log.info(`🤝 Merge suggested for ${fileA} and ${fileB}: ${resolution.suggestion}`);
    log.info(`   (Manual merge recommended to avoid data loss)`);
  }
}

// --- MAIN PROCESS ---

function safeWriteFile(filePath, content) {
  try {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    log.error(`❌ Atomic write failed for ${filePath}: ${e.message}`);
    logError('conflict-resolver.mjs', e);
    throw e;
  }
}

async function main() {
  log.step('🚀 Starting Conflict Resolver...');
  
  const files = globSync(`${KNOWLEDGE_PATH}/*.md`).filter(f => !path.basename(f).startsWith('[DEPRECATED]'));
  const contents = {};
  const fileNames = [];

  for (const file of files) {
    const name = path.basename(file, '.md');
    fileNames.push(name);
    contents[name] = fs.readFileSync(file, 'utf8');
  }

  const processedPairs = new Set();
  let conflictsFound = 0;

  for (const nameA of fileNames) {
    const contentA = contents[nameA];
    
    // Only check files that have semantic relations (candidates for conflict)
    if (!contentA.includes('## Semantic Relations')) continue;

    const relationsMatch = contentA.match(/## Semantic Relations\n([\s\S]*?)(?=\n\n|$)/);
    if (!relationsMatch) continue;

    const relations = relationsMatch[1].split('\n').filter(line => line.trim().match(/^-\s*(?:[\w-]+::\s*)?\[\[/));
    
    for (const rel of relations) {
      const nameB = rel.match(/\[\[(.*?)(?:\|.*?)?\]\]/)?.[1];
      if (!nameB || nameB === nameA) continue;

      const pairId = [nameA, nameB].sort().join(':::');
      if (processedPairs.has(pairId)) continue;
      processedPairs.add(pairId);

      if (!contents[nameB]) continue;

      log.debug(`🔍 Checking for conflict: ${nameA} <-> ${nameB}...`);
      try {
        const result = await analyzeConflict(nameA, contentA, nameB, contents[nameB]);
        if (result.conflict) {
          conflictsFound++;
          log.warn(`⚠️ Conflict found! Type: ${result.resolution_type}`);
          applyResolution(nameA, nameB, result);
        }
      } catch (e) {
        log.error(`Error analyzing ${nameA} <-> ${nameB}: ${e.message}`);
      }
    }
  }

  log.info(`\\n✨ Conflict Resolution Complete. Found and processed ${conflictsFound} conflicts.`);
}

main().catch(err => {
  logError('conflict-resolver.mjs', err);
  console.error('❌ Fatal error in Conflict Resolver:', err);
});
