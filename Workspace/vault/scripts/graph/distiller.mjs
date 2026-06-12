import { logError } from '../core/logger.mjs';
import { callAI } from '../core/ai-client.mjs';
import { parseAIJson } from '../core/json-parser.mjs';
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
const MAX_MESSAGES = 30;
const REQUEST_TIMEOUT_MS = 20_000;


const SYSTEM_PROMPT= 
  `You are an expert Knowledge Engineer. Your job is to capture ANY knowledge from the conversation that could be useful later — including incremental learnings, evolving context, and softer insights, not just major revelations.

Extract knowledge that is:
- NEW: Information not commonly known or specific to this context (tools, configs, workarounds, preferences, project decisions).
- CHANGED: Updates or corrections to previously held assumptions.
- NOTABLE: Even small tips, gotchas, or user preferences that would save time if remembered.

Do NOT extract: pure small talk, greetings, or content with zero informational value.

Categorize into:
1. KNOWLEDGE CLAIM: Insights, decisions, architectural patterns, lessons learned, or gotchas. Filename: MUST start with 'k-' (e.g., 'k-kebab-case-name.md').
2. REFERENCE: Technical facts, API specs, constants, or configuration details. Filename: (e.g., 'ref-kebab-case-name.md').
3. CONTEXT: User preferences, project status, working style, or situational notes. Filename: MUST start with 'ctx-' (e.g., 'ctx-user-prefers-concise-answers.md').

OUTPUT FORMAT (JSON ONLY):
{
  "notes": [
    {
      "filename": "...",
      "content": "# Title\\n\\n## Summary\\n[Brief summary]\\n\\n## Details\\n[Details/facts/context]\\n\\n## Related Concepts\\n- [Concept 1]\\n- [Concept 2]"
    }
  ]
}

RULES:
- Be concise but comprehensive. Capture specifics, not just generalities.
- Include subjective preferences and working decisions — these are knowledge too.
- When in doubt about whether something is worth saving, SAVE IT. Missing knowledge is worse than an extra note.
- Use Markdown for all content.
- Always in english language.
- If truly nothing worth saving (no facts, no decisions, no preferences, no context), return {"notes": []}.
- NO preamble, NO markdown code blocks, NO conversational filler.`;

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



async function extractNotes(conversation) {
  try {
  const content = await callAI([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: conversation },
  ], { temperature: 0.2, timeoutMs: REQUEST_TIMEOUT_MS });

    if (content == null) {
      console.error('⚠️ AI returned empty response (both providers may have failed).');
      return { notes: [] };
    }

    console.error('🔍 AI output received, length:', content?.length ?? 0);

    if (typeof content === 'string') {
      const { data, error } = parseAIJson(content, 'distiller.mjs');
      if (data) {
        console.error('✅ AI extraction successful.');
        return data;
      }
      if (error) {
        console.error(`🚨 JSON parse failed: ${error}`);
      }
    }
  } catch (err) {
    console.error(`⚠️ AI extraction failed: ${err.message}`);
    logError('distiller.mjs', err);
  }

  console.error('🛡️ Graceful Degradation: No knowledge extracted.');
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
        console.error(`🔄 Duplicate skipped: ${filename} ≈ ${ex}`);
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
    console.error('No transcript found.');
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
    console.error('No valid messages to extract.');
    return;
  }

  const conversation = formatConversation(messages);
  const result = await extractNotes(conversation);
  const notes = (result && Array.isArray(result.notes)) ? result.notes : [];
  const count = await writeNotes(notes, transcriptPath);
  
  console.error(`📊 Distillation complete. Total extracted: ${count} notes.`);
  if (count > 0) {
    console.error(`✅ Extracted ${count} notes to vault/00_inbox.`);
  } else {
    console.error(`ℹ️ No new knowledge to save.`);
  }
}

main().catch(err => {
  console.error('Knowledge Distiller Error:', err.message);
  logError('distiller.mjs', err);
  process.exitCode = 1;
});
