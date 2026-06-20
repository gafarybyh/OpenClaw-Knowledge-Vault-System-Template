import { logError, log } from '../core/logger.mjs';
import { callAIJson, sleep } from '../core/ai-client.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');

const VAULT_PATH = path.join(WORKSPACE_ROOT, 'vault');
const STATE_PATH = path.join(VAULT_PATH, '.system/state/.vault_state.json');
const INBOX_PATH = path.join(WORKSPACE_ROOT, 'vault', '00_inbox');
const KNOWLEDGE_PATH = path.join(VAULT_PATH, '01_thinking', 'knowledge');
const MAX_MESSAGES = 200;
const AI_MAX_RETRIES = 3;
const AI_RETRY_DELAY_MS = 2000;

const SYSTEM_PROMPT =
  'You are an expert Knowledge Engineer. Capture ANY knowledge from conversations that could be useful later — including incremental learnings, evolving context, and softer insights. ' +
  'Output ONLY valid JSON. No markdown, no explanation, no preamble.';

const USER_PROMPT = (conversation) =>
  `Analyze this conversation and extract knowledge.

Extract knowledge that is:
- NEW: Information not commonly known or specific to this context (tools, configs, workarounds, preferences, project decisions).
- CHANGED: Updates or corrections to previously held assumptions.
- NOTABLE: Even small tips, gotchas, or user preferences that would save time if remembered.

Do NOT extract: pure small talk, greetings, or content with zero informational value.

Categorize into:
1. KNOWLEDGE CLAIM: Insights, decisions, architectural patterns, lessons learned. Filename: MUST start with 'k-' (e.g., 'k-kebab-case-name.md').
2. REFERENCE: Technical facts, API specs, constants, configuration. Filename: 'ref-kebab-case-name.md'.
3. CONTEXT: User preferences, project status, working style. Filename: MUST start with 'ctx-' (e.g., 'ctx-user-prefers-concise-answers.md').

RULES:
- Filename MUST be kebab-case, start with correct prefix, end with .md.
- Content MUST use Markdown with sections: # Title, ## Summary, ## Details, ## Related Concepts.
- Be concise but comprehensive. Capture specifics, not just generalities.
- Include subjective preferences and working decisions — these are knowledge too.
- When in doubt, SAVE IT. Missing knowledge is worse than an extra note.
- Always in English language.
- Max 10 notes per extraction.
- If nothing worth saving, return: {"notes": []}

Example:
→ {"notes": [{"filename": "k-react-hooks-optimize-performance.md", "content": "# React Hooks Optimize Performance\\n\\n## Summary\\nReact hooks reduce re-renders through memoization.\\n\\n## Details\\nUse useMemo and useCallback to stabilize references.\\n\\n## Related Concepts\\n- Component lifecycle\\n- Rendering optimization"}]}

Conversation:
<<user_content>
${conversation}
</user_content>

Output:`;

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
      if (!text) continue;
      messages.push({ role, text });
    } catch (e) {
      // Skip malformed lines
    }
  }
  return messages;
}

function formatConversation(messages) {
  return messages
    .slice(-MAX_MESSAGES)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n');
}

function sanitizeFilename(filename) {
  const base = filename
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'note'}.md`;
}

function validateNotes(data) {
  if (!data || typeof data !== 'object') return { notes: [] };
  if (!Array.isArray(data.notes)) return { notes: [] };
  return {
    notes: data.notes
      .filter(n => n && typeof n.filename === 'string' && typeof n.content === 'string')
      .slice(0, 10)
  };
}

async function extractNotes(conversation) {
  const { data, error, attempts } = await callAIJson([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT(conversation) },
  ], { 
    temperature: 0.2, 
    maxRetries: AI_MAX_RETRIES, 
    retryDelayMs: AI_RETRY_DELAY_MS, 
    promptLabel: 'distiller.mjs' 
  });

  if (data) {
    log.success(`[Distiller] ✅ AI extraction successful (${attempts} attempt(s)).`);
    return validateNotes(data);
  }

  if (error) {
    log.warn(`[Distiller] ⚠️ AI extraction failed after ${attempts} attempts: ${error}`);
    logError('distiller.mjs', new Error(error));
  }

  log.info('[Distiller] 🛡️ Graceful Degradation: No knowledge extracted.');
  return { notes: [] };
}

function filenameSimilarity(a, b) {
  const tokA = new Set(a.toLowerCase().replace(/\.md$/, '').split(/[-_\s]+/).filter(w => w.length > 2));
  const tokB = new Set(b.toLowerCase().replace(/\.md$/, '').split(/[-_\s]+/).filter(w => w.length > 2));
  if (tokA.size === 0 || tokB.size === 0) return 0;
  const inter = [...tokA].filter(x => tokB.has(x)).length;
  return inter / Math.min(tokA.size, tokB.size);
}

function generateFrontmatter(note, transcriptPath) {
  const topics = note.content
    .split(/\s+/)
    .filter(w => w.length > 4 && /^[a-zA-Z]/.test(w))
    .slice(0, 5)
    .join(', ');
  const type = note.filename.startsWith('ref-') ? 'reference' : note.filename.startsWith('ctx-') ? 'context' : 'claim';
  return `---
