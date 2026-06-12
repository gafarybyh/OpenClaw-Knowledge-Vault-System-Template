/**
 * SELF-REFLECTION ENGINE v2.0 OPTIMAL
 * =====================================
 * Purpose: Critical self-evaluation of agent performance and reasoning.
 * 
 * Workflow:
 * 1. Parse transcript -> 2. AI Critical Analysis -> 3. Generate Reflection Report
 */

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
const REFLECTIONS_DIR = path.join(WORKSPACE_ROOT, 'vault', '01_thinking', 'reflections');
const MAX_MESSAGES = 50;

const SYSTEM_PROMPT = `You are a high-precision Self-Reflection AI engine for an autonomous coding agent. 
Your goal is to perform a brutal, critical self-evaluation of the agent's performance in the provided transcript.

Do not be lenient. Look for "blind spots," reasoning failures, and inefficiencies.

### EVALUATION CRITERIA:
1. **Reasoning Coherence**: Was the logic sound? Did the agent jump to conclusions or miss obvious clues?
2. **Instruction Adherence**: Did the agent contradict the user or ignore specific constraints?
3. **Context Awareness**: Was critical context ignored? Did the agent ask for information already provided?
4. **Confidence vs. Accuracy**: Did the agent overpromise or show "hallucinated confidence" before failing?
5. **Efficiency**: Did the agent take a circuitous path? Did it fall into a "loop" of repeated failed attempts?
6. **Rule Alignment**: Did the agent follow the AGENT-BEHAVIORAL-RULEBOOK and other system constraints?

### OUTPUT FORMAT:
You must output a single, valid JSON object. NO preamble, NO markdown wrappers.

{
  "coherent": boolean,
  "contradictions_found": boolean,
  "context_missing": boolean,
  "confidence_issue": boolean,
  "alignment_issue": boolean,
  "summary": "A concise, 2-3 sentence summary of the failure/success points.",
  "reflection_markdown": "A detailed, professional markdown report. Use sections like: \\n## 🚩 Critical Failures\\n## 💡 Missed Opportunities\\n## ✅ Successes\\n## 🛠️ Corrective Actions for Next Time",
  "importance": "low" | "medium" | "high",
  "confidence_score": number (0.0 to 1.0),
  "tags": ["reasoning", "efficiency", "alignment", "etc"]
}`;

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



async function runSelfReflection(conversation) {
  try {
    log.info('📡 Analyzing chat session reflection via AI Client...');
    
    const response = await callAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: conversation }
    ], { temperature: 0 });

    if (response) {
      const { data, error } = parseAIJson(response, 'reflection.mjs');
      if (data) {
        log.success('✅ AI reflection successful.');
        return data;
      }
      if (error) console.warn(`⚠️ AI returned content but JSON parse failed: ${error}`);
    }
  } catch (err) {
    console.warn(`⚠️ Reflection AI failed: ${err.message}`);
    logError('reflection.mjs', err);
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

    const conversation = messages.slice(-MAX_MESSAGES).map(m => `${m.role}: ${m.text}`).join('\n');
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
    console.error('Reflection Engine Error:', err.message);
    logError('reflection.mjs', err);
    process.exit(1);
  }
}

main();
