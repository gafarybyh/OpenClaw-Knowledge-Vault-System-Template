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
import { callAI } from '../core/ai-client.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');

// --- CONFIGURATION ---
const REFLECTIONS_DIR = path.join(WORKSPACE_ROOT, 'vault', '01_thinking', 'reflections');
const RULEBOOK_PATH = path.join(WORKSPACE_ROOT, 'vault', '01_thinking', 'AGENT-BEHAVIORAL-RULEBOOK.md');

const SYSTEM_PROMPT = `You are a Behavioral Architect specializing in AI alignment and performance optimization.
Your task is to analyze a collection of self-reflection reports and synthesize them into a set of high-level, prescriptive behavioral rules.

### GOAL:
Transform "symptoms of failure" into "preventative rules". 
Instead of saying "The agent failed to X", say "Always do Y to avoid X".

### NON-DUPLICATION PROTOCOL:
You will be provided with the CURRENT Behavioral Rulebook. 
1. **Analyze Existing Rules**: Carefully review the current rules to avoid redundancy.
2. **Filter Redundancy**: If a suggested rule is already covered by an existing rule (even if phrased differently), DO NOT include it.
3. **Refine/Expand**: Only include a rule if it fills a gap, corrects a systemic failure not yet addressed, or significantly improves an existing rule.

### GUIDELINES:
1. **Pattern Recognition**: Identify recurring failures across multiple reports.
2. **Prescriptive Tone**: Rules must be clear, actionable, and mandatory (e.g., "Always...", "Never...", "Before doing X, first Y...").
3. **Categorization**: Group rules into categories (e.g., Reasoning, Tool Use, Communication, Context Management).
4. **Conciseness**: Avoid fluff. Each rule should be a single, powerful sentence.

### OUTPUT FORMAT:
You must output a single, valid JSON object. NO preamble, NO markdown wrappers.

{
  "synthesized_rules": [
    {
      "category": "Category Name",
      "rule": "The prescriptive rule",
      "reason": "Brief explanation of the failure pattern this rule prevents"
    }
  ],
  "analysis_summary": "A brief summary of the systemic patterns identified and how they differ from existing rules."
}`;

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
    console.warn(`⚠️ Failed to parse reflection ${filePath}: ${err.message}`);
    return null;
  }
}

function cleanJsonResponse(text) {
  if (!text) return null;
  let cleaned = text.trim();
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = cleaned.match(codeBlockRegex);
  if (match) {
    cleaned = match[1].trim();
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return cleaned.substring(start, end + 1).trim();
}

// ==================== CORE LOGIC ====================

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

  const promptContent = aggregatedData
    .map(d => `File: ${d.file}\nSummary: ${d.summary}\nCorrective Actions:\n${d.actions}`)
    .join('\n\n---\n\n');

  try {
    log.info('📡 Synthesizing systemic patterns (Rulebook-Aware) via AI Client...');
    const response = await callAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { 
        role: 'user', 
        content: `### CURRENT BEHAVIORAL RULEBOOK:\n${currentRulebook}\n\n---\n\n### REFLECTION REPORTS TO ANALYZE:\n${promptContent}` 
      }
    ], { temperature: 0.2 });

    if (response) {
      const cleaned = cleanJsonResponse(response);
      if (cleaned) {
        return {
          synthesis: JSON.parse(cleaned),
          processedFiles: files
        };
      }
    }
  } catch (err) {
    console.error('❌ Synthesis AI failed:', err.message);
    logError('reflection-synthesizer.mjs', err);
  }
  return null;
}

async function updateRulebook(synthesis) {
  if (!fs.existsSync(RULEBOOK_PATH)) {
    log.error(`❌ Rulebook not found at ${RULEBOOK_PATH}`);
    return;
  }

  let rulebookContent = fs.readFileSync(RULEBOOK_PATH, 'utf8');
  
  // Create a section for Synthesized Rules if it doesn't exist
  const sectionHeader = '## 🧠 Synthesized Behavioral Rules (from Reflections)';
  let sectionExists = rulebookContent.includes(sectionHeader);
  
  let newRulesMarkdown = '\n\n' + sectionHeader + '\n';
  
  // Group rules by category
  const categories = {};
  synthesis.synthesized_rules.forEach(r => {
    if (!categories[r.category]) categories[r.category] = [];
    categories[r.category].push(r);
  });

  for (const [category, rules] of Object.entries(categories)) {
    newRulesMarkdown += `\n### ${category}\n`;
    rules.forEach(r => {
      newRulesMarkdown += `- **${r.rule}** (Reason: ${r.reason})\n`;
    });
  }

  if (sectionExists) {
    // Replace existing synthesized section with new one
    const regex = new RegExp(`${sectionHeader}[\\s\\S]*?(?=\\n#|$)`, 'g');
    rulebookContent = rulebookContent.replace(regex, newRulesMarkdown);
  } else {
    // Append to the end of the file
    rulebookContent += '\n' + newRulesMarkdown;
  }

  // Atomic write
  const tmpPath = RULEBOOK_PATH + '.tmp';
  fs.writeFileSync(tmpPath, rulebookContent, 'utf8');
  fs.renameSync(tmpPath, RULEBOOK_PATH);
  
  log.success('✅ Rulebook updated with synthesized behavioral rules.');
}

async function main() {
  try {
    const result = await synthesizeReflections();
    if (result && result.synthesis && result.synthesis.synthesized_rules.length > 0) {
      log.step('✨ New systemic patterns identified. Updating rulebook...');
      log.info(`Summary: ${result.synthesis.analysis_summary}`);
      await updateRulebook(result.synthesis);
      
      // Mark files as claimed
      log.info('🏷️ Marking processed reports as claimed...');
      result.processedFiles.forEach(file => {
        const oldPath = path.join(REFLECTIONS_DIR, file);
        const newPath = path.join(REFLECTIONS_DIR, file.replace('.md', '-claimed.md'));
        fs.renameSync(oldPath, newPath);
      });
      log.success(`✅ ${result.processedFiles.length} reports marked as claimed.`);
    } else if (result && result.synthesis) {
      log.info('ℹ️ No new systemic patterns found that aren\'t already in the rulebook.');
      
      // Even if no new rules were added, the files were analyzed and found redundant.
      // Mark them as claimed anyway to avoid re-analyzing them.
      log.info('🏷️ Marking analyzed reports as claimed...');
      result.processedFiles.forEach(file => {
        const oldPath = path.join(REFLECTIONS_DIR, file);
        const newPath = path.join(REFLECTIONS_DIR, file.replace('.md', '-claimed.md'));
        fs.renameSync(oldPath, newPath);
      });
      log.success(`✅ ${result.processedFiles.length} reports marked as claimed.`);
    } else {
      log.info('ℹ️ No new unclaimed reflection files found to synthesize.');
    }
  } catch (err) {
    console.error('Reflection Synthesizer Error:', err.message);
    logError('reflection-synthesizer.mjs', err);
    process.exit(1);
  }
}

main();
