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

const LEARNINGS_DIR = path.join(WORKSPACE_ROOT, 'vault', '.system', 'temp_learnings');
const MAX_MESSAGES = 50;
const REQUEST_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `You are a Behavioral Learning Architect. Your goal is to extract "Behavioral Deltas" from a conversation—specifically, changes in how the agent should operate, interact, or solve problems.

DISTINCTION:
- Knowledge (Ignore): "The capital of France is Paris."
- Behavior (Extract): "Stop using formal greetings; use a direct, technical tone instead."

FOCUS AREAS:
1. CORRECTIONS: Explicit requests to change behavior, tone, style, or formatting. (e.g., "Don't use markdown tables here, use a list").
2. ERRORS: Tool/script failures where a root cause and a fix were identified. (e.g., "The rtk command failed because of X, fixed by doing Y").
3. INSIGHTS: User preferences or discovered efficiencies. (e.g., "The user prefers summaries at the top of the response").

CRITICAL OUTPUT REQUIREMENTS:
- Output ONLY a single, valid JSON object.
- NO preamble, NO markdown code blocks, NO explanations.
- If nothing is found, output: {"corrections": [], "errors": [], "learnings": []}

Expected Format:
{
  "corrections": [{"category": "Tone/Style/Format", "lesson": "The actual behavioral change"}],
  "errors": [{"category": "Tool/System", "lesson": "The error and its resolution"}],
  "learnings": [{"category": "Preference/Efficiency", "lesson": "The discovered insight"}]
}`;

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
    } catch (e) {
      // Only log if it looks like it should have been JSON
      if (trimmed.startsWith('{')) {
        console.warn(`[Collector] Skipping malformed JSON line: ${trimmed.substring(0, 50)}...`);
      }
    }
  }
  return messages;
}

async function collectLearnings(conversation) {
  try {
    const content = await callAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: conversation },
    ], { temperature: 0 });

    if (content) {
      const { data, error } = parseAIJson(content, 'learning-collector.mjs');
      if (data) {
        log.info('[Collector] ✅ AI learning collection successful.');
        return data;
      }
      if (error) log.error(`[Collector] ⚠️ JSON parse failed: ${error}`);
    }
  } catch (err) {
    log.error(`[Collector] ⚠️ AI learning collection failed: ${err.message}`);
    logError('learnings-collector.mjs', err);
  }

  log.info('🛡️ Graceful Degradation: Returning clean empty learning schema.');
  return { corrections: [], errors: [], learnings: [] };
}

function saveLearning(category, entries, sessionName) {
  if (entries.length === 0) return;
  if (!fs.existsSync(LEARNINGS_DIR)) fs.mkdirSync(LEARNINGS_DIR, { recursive: true });

  const fileName = category === 'corrections' ? 'corrections.md' :
    category === 'errors' ? 'ERRORS.md' : 'LEARNINGS.md';

  const date = new Date().toISOString().split('T')[0];
  const formattedEntries = entries.map(e => {
    const lesson = typeof e === 'object' ? e.lesson : e;
    const cat = typeof e === 'object' ? `[${e.category}]` : '[General]';
    return `- [${date}] [Session: ${sessionName}] ${cat} ${lesson}`;
  }).join('\n');

  fs.appendFileSync(path.join(LEARNINGS_DIR, fileName), formattedEntries + '\n', 'utf8');
}

async function main() {
  let transcriptPath = process.argv[2];

  // Fallback: If no path is provided or the path doesn't exist, search for the most recent session
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
    log.error('[Collector] ❌ No transcript path provided or found.');
    logError('learnings-collector.mjs', new Error('No transcript path provided or found'));
    process.exit(1);
  }

  try {
    const messages = parseTranscript(transcriptPath);
    if (messages.length === 0) return;

    const conversation = messages.slice(-MAX_MESSAGES).map(m => `${m.role}: ${m.text}`).join('\n');
    const result = await collectLearnings(conversation);

    const sessionName = path.basename(transcriptPath);
    saveLearning('corrections', result.corrections, sessionName);
    saveLearning('errors', result.errors, sessionName);
    saveLearning('learnings', result.learnings, sessionName);

    log.info(`[Collector] ✅ Learning collection complete. Saved entries to ${LEARNINGS_DIR}`);
  } catch (err) {
    log.error(`[Collector] ❌ Critical Error: ${err.message}`);
    logError('learning-collector.mjs', err);
    process.exit(1);
  }
}

main();
