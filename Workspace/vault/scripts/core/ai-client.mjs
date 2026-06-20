import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError, log } from './logger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');

/**
 * Load environment variables from .env file
 */
export function loadEnv() {
  try {
    const envPath = path.join(WORKSPACE_ROOT, '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').trim();
          if (!process.env[key.trim()]) process.env[key.trim()] = value;
        }
      }
    }
  } catch (e) {
    logError('ai-client.mjs', e);
  }
}

// Initialize env on load
loadEnv();

// Configuration from Env
export const AI_CONFIG = {
  requestDelay: parseInt(process.env.AI_REQUEST_DELAY) || 1000, // Jeda antar request dalam ms
  embedding: {
    url: process.env.EMBEDDING_URL || 'http://localhost:11434/api/embed',
    model: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
    key: process.env.EMBEDDING_KEY || '',
  },
  primary: {
    url: process.env.PRIMARY_AI_URL || 'https://api.cerebras.ai/v1/chat/completions',
    model: process.env.PRIMARY_AI_MODEL || 'gpt-oss-120b',
    key: process.env.PRIMARY_AI_KEY || '',
  },
  fallback: {
    url: process.env.FALLBACK_AI_URL || 'https://generativelanguage.googleapis.com/v1beta/chat/completions',
    model: process.env.FALLBACK_AI_MODEL || 'gemini-2.5-flash',
    key: process.env.FALLBACK_AI_KEY || '',
  }
};

/**
 * Generate embedding vector for a given text
 * @param {string} text 
 * @returns {Promise<number[]>}
 */
export async function getEmbedding(text) {
  const { url, model, key } = AI_CONFIG.embedding;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        ...(key && { 'Authorization': `Bearer ${key}` })
      },
      body: JSON.stringify({ model, input: text })
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    // Handle different API response formats (Ollama vs others)
    // Ollama often returns 'embeddings' as an array of arrays
    return data.embedding || data.embeddings?.[0] || data.data?.[0]?.embedding;
  } catch (e) {
    logError('ai-client.mjs', e);
    throw e;
  }
}

/**
 * Utility untuk memberikan jeda waktu (throttling)
 * @param {number} ms - Milidetik untuk menunggu
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call AI with automatic fallback mechanism
 * @param {Array} messages - Array of {role, content}
 * @param {Object} options - Optional overrides (model, temperature, etc)
 * @returns {Promise<string>}
 */
export async function callAI(messages, options = {}) {
  const { primary, fallback } = AI_CONFIG;

  const timeoutMs = options.timeoutMs || 50000;

  // Build request body — inject response_format for JSON-mode providers
  const buildBody = (model) => {
    const body = {
      model: model,
      messages: messages,
      temperature: options.temperature ?? 0.3,
      ...options.extraParams,
    };
    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    return body;
  };

  // 1. Try Primary AI
  try {
    const response = await fetch(primary.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${primary.key}`
      },
      body: JSON.stringify(buildBody(options.model || primary.model)),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logError('ai-client.mjs', new Error(`Primary AI HTTP ${response.status}: ${errorText}`));
      throw new Error(`Primary AI error: ${response.status}`);
    }
    
    const data = await response.json();
    log.debug('[AI] 🔄 Primary AI responded OK.');
    return data.choices?.[0]?.message?.content || data.content;
  } catch (e) {
    logError('ai-client.mjs', new Error(`Primary AI failed: ${e.message}. Switching to fallback...`));
  }

  // 2. Try Fallback AI
  try {
    const isGemini = fallback.url.includes('gemini');
    const finalUrl = isGemini ? `${fallback.url}?key=${fallback.key}` : fallback.url;
    
    const response = await fetch(finalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(!isGemini && { 'Authorization': `Bearer ${fallback.key}` })
      },
      body: JSON.stringify(buildBody(options.model || fallback.model)),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logError('ai-client.mjs', new Error(`Fallback AI HTTP ${response.status}: ${errorText}`));
      throw new Error(`Fallback AI error: ${response.status}`);
    }
    
    const data = await response.json();
    log.debug('[AI] 🔄 Fallback AI responded OK.');
    return data.choices?.[0]?.message?.content || data.content;
  } catch (e) {
    logError('ai-client.mjs', new Error(`All AI providers failed: ${e.message}`));
    // throw new Error(`All AI providers failed. Last error: ${e.message}`);
  }
}

/**
 * Call AI and parse the response as JSON, with auto-retry on parse failure.
 * Handles markdown wrappers, invalid escapes, trailing commas, etc.
 *
 * @param {Array} messages - Chat messages
 * @param {Object} options - callAI options + { maxRetries, retryDelayMs, promptLabel }
 * @returns {Promise<{ data: object|null, error: string|null, attempts: number }>}
 */
export async function callAIJson(messages, options = {}) {
  const { parseAIJson } = await import('./json-parser.mjs');
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1500;
  const label = options.promptLabel || 'callAIJson';

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Always request jsonMode if the provider supports it
      const content = await callAI(messages, { ...options, jsonMode: true });

      if (!content) {
        lastError = 'Empty AI response';
        log.warn(`[${label}] Attempt ${attempt}: empty response`);
        if (attempt < maxRetries) await sleep(retryDelayMs * attempt);
        continue;
      }

      const { data, error } = parseAIJson(content, label);

      if (data) {
        if (attempt > 1) log.info(`[${label}] ✅ JSON parsed on attempt ${attempt}`);
        return { data, error: null, attempts: attempt };
      }

      lastError = error;
      log.warn(`[${label}] Attempt ${attempt}/${maxRetries} parse failed: ${error}`);

      // On retry, append a correction hint to the last user message
      if (attempt < maxRetries) {
        const correctedMessages = [...messages];
        const lastUserIdx = correctedMessages.findLastIndex(m => m.role === 'user');
        if (lastUserIdx !== -1) {
          correctedMessages[lastUserIdx] = {
            ...correctedMessages[lastUserIdx],
            content: correctedMessages[lastUserIdx].content +
              '\n\nIMPORTANT: Your previous response contained invalid JSON. ' +
              'Output ONLY valid JSON. No markdown wrappers, no backtick code blocks, ' +
              'no trailing commas, no unescaped control characters. Just raw JSON.'
          };
        }
        messages = correctedMessages;
        await sleep(retryDelayMs * attempt);
      }
    } catch (err) {
      lastError = err.message;
      log.warn(`[${label}] Attempt ${attempt}/${maxRetries} exception: ${err.message}`);
      if (attempt < maxRetries) await sleep(retryDelayMs * attempt);
    }
  }

  return { data: null, error: lastError, attempts: maxRetries };
}
