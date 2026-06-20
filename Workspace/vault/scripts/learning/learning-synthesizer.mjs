import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError, log } from '../core/logger.mjs';
import { callAI, sleep } from '../core/ai-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');

// --- CONFIGURATION ---

const LEARNINGS_DIR = path.join(WORKSPACE_ROOT, 'vault', '.system', 'temp_learnings');
const RULEBOOK_PATH = path.join(WORKSPACE_ROOT, 'vault/01_thinking/AGENT-BEHAVIORAL-RULEBOOK.md');
const AI_MAX_RETRIES = 3;
const AI_RETRY_DELAY_MS = 3000;
const MAX_INPUT_CHARS = 25000;
const MAX_BACKUPS = 3;

const SYSTEM_PROMPT =
  'You are the Lead Behavioral Architect for an autonomous agent. ' +
  'Evolve the agent\'s Behavioral Rulebook by synthesizing new learnings into permanent operating principles. ' +
  'Output ONLY the finalized markdown text. No code blocks, no preamble, no explanations.';

const USER_PROMPT = (currentRulebook, newLearnings) =>
  `Merge the NEW LEARNINGS into the CURRENT RULEBOOK following these rules:

CORE OBJECTIVES:
1. CONSOLIDATION: Merge NEW learnings into the CURRENT Rulebook.
2. DEDUPLICATION: If a new learning reinforces an existing rule, merge them into a single, stronger statement.
3. CONFLICT RESOLUTION: If a new learning contradicts an existing rule, the NEW learning takes precedence (most recent user preference).
4. ABSTRACTION: Convert raw observations into permanent principles.
   - Bad: "User told me on May 30 to stop using formal greetings."
   - Good: "- Avoid formal greetings; maintain a direct, technical tone."

STRUCTURAL REQUIREMENTS:
- Preserve the exact header "# AGENT-BEHAVIORAL-RULEBOOK" and the "> ⚠️ CRITICAL:" block.
- Organize rules under "## Behavioral Rules" using logical categories (e.g., Communication, Tool-Usage, Formatting).
- Use concise bullet points. No fluff, no preamble, no explanations.
- Output ONLY the finalized markdown text. No \`\`\`markdown wrappers.

Example:
Current Rulebook:
# AGENT-BEHAVIORAL-RULEBOOK

> ⚠️ CRITICAL: This file is PERMANENT.

---

## Behavioral Rules

### Communication
- Use a direct, technical tone.

New Learnings:
### Corrections
- [2024-01-15] [Session: session.md] [Tone/Style/Format] Stop using markdown tables, use lists instead.

Output:
# AGENT-BEHAVIORAL-RULEBOOK

> ⚠️ CRITICAL: This file is PERMANENT.

---

## Behavioral Rules

### Communication
- Use a direct, technical tone.
- Prefer lists over markdown tables for data presentation.

---

CURRENT RULEBOOK:
<<user_content>
${currentRulebook}
</user_content>

NEW LEARNINGS TO CONSOLIDATE (Categorized):
<<user_content>
${newLearnings}
</user_content>

Output:`;

async function consolidateWithAI(currentRulebook, newLearnings) {
  for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      const content = await callAI([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT(currentRulebook, newLearnings) },
      ], { temperature: 0.1 });

      if (typeof content === 'string') {
        const cleaned = content.replace(/^```markdown\n?/, '').replace(/\n?```$/, '').trim();
        if (cleaned) return cleaned;
      }
    } catch (err) {
      log.error(`[Synthesizer] ⚠️ AI consolidation failed (attempt ${attempt}/${AI_MAX_RETRIES}): ${err.message}`);
      if (attempt < AI_MAX_RETRIES) {
        await sleep(AI_RETRY_DELAY_MS * attempt);
        continue;
      }
      logError('learning-synthesizer.mjs', err);
    }
  }

  return null;
}

