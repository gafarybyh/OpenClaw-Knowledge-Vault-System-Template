/**
 * REFLECTION SYNTHESIZER v1.2 (Claimed-System)
 * =====================================
 * Purpose: Analyze systemic failure patterns from reflection reports 
 * and synthesize them into prescriptive rules for the Behavioral Rulebook.
 * 
 * Workflow:
 * 1. Scan unclaimed reflections/ -> 2. Read Current Rulebook -> 3. AI Synthesis (De-duplicated) -> 4. Update Rulebook -> 5. Mark as Claimed
 */

import { logError, log } from '../core/logger.mjs';
import { callAIJson } from '../core/ai-client.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');

// --- CONFIGURATION ---
const REFLECTIONS_DIR = path.join(WORKSPACE_ROOT, 'vault', '01_thinking', 'reflections');
const RULEBOOK_PATH = path.join(WORKSPACE_ROOT, 'vault', '01_thinking', 'AGENT-BEHAVIORAL-RULEBOOK.md');
const MAX_INPUT_CHARS = 25000;
const MAX_BACKUPS = 3;
const MAX_RULES = 50;

const VALID_CATEGORIES = ['Reasoning', 'Tool Use', 'Communication', 'Context Management', 'Efficiency', 'Architecture', 'Security'];

const SYSTEM_PROMPT =
  'You are a Behavioral Architect specializing in AI alignment and performance optimization. ' +
  'Analyze self-reflection reports and synthesize prescriptive behavioral rules. ' +
  'Output ONLY valid JSON. No markdown, no explanation, no preamble.';

const USER_PROMPT = (rulebook, reflections) =>
  `Analyze these self-reflection reports and synthesize prescriptive behavioral rules, avoiding duplication with the current rulebook.

GOAL:
Transform "symptoms of failure" into "preventative rules".
Instead of "The agent failed to X", say "Always do Y to avoid X".

NON-DUPLICATION PROTOCOL:
1. Analyze the CURRENT RULEBOOK carefully to avoid redundancy.
2. If a suggested rule is already covered (even if phrased differently), DO NOT include it.
3. Only include a rule if it fills a gap, corrects a systemic failure, or significantly improves an existing rule.

RULES:
- "rule" MUST be ≤ 25 words. Use prescriptive tone: "Always...", "Never...", "Before doing X, first Y..."
- "reason" MUST be ≤ 15 words. Briefly explain the failure pattern this prevents.
- "category" MUST be one of: ${VALID_CATEGORIES.join(', ')}.
- Max ${MAX_RULES} rules total. Prioritize recurring patterns across multiple reports.

Example:
Current Rulebook has: "Always read error messages before making changes."

Reflection Reports:
File: reflection-2024-01-15-1234.md
Summary: Agent ignored CSS error and made blind fixes
Corrective Actions: Read error messages first

→ {"synthesized_rules": [], "analysis_summary": "No new rules needed; existing 'Always read error messages' rule already covers this pattern."}

CURRENT RULEBOOK:
<<user_content>
${rulebook}
</user_content>

REFLECTION REPORTS TO ANALYZE:
<<user_content>
${reflections}
</user_content>

Output:`;

// ==================== UTILITIES ====================

function extractReflectionData(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Extract summary from frontmatter
    const summaryMatch = content.match(/summary: "(.*?)"/);
    const summary = summaryMatch ? summaryMatch[1] : 'No summary available';
    
    // Extract Corrective Actions section
    const actionsMatch = content.match(/## 🛠️ Corrective Actions for Next Time\s*([\s\S]*?)(?=\n#|$)/);
    const actions = actionsMatch ? actionsMatch[1].trim() : 'No corrective actions found';
    
    return {
      file: path.basename(filePath),
      summary,
      actions
    };
  } catch (err) {
    log.warn(`[ReflectionSynth] ⚠️ Failed to parse reflection ${path.basename(filePath)}: ${err.message}`);
    return null;
  }
}



// ==================== CORE LOGIC ====================

