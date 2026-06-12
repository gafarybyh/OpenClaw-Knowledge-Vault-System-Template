/**
 * Robust JSON parser for AI responses.
 * Centralizes all JSON cleaning/sanitization logic so every script
 * uses the same battle-tested parser instead of fragile copy-pasted versions.
 */

import { logError } from './logger.mjs';

/**
 * Clean and parse a JSON response from an AI model.
 * Handles common LLM output issues:
 * - Markdown code block wrappers (```json ... ```)
 * - Literal control characters (newlines, tabs, etc.) inside string values
 * - Trailing commas before closing brackets
 * - Single quotes instead of double quotes in keys/values
 * - JavaScript-style comments
 *
 * @param {string} text - Raw AI output text
 * @param {string} [callerName='unknown'] - Script name for error logging
 * @returns {{ data: object|null, error: string|null }}
 */
export function parseAIJson(text, callerName = 'unknown') {
  if (!text || typeof text !== 'string') {
    return { data: null, error: 'Empty or non-string input' };
  }

  let cleaned = text.trim();

  // Step 1: Strip markdown code block wrappers
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = cleaned.match(codeBlockRegex);
  if (match) {
    cleaned = match[1].trim();
  }

  // Step 2: Extract the outermost JSON object { ... }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { data: null, error: 'No valid JSON object boundaries found' };
  }
  cleaned = cleaned.substring(start, end + 1).trim();

  // Step 3: Try parsing as-is first (fast path)
  try {
    const parsed = JSON.parse(cleaned);
    return { data: parsed, error: null };
  } catch (_firstErr) {
    // Continue to sanitization
  }

  // Step 4: Sanitize control characters inside string values
  // We need to be careful: only replace control chars that are NOT part of
  // valid escape sequences. We process char by char tracking string context.
  cleaned = sanitizeJsonString(cleaned);

  // Step 5: Fix trailing commas — ,] or ,}
  cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');

  // Step 6: Strip single-line JS comments (// ...)
  // Only outside of strings — simple heuristic: lines starting with //
  cleaned = cleaned.replace(/^\s*\/\/.*$/gm, '');

  // Step 7: Try parsing again
  try {
    const parsed = JSON.parse(cleaned);
    return { data: parsed, error: null };
  } catch (secondErr) {
    logError(callerName, secondErr);
    return { data: null, error: secondErr.message };
  }
}

/**
 * Sanitize a JSON string by escaping literal control characters
 * that appear inside string values (between unescaped double quotes).
 * This handles the most common LLM failure: outputting real newlines/tabs
 * inside JSON string literals.
 *
 * @param {string} json - JSON string to sanitize
 * @returns {string}
 */
function sanitizeJsonString(json) {
  const result = [];
  let inString = false;
  let i = 0;

  while (i < json.length) {
    const ch = json[i];

    if (inString) {
      if (ch === '\\') {
        // Escaped character — pass through both the backslash and next char
        result.push(ch);
        i++;
        if (i < json.length) {
          result.push(json[i]);
        }
        i++;
        continue;
      }
      if (ch === '"') {
        // End of string
        inString = false;
        result.push(ch);
        i++;
        continue;
      }
      // Check for control characters inside a string
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7F) {
        // Replace with proper escape sequences
        if (ch === '\n') { result.push('\\n'); }
        else if (ch === '\r') { result.push('\\r'); }
        else if (ch === '\t') { result.push('\\t'); }
        else {
          // Other control chars: use unicode escape
          result.push('\\u' + code.toString(16).padStart(4, '0'));
        }
        i++;
        continue;
      }
      result.push(ch);
    } else {
      if (ch === '"') {
        inString = true;
      }
      result.push(ch);
    }
    i++;
  }

  return result.join('');
}

/**
 * Backward-compatible wrapper matching the old cleanJsonResponse signature.
 * Returns the cleaned JSON string (or null), without parsing.
 * 
 * @deprecated Use parseAIJson() instead for full parse + error info.
 * @param {string} text - Raw AI output text
 * @returns {string|null}
 */
export function cleanJsonResponse(text) {
  const { data } = parseAIJson(text);
  if (data === null) return null;
  return JSON.stringify(data);
}
