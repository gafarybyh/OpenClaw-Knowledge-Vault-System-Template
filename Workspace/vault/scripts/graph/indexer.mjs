/**
 * GRAPH INDEXER v8 OPTIMAL
 * =========================
 * Compatible dengan semantic-linker v16 (frontmatter exclude hash)
 * 
 * Features:
 * - Hash-based incremental (contentHash = hash(full content))
 * - Backlinks rebuild global
 * - Content preview untuk graph-search
 * - Note type detection
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { globSync } from 'glob';
import crypto from 'crypto';
import { logError, log } from '../core/logger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');
const VAULT_PATH =  path.join(WORKSPACE_ROOT, 'vault');
const OUTPUT_FILE = path.join(VAULT_PATH, '.system/graph/graph.json');
const IS_FULL = process.argv.includes('--full');
const EXCLUDED_FOLDERS = ['behavioral_rules', 'reflections'];

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { metadata: {}, body: content };

  const yamlText = match[1];
  const body = content.substring(match[0].length).trim();
  const metadata = {};

  for (const line of yamlText.split(/\r?\n/)) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > -1) {
      const key = line.substring(0, colonIndex).trim();
      let value = line.substring(colonIndex + 1).trim();

      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.substring(1, value.length - 1)
          .split(',')
          .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
      } else {
        value = value.replace(/^['"]|['"]$/g, '');
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (!isNaN(value) && value !== '') value = Number(value);
      }
      metadata[key] = value;
    }
  }
  return { metadata, body };
}

function hashContent(text) {
  return crypto.createHash('md5')
    .update(text.replace(/\r\n/g, '\n').trimEnd())
    .digest('hex');
}

function inferRelationType(nameA, nameB) {
  const a = nameA.toLowerCase();
  const b = nameB.toLowerCase();

  if (a.startsWith('ref-') && !b.startsWith('ref-')) return 'derived_from';
  if (b.startsWith('ref-') && !a.startsWith('ref-')) return 'derived_from';
  if (a.startsWith('concept-') && b.startsWith('claim-')) return 'supports';
  if (a.startsWith('claim-') && b.startsWith('concept-')) return 'supported_by';
  if (a.startsWith('tool-')) return 'implementation_of';
  if (b.startsWith('tool-')) return 'implemented_by';
  if (a.includes('moc') || a.includes('index')) return 'related_to';
  if (b.includes('moc') || b.includes('index')) return 'related_to';

  return 'related_to';
}

// ⭐ v8: Hybrid typed links parser (sama dengan v7)
function parseTypedLinks(contentWithoutCode, fileName, graphNodes) {
  const typedLinks = [];
  const lines = contentWithoutCode.split('\n');

  const typedRegex = /^-\s+(\w+)::\s*\[\[(.*?)\]\](?:\s*\((.*?)\))?$/;
  const wikiStartRegex = /^-\s*\[\[(.*?)(?:\|.*?)?\]\]\s*\(/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line.startsWith('- ')) { i++; continue; }

    const typedMatch = line.match(typedRegex);
    if (typedMatch) {
      typedLinks.push({
        target: typedMatch[2].split('|')[0],
        type: typedMatch[1],
        reason: typedMatch[3] || '',
        inferred: false
      });
      i++;
      continue;
    }

    const wikiMatch = line.match(wikiStartRegex);
    if (wikiMatch) {
      const target = wikiMatch[1].split('|')[0];
      let reason = line.substring(line.indexOf('(') + 1);
      let j = i + 1;

      while (j < lines.length && !reason.includes(')')) {
        reason += ' ' + lines[j].trim();
        j++;
      }

      reason = reason.replace(/\)$/, '').trim();

      if (!graphNodes[target]) {
        i = j || i + 1;
        continue;
      }

      if (typedLinks.some(t => t.target === target)) {
        i = j || i + 1;
        continue;
      }

      const inferredType = inferRelationType(fileName, target);
      typedLinks.push({
        target,
        type: inferredType || 'related_to',
        reason,
        inferred: true
      });

      i = j || i + 1;
      continue;
    }

    i++;
  }

  return typedLinks;
}

(async () => {
  const t0 = Date.now();

  try {
    let files;
    try {
      const allFiles = globSync(`${VAULT_PATH}/**/*.md`);
      files = allFiles.filter(f => !EXCLUDED_FOLDERS.some(folder => f.includes(folder)));
    } catch (e) {
      logError('indexer.mjs', e);
      log.error(`[Indexer] ❌ Glob failed: ${e.message}`);
      process.exit(1);
    }

    // Load existing graph untuk incremental merge
    let existingGraph = { metadata: { version: 8, lastIndexed: new Date().toISOString(), totalFiles: 0 }, nodes: {} };
    let filesToProcess = files;
    let isIncremental = false;

    if (!IS_FULL && fs.existsSync(OUTPUT_FILE)) {
      try {
        existingGraph = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
        // Validate loaded graph has expected structure
        if (!existingGraph.nodes || typeof existingGraph.nodes !== 'object') {
          existingGraph = { metadata: { version: 8, lastIndexed: new Date().toISOString(), totalFiles: 0 }, nodes: {} };
        }
        const changed = [];
        
        for (const file of files) {
          const fileName = path.basename(file, '.md');
          let content;
          try {
            content = fs.readFileSync(file, 'utf8');
          } catch (e) {
            continue; // Skip unreadable files
          }
          const hash = hashContent(content);
          const existing = existingGraph.nodes[fileName];
          
          if (!existing || existing.contentHash !== hash) {
            changed.push(file);
          }
        }
        
        if (changed.length > 0 && changed.length < files.length) {
          filesToProcess = changed;
          isIncremental = true;
          log.info(`[Indexer] ℹ️ Incremental mode: ${changed.length}/${files.length} files changed`);
        }
      } catch {
        existingGraph = { metadata: { version: 8, lastIndexed: new Date().toISOString(), totalFiles: 0 }, nodes: {} };
      }
    }

    // Fase 1: Inisialisasi / Update Node untuk file yang berubah
    for (const file of filesToProcess) {
      try {
      const fileName = path.basename(file, '.md');
      const stats = fs.statSync(file);
      existingGraph.nodes[fileName] = {
        path: file,
        updatedAt: stats.mtime.toISOString(),
        links: [],
        backlinks: [],
        typedLinks: [],
        metadata: {},
        wordCount: 0,
        linkCount: 0,
        contentHash: '',
        contentPreview: ''
      };
      } catch (e) {
        logError('indexer.mjs', e);
        log.error(`[Indexer] ⚠️ Cannot stat ${file}: ${e.message}`);
      }
    }

    // Fase 2: Parse file yang berubah
    await Promise.all(filesToProcess.map(async (file) => {
      try {
      const content = await fs.promises.readFile(file, 'utf-8');
      const { metadata, body } = parseFrontmatter(content);

      const contentWithoutCode = body.replace(/```[\s\S]*?```/g, '');
      const fileName = path.basename(file, '.md');

      // ⭐ Content preview untuk Graph Search
      const preview = body
        .replace(/```[\s\S]*?```/g, '')
        .replace(/#+\s+/g, '')
        .replace(/\[\[(.*?)\]\]/g, '$1')
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .trim()
        .substring(0, 400);

      const node = existingGraph.nodes[fileName];
      node.metadata = metadata;
      node.wordCount = body.split(/\s+/).filter(w => w.length > 0).length;
      node.contentHash = hashContent(content);
      node.contentPreview = preview;

      // Parse wiki links
      const allWikiLinks = [...contentWithoutCode.matchAll(/\[\[(.*?)\]\]/g)];
      node.linkCount = allWikiLinks.length;
      node.links = [];

      for (const match of allWikiLinks) {
        const linkTarget = match[1].split('|')[0];
        if (existingGraph.nodes[linkTarget]) {
          if (!node.links.includes(linkTarget)) {
            node.links.push(linkTarget);
          }
        }
      }

      // Typed links
      const typedLinks = parseTypedLinks(contentWithoutCode, fileName, existingGraph.nodes);
      node.typedLinks = typedLinks;

      // Ensure typed targets in links array
      for (const t of typedLinks) {
        if (!node.links.includes(t.target)) node.links.push(t.target);
      }
      } catch (err) {
        logError('indexer.mjs', err);
        log.error(`[Indexer] ⚠️ Failed to parse ${file}: ${err.message}`);
        // Remove broken node if it was just initialized
        const fileName = path.basename(file, '.md');
        if (existingGraph.nodes[fileName]?.contentHash === '') {
          delete existingGraph.nodes[fileName];
        }
      }
    }));

    // ⭐ Fase 2.5: Rebuild backlinks untuk SELURUH graph
    // (karena file baru bisa link ke file lama, backlinks file lama harus di-update)
    for (const [name, data] of Object.entries(existingGraph.nodes)) {
      data.backlinks = [];
    }
    
    for (const [name, data] of Object.entries(existingGraph.nodes)) {
      for (const link of (data.links || [])) {
        if (existingGraph.nodes[link] && !existingGraph.nodes[link].backlinks.includes(name)) {
          existingGraph.nodes[link].backlinks.push(name);
        }
      }
      for (const t of (data.typedLinks || [])) {
        if (existingGraph.nodes[t.target] && !existingGraph.nodes[t.target].backlinks.includes(name)) {
          existingGraph.nodes[t.target].backlinks.push(name);
        }
      }
    }

    // Fase 3: Hitung degree & deteksi note type untuk SEMUA node
    for (const [name, data] of Object.entries(existingGraph.nodes)) {
      const degree = (data.links?.length || 0) + 
                     (data.backlinks?.length || 0) + 
                     (data.typedLinks?.length || 0);
      data.degree = degree;

      const lower = name.toLowerCase();
      if (lower.includes('moc') || lower.includes('index') || lower.includes('dashboard')) {
        data.noteType = 'MOC';
      } else if (degree > 25) {
        data.noteType = 'hub';
      } else if (data.wordCount < 300 && degree > 3) {
        data.noteType = 'stub';
      } else if (lower.startsWith('ref-')) {
        data.noteType = 'reference';
      } else if (lower.startsWith('concept-')) {
        data.noteType = 'concept';
      } else if (lower.startsWith('claim-')) {
        data.noteType = 'claim';
      } else if (lower.startsWith('tool-')) {
        data.noteType = 'tool';
      } else {
        data.noteType = 'atomic';
      }
    }

    // Fase 4: Atomic Write
    existingGraph.metadata = {
      version: 8,
      lastIndexed: new Date().toISOString(),
      totalFiles: Object.keys(existingGraph.nodes).length,
      mode: isIncremental ? 'incremental' : 'full'
    };

    const tmpFile = OUTPUT_FILE + '.tmp.' + Date.now();
    await fs.promises.writeFile(tmpFile, JSON.stringify(existingGraph, null, 2));
    fs.renameSync(tmpFile, OUTPUT_FILE);

    // Summary
    const totalTyped = Object.values(existingGraph.nodes).reduce((sum, n) => sum + (n.typedLinks?.length || 0), 0);
    const totalInferred = Object.values(existingGraph.nodes).reduce((sum, n) =>
      sum + (n.typedLinks?.filter(t => t.inferred)?.length || 0), 0);
    const totalAI = totalTyped - totalInferred;
    const durationMs = Date.now() - t0;

    log.success(`[Indexer] ✅ Graph index written to ${path.basename(OUTPUT_FILE)}`);
    log.info(`[Indexer] Mode: ${isIncremental ? 'incremental' : 'full'} | Nodes: ${Object.keys(existingGraph.nodes).length} | Duration: ${durationMs}ms`);
    log.info(`[Indexer] Typed links: ${totalTyped} (AI: ${totalAI}, Inferred: ${totalInferred})`);

  } catch (err) {
    logError('indexer.mjs', err);
    log.error(`[Indexer] ❌ ${err.message}`);
    process.exit(1);
  }
})();
