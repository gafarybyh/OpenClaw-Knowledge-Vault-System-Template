const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Configuration ─────────────────────────────────────────────────
const CONFIG = {
  LOCK_STALE_MS: 60 * 60 * 1000,        // 1 hour
  TASK_TIMEOUT_MS: 10 * 60 * 1000,      // 10 minutes
  PIPELINE_TIMEOUT_MS: 30 * 60 * 1000,  // 30 minutes (overall cap)
  MAX_BUFFER: 50 * 1024 * 1024,         // 50MB
  RETRY_ATTEMPTS: 2,                     // 1 = no retry; 2 = one retry
  RETRY_DELAY_MS: 1000,
};

// ─── Helper: Safe JSON Read ─────────────────────────────────────────
function safeReadJson(filePath, defaultValue = null) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

// ─── Helper: Safe JSON Write ────────────────────────────────────────
function safeWriteJson(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('  ❌ Failed to write JSON:', err.message);
    return false;
  }
}

// ─── Helper: Validate Script Exists ─────────────────────────────────
function validateScript(scriptPath) {
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}`);
  }
}

// ─── Helper: Check if PID is alive ──────────────────────────────────
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Lock Manager (Atomic-ish with PID check) ───────────────────────
class LockManager {
  constructor(lockFile) {
    this.lockFile = lockFile;
  }

  isLocked() {
    if (!fs.existsSync(this.lockFile)) return null;

    const lock = safeReadJson(this.lockFile);
    if (!lock || !lock.startedAt) {
      this.removeLock();
      return null;
    }

    const age = Date.now() - new Date(lock.startedAt).getTime();

    // Check if process is still alive
    if (lock.pid && isProcessAlive(lock.pid)) {
      return lock;
    }

    // Stale lock detection
    if (age > CONFIG.LOCK_STALE_MS) {
      console.warn(`  🗑️ Stale lock removed (age: ${(age / 60000).toFixed(1)} min)`);
      this.removeLock();
      return null;
    }

    // Process dead but lock not stale yet — treat as stale to unblock
    console.warn('  🗑️ Lock held by dead process, reclaimed');
    this.removeLock();
    return null;
  }

  createLock() {
    safeWriteJson(this.lockFile, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  }

  removeLock() {
    try {
      if (fs.existsSync(this.lockFile)) {
        fs.unlinkSync(this.lockFile);
      }
    } catch (err) {
      console.error('  ❌ Remove lock failed:', err.message);
    }
  }
}

// ─── Logger ─────────────────────────────────────────────────────────
class Logger {
  constructor(logFile) {
    this.logFile = logFile;
    ensureDir(path.dirname(logFile));
  }

  error(source, error) {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] [${source}] ERROR\n${error?.stack || error}\n\n`;
    try {
      fs.appendFileSync(this.logFile, message, 'utf8');
    } catch (e) {
      console.error('  ❌ Log write failed:', e.message);
    }
  }
}

// ─── Status Manager ─────────────────────────────────────────────────
class StatusManager {
  constructor(statusFile) {
    this.statusFile = statusFile;
  }

