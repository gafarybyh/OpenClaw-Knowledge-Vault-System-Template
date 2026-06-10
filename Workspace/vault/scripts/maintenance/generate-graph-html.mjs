import { log } from '../core/logger.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GRAPH_PATH = path.join(__dirname, '..', '..', '.system', 'graph', 'graph.json');
const OUTPUT_PATH = path.join(__dirname, '..', '..', '06_system', 'graph_view.html');

const folderColors = {
  '00_inbox': { bg: '#FF6B6B', border: '#FF8787', label: 'Inbox' },
  '01_thinking': { bg: '#4D96FF', border: '#74B3FF', label: 'Thinking' },
  '02_reference': { bg: '#2ED573', border: '#6EE7A8', label: 'Reference' },
  '03_creating': { bg: '#FFD166', border: '#FFE08A', label: 'Creating' },
  '04_published': { bg: '#BFC5D2', border: '#D6DAE3', label: 'Published' },
  '05_archive': { bg: '#FF9F1C', border: '#FFBE5C', label: 'Archive' },
  '06_system': { bg: '#5BC0EB', border: '#8EDAF7', label: 'System' },
  'default': { bg: '#AAB2C0', border: '#CDD3DD', label: 'Uncategorized' }
};

function detectFolder(filePath = '') {
  for (const folder of Object.keys(folderColors)) {
    if (folder !== 'default' && filePath.includes(folder)) return folder;
  }
  return 'default';
}