function rotateBackup() {
  // Remove oldest backup if we exceed MAX_BACKUPS
  for (let i = MAX_BACKUPS; i < 99; i++) {
    const oldBackup = `${RULEBOOK_PATH}.bak${i > 1 ? i : ''}`;
    const prevBackup = i === 1 ? `${RULEBOOK_PATH}.bak` : `${RULEBOOK_PATH}.bak${i}`;
    if (fs.existsSync(oldBackup)) {
      fs.unlinkSync(oldBackup);
    }
    if (fs.existsSync(prevBackup)) {
      const next = i === 1 ? `${RULEBOOK_PATH}.bak2` : `${RULEBOOK_PATH}.bak${i + 1}`;
      fs.renameSync(prevBackup, next);
    }
  }
}

async function synthesize() {
  try {
    if (!fs.existsSync(LEARNINGS_DIR)) return;

    const files = fs.readdirSync(LEARNINGS_DIR).filter(f => f.endsWith('.md'));
    if (files.length === 0) return;

    let newLearnings = "";
    const filesToDelete = [];

    for (const file of files) {
      const filePath = path.join(LEARNINGS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content) {
        const category = file.replace('.md', '').toUpperCase();
        newLearnings += `\n### ${category}\n${content}\n`;
        filesToDelete.push(filePath);
      }
    }

    if (!newLearnings.trim()) return;

    // Truncate if input exceeds token safety limit (~25K chars ≈ ~6K tokens)
    if (newLearnings.length > MAX_INPUT_CHARS) {
      log.warn(`[Synthesizer] ⚠️ Learnings truncated from ${newLearnings.length} to ${MAX_INPUT_CHARS} chars to prevent token overflow.`);
      newLearnings = newLearnings.substring(0, MAX_INPUT_CHARS) + '\n\n[TRUNCATED]';
    }

    let currentRulebook = "";
    if (fs.existsSync(RULEBOOK_PATH)) {
      currentRulebook = fs.readFileSync(RULEBOOK_PATH, 'utf8');
      // Also cap rulebook size
      if (currentRulebook.length > MAX_INPUT_CHARS) {
        log.warn(`[Synthesizer] ⚠️ Current rulebook truncated to ${MAX_INPUT_CHARS} chars.`);
        currentRulebook = currentRulebook.substring(0, MAX_INPUT_CHARS) + '\n\n[TRUNCATED]';
      }
    } else {
      currentRulebook = `# AGENT-BEHAVIORAL-RULEBOOK\n\n> ⚠️ CRITICAL: This file is PERMANENT. Do NOT move to archive or published.\n> Purpose: The single source of truth for learned behavioral rules.\n\n---`;
    }

    log.info('[Synthesizer] 🧠 AI Consolidation started...');
    const updatedRulebook = await consolidateWithAI(currentRulebook, newLearnings);

    if (updatedRulebook && updatedRulebook.includes('# AGENT-BEHAVIORAL-RULEBOOK')) {
      // 1. Backup with rotation
      if (fs.existsSync(RULEBOOK_PATH)) {
        rotateBackup();
        fs.copyFileSync(RULEBOOK_PATH, `${RULEBOOK_PATH}.bak`);
      }

      // 2. Atomic Write: Write to temp file then rename
      const tempPath = `${RULEBOOK_PATH}.tmp`;
      fs.writeFileSync(tempPath, updatedRulebook, 'utf8');
      fs.renameSync(tempPath, RULEBOOK_PATH);
      
      log.info('[Synthesizer] ✅ Learnings successfully consolidated via AI.');

      // 3. Update individual rule nodes
      updateBehavioralRuleNodes();

      // 4. Only delete raw files if synthesis was successful
      for (const filePath of filesToDelete) {
        fs.unlinkSync(filePath);
      }
    } else {
      log.error('[Synthesizer] ❌ AI Consolidation failed or returned invalid format. Raw learnings kept for next try.');
      logError('learning-synthesizer.mjs', new Error('AI Consolidation failed or returned invalid format'));
    }
  } catch (err) {
    log.error(`[Synthesizer] ❌ Critical Error: ${err.message}`);
    logError('learning-synthesizer.mjs', err);
    process.exit(1);
  }
}

