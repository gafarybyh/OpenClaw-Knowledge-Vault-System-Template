/**
 * SELF-REFLECTION ENGINE v2.0 OPTIMAL
 * =====================================
 * Purpose: Critical self-evaluation of agent performance and reasoning.
 * 
 * Workflow:
 * 1. Parse transcript -> 2. AI Critical Analysis -> 3. Generate Reflection Report
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
const MAX_MESSAGES = 200;
const MAX_INPUT_CHARS = 25000;

const VALID_IMPORTANCE = ['low', 'medium', 'high'];
const VALID_TAGS = ['reasoning', 'efficiency', 'alignment', 'context', 'communication', 'tool-usage', 'architecture', 'correctness'];

const SYSTEM_PROMPT =
  'You are a high-precision Self-Reflection AI engine for an autonomous coding agent. ' +
  'Perform a brutal, critical self-evaluation. Do not be lenient. ' +
  'Output ONLY valid JSON. No markdown, no explanation, no preamble.';

const USER_PROMPT = (transcript) =>
  `Perform a critical self-evaluation of the agent's performance in this transcript.

The transcript uses this format:
user: <message>
assistant: <message>

EVALUATION CRITERIA:
1. Reasoning Coherence: Was the logic sound? Did the agent jump to conclusions?
2. Instruction Adherence: Did the agent contradict the user or ignore constraints?
3. Context Awareness: Was critical context ignored?
4. Confidence vs. Accuracy: Did the agent overpromise before failing?
5. Efficiency: Did the agent take a circuitous path or fall into loops?
6. Rule Alignment: Did the agent follow the AGENT-BEHAVIORAL-RULEBOOK?

RULES:
- "summary" MUST be ≤ 30 words.
- "importance" MUST be one of: low, medium, high.
- "tags" MUST be chosen from: ${VALID_TAGS.join(', ')}. Max 4 tags.
- "confidence_score" MUST be a number between 0.0 and 1.0.
- "reflection_markdown" should include sections: 🚩 Critical Failures, 💡 Missed Opportunities, ✅ Successes, 🛠️ Corrective Actions for Next Time.

Example:
Transcript:
user: Fix the CSS layout bug
assistant: I'll change the margin to padding.
user: That didn't work, the layout is still broken
assistant: Let me try changing the width instead.
user: Still broken. Did you even read the error message?

→ {"coherent": false, "contradictions_found": false, "context_missing": true, "confidence_issue": true, "alignment_issue": false, "summary": "Agent ignored error output and made blind trial-and-error fixes instead of diagnosing root cause.", "reflection_markdown": "## 🚩 Critical Failures\\n- Failed to read error messages before attempting fixes\\n## 💡 Missed Opportunities\\n- Should have analyzed the error output first\\n## ✅ Successes\\n- None\\n## 🛠️ Corrective Actions\\n- Always read error messages before making changes", "importance": "high", "confidence_score": 0.95, "tags": ["reasoning", "context", "efficiency"]}

Transcript:
<<user_content>
${transcript}
</user_content>

Output:`;

// ==================== UTILITIES ====================

function getMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
}

function stripUntrustedMetadata(text) {
  const lines = text.split(/\r?\n/);
  const cleaned = [];
  let skippingJsonBlob = false;
  let braceDepth = 0;
  let awaitingJsonStart = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!skippingJsonBlob && /Sender \(untrusted metadata\)/.test(line)) {
      skippingJsonBlob = true;
      braceDepth = 0;
      awaitingJsonStart = true;
      continue;
    }
    if (skippingJsonBlob) {
      if (!trimmed) continue;
      if (awaitingJsonStart && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        skippingJsonBlob = false;
        awaitingJsonStart = false;
      }
      if (!skippingJsonBlob) {
        cleaned.push(line);
        continue;
      }
      awaitingJsonStart = false;
      const opens = (line.match(/[{\[]/g) ?? []).length;
      const closes = (line.match(/[}\]]/g) ?? []).length;
      braceDepth += opens - closes;
      if (braceDepth <= 0 && (opens > 0 || closes > 0)) {
        skippingJsonBlob = false;
      }
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join('\n').trim();
}

function parseTranscript(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) return [];
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const messages = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('user: ')) {
      messages.push({ role: 'user', text: stripUntrustedMetadata(trimmed.substring(6).trim()) });
      continue;
    }
    if (trimmed.startsWith('assistant: ')) {
      messages.push({ role: 'assistant', text: stripUntrustedMetadata(trimmed.substring(11).trim()) });
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const role = parsed.message?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = stripUntrustedMetadata(getMessageText(parsed.message?.content));
      if (text) messages.push({ role, text });
    } catch (e) { }
  }
  return messages;
}



function validateReflection(data) {
  if (!data || typeof data !== 'object') return null;

  // Validate boolean fields
  for (const key of ['coherent', 'contradictions_found', 'context_missing', 'confidence_issue', 'alignment_issue']) {
    if (typeof data[key] !== 'boolean') data[key] = false;
  }

  // Validate importance
  if (!VALID_IMPORTANCE.includes(data.importance)) data.importance = 'medium';

  // Validate confidence_score
  if (typeof data.confidence_score !== 'number' || data.confidence_score < 0 || data.confidence_score > 1) {
    data.confidence_score = 0.5;
  }

  // Validate tags
  if (!Array.isArray(data.tags)) data.tags = [];
  data.tags = data.tags.filter(t => VALID_TAGS.includes(t)).slice(0, 4);
  if (data.tags.length === 0) data.tags = ['reasoning'];

  // Truncate summary
  if (typeof data.summary === 'string') {
    const words = data.summary.replace(/[\r\n]+/g, ' ').trim().split(/\s+/);
    if (words.length > 30) data.summary = words.slice(0, 30).join(' ');
  }

  return data;
}

async function runSelfReflection(conversation) {
  const result = await callAIJson([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT(conversation) }
  ], { temperature: 0, promptLabel: 'reflection' });

  if (result.data) {
    const validated = validateReflection(result.data);
    if (validated) {
      log.success(`✅ AI reflection successful (${result.attempts} attempt(s)).`);
      return validated;
    }
  }

  if (result.error) {
    log.warn(`[Reflection] ⚠️ Reflection AI failed after ${result.attempts} attempts: ${result.error}`);
    logError('reflection.mjs', new Error(result.error));
  }

  return null;
}

async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');
  let transcriptPath = process.argv[2];

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    const memoryDir = path.join(WORKSPACE_ROOT, 'memory');
    if (fs.existsSync(memoryDir)) {
      const files = fs.readdirSync(memoryDir)
        .filter(f => f.endsWith('.jsonl') || f.endsWith('.md'))
        .map(f => ({
          name: f,
          path: path.join(memoryDir, f),
          mtime: fs.statSync(path.join(memoryDir, f)).mtimeMs
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        transcriptPath = files[0].path;
        log.info(`ℹ️ No valid transcript path provided. Falling back to latest session: ${path.basename(transcriptPath)}`);
      }
    }
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log.error('No transcript path provided or found.');
    process.exit(1);
  }

  try {
    const messages = parseTranscript(transcriptPath);
    if (messages.length === 0) {
      log.info('No valid messages found in transcript.');
      return;
    }

    let conversation = messages.slice(-MAX_MESSAGES).map(m => `${m.role}: ${m.text}`).join('\n');

    // Truncate if input exceeds token safety limit
    if (conversation.length > MAX_INPUT_CHARS) {
      log.warn(`[Reflection] ⚠️ Transcript truncated from ${conversation.length} to ${MAX_INPUT_CHARS} chars.`);
      conversation = conversation.substring(0, MAX_INPUT_CHARS) + '\n\n[TRUNCATED]';
    }

    const reflection = await runSelfReflection(conversation);

    if (reflection) {
      if (DRY_RUN) {
        log.info('--- DRY RUN: Reflection Result ---');
        console.log(JSON.stringify(reflection, null, 2));
        return;
      }

      if (!fs.existsSync(REFLECTIONS_DIR)) {
        fs.mkdirSync(REFLECTIONS_DIR, { recursive: true });
      }

      const dateStr = new Date().toISOString().split('T')[0];
      const timeStr = Date.now().toString().slice(-4);
      const fileName = `reflection-${dateStr}-${timeStr}.md`;
      const filePath = path.join(REFLECTIONS_DIR, fileName);

      const frontmatter = `---
type: reflection
created: ${dateStr}
confidence: ${reflection.confidence_score || 0.90}
importance: ${reflection.importance || 'medium'}
tags: ${JSON.stringify(reflection.tags || ['reflection'])}
coherent: ${reflection.coherent}
contradictions_found: ${reflection.contradictions_found}
context_missing: ${reflection.context_missing}
confidence_issue: ${reflection.confidence_issue}
alignment_issue: ${reflection.alignment_issue}
---

# Self-Reflection: ${dateStr}

## Summary
${reflection.summary}

## Evaluation Details
${reflection.reflection_markdown}
`;

      fs.writeFileSync(filePath, frontmatter, 'utf8');
      log.success(`✅ Reflection file generated: ${fileName}`);
    } else {
      log.info('ℹ️ No reflection generated.');
    }
  } catch (err) {
    log.error(`[Reflection] ❌ Reflection Engine Error: ${err.message}`);
    logError('reflection.mjs', err);
    process.exit(1);
  }
}

main();