function validateSynthesis(data) {
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.synthesized_rules)) data.synthesized_rules = [];
  if (typeof data.analysis_summary !== 'string') data.analysis_summary = '';

  // Validate and truncate each rule
  data.synthesized_rules = data.synthesized_rules
    .filter(r => r && typeof r.rule === 'string' && r.rule.trim())
    .slice(0, MAX_RULES)
    .map(r => {
      const rule = r.rule.replace(/[\r\n]+/g, ' ').trim().split(/\s+/);
      const reason = (r.reason || '').replace(/[\r\n]+/g, ' ').trim().split(/\s+/);
      return {
        category: VALID_CATEGORIES.includes(r.category) ? r.category : 'Reasoning',
        rule: rule.length > 25 ? rule.slice(0, 25).join(' ') : rule.join(' '),
        reason: reason.length > 15 ? reason.slice(0, 15).join(' ') : reason.join(' '),
      };
    });

  // Truncate summary
  const words = data.analysis_summary.replace(/[\r\n]+/g, ' ').trim().split(/\s+/);
  if (words.length > 50) data.analysis_summary = words.slice(0, 50).join(' ');

  return data;
}

async function synthesizeReflections() {
  if (!fs.existsSync(REFLECTIONS_DIR)) {
    log.error('❌ Reflections directory not found.');
    return null;
  }

  // Filter for .md files that are NOT yet claimed
  const files = fs.readdirSync(REFLECTIONS_DIR).filter(f => f.endsWith('.md') && !f.includes('-claimed'));
  if (files.length === 0) {
    log.info('ℹ️ No new unclaimed reflection files found to synthesize.');
    return null;
  }

  // Read current rulebook for de-duplication
  let currentRulebook = '';
  if (fs.existsSync(RULEBOOK_PATH)) {
    currentRulebook = fs.readFileSync(RULEBOOK_PATH, 'utf8');
  }

  log.info(`📡 Scanning ${files.length} unclaimed reflection reports...`);
  const aggregatedData = files
    .map(f => extractReflectionData(path.join(REFLECTIONS_DIR, f)))
    .filter(Boolean);

  let promptContent = aggregatedData
    .map(d => `File: ${d.file}\nSummary: ${d.summary}\nCorrective Actions:\n${d.actions}`)
    .join('\n\n---\n\n');

  // Truncate if input exceeds token safety limit
  if (promptContent.length > MAX_INPUT_CHARS) {
    log.warn(`[ReflectionSynth] ⚠️ Reflections truncated from ${promptContent.length} to ${MAX_INPUT_CHARS} chars.`);
    promptContent = promptContent.substring(0, MAX_INPUT_CHARS) + '\n\n[TRUNCATED]';
  }

  // Also cap rulebook size
  if (currentRulebook.length > MAX_INPUT_CHARS) {
    log.warn(`[ReflectionSynth] ⚠️ Current rulebook truncated to ${MAX_INPUT_CHARS} chars.`);
    currentRulebook = currentRulebook.substring(0, MAX_INPUT_CHARS) + '\n\n[TRUNCATED]';
  }

  log.info('📡 Synthesizing systemic patterns...');
  const result = await callAIJson([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT(currentRulebook, promptContent) }
  ], { temperature: 0.2, promptLabel: 'reflection-synthesizer' });

  if (result.data) {
    const validated = validateSynthesis(result.data);
    if (validated) {
      return { synthesis: validated, processedFiles: files };
    }
  }

  if (result.error) {
    log.warn(`[ReflectionSynth] ⚠️ AI synthesis failed after ${result.attempts} attempts: ${result.error}`);
    logError('reflection-synthesizer.mjs', new Error(result.error));
  }

  return null;
}

function rotateBackup() {
  for (let i = MAX_BACKUPS; i < 99; i++) {
    const oldBackup = `${RULEBOOK_PATH}.bak${i > 1 ? i : ''}`;
    const prevBackup = i === 1 ? `${RULEBOOK_PATH}.bak` : `${RULEBOOK_PATH}.bak${i}`;
    if (fs.existsSync(oldBackup)) fs.unlinkSync(oldBackup);
    if (fs.existsSync(prevBackup)) {
      const next = i === 1 ? `${RULEBOOK_PATH}.bak2` : `${RULEBOOK_PATH}.bak${i + 1}`;
      fs.renameSync(prevBackup, next);
    }
  }
}

