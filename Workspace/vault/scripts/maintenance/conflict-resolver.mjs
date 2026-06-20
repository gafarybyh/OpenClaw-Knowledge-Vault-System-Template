import { logError, log } from '../core/logger.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { globSync } from 'glob';
import { callAIJson, sleep } from '../core/ai-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');

// --- CONFIGURATION ---

const VAULT_PATH = path.join(WORKSPACE_ROOT, 'vault');
const KNOWLEDGE_PATH = path.join(VAULT_PATH, '01_thinking/knowledge');
const AI_CALL_DELAY_MS = 1500;
const MAX_INPUT_CHARS = 15000;

// --- UTILITIES ---

function truncate(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  return text.substring(0, maxChars) + '\n[TRUNCATED]';
}

const SYSTEM_PROMPT =
  'You are a Knowledge Integrity Architect. Detect and resolve contradictions between two claims in a Zettelkasten vault. ' +
  'Output ONLY valid JSON. No markdown, no explanation, no preamble.';

const USER_PROMPT = (fileA, contentA, fileB, contentB) =>
  `Analyze these two claims for contradictions.

A contradiction occurs if:
1. One claim asserts a fact that the other explicitly denies.
2. They make mutually exclusive claims about the same topic.
3. One claim is a general rule that the other presents as a universal exception without nuance.

If a conflict is found, propose a resolution:
- "RESOLVE_NUANCE": Both are true but apply to different contexts. Explain the nuance in "suggestion" (≤30 words).
- "RESOLVE_DEPRECATE": One claim is outdated/incorrect. Specify which in "deprecated_file" (A or B).
- "RESOLVE_MERGE": Claims are complementary and should be combined.

Example:
Note A (react-hooks-performance):
React hooks optimize rendering performance in component patterns.

Note B (react-hooks-memory):
React hooks can cause memory leaks if cleanup is not performed correctly.

→ {"conflict": false}

Note A (css-flexbox-layout):
Flexbox is the best layout method for all web pages.

Note B (css-grid-layout):
Grid is the only layout method that should be used for complex pages.

→ {"conflict": true, "resolution_type": "RESOLVE_NUANCE", "suggestion": "Flexbox excels at 1D layouts while Grid handles 2D. Both are valid for their respective use cases.", "deprecated_file": "none"}

Note A (${fileA}):
<<user_content>
${contentA}
</user_content>

Note B (${fileB}):
<<user_content>
${contentB}
</user_content>

Output:`;

async function analyzeConflict(fileA, contentA, fileB, contentB) {
  const safeA = truncate(contentA, MAX_INPUT_CHARS);
  const safeB = truncate(contentB, MAX_INPUT_CHARS);

  const result = await callAIJson([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT(fileA, safeA, fileB, safeB) },
  ], { temperature: 0, promptLabel: 'conflict-resolver' });

  if (result.data) return result.data;

  if (result.error) {
    log.warn(`[ConflictResolver] ⚠️ Conflict analysis failed after ${result.attempts} attempts: ${result.error}`);
    logError('conflict-resolver.mjs', new Error(result.error));
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
    // Validate deprecated_file field — only accept 'A' or 'B'
    const deprecationTarget = resolution.deprecated_file === 'A' ? 'A' :
      resolution.deprecated_file === 'B' ? 'B' : null;
    if (!deprecationTarget) {
      log.warn(`[ConflictResolver] ⚠️ Invalid deprecated_file value: "${resolution.deprecated_file}". Skipping deprecation.`);
      return;
    }
    const target = deprecationTarget === 'A' ? pathA : pathB;
    const targetName = deprecationTarget === 'A' ? fileA : fileB;

    if (fs.existsSync(target) && !targetName.startsWith('[DEPRECATED]')) {
      log.warn(`🚫 Deprecating ${targetName}...`);
      const newPath = path.join(KNOWLEDGE_PATH, '[DEPRECATED] ' + targetName + '.md');
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
    log.error(`[ConflictResolver] ❌ Atomic write failed for ${filePath}: ${e.message}`);
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
  let totalCalls = 0;

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
        // Rate limit: delay between AI calls to prevent 429
        if (totalCalls > 0) await sleep(AI_CALL_DELAY_MS);

        const result = await analyzeConflict(nameA, contentA, nameB, contents[nameB]);
        totalCalls++;
        if (result.conflict) {
          conflictsFound++;
          log.warn(`⚠️ Conflict found! Type: ${result.resolution_type}`);
          applyResolution(nameA, nameB, result);
        }
      } catch (e) {
        log.error(`[ConflictResolver] Error analyzing ${nameA} <-> ${nameB}: ${e.message}`);
      }
    }
  }

  log.info(`\n✨ Conflict Resolution Complete. Processed ${totalCalls} pairs, found ${conflictsFound} conflicts.`);
}

main().catch(err => {
  log.error(`[ConflictResolver] ❌ Fatal error: ${err.message}`);
  logError('conflict-resolver.mjs', err);
});