  write(status, extra = {}) {
    safeWriteJson(this.statusFile, {
      status,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }
}

// ─── Task Runner ─────────────────────────────────────────────────────
class TaskRunner {
  constructor({ workspaceDir, logger, statusManager, config }) {
    this.workspaceDir = workspaceDir;
    this.logger = logger;
    this.statusManager = statusManager;
    this.config = config;
    this.completedTasks = [];
    this.failedTasks = [];
  }

  async runWithRetry(task, index, total) {
    let lastError;
    for (let attempt = 1; attempt <= this.config.RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.runOnce(task, index, total);
      } catch (err) {
        lastError = err;
        if (attempt < this.config.RETRY_ATTEMPTS) {
          console.log(`  ↻ ${task.name} (attempt ${attempt + 1}/${this.config.RETRY_ATTEMPTS})...`);
          await this.delay(this.config.RETRY_DELAY_MS);
        }
      }
    }
    throw lastError;
  }

  async runOnce(task, index, total) {
    if (!task.cmd) {
      console.log(`  ⏭ (${index}/${total}) ${task.name} skipped`);
      return { skipped: true };
    }

    // Validate script exists before running
    const scriptPath = extractScriptPath(task.cmd);
    if (scriptPath) {
      validateScript(scriptPath);
    }

    this.statusManager.write('running', {
      currentTask: task.name,
      currentStep: index,
      totalSteps: total,
      progress: Number(((index / total) * 100).toFixed(1)),
    });

    const started = Date.now();
    console.log(`  ▶ (${index}/${total}) ${task.name}...`);

    // Parse cmd into program + args for spawn (real-time streaming)
    const { program, args } = parseCommand(task.cmd);

    const result = await new Promise((resolve, reject) => {
      const child = spawn(program, args, {
        cwd: this.workspaceDir,
        env: { ...process.env, FORCE_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        process.stdout.write(text); // ← real-time
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        process.stderr.write(text); // ← real-time
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Timeout (${this.config.TASK_TIMEOUT_MS / 1000}s)`));
      }, this.config.TASK_TIMEOUT_MS);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const err = new Error(`Exit code ${code}${stderr ? ': ' + stderr.trim().slice(0, 200) : ''}`);
          err.code = code;
          err.stderr = stderr;
          err.stdout = stdout;
          reject(err);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ✓ ${task.name} (${elapsed}s)`);

    this.completedTasks.push(task.name);
    return { success: true, stdout: result.stdout, stderr: result.stderr };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ─── Ensure Directory ────────────────────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Extract script path from command ──────────────────────────────
function extractScriptPath(cmd) {
  if (!cmd) return null;
  // Match: node "path", node 'path', or node path (until whitespace)
  const match = cmd.match(/^node\s+["']([^"']+)"|^node\s+(\S+)/);
  return match?.[1] || match?.[2] || null;
}

// ─── Parse command string into program + args array [for spawn] ────
function parseCommand(cmd) {
  // Simple tokenizer: splits by spaces but respects quoted strings
  const tokens = [];
  let current = '';
  let inQuote = null;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  return { program: tokens[0] || 'node', args: tokens.slice(1) };
}

// ─── Helper: Resolve transcript path ────────────────────────────────
function resolveTranscriptPath(event) {
  // Priority 1: previousSessionEntry.sessionFile (command:new/reset)
  const prevFile = event.context?.previousSessionEntry?.sessionFile;
  if (prevFile && fs.existsSync(prevFile)) return prevFile;

  // Priority 2: sessionKey → sessions.json → sessionFile (session:compact:before)
  const sessionKey = event.sessionKey;
  if (sessionKey) {
    // Derive agentId from sessionKey pattern "agent:<agentId>:..."
    const agentMatch = sessionKey.match(/^agent:([^:]+):/);
    const agentId = agentMatch ? agentMatch[1] : 'main';
    const sessionsDir = path.join(os.homedir(), '.openclaw', 'agents', agentId, 'sessions');
    const storePath = path.join(sessionsDir, 'sessions.json');

    try {
      const store = safeReadJson(storePath, {});
      const entry = store[sessionKey];
      if (entry) {
        // Use sessionFile if available (has full path), otherwise construct it
        if (entry.sessionFile && fs.existsSync(entry.sessionFile)) {
          return entry.sessionFile;
        }
        const constructed = path.join(sessionsDir, entry.sessionId + '.jsonl');
        if (fs.existsSync(constructed)) return constructed;
      }
    } catch (err) {
      console.warn('  ⚠️ Failed to resolve transcript from session store:', err.message);
    }
  }

  return null;
}

// ─── Main Handler ───────────────────────────────────────────────────
const handler = async (event) => {
  // Validate event structure
  if (!event) {
    throw new Error('Event object is required');
  }
  if (!Array.isArray(event.messages)) {
    event.messages = [];
  }

  // session:compact:before doesn't provide context.workspaceDir — load from .env or derive from hook location
  function loadWorkspaceDir() {
    // 1. event context (command:new/reset)
    if (event.context?.workspaceDir) return event.context.workspaceDir;

    // 2. Try loading .env from workspace-adjacent paths
    const candidates = [
      path.resolve(__dirname, '..', '..', '.env'),          // D:\Project\OpenClaw\Workspace\.env
      path.resolve(os.homedir(), '.openclaw', '.env'),      // ~/.openclaw/.env
    ];

    for (const envPath of candidates) {
      try {
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, 'utf8');
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('WORKSPACE_DIR=')) {
              const val = trimmed.slice('WORKSPACE_DIR='.length).replace(/^['"]|['"]$/g, '');
              if (val) return val;
            }
          }
        }
      } catch (_) { /* ignore */ }
    }

    // 3. Fallback: derive from hook location
    return path.resolve(__dirname, '..', '..');
  }

  const workspaceDir = loadWorkspaceDir();

  const CACHE_DIR = path.join(workspaceDir, 'vault', '.system', 'cache');
  const DEBUG_FILE = path.join(CACHE_DIR, 'event-debug.json');
  const LOCK_FILE = path.join(CACHE_DIR, 'memory-sync.lock.json');
  const STATUS_FILE = path.join(CACHE_DIR, 'memory-sync-status.json');
  const LOG_FILE = path.join(workspaceDir, 'vault', 'logs', 'errors.log');

  ensureDir(CACHE_DIR);
  ensureDir(path.dirname(LOG_FILE));

  // Debug mode
  if (process.env.DEBUG_HOOKS === 'true') {
    safeWriteJson(DEBUG_FILE, event);
  }

  const lockManager = new LockManager(LOCK_FILE);
  const logger = new Logger(LOG_FILE);
  const statusManager = new StatusManager(STATUS_FILE);

  // ─── Signal Handlers for Cleanup (once-only to prevent stacking) ──
  const onSignal = (sig) => {
    console.log(`\n  ⛔ Received ${sig}, cleaning up...`);
    lockManager.removeLock();
    statusManager.write('interrupted', { reason: sig });
    process.exit(1);
  };

  const onUncaught = (err) => {
    console.error('  ❌ Uncaught Exception:', err);
    logger.error('UncaughtException', err);
    lockManager.removeLock();
    process.exit(1);
  };

  const onRejection = (reason) => {
    console.error('  ❌ Unhandled Rejection:', reason);
    logger.error('UnhandledRejection', new Error(String(reason)));
  };

  // Remove any previous listeners to prevent stacking
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  // ─── Check Lock ──────────────────────────────────────────────────
  const lockInfo = lockManager.isLocked();
  if (lockInfo) {
    const msg = `⚠️ Memory sync already running (PID: ${lockInfo.pid || 'unknown'}).`;
    console.log(`  ${msg}`);
    event.messages.push(msg);
    return;
  }

  // ─── Compact Event: log context ─────────────────────────────────
  const isCompactEvent = event.type === 'session' && event.action === 'compact:before';
  if (isCompactEvent) {
    console.log(`  📦 Compact event: ${event.context?.messageCount || '?'} msgs, ${event.context?.tokenCount || '?'} tokens`);
  }

  // ─── Build Task List ─────────────────────────────────────────────
  const prevSession = event.context?.previousSessionEntry;
  const sessionTraceFile = resolveTranscriptPath(event);

  // Use sessionFile priority: previousSessionEntry > resolved from sessionKey
  const transcriptFile = prevSession?.sessionFile || sessionTraceFile;
  const scriptsDir = path.join(workspaceDir, 'vault', 'scripts');

  const tasks = [
    {
      name: 'Distiller',
      cmd: transcriptFile
        ? 'node "' + scriptsDir + '/graph/distiller.mjs" "' + transcriptFile + '"'
        : null,
      critical: false,
    },
    {
      name: 'Learning Collector',
      cmd: transcriptFile
        ? 'node "' + scriptsDir + '/learning/learning-collector.mjs" "' + transcriptFile + '"'
        : null,
      critical: false,
    },
    {
      name: 'Learning Synthesizer',
      cmd: 'node "' + scriptsDir + '/learning/learning-synthesizer.mjs"',
      critical: false,
    },
    {
      name: 'Reflection Engine',
      cmd: transcriptFile
        ? 'node "' + scriptsDir + '/learning/reflection.mjs" "' + transcriptFile + '"'
        : null,
      critical: false,
    },
    {
      name: 'Reflection Synthesizer',
      cmd: 'node "' + scriptsDir + '/learning/reflection-synthesizer.mjs"',
      critical: false,
    },
    {
      name: 'Inbox Processor',
      cmd: 'node "' + scriptsDir + '/maintenance/process-inbox.mjs"',
      critical: false,
    },
    {
      name: 'Semantic Linker',
      cmd: 'node "' + scriptsDir + '/graph/linker.mjs"',
      critical: false,
    },
    {
      name: 'Graph Indexer',
      cmd: 'node "' + scriptsDir + '/graph/indexer.mjs"',
      critical: false,
    },
    {
      name: 'Memory Sync',
      cmd: 'node "' + scriptsDir + '/maintenance/update-memory.mjs"',
      critical: true,
    },
    {
      name: 'Graph View',
      cmd: 'node "' + scriptsDir + '/maintenance/generate-graph-html.mjs"',
      critical: false,
    },
  ];

  // ─── Execute Pipeline ────────────────────────────────────────────
  lockManager.createLock();
  statusManager.write('running', {
    currentTask: 'Initializing',
    currentStep: 0,
    totalSteps: tasks.length,
    progress: 0,
  });

  const runner = new TaskRunner({ workspaceDir, logger, statusManager, config: CONFIG });
  const startedAt = Date.now();

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  PIPELINE SYNC`);
  console.log(`  Active: ${tasks.filter(t => t.cmd).length} / ${tasks.length} tasks`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Execute pipeline in background (with overall timeout guard)
  const pipelineTimer = setTimeout(() => {
    console.error(`  ⏰ Pipeline timeout (${CONFIG.PIPELINE_TIMEOUT_MS / 60000} min), force-releasing lock`);
    lockManager.removeLock();
    statusManager.write('failed', { error: 'Pipeline timeout' });
  }, CONFIG.PIPELINE_TIMEOUT_MS);
  pipelineTimer.unref(); // Don't keep process alive for timer alone

  (async () => {
    try {
      // ─── Helper: run a batch of tasks with max concurrency ──────
      const byName = (name) => tasks.find(t => t.name === name) || { cmd: null, name, critical: false };

      const runGroup = async (subset, label, concurrency) => {
        const active = subset.filter(t => t.cmd);
        if (active.length === 0) {
          console.log(`  ⏭ Group "${label}" — no active tasks`);
          return;
        }

        console.log(`\n── ${label} ──────────────────────────────────`);
        console.log(`  Tasks: ${active.length} | Concurrency: ${concurrency}`);

        let nextIdx = 0;
        const errors = [];

        const worker = async () => {
          while (nextIdx < subset.length) {
            const idx = nextIdx++;
            const task = subset[idx];
            if (!task.cmd) continue;
            try {
              await runner.runWithRetry(task, idx + 1, tasks.length);
            } catch (err) {
              errors.push({ task, err });
            }
          }
        };

        const pool = Array.from({ length: Math.min(concurrency, active.length) }, () => worker());
        await Promise.all(pool);

        // Process failures after all tasks finish — critical check at end
        for (const { task, err } of errors) {
          runner.failedTasks.push({ name: task.name, error: err.message });
          logger.error(task.name, err);
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          console.error(`  ✗ ${task.name} (${elapsed}s)`);
          console.error(`    → ${err.message}`);
          if (task.critical) {
            throw new Error('Critical "' + task.name + '" failed: ' + err.message);
          }
          console.log(`    → Continuing (non-critical)...`);
        }
      };

      // ─── Phase 1: Distiller + Collector + Reflection (max 2 AI) ─
      await runGroup([byName('Distiller'), byName('Learning Collector'), byName('Reflection Engine')], 'Extract', 2);

      // ─── Phase 2: Inbox Processor (tunggu distiller selesai) ────
      await runGroup([byName('Inbox Processor')], 'Inbox', 1);

      // ─── Phase 3: Synthesizers (max 2 AI) ───────────────────────
      await runGroup([byName('Learning Synthesizer'), byName('Reflection Synthesizer')], 'Synthesize', 2);

      // ─── Phase 4: Linker (single, AI-heavy) ─────────────────────
      await runGroup([byName('Semantic Linker')], 'Linker', 1);

      // ─── Phase 5: Indexer + Memory Sync (non-AI, parallel) ──────
      await runGroup([byName('Graph Indexer'), byName('Memory Sync')], 'Index & Sync', 2);

      // ─── Phase 6: Graph View (non-AI) ───────────────────────────
      await runGroup([byName('Graph View')], 'Graph View', 1);

      // ─── Pipeline Complete ──────────────────────────────────────
      const totalTime = ((Date.now() - startedAt) / 1000).toFixed(1);
      const allSuccess = runner.failedTasks.length === 0;

      statusManager.write(allSuccess ? 'completed' : 'completed_with_errors', {
        durationSeconds: totalTime,
        completedTasks: runner.completedTasks,
        failedTasks: runner.failedTasks,
        totalTasks: tasks.length,
      });

      clearTimeout(pipelineTimer);
      lockManager.removeLock();

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      if (allSuccess) {
        console.log(`  ✅ COMPLETED (${totalTime}s)`);
      } else {
        console.log(`  ⚠️  COMPLETED WITH ERRORS (${totalTime}s)`);
        console.log(`  Failed: ${runner.failedTasks.map(t => t.name).join(', ')}`);
      }
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    } catch (error) {
      const totalTime = ((Date.now() - startedAt) / 1000).toFixed(1);
      logger.error('Critical Background Handler', error);
      statusManager.write('failed', {
        error: error.message,
        durationSeconds: totalTime,
        failedTasks: runner.failedTasks,
      });
      clearTimeout(pipelineTimer);
      lockManager.removeLock();

      console.error(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.error(`  ❌ FATAL ERROR (${totalTime}s)`);
      console.error(`  ${error.message}`);
      console.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    }
  })();

  // ─── Completion message (only delivered on replyable surfaces) ──
  if (isCompactEvent) {
    // lifecycle-only events ignore messages; log only
    console.log('  ✅ Hook completed for session:compact:before');
  } else {
    event.messages.push('✅ New session started. Memory sync is running in the background...');
  }
};

module.exports = handler;