async function updateRulebook(synthesis) {
  if (!fs.existsSync(RULEBOOK_PATH)) {
    log.error(`❌ Rulebook not found at ${RULEBOOK_PATH}`);
    return;
  }

  let rulebookContent = fs.readFileSync(RULEBOOK_PATH, 'utf8');
  
  const sectionHeader = '## 🧠 Synthesized Behavioral Rules (from Reflections)';
  const sectionExists = rulebookContent.includes(sectionHeader);
  
  // Build rules markdown
  const categories = {};
  synthesis.synthesized_rules.forEach(r => {
    if (!categories[r.category]) categories[r.category] = [];
    categories[r.category].push(r);
  });

  let rulesBody = '';
  for (const [category, rules] of Object.entries(categories)) {
    rulesBody += `\n### ${category}\n`;
    rules.forEach(r => {
      rulesBody += `- **${r.rule}** (Reason: ${r.reason})\n`;
    });
  }

  if (sectionExists) {
    // Replace existing section with updated content
    const regex = new RegExp(`\n${sectionHeader}[\\s\\S]*?(?=\\n## |$)`, 'g');
    const replacement = `\n${sectionHeader}\n${rulesBody.trimEnd()}`;
    rulebookContent = rulebookContent.replace(regex, replacement);
  } else {
    rulebookContent += `\n\n${sectionHeader}\n${rulesBody}`;
  }

  // Backup with rotation
  rotateBackup();
  fs.copyFileSync(RULEBOOK_PATH, `${RULEBOOK_PATH}.bak`);

  // Atomic write
  const tmpPath = RULEBOOK_PATH + '.tmp';
  fs.writeFileSync(tmpPath, rulebookContent, 'utf8');
  fs.renameSync(tmpPath, RULEBOOK_PATH);
  
  log.success('✅ Rulebook updated with synthesized behavioral rules.');
}

function cleanupOldReflections() {
  try {
    const files = fs.readdirSync(REFLECTIONS_DIR)
      .filter(f => f.endsWith('-claimed.md'))
      .map(f => ({
        name: f,
        path: path.join(REFLECTIONS_DIR, f),
        mtime: fs.statSync(path.join(REFLECTIONS_DIR, f)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime); // Terbaru di atas

    // Simpan 10 laporan terbaru saja
    if (files.length > 10) {
      const toDelete = files.slice(10);
      let count = 0;
      toDelete.forEach(file => {
        try {
          fs.unlinkSync(file.path);
          count++;
        } catch (e) {}
      });
      if (count > 0) {
        log.info(`🧹 Garbage collected ${count} old reflection reports (kept latest 10).`);
      }
    }
  } catch (err) {
    log.error(`⚠️ Failed to cleanup old reflections: ${err.message}`);
  }
}

function markFilesAsClaimed(files) {
  log.info('🏷️ Marking processed reports as claimed...');
  let count = 0;
  for (const file of files) {
    try {
      const oldPath = path.join(REFLECTIONS_DIR, file);
      const newPath = path.join(REFLECTIONS_DIR, file.replace('.md', '-claimed.md'));
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath);
        count++;
      }
    } catch (e) {
      log.warn(`[ReflectionSynth] Failed to claim ${file}: ${e.message}`);
    }
  }
  if (count > 0) log.success(`✅ ${count} reports marked as claimed.`);
}

async function main() {
  try {
    const result = await synthesizeReflections();
    if (result && result.synthesis && result.synthesis.synthesized_rules.length > 0) {
      log.step('✨ New systemic patterns identified. Updating rulebook...');
      log.info(`Summary: ${result.synthesis.analysis_summary}`);
      await updateRulebook(result.synthesis);
    } else if (result && result.synthesis) {
      log.info('ℹ️ No new systemic patterns found that aren\'t already in the rulebook.');
    } else {
      log.info('ℹ️ No new unclaimed reflection files found to synthesize.');
    }
    
    // Mark files as claimed (if any were processed)
    if (result && result.processedFiles && result.processedFiles.length > 0) {
      markFilesAsClaimed(result.processedFiles);
    }
    
    // Garbage Collection
    cleanupOldReflections();
    
  } catch (err) {
    log.error(`[ReflectionSynth] ❌ Reflection Synthesizer Error: ${err.message}`);
    logError('reflection-synthesizer.mjs', err);
    process.exit(1);
  }
}

main();