source: ${path.basename(transcriptPath)}
extractedAt: ${new Date().toISOString()}
type: ${type}
topics: [${topics}]
---

`;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { version: 1, stagedFiles: [], sessions: [] }; }
}

function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function writeNotes(notes, transcriptPath) {
  if (!fs.existsSync(INBOX_PATH)) fs.mkdirSync(INBOX_PATH, { recursive: true });

  const state = loadState();
  const existingNames = new Set([
    ...fs.readdirSync(VAULT_PATH, { recursive: true }),
    ...(fs.existsSync(KNOWLEDGE_PATH) ? fs.readdirSync(KNOWLEDGE_PATH, { recursive: true }) : [])
  ]
    .filter(f => f.endsWith('.md'))
    .map(f => path.basename(f, '.md'))
  );

  const saved = [];
  for (const note of notes ?? []) {
    if (typeof note?.filename !== 'string' || typeof note.content !== 'string') continue;

    const filename = sanitizeFilename(note.filename);

    let dup = false;
    for (const ex of existingNames) {
      if (filenameSimilarity(ex, filename) > 0.85) {
        log.info(`[Distiller] 🔄 Duplicate skipped: ${filename} ≈ ${ex}`);
        dup = true; break;
      }
    }
    if (dup) continue;
    if (fs.existsSync(path.join(INBOX_PATH, filename))) continue;

    const finalContent = generateFrontmatter(note, transcriptPath) + note.content;
    await fs.promises.writeFile(path.join(INBOX_PATH, filename), finalContent, 'utf8');
    saved.push(filename);
    existingNames.add(filename);
  }

  state.stagedFiles = [...new Set([...(state.stagedFiles || []), ...saved])];
  state.sessions = state.sessions || [];
  state.sessions.unshift({
    id: path.basename(transcriptPath, path.extname(transcriptPath)),
    timestamp: new Date().toISOString(),
    extracted: saved.length
  });
  if (state.sessions.length > 10) state.sessions = state.sessions.slice(0, 10);
  saveState(state);

  return saved.length;
}

async function main() {
  let transcriptPath = process.argv[2];

  if (transcriptPath && !fs.existsSync(transcriptPath)) {
    const sessionDir = path.dirname(transcriptPath);
    const baseName = path.basename(transcriptPath);
    if (fs.existsSync(sessionDir)) {
      const relatedFiles = fs.readdirSync(sessionDir)
        .filter(f => f.startsWith(baseName))
        .map(f => ({ path: path.join(sessionDir, f), mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (relatedFiles.length > 0) transcriptPath = relatedFiles[0].path;
    }
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    const memoryDir = path.join(WORKSPACE_ROOT, 'memory');
    if (fs.existsSync(memoryDir)) {
      const files = fs.readdirSync(memoryDir)
        .filter(f => f.endsWith('.md'))
        .map(f => ({ path: path.join(memoryDir, f), mtime: fs.statSync(path.join(memoryDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) transcriptPath = files[0].path;
    }
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log.error('[Distiller] ❌ No transcript found.');
    process.exitCode = 1;
    return;
  }

  let messages = parseTranscript(transcriptPath);
  if (messages.length === 0) {
    const sessionDir = path.dirname(transcriptPath);
    if (fs.existsSync(sessionDir)) {
      const files = fs.readdirSync(sessionDir)
        .filter(f => f.endsWith('.jsonl') && f !== path.basename(transcriptPath))
        .map(f => ({ path: path.join(sessionDir, f), mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        messages = parseTranscript(files[0].path);
        transcriptPath = files[0].path;
      }
    }
  }

  if (messages.length === 0) {
    log.warn('[Distiller] No valid messages to extract.');
    return;
  }

  const conversation = formatConversation(messages);
  const result = await extractNotes(conversation);
  const notes = (result && Array.isArray(result.notes)) ? result.notes : [];
  const count = await writeNotes(notes, transcriptPath);

  log.info(`[Distiller] 📊 Distillation complete. Extracted: ${count} notes.`);
  if (count > 0) {
    log.success(`[Distiller] ✅ Extracted ${count} notes to vault/00_inbox.`);
  } else {
    log.info('[Distiller] ℹ️ No new knowledge to save.');
  }
}

main().catch(err => {
  log.error(`[Distiller] ❌ Knowledge Distiller Error: ${err.message}`);
  logError('distiller.mjs', err);
  process.exitCode = 1;
});