function updateBehavioralRuleNodes() {
  try {
    const content = fs.readFileSync(RULEBOOK_PATH, 'utf8');
    const rulesDir = path.join(WORKSPACE_ROOT, 'vault/01_thinking/behavioral_rules');
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }

    const generatedFiles = new Set();
    const lines = content.split(/\r?\n/);
    let currentCategory = 'general';
    let isBehavioralRulesSection = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('## ')) {
        const header = trimmed.substring(3).toLowerCase();
        if (header.includes('behavioral rules') || header.includes('learning synthesis')) {
          isBehavioralRulesSection = true;
        } else {
          isBehavioralRulesSection = false;
        }
        continue;
      }

      if (isBehavioralRulesSection && trimmed.startsWith('### ')) {
        currentCategory = trimmed.substring(4).trim().toLowerCase().replace(/\s+/g, '_');
        continue;
      }

      if (isBehavioralRulesSection && (trimmed.startsWith('- ') || trimmed.startsWith('* '))) {
        const ruleText = trimmed.substring(2).trim();
        if (!ruleText || ruleText.startsWith('[') || ruleText.includes('Learning Synthesis')) continue;

        // Generate filename
        let baseName = ruleText.toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (baseName.length > 60) {
          baseName = baseName.substring(0, 60).replace(/-+$/, '');
        }
        const fileName = `${baseName || 'rule'}.md`;
        const filePath = path.join(rulesDir, fileName);
        generatedFiles.add(fileName);

        let confidence = 0.90;
        let impact = 'medium';
        let recurrenceCount = 1;
        const lastValidated = new Date().toISOString().split('T')[0];

        if (fs.existsSync(filePath)) {
          try {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const fmMatch = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (fmMatch) {
              fmMatch[1].split(/\r?\n/).forEach(l => {
                const parts = l.split(':');
                if (parts.length >= 2) {
                  const key = parts[0].trim();
                  const val = parts.slice(1).join(':').trim();
                  if (key === 'confidence') confidence = parseFloat(val) || confidence;
                  else if (key === 'impact') impact = val.replace(/['"]/g, '') || impact;
                  else if (key === 'recurrence_count') recurrenceCount = (parseInt(val) || recurrenceCount) + 1; // Increment count if it persists
                }
              });
            }
          } catch (e) {
            log.error(`[Synthesizer] Failed to parse rule file: ${fileName} — ${e.message}`);
            logError('learning-synthesizer.mjs', e);
          }
        }

        const newContent = `---
type: behavior_rule
rule_type: ${currentCategory}
confidence: ${confidence}
impact: ${impact}
recurrence_count: ${recurrenceCount}
last_validated: ${lastValidated}
---

# Rule: ${ruleText}

- Type: behavior_rule
- Category: ${currentCategory}
- Confidence: ${confidence}
- Impact: ${impact}
- Recurrence Count: ${recurrenceCount}

## Statement
${ruleText}
`;
        fs.writeFileSync(filePath, newContent, 'utf8');
        log.info(`Updated behavioral rule node: ${fileName}`);
      }
    }

    // Garbage Collection: Remove obsolete rule files
    // Safety: Only delete if we have generated at least 1 rule (prevents mass deletion on parse failure)
    if (generatedFiles.size > 0) {
      const existingFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md'));
      const deleteCandidates = existingFiles.filter(f => !generatedFiles.has(f));

      // Safety threshold: never delete more than 80% of existing rules in one run
      if (deleteCandidates.length > 0 && deleteCandidates.length < existingFiles.length * 0.8) {
        let deletedCount = 0;
        for (const f of deleteCandidates) {
          try {
            fs.unlinkSync(path.join(rulesDir, f));
            deletedCount++;
          } catch (e) {
            log.error(`[Synthesizer] Failed to delete obsolete rule ${f}: ${e.message}`);
          }
        }
        if (deletedCount > 0) {
          log.info(`🗑️ Garbage collected ${deletedCount} obsolete behavioral rules.`);
        }
      } else if (deleteCandidates.length >= existingFiles.length * 0.8) {
        log.warn(`[Synthesizer] ⚠️ GC skipped: would delete ${deleteCandidates.length}/${existingFiles.length} rules (>80% threshold). Possible parse failure.`);
      }
    }
  } catch (err) {
    log.error(`[Synthesizer] ❌ Error generating behavioral rule nodes: ${err.message}`);
    logError('learning-synthesizer.mjs', err);
  }
}

synthesize();
