import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError } from './logger.mjs';

// Maximum number of retries for failed requests
const MAX_RETRIES = 3;
// Base delay for exponential backoff in milliseconds
const BASE_RETRY_DELAY = 1000;

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
      content.split(/\r?\n/).forEach(line => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').trim();
          if (!process.env[key.trim()]) process.env[key.trim()] = value;
        }
      });
    }
  } catch (e) {
    logError('ai-client', 'Failed to load .env file: ' + e.message);
  }
}

// Initialize env on load
loadEnv();

// Configuration from Env
export const AI_CONFIG = {
  requestDelay: parseInt(process.env.AI_REQUEST_DELAY) || 200, // Jeda antar request dalam ms
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
    const response = await fetchWithRetry(url, {
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
    const result = data.embedding || data.embeddings?.[0] || data.data?.[0]?.embedding;
    
    // Apply request delay after successful call
    await sleep(AI_CONFIG.requestDelay);
    return result;
  } catch (e) {
    logError('ai-client', `Embedding failed: ${e.message}`);
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
 * Execute a fetch request with retry logic for rate limiting and service unavailability
 * @param {string} url - API endpoint
 * @param {Object} options - Fetch options
 * @param {number} retryCount - Current retry count
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, retryCount = 0) {
  try {
    const response = await fetch(url, options);
    
    // If we get a rate limit or service unavailable error, retry with exponential backoff
    if (response.status === 429 || response.status === 503) {
      if (retryCount < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY * Math.pow(2, retryCount);
        logError('ai-client', `Rate limited or service unavailable (${response.status}). Retrying in ${delay}ms... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        return fetchWithRetry(url, options, retryCount + 1);
      } else {
        throw new Error(`Max retries (${MAX_RETRIES}) exceeded for ${url}. Status: ${response.status}`);
      }
    }
    
    return response;
  } catch (error) {
    // For network errors, also implement retry logic
    if (retryCount < MAX_RETRIES) {
      const delay = BASE_RETRY_DELAY * Math.pow(2, retryCount);
      logError('ai-client', `Network error: ${error.message}. Retrying in ${delay}ms... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return fetchWithRetry(url, options, retryCount + 1);
    }
    throw error;
  }
}

/**
 * Call AI with automatic fallback mechanism
 * @param {Array} messages - Array of {role, content}
 * @param {Object} options - Optional overrides (model, temperature, etc)
 * @returns {Promise<string>}
 */
export async function callAI(messages, options = {}) {
  const { primary, fallback } = AI_CONFIG;
  let result = null;

  // Helper function to execute AI call with retry and delay
  async function executeAICall(config, isPrimary = true) {
    try {
      const { url, model, key } = config;
      const isGemini = url.includes('gemini');
      const finalUrl = isGemini ? `${url}?key=${key}` : url;
      
      const headers = {
        'Content-Type': 'application/json',
        ...(!isGemini && { 'Authorization': `Bearer ${key}` })
      };
      
      const response = await fetchWithRetry(finalUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: options.model || model,
          messages: messages,
          temperature: options.temperature ?? 0.3,
          ...options.extraParams
        })
      });

      if (!response.ok) {
        throw new Error(`${isPrimary ? 'Primary' : 'Fallback'} AI error: ${response.status}`);
      }
      
      const data = await response.json();
      result = data.choices?.[0]?.message?.content || data.content;
      
      // Apply request delay after successful call
      await sleep(AI_CONFIG.requestDelay);
      return result;
    } catch (e) {
      logError('ai-client', `${isPrimary ? 'Primary' : 'Fallback'} AI failed: ${e.message}${isPrimary ? '. Switching to fallback...' : ''}`);
      throw e;
    }
  }

  // 1. Try Primary AI
  try {
    return await executeAICall(primary, true);
  } catch (e) {
    // Primary failed, continue to fallback
  }

  // 2. Try Fallback AI
  try {
    return await executeAICall(fallback, false);
  } catch (e) {
    logError('ai-client', `Fallback AI also failed: ${e.message}. All AI providers are unavailable...`);
    // Return null instead of throwing to maintain existing behavior
    return null;
  }
}