function generateGraphHtml() {
  log.step('🚀 Generating Vault Graph View...');

  if (!fs.existsSync(GRAPH_PATH)) {
    log.error(`❌ Error: Graph file not found at ${GRAPH_PATH}`);
    process.exit(1);
  }

  const graphData = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  const rawNodes = graphData.nodes || {};

  const nodes = [];
  const edges = [];
  const edgeSet = new Set();

  for (const [id, node] of Object.entries(rawNodes)) {
    const folder = detectFolder(node.path || '');
    const palette = folderColors[folder] || FOLDER_COLORS.default;
    const degree = Number(node.degree || 0);
    const wordCount = Number(node.wordCount || 0);
    const size = Math.max(10, Math.min(34, 10 + degree * 1.4 + Math.log10(wordCount + 10) * 2));

    nodes.push({
      id,
      label: id,
      group: folder,
      value: size,
      shape: 'dot',
      size,
      margin: 8,
      meta: {
        path: node.path || '',
        degree,
        wordCount,
        folder,
        links: node.links || [],
        typedLinks: node.typedLinks || [],
        preview: node.contentPreview || ''
      },
      font: {
        color: '#EAF0FF',
        size: 13,
        face: 'Outfit, system-ui, sans-serif',
        strokeWidth: 4,
        strokeColor: 'rgba(0,0,0,0.35)'
      },
      color: {
        background: palette.bg,
        border: palette.border,
        highlight: { background: palette.bg, border: '#FFFFFF' },
        hover: { background: palette.bg, border: '#FFFFFF' }
      },
      borderWidth: 2,
      shadow: {
        enabled: true,
        color: 'rgba(0,0,0,0.35)',
        size: 10,
        x: 0,
        y: 3
      }
    });

    const processEdge = (linkId, type = null) => {
      if (!rawNodes[linkId]) return;
      const key = id < linkId ? `${id}__${linkId}` : `${linkId}__${id}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);

      const edge = {
        from: id,
        to: linkId,
        width: type ? 1.5 : 1,
        color: {
          color: type ? 'rgba(124, 156, 255, 0.4)' : 'rgba(200, 210, 230, 0.25)',
          highlight: 'rgba(255,255,255,0.9)',
          hover: 'rgba(255,255,255,0.8)'
        },
        smooth: { type: 'dynamic', roundness: 0.35 },
        selectionWidth: 2,
        hoverWidth: 1.5
      };

      // if (type) {
      //   edge.label = type;
      //   edge.font = { align: 'middle', size: 10, color: 'rgba(200,210,230,0.7)', strokeWidth: 0, background: 'rgba(10,10,10,0.6)' };
      // }

      edges.push(edge);
    };

    if (Array.isArray(node.typedLinks)) {
      for (const tLink of node.typedLinks) {
        processEdge(tLink.target, tLink.type);
      }
    }

    if (Array.isArray(node.links)) {
      for (const linkId of node.links) {
        processEdge(linkId, null);
      }
    }
  }

  // Stats
  const folderDistribution = nodes.reduce((acc, n) => {
    acc[n.group] = (acc[n.group] || 0) + 1;
    return acc;
  }, {});

  const folderLegend = Object.entries(folderColors)
    .map(([folder, c]) => {
      const count = folderDistribution[folder] || 0;
      return `
      <button class="legend-item" data-folder="${folder}" title="Filter ${folder}">
        <span class="dot" style="background:${c.bg}; border-color:${c.border}"></span>
        <span>${c.label || folder}</span>
        <span class="count">${count}</span>
      </button>`;
    }).join('');

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vault Knowledge Graph</title>
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root{
      --bg: #050505;
      --panel: rgba(18, 18, 18, 0.72);
      --panel-solid: rgba(18, 18, 18, 0.95);
      --border: rgba(255,255,255,0.08);
      --border-highlight: rgba(255, 255, 255, 0.25);
      --text: #ededed;
      --muted: #888888;
      --accent: #5e6ad2;
      --accent-light: #8b95e0;
      --shadow: 0 24px 48px -12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
      --radius: 20px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 10px; }
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background:
        radial-gradient(circle at top left, rgba(124,156,255,0.16), transparent 28%),
        radial-gradient(circle at bottom right, rgba(46,213,115,0.09), transparent 24%),
        var(--bg);
      color: var(--text);
      font-family: 'Outfit', system-ui, -apple-system, sans-serif;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideInLeft { from { transform: translateX(-20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes slideInRight { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes slideUp { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    @keyframes spin { to { transform: rotate(360deg); } }

    #network { position: absolute; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 1; }

    .loading-overlay {
      position: fixed; inset: 0; background: var(--bg);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      z-index: 1000; transition: opacity 0.5s ease, visibility 0.5s ease;
    }
    .loading-overlay.hidden { opacity: 0; visibility: hidden; pointer-events: none; }
    .loading-spinner { width: 48px; height: 48px; border: 3px solid rgba(255,255,255,0.1); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; }
    .loading-text { margin-top: 16px; font-size: 14px; color: var(--muted); }

    .toast-container { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 100; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .toast { background: var(--panel-solid); border: 1px solid var(--border); border-radius: 12px; padding: 12px 20px; font-size: 13px; color: var(--text); backdrop-filter: blur(16px); animation: slideUp 0.3s ease forwards; pointer-events: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.3); max-width: 400px; text-align: center; }
    .toast.error { border-color: rgba(255,100,100,0.4); color: #ff9999; }
    .toast.success { border-color: rgba(100,255,150,0.3); color: #aaffaa; }

    .panel {
      position: absolute; top: 24px; left: 24px; z-index: 20; width: 340px; max-height: calc(100vh - 48px);
      padding: 24px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
      animation: slideInLeft 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards; overflow-y: auto; transition: transform 0.3s ease;
    }
    .panel.collapsed { transform: translateX(calc(-100% - 40px)); }
    .panel-toggle { position: absolute; right: -40px; top: 20px; width: 36px; height: 36px; background: var(--panel); border: 1px solid var(--border); border-radius: 0 10px 10px 0; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text); font-size: 16px; backdrop-filter: blur(16px); transition: 0.15s ease; }
    .panel-toggle:hover { background: rgba(255,255,255,0.08); }

    .title { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; }
    .title h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.5px; background: linear-gradient(135deg, #ffffff 0%, #a5b4fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .title p { margin: 0; font-size: 12px; color: var(--muted); }

    .search-wrapper { position: relative; margin-bottom: 10px; }
    .search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 14px; pointer-events: none; }
    .search { width: 100%; border: 1px solid var(--border); background: rgba(255,255,255,0.06); color: var(--text); outline: none; border-radius: 12px; padding: 11px 12px 11px 36px; font-size: 13px; transition: 0.15s ease; font-family: inherit; }
    .search::placeholder { color: var(--muted); }
    .search:focus { border-color: rgba(124,156,255,0.65); box-shadow: 0 0 0 4px rgba(124,156,255,0.14); }
    .search-clear { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 6px; display: none; transition: 0.15s ease; }
    .search-clear:hover { color: var(--text); background: rgba(255,255,255,0.1); }
    .search-clear.visible { display: block; }

    .actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
    .btn { border: 1px solid var(--border); background: rgba(255,255,255,0.03); color: var(--text); border-radius: 10px; padding: 10px 8px; cursor: pointer; font-size: 12px; font-weight: 500; font-family: inherit; transition: all 0.15s ease; display: flex; align-items: center; justify-content: center; gap: 4px; }
    .btn:hover { transform: translateY(-2px); background: rgba(255,255,255,0.08); border-color: var(--border-highlight); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .btn:active { transform: translateY(0); }
    .btn.active { border-color: var(--accent); background: rgba(94, 106, 210, 0.15); color: var(--accent-light); }

    .stats { display: flex; gap: 10px; margin-top: 12px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
    .stats span { display: flex; align-items: center; gap: 6px; }
    .badge { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 7px; border-radius: 999px; background: rgba(255,255,255,0.08); font-size: 11px; color: var(--text); font-weight: 500; }

    .legend { margin-top: 14px; display: grid; gap: 6px; max-height: 280px; overflow-y: auto; padding-right: 4px; }
    .legend-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; cursor: pointer; border: 1px solid var(--border); background: rgba(255,255,255,0.04); color: var(--text); text-align: left; transition: 0.15s ease; font-size: 13px; }
    .legend-item:hover { background: rgba(255,255,255,0.08); }
    .legend-item.active { border-color: rgba(124,156,255,0.8); background: rgba(124,156,255,0.16); }
    .legend-item .count { margin-left: auto; font-size: 11px; color: var(--muted); background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 999px; }
    .dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid; flex: 0 0 auto; transition: transform 0.15s ease; }
    .legend-item:hover .dot { transform: scale(1.2); }

    .hint { margin-top: 12px; font-size: 11px; color: var(--muted); line-height: 1.5; padding: 10px; background: rgba(255,255,255,0.02); border-radius: 10px; border: 1px solid rgba(255,255,255,0.03); }
    .hint kbd { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 10px; border: 1px solid rgba(255,255,255,0.15); }

    .zoom-controls { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 20; display: flex; flex-direction: row; gap: 6px; animation: slideUp 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
    .zoom-btn { width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel); color: var(--text); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 300; backdrop-filter: blur(16px); transition: 0.15s ease; box-shadow: var(--shadow); }
    .zoom-btn:hover { background: rgba(255,255,255,0.08); transform: scale(1.05); }

    #inspector { position: absolute; top: 24px; right: 24px; width: 360px; max-height: calc(100vh - 48px); z-index: 20; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); overflow-y: auto; padding: 24px; box-shadow: var(--shadow); animation: slideInRight 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards; transition: transform 0.3s ease, opacity 0.3s ease; }
    #inspector.hidden { animation: none !important; transform: translateX(calc(100% + 40px)) !important; opacity: 0 !important; pointer-events: none !important; }
    .inspector-header { position: relative; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-right: 32px; }
    .inspector-title { font-size: 20px; font-weight: 600; letter-spacing: -0.3px; word-break: break-word; }
    .inspector-close { position: absolute; top: -4px; right: -8px; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 24px; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 8px; transition: 0.15s ease; z-index: 2; }
    .inspector-close:hover { color: var(--text); background: rgba(255,255,255,0.08); }

    .empty-state { color: var(--muted); display: flex; align-items: center; justify-content: center; height: 100%; text-align: center; font-size: 14px; font-weight: 500; flex-direction: column; gap: 12px; }
    .empty-state-icon { font-size: 48px; opacity: 0.3; }

    .info-block { margin-bottom: 16px; }
    .info-label { font-size: 11px; color: #8fa3c9; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; margin-bottom: 4px; }
    .info-value { color: white; word-break: break-word; font-size: 14px; line-height: 1.4; }
    .info-value.mono { font-family: 'SF Mono', Monaco, monospace; font-size: 12px; background: rgba(255,255,255,0.03); padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }

    .related-list { margin-top: 8px; }
    .related-node { padding: 10px 14px; margin-bottom: 6px; border-radius: 10px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.03); cursor: pointer; transition: all 0.15s ease; font-weight: 500; font-size: 13px; display: flex; align-items: center; gap: 8px; }
    .related-node:hover { background: rgba(255,255,255,0.08); border-color: var(--border-highlight); transform: translateX(4px); }
    .related-node .related-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

    .folder-tag { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 500; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); }
    .folder-tag .dot-inline { width: 8px; height: 8px; border-radius: 50%; }

    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(8px); z-index: 200; display: flex; align-items: center; justify-content: center; opacity: 0; visibility: hidden; transition: all 0.3s ease; }
    .modal-overlay.active { opacity: 1; visibility: visible; }
    .modal { background: var(--panel-solid); border: 1px solid var(--border); border-radius: var(--radius); padding: 32px; max-width: 480px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 24px 48px rgba(0,0,0,0.4); transform: translateY(20px); transition: transform 0.3s ease; }
    .modal-overlay.active .modal { transform: translateY(0); }
    .modal h2 { font-size: 20px; margin-bottom: 20px; font-weight: 600; }
    .modal-close { position: absolute; top: 16px; right: 16px; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 24px; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: 0.15s ease; }
    .modal-close:hover { background: rgba(255,255,255,0.08); color: var(--text); }
    .shortcut-list { display: grid; gap: 12px; }
    .shortcut-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .shortcut-item:last-child { border-bottom: none; }
    .shortcut-keys { display: flex; gap: 4px; }
    .shortcut-keys kbd { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 10px; font-family: 'SF Mono', monospace; font-size: 12px; color: var(--accent-light); }

    @media (max-width: 900px) { #inspector { width: 300px; } }
    @media (max-width: 760px) {
      .panel { width: calc(100vw - 24px); left: 12px; top: 12px; max-height: calc(100vh - 24px); }
      #inspector { position: fixed; top: auto; bottom: 0; left: 0; right: 0; width: 100%; max-height: 50vh; border-radius: var(--radius) var(--radius) 0 0; animation: slideUp 0.4s ease forwards; }
      #inspector.hidden { animation: none !important; transform: translateY(100%) !important; opacity: 0 !important; pointer-events: none !important; }
      .zoom-controls { bottom: 12px; }
    }
    *:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button:focus-visible, input:focus-visible { outline-offset: 2px; }
    div.vis-tooltip { background: var(--panel-solid) !important; border: 1px solid var(--border) !important; border-radius: 10px !important; color: var(--text) !important; font-family: 'Outfit', sans-serif !important; font-size: 13px !important; padding: 10px 14px !important; box-shadow: 0 8px 24px rgba(0,0,0,0.3) !important; backdrop-filter: blur(16px) !important; }
  </style>
</head>
<body>
  <div class="loading-overlay" id="loadingOverlay">
    <div class="loading-spinner"></div>
    <div class="loading-text">Initializing Knowledge Graph...</div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <div class="panel" id="leftPanel">
    <button class="panel-toggle" id="panelToggle" title="Toggle Panel (P)" aria-label="Toggle panel">&#9664;</button>
    <div class="title">
      <h1>Vault Graph Explorer</h1>
      <p>Search, filter, and inspect your knowledge map.</p>
    </div>
    <div class="search-wrapper">
      <span class="search-icon">&#128269;</span>
      <input id="nodeSearch" class="search" type="text" placeholder="Search nodes..." autocomplete="off" aria-label="Search nodes" />
      <button class="search-clear" id="searchClear" aria-label="Clear search">&#215;</button>
    </div>
    <div class="actions">
      <button class="btn" id="btnReset" title="Reset view (Esc)"><span>&#8634;</span> Reset</button>
      <button class="btn" id="btnFit" title="Fit to screen (F)"><span>&#8858;</span> Fit</button>
      <button class="btn" id="btnPhysics" title="Toggle physics (Space)"><span>&#9678;</span> <span id="physicsLabel">On</span></button>
    </div>
    <div class="stats">
      <span>Nodes: <span class="badge" id="nodeCount">${nodes.length}</span></span>
      <span>Edges: <span class="badge" id="edgeCount">${edges.length}</span></span>
      <span>Visible: <span class="badge" id="filteredCount">${nodes.length}</span></span>
    </div>
    <div class="legend" id="legend" role="group" aria-label="Folder filters">
      ${folderLegend}
    </div>
    <div class="hint">
      <strong>Controls:</strong><br>
      &#8226; Click node to focus &amp; inspect<br>
      &#8226; Click background to reset<br>
      &#8226; Click folder to filter<br>
      &#8226; Double-click node for details<br>
      &#8226; <kbd>?</kbd> for shortcuts
    </div>
  </div>

  <div id="network" role="application" aria-label="Interactive knowledge graph"></div>

  <div class="zoom-controls">
    <button class="zoom-btn" id="btnZoomIn" title="Zoom in (+)">+</button>
    <button class="zoom-btn" id="btnZoomOut" title="Zoom out (-)">&#8722;</button>
    <button class="zoom-btn" id="btnExport" title="Export as image (E)">&#128247;</button>
    <button class="zoom-btn" id="btnHelp" title="Keyboard shortcuts (?)">?</button>
  </div>

  <div id="inspector" class="hidden">
    <div class="empty-state">
      <div class="empty-state-icon">&#128302;</div>
      <div>Select a node to inspect</div>
    </div>
  </div>

  <div class="modal-overlay" id="shortcutsModal">
    <div class="modal" style="position: relative;">
      <button class="modal-close" id="modalClose">&#215;</button>
      <h2>Keyboard Shortcuts</h2>
      <div class="shortcut-list">
        <div class="shortcut-item"><span>Search nodes</span><div class="shortcut-keys"><kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>K</kbd></div></div>
        <div class="shortcut-item"><span>Reset view</span><div class="shortcut-keys"><kbd>Esc</kbd></div></div>
        <div class="shortcut-item"><span>Fit to screen</span><div class="shortcut-keys"><kbd>F</kbd></div></div>
        <div class="shortcut-item"><span>Toggle physics</span><div class="shortcut-keys"><kbd>Space</kbd></div></div>
        <div class="shortcut-item"><span>Zoom in/out</span><div class="shortcut-keys"><kbd>+</kbd> / <kbd>-</kbd></div></div>
        <div class="shortcut-item"><span>Export image</span><div class="shortcut-keys"><kbd>E</kbd></div></div>
        <div class="shortcut-item"><span>Toggle panel</span><div class="shortcut-keys"><kbd>P</kbd></div></div>
        <div class="shortcut-item"><span>Toggle inspector</span><div class="shortcut-keys"><kbd>I</kbd></div></div>
        <div class="shortcut-item"><span>Close modals</span><div class="shortcut-keys"><kbd>Esc</kbd></div></div>
      </div>
    </div>
  </div>

  <script>
    // DEBUG: log data immediately
    console.log('[VaultGraph] Script loaded');

    const FOLDER_COLORS = ${JSON.stringify(folderColors)};

    const rawNodes = new vis.DataSet(${JSON.stringify(nodes)});
    const rawEdges = new vis.DataSet(${JSON.stringify(edges)});
    console.log('[VaultGraph] DataSet created. Nodes:', rawNodes.length, 'Edges:', rawEdges.length);

    const originalNodes = rawNodes.get();
    const nodeMap = new Map(originalNodes.map(n => [n.id, n]));
    const baseNodeMap = new Map(originalNodes.map(n => [n.id, JSON.parse(JSON.stringify(n))]));
    console.log('[VaultGraph] originalNodes count:', originalNodes.length);

    const container = document.getElementById('network');
    const data = { nodes: rawNodes, edges: rawEdges };
    const inspector = document.getElementById('inspector');
    console.log('[VaultGraph] Container found:', !!container);

    let physicsEnabled = true;
    let activeFolder = 'all';
    let activeSearch = '';
    let focusMode = false;
    let inspectorVisible = false;
    let inspectorOpening = false;
    let selectedNodeId = null;

    const AppConfig = {
      searchDebounce: 150,
      focusScale: 0.5,
      animationDuration: 700,
      focusAnimationDuration: 500
    };

    function escapeHtml(str) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
      return String(str).replace(/[&<>"']/g, c => map[c]);
    }

    const debounce = (fn, delay) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), delay); }; };

    const showToast = (msg, type = 'info', duration = 3000) => {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = msg;
      toast.setAttribute('role', 'status');
      container.appendChild(toast);
      setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)'; setTimeout(() => toast.remove(), 300); }, duration);
    };

    const loadingOverlay = document.getElementById('loadingOverlay');
    function hideLoading() {
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }

    const options = {
      autoResize: true,
      nodes: {
        scaling: { min: 8, max: 34, label: { enabled: true, min: 10, max: 22, maxVisible: 22 } },
        chosen: {
          node(values, id, selected, hovering) {
            values.borderWidth = selected || hovering ? 4 : 2;
            values.shadow = selected || hovering;
          }
        }
      },
      edges: { selectionWidth: 2, hoverWidth: 1.5 },
      layout: { improvedLayout: true },
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -45,
          centralGravity: 0.01,
          springLength: 110,
          springConstant: 0.08,
          avoidOverlap: 0.9
        },
        maxVelocity: 45,
        minVelocity: 0.1,
        timestep: 0.2,
        stabilization: { enabled: true, iterations: 180, updateInterval: 25 }
      },
      interaction: {
        hover: true,
        tooltipDelay: 120,
        zoomView: true,
        dragView: true,
        dragNodes: true,
        hideEdgesOnDrag: true,
        hideNodesOnDrag: false,
        selectable: true,
        multiselect: false,
        keyboard: false
      },
      groups: {
        '00_inbox': { shape: 'dot' },
        '01_thinking': { shape: 'dot' },
        '02_reference': { shape: 'dot' },
        '03_creating': { shape: 'dot' },
        '04_published': { shape: 'dot' },
        '05_archive': { shape: 'dot' },
        '06_system': { shape: 'dot' },
        'default': { shape: 'dot' }
      }
    };

    console.log('[VaultGraph] Creating Network...');
    const network = new vis.Network(container, data, options);
    window.graphNetwork = network;
    console.log('[VaultGraph] Network created');

    network.once('stabilizationIterationsDone', () => {
      console.log('[VaultGraph] Stabilization done');
      hideLoading();
      try {
        network.fit({ animation: { duration: AppConfig.animationDuration, easingFunction: 'easeInOutQuad' } });
      } catch (e) {}
      setTimeout(() => {
        try {
          network.setOptions({ physics: { enabled: false } });
          physicsEnabled = false;
          document.getElementById('physicsLabel').textContent = 'Off';
          document.getElementById('btnPhysics').classList.add('active');
        } catch (e) {}
      }, 1000);
    });

    network.on('stabilizationProgress', (params) => {
      const pct = Math.round((params.iterations / params.total) * 100);
      const lt = document.querySelector('.loading-text');
      if (lt) lt.textContent = 'Stabilizing graph... ' + pct + '%';
    });

    // Ultimate fallback: hide loading after 3s no matter what
    setTimeout(() => {
      console.log('[VaultGraph] Fallback hide loading triggered');
      hideLoading();
    }, 3000);

    // INSPECTOR
    function renderInspector(nodeId) {
      const node = nodeMap.get(nodeId);
      if (!node) return;
      const connected = network.getConnectedNodes(nodeId) || [];
      const palette = FOLDER_COLORS[node.meta.folder] || FOLDER_COLORS.default;
      const connectedHtml = connected.map(id => {
        const rn = nodeMap.get(id);
        const rp = rn ? (FOLDER_COLORS[rn.group] || FOLDER_COLORS.default) : FOLDER_COLORS.default;
        
        let relType = '';
        if (node.meta.typedLinks) {
          const tl = node.meta.typedLinks.find(t => t.target === id);
          if (tl) relType = '<span style="color:#8fa3c9; font-size:10px; border:1px solid rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; margin-left:auto; background:rgba(255,255,255,0.03);">' + escapeHtml(tl.type) + '</span>';
        }
        if (!relType && rn && rn.meta.typedLinks) {
          const tl = rn.meta.typedLinks.find(t => t.target === nodeId);
          if (tl) relType = '<span style="color:#8fa3c9; font-size:10px; border:1px solid rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; margin-left:auto; background:rgba(255,255,255,0.03);">&larr; ' + escapeHtml(tl.type) + '</span>';
        }

        return '<div class="related-node" onclick="focusNode(' + JSON.stringify(id).replace(/"/g, '&quot;') + ')" ' +
               'onmouseenter="highlightNode(' + JSON.stringify(id).replace(/"/g, '&quot;') + ')" ' +
               'onmouseleave="unhighlightNode()" role="button" tabindex="0">' +
          '<span class="related-dot" style="background:' + rp.bg + '; border: 2px solid ' + rp.border + '"></span>' + escapeHtml(id) + relType + '</div>';
      }).join('');

      inspector.innerHTML =
        '<div class="inspector-header">' +
        '<div class="inspector-title">' + escapeHtml(node.label) + '</div>' +
        '<button class="inspector-close" id="inspectorCloseBtn" aria-label="Close inspector">&#215;</button>' +
        '</div>' +
        '<div class="info-block"><div class="info-label">Folder</div><div class="info-value"><span class="folder-tag"><span class="dot-inline" style="background:' + palette.bg + '; border: 2px solid ' + palette.border + '"></span>' + escapeHtml(node.meta.folder) + '</span></div></div>' +
        '<div class="info-block"><div class="info-label">Path</div><div class="info-value mono">' + escapeHtml(node.meta.path) + '</div></div>' +
        (node.meta.preview ? '<div class="info-block"><div class="info-label">Preview</div><div class="info-value" style="background:rgba(255,255,255,0.03); padding:12px; border-radius:8px; border:1px solid rgba(255,255,255,0.05); font-size:13px; max-height:200px; overflow-y:auto; line-height:1.5; color:#cbd5e1; white-space:pre-wrap;">' + escapeHtml(node.meta.preview) + '</div></div>' : '') +
        '<div class="info-block"><div class="info-label">Statistics</div><div class="info-value" style="display:flex;gap:16px;">' +
        '<span><strong>' + node.meta.wordCount.toLocaleString() + '</strong> words</span>' +
        '<span><strong>' + node.meta.degree + '</strong> connections</span></div></div>' +
        '<div class="info-block"><div class="info-label">Connected Nodes (' + connected.length + ')</div><div class="related-list">' +
        (connectedHtml || '<div style="color: var(--muted); font-size: 13px; padding: 8px 0;">No connections</div>') + '</div></div>';

        document.getElementById('inspectorCloseBtn').addEventListener('click', function(e) { e.stopPropagation(); closeInspector(); });
        inspector.addEventListener('click', function(e) { e.stopPropagation(); });
        // Delay setting visible flag to avoid immediate document click hide
        inspector.classList.remove('hidden');
        inspectorOpening = true;
        setTimeout(() => { inspectorVisible = true; inspectorOpening = false; }, 0);
        selectedNodeId = nodeId;
    }

    window.closeInspector = function() {
      inspector.classList.add('hidden');
      inspectorVisible = false;
      selectedNodeId = null;
      network.unselectAll();
      applyNodeState();
    };

    window.highlightNode = function(hoverId) {
      if (!selectedNodeId) return;
      network.selectNodes([selectedNodeId, hoverId]);
    };
    
    window.unhighlightNode = function() {
      if (!selectedNodeId) return;
      network.selectNodes([selectedNodeId]);
    };

    window.focusNode = function(nodeId) {
      try {
        network.selectNodes([nodeId]);
        network.focus(nodeId, { scale: AppConfig.focusScale, animation: { duration: AppConfig.focusAnimationDuration, easingFunction: 'easeInOutQuad' } });
        renderInspector(nodeId);
        applyNodeState({ focusNodeId: nodeId });
      } catch (err) { showToast('Failed to focus node: ' + err.message, 'error'); }
    };

    function applyNodeState({ searchTerm = activeSearch, folder = activeFolder, focusNodeId = null } = {}) {
      const term = (searchTerm || '').trim().toLowerCase();
      let matchedIds = null;
      if (term) {
        matchedIds = new Set(originalNodes.filter(n => String(n.label || '').toLowerCase().includes(term)).map(n => n.id));
      }
      let focusSet = null;
      if (focusNodeId) {
        try { const neighbors = network.getConnectedNodes(focusNodeId) || []; focusSet = new Set([focusNodeId, ...neighbors]); }
        catch (e) { focusSet = new Set([focusNodeId]); }
      }
      const updates = [];
      let visibleCount = 0;
      for (const node of originalNodes) {
        const base = baseNodeMap.get(node.id);
        const nodeFolder = base.group || 'default';
        const matchesFolder = folder === 'all' ? true : nodeFolder === folder;
        const matchesSearch = !matchedIds ? true : matchedIds.has(node.id);
        const matchesFocus = !focusSet ? true : focusSet.has(node.id);
        const visible = matchesFolder && matchesSearch && matchesFocus;
        if (visible) visibleCount++;
        updates.push({
          id: node.id,
          opacity: visible ? 1 : 0.08,
          font: Object.assign({}, base.font, { color: visible ? '#EAF0FF' : '#66708A' }),
          hidden: false
        });
      }
      rawNodes.update(updates);
      document.getElementById('filteredCount').textContent = visibleCount;
    }

    function resetView() {
      activeFolder = 'all';
      activeSearch = '';
      focusMode = false;
      selectedNodeId = null;
      document.getElementById('nodeSearch').value = '';
      document.getElementById('searchClear').classList.remove('visible');
      setLegendActive('all');
      rawNodes.update(originalNodes.map(n => ({
        id: n.id,
        opacity: 1,
        hidden: false,
        font: Object.assign({}, baseNodeMap.get(n.id).font, { color: '#EAF0FF' })
      })));
      document.getElementById('filteredCount').textContent = originalNodes.length;
      try { network.fit({ animation: { duration: AppConfig.animationDuration, easingFunction: 'easeInOutQuad' } }); } catch (e) {}
      inspector.classList.add('hidden');
      inspectorVisible = false;
    }

    function setLegendActive(folder) {
      document.querySelectorAll('.legend-item').forEach(btn => {
        const isActive = btn.dataset.folder === folder;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive);
      });
    }

    // Event handlers
    const searchInput = document.getElementById('nodeSearch');
    const searchClear = document.getElementById('searchClear');

    const debouncedSearch = debounce((value) => { activeSearch = value; applyNodeState(); }, AppConfig.searchDebounce);

    searchInput.addEventListener('input', (e) => {
      searchClear.classList.toggle('visible', e.target.value.length > 0);
      debouncedSearch(e.target.value);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { activeSearch = e.target.value; applyNodeState(); }
      if (e.key === 'Escape') {
        e.target.value = '';
        searchClear.classList.remove('visible');
        activeSearch = '';
        applyNodeState();
      }
    });
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.classList.remove('visible');
      activeSearch = '';
      applyNodeState();
      searchInput.focus();
    });

    document.getElementById('btnReset').addEventListener('click', resetView);
    document.getElementById('btnFit').addEventListener('click', () => {
      try { network.fit({ animation: { duration: 650, easingFunction: 'easeInOutQuad' } }); } catch (e) { showToast('Failed to fit view', 'error'); }
    });
    document.getElementById('btnPhysics').addEventListener('click', (e) => {
      physicsEnabled = !physicsEnabled;
      try {
        network.setOptions({ physics: { enabled: physicsEnabled } });
        document.getElementById('physicsLabel').textContent = physicsEnabled ? 'On' : 'Off';
        e.currentTarget.classList.toggle('active', !physicsEnabled);
        if (physicsEnabled) network.stabilize(40);
      } catch (err) { showToast('Physics toggle failed', 'error'); }
    });
    document.getElementById('btnZoomIn').addEventListener('click', () => {
      try { const s = network.getScale() + 0.3; network.moveTo({ scale: s, animation: { duration: 300 } }); } catch (e) {}
    });
    document.getElementById('btnZoomOut').addEventListener('click', () => {
      try { const s = Math.max(0.1, network.getScale() - 0.3); network.moveTo({ scale: s, animation: { duration: 300 } }); } catch (e) {}
    });
    document.getElementById('btnExport').addEventListener('click', () => {
      try {
        const canvas = container.querySelector('canvas');
        if (!canvas) { showToast('Canvas not found', 'error'); return; }
        // Use devicePixelRatio for crisp HD export and ensure dark background
        const scale = Math.max(2, window.devicePixelRatio || 1);
        const temp = document.createElement('canvas');
        temp.width = canvas.width * scale;
        temp.height = canvas.height * scale;
        const ctx = temp.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        // Fill dark background (fallback to #050505)
        ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg') || '#050505';
        ctx.fillRect(0, 0, temp.width, temp.height);
        // Draw original canvas scaled up for HD output
        ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, canvas.width * scale, canvas.height * scale);
        const link = document.createElement('a');
        link.download = 'vault-graph-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.png';
        link.href = temp.toDataURL('image/png');
        link.click();
        showToast('Graph exported in HD successfully!', 'success');
      } catch (err) { showToast('Export failed: ' + err.message, 'error'); }
    });

    const leftPanel = document.getElementById('leftPanel');
    const panelToggle = document.getElementById('panelToggle');
    panelToggle.addEventListener('click', () => {
      const collapsed = leftPanel.classList.toggle('collapsed');
      panelToggle.innerHTML = collapsed ? '&#9654;' : '&#9664;';
      panelToggle.setAttribute('aria-expanded', !collapsed);
    });

    document.querySelectorAll('.legend-item').forEach(btn => {
      btn.addEventListener('click', () => {
        activeFolder = btn.dataset.folder;
        setLegendActive(activeFolder);
        applyNodeState();
      });
    });

    // Hide inspector when clicking outside of it
    document.addEventListener('click', function(e) {
      if (e.target.closest('#network')) return; // Let network.on('click') handle canvas clicks
      if (inspectorVisible && !inspectorOpening && !inspector.contains(e.target) && !e.target.closest('.inspector-close')) {
        closeInspector();
      }
    });

    network.on('doubleClick', (params) => {
      if (params.nodes && params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = nodeMap.get(nodeId);
        if (node && node.title) {
          const safeTitle = String(node.title).replace(/<[^>]*>/g, '');
          const modal = window.open('', '_blank', 'width=800,height=600');
          if (modal) {
            modal.document.write('<!DOCTYPE html><html><head><title>' + escapeHtml(nodeId) + '</title><style>body{background:#0a0a0a;color:#ededed;font-family:system-ui,sans-serif;padding:24px;line-height:1.6;}pre{white-space:pre-wrap;font-family:SF Mono,monospace;font-size:14px;}</style></head><body><h2>' + escapeHtml(nodeId) + '</h2><pre>' + escapeHtml(safeTitle) + '</pre></body></html>');
            modal.document.close();
          }
        }
      }
    });

    network.on('click', (params) => {
      if (params.nodes && params.nodes.length > 0) {
        focusNode(params.nodes[0]);
      } else {
        closeInspector();
        applyNodeState();
      }
    });

    network.on('hoverNode', () => { container.style.cursor = 'pointer'; });
    network.on('blurNode', () => { container.style.cursor = 'default'; });
    network.on('error', (err) => { console.error('Network error:', err); showToast('Graph rendering error occurred', 'error'); });

    // Keyboard shortcuts
    const shortcutsModal = document.getElementById('shortcutsModal');
    document.getElementById('btnHelp').addEventListener('click', () => shortcutsModal.classList.add('active'));
    document.getElementById('modalClose').addEventListener('click', () => shortcutsModal.classList.remove('active'));
    shortcutsModal.addEventListener('click', (e) => { if (e.target === shortcutsModal) shortcutsModal.classList.remove('active'); });

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') {
          e.target.blur();
          if (e.target.id === 'nodeSearch') {
            e.target.value = '';
            searchClear.classList.remove('visible');
            activeSearch = '';
            applyNodeState();
          }
        }
        return;
      }
      switch (e.key) {
        case '?': case 'h': case 'H': e.preventDefault(); shortcutsModal.classList.toggle('active'); break;
        case '/': e.preventDefault(); searchInput.focus(); searchInput.select(); break;
        case 'k': if (e.ctrlKey) { e.preventDefault(); searchInput.focus(); searchInput.select(); } break;
        case 'Escape': shortcutsModal.classList.remove('active'); resetView(); break;
        case 'f': case 'F': e.preventDefault(); document.getElementById('btnFit').click(); break;
        case ' ': e.preventDefault(); document.getElementById('btnPhysics').click(); break;
        case '+': case '=': e.preventDefault(); document.getElementById('btnZoomIn').click(); break;
        case '-': case '_': e.preventDefault(); document.getElementById('btnZoomOut').click(); break;
        case 'e': case 'E': e.preventDefault(); document.getElementById('btnExport').click(); break;
        case 'p': case 'P': e.preventDefault(); panelToggle.click(); break;
        case 'i': case 'I': e.preventDefault(); if (inspectorVisible) { closeInspector(); } else if (selectedNodeId) { renderInspector(selectedNodeId); } break;
      }
    });

    setLegendActive('all');
    applyNodeState();
    console.log('[VaultGraph] Initialization complete');

    window.addEventListener('resize', () => { try { network.redraw(); } catch (e) {} });
    window.graphApp = { network, rawNodes, rawEdges, state: { physicsEnabled, activeFolder, activeSearch, focusMode, inspectorVisible, selectedNodeId } };
  </script>
</body>
</html>`;

  fs.writeFileSync(OUTPUT_PATH, htmlContent, 'utf8');
  log.success(`✅ Success! Graph view generated at: ${OUTPUT_PATH}`);
  log.info(`📊 Stats: ${nodes.length} nodes, ${edges.length} edges`);
}

generateGraphHtml();
