import { logError, log } from '../core/logger.mjs';
import { callAIJson, sleep } from '../core/ai-client.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');

// --- CONFIGURATION ---

const LEARNINGS_DIR = path.join(WORKSPACE_ROOT, 'vault', '.system', 'temp_learnings');
const MAX_MESSAGES = 200;
const LESSON_MAX_WORDS = 30;

const VALID_CATEGORIES = [
  'Tone/Style/Format',
  'Tool/System',
  'Preference/Efficiency',
  'Code/Architecture',
  'Workflow/Process',
  'Security/Privacy',
];

const SYSTEM_PROMPT =
  'You are a Behavioral Learning Architect. Extract only behavioral changes from conversations. ' +
  'Output ONLY valid JSON. No markdown, no explanation, no preamble.';

const USER_PROMPT = (transcript) =>
  `Analyze this conversation transcript and extract behavioral deltas—changes in how the agent should operate.

The transcript uses this format:
user: <message>
assistant: <message>

DISTINCTION:
- Knowledge (Ignore): "The capital of France is Paris."
- Behavior (Extract): "Stop using formal greetings; use a direct, technical tone instead."

FOCUS AREAS:
1. CORRECTIONS: Explicit requests to change behavior, tone, style, or formatting.
2. ERRORS: Tool/script failures where a root cause and a fix were identified.
3. INSIGHTS: User preferences or discovered efficiencies.

RULES:
- "lesson" MUST be ≤ ${LESSON_MAX_WORDS} words. Be specific, not verbose.
- "category" MUST be one of: ${VALID_CATEGORIES.join(', ')}.
- Do NOT duplicate the same insight in different categories.
- If nothing relevant is found, output: {"corrections": [], "errors": [], "learnings": []}

Example:
Transcript:
user: Please stop using bullet points, just use numbered lists
assistant: Understood, I'll use numbered lists going forward.

→ {"corrections": [{"category": "Tone/Style/Format", "lesson": "Use numbered lists instead of bullet points when the user requests it."}], "errors": [], "learnings": []}

Transcript:
<<user_content>
${transcript}
</user_content>

Output:`;

function truncateLesson(text) {
  if (!text || typeof text !== 'string') return '';
  const words = text.replace(/[\r\n]+/g, ' ').trim().split(/\s+/);
  if (words.length <= LESSON_MAX_WORDS) return words.join(' ');
  return words.slice(0, LESSON_MAX_WORDS).join(' ');
}

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
        log.warn(`[Collector] Skipping malformed JSON line: ${trimmed.substring(0, 50)}...`);
      }
    }
  }
  return messages;
}

function normalizeCategory(cat) {
  if (!cat || typeof cat !== 'string') return 'Preference/Efficiency';
  if (VALID_CATEGORIES.includes(cat)) return cat;
  // Fuzzy match: find closest valid category
  const lower = cat.toLowerCase();
  const match = VALID_CATEGORIES.find(c => c.toLowerCase() === lower);
  if (match) return match;
  // Fallback: partial match
  for (const valid of VALID_CATEGORIES) {
    if (lower.includes(valid.split('/')[0].toLowerCase())) return valid;
  }
  return 'Preference/Efficiency';
}

async function collectLearnings(conversation) {
  const result = await callAIJson([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT(conversation) },
  ], { temperature: 0, promptLabel: 'learning-collector' });

  if (result.data) {
    // Normalize categories and truncate lessons
    for (const arr of [result.data.corrections, result.data.errors, result.data.learnings]) {
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (entry.category) entry.category = normalizeCategory(entry.category);
        if (entry.lesson) entry.lesson = truncateLesson(entry.lesson);
      }
    }
    log.info(`[Collector] ✅ AI learning collection successful (${result.attempts} attempt(s)).`);
    return result.data;
  }

  log.error(`[Collector] ⚠️ JSON parse failed after ${result.attempts} attempts: ${result.error}`);
  logError('learning-collector.mjs', new Error(result.error));

  log.info('🛡️ Graceful Degradation: Returning clean empty learning schema.');
  return { corrections: [], errors: [], learnings: [] };
}

function saveLearning(category, entries, sessionName) {
  if (entries.length === 0) return;
  if (!fs.existsSync(LEARNINGS_DIR)) fs.mkdirSync(LEARNINGS_DIR, { recursive: true });

  const fileName = category === 'corrections' ? 'corrections.md' :
    category === 'errors' ? 'ERRORS.md' : 'LEARNINGS.md';

  const filePath = path.join(LEARNINGS_DIR, fileName);

  // Load existing entries to prevent duplicates on re-runs
  let existingContent = '';
  try { existingContent = fs.readFileSync(filePath, 'utf8'); } catch {}

  const date = new Date().toISOString().split('T')[0];
  const newLines = [];
  for (const e of entries) {
    const lesson = typeof e === 'object' ? e.lesson : e;
    const cat = typeof e === 'object' ? `[${e.category}]` : '[General]';
    const line = `- [${date}] [Session: ${sessionName}] ${cat} ${lesson}`;
    // Skip if this exact lesson already exists for the same session
    if (existingContent.includes(`[Session: ${sessionName}]`) && existingContent.includes(lesson)) continue;
    newLines.push(line);
  }

  if (newLines.length > 0) {
    fs.appendFileSync(filePath, newLines.join('\n') + '\n', 'utf8');
  }
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
    logError('learning-collector.mjs', new Error('No transcript path provided or found'));
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
