const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

// ─── Configuration ─────────────────────────────────────────────────
const CONFIG = {
  LOCK_STALE_MS: 60 * 60 * 1000,        // 1 hour
  TASK_TIMEOUT_MS: 10 * 60 * 1000,      // 10 minutes
  MAX_BUFFER: 50 * 1024 * 1024,         // 50MB
  RETRY_ATTEMPTS: 1,
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
    console.error('[memory-sync] Failed to write JSON:', err.message);
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
    if (!fs.existsSync(this.lockFile)) return false;

    const lock = safeReadJson(this.lockFile);
    if (!lock || !lock.startedAt) {
      this.removeLock();
      return false;
    }

    const age = Date.now() - new Date(lock.startedAt).getTime();

    // Check if process is still alive
    if (lock.pid && isProcessAlive(lock.pid)) {
      return true;
    }

    // Stale lock detection
    if (age > CONFIG.LOCK_STALE_MS) {
      console.warn('[memory-sync] Removing stale lock (age: ' + (age / 1000 / 60).toFixed(1) + ' min)');
      this.removeLock();
      return false;
    }

    // Process dead but lock not stale yet — wait a bit
    return true;
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
      console.error('[memory-sync] Remove lock failed:', err.message);
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
      console.error('[memory-sync] Log write failed:', e.message);
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
          console.log(`[memory-sync] ↻ Retrying ${task.name} (attempt ${attempt + 1}/${this.config.RETRY_ATTEMPTS})...`);
          await this.delay(this.config.RETRY_DELAY_MS);
        }
      }
    }
    throw lastError;
  }

  async runOnce(task, index, total) {
    if (!task.cmd) {
      console.log(`[memory-sync] (${index}/${total}) ⏭ ${task.name} skipped`);
      return { skipped: true };
    }

    // Validate script exists before running
    const scriptMatch = task.cmd.match(/node\s+"([^"]+)"/);
    if (scriptMatch) {
      validateScript(scriptMatch[1]);
    }

    this.statusManager.write('running', {
      currentTask: task.name,
      currentStep: index,
      totalSteps: total,
      progress: Number((((index - 1) / total) * 100).toFixed(1)),
    });

    const started = Date.now();
    console.log(`\n${'━'.repeat(40)}`);
    console.log(`[memory-sync] (${index}/${total}) ▶ Starting ${task.name}`);

    const { stdout, stderr } = await execAsync(task.cmd, {
      cwd: this.workspaceDir,
      timeout: this.config.TASK_TIMEOUT_MS,
      maxBuffer: this.config.MAX_BUFFER,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
      },
    });

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[memory-sync] ✓ ${task.name} completed (${elapsed}s)`);

    if (stdout?.trim()) console.log(stdout.trim());
    if (stderr?.trim()) console.warn(`[memory-sync] ⚠ ${task.name} stderr:`, stderr.trim());

    this.completedTasks.push(task.name);
    return { success: true, stdout, stderr };
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

// ─── Main Handler ───────────────────────────────────────────────────
const handler = async (event) => {
  // Validate event structure
  if (!event) {
    throw new Error('Event object is required');
  }
  if (!Array.isArray(event.messages)) {
    event.messages = [];
  }

  const workspaceDir = event.context?.workspaceDir || process.cwd();

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

  // ─── Signal Handlers for Cleanup ─────────────────────────────────
  const cleanup = () => {
    console.log('\n[memory-sync] Received termination signal, cleaning up...');
    lockManager.removeLock();
    statusManager.write('interrupted', { reason: 'signal' });
    process.exit(1);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('uncaughtException', (err) => {
    console.error('[memory-sync] Uncaught Exception:', err);
    logger.error('UncaughtException', err);
    lockManager.removeLock();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[memory-sync] Unhandled Rejection:', reason);
    logger.error('UnhandledRejection', new Error(String(reason)));
  });

  // ─── Check Lock ──────────────────────────────────────────────────
  if (lockManager.isLocked()) {
    const lockInfo = safeReadJson(LOCK_FILE, {});
    const msg = `⚠️ Memory sync already running (PID: ${lockInfo.pid || 'unknown'}).`;
    console.log(`[memory-sync] ${msg}`);
    event.messages.push(msg);
    return;
  }

  // ─── Build Task List ─────────────────────────────────────────────
  const prevSession = event.context?.previousSessionEntry;
  const scriptsDir = path.join(workspaceDir, 'vault', 'scripts');

  const tasks = [
    {
      name: 'Distiller',
      cmd: prevSession?.sessionFile
        ? `node "${scriptsDir}/graph/distiller.mjs" "${prevSession.sessionFile}"`
        : null,
      critical: false,
    },
    {
      name: 'Learning Collector',
      cmd: prevSession?.sessionFile
        ? `node "${scriptsDir}/learning/learning-collector.mjs" "${prevSession.sessionFile}"`
        : null,
      critical: false,
    },
    {
      name: 'Learning Synthesizer',
      cmd: `node "${scriptsDir}/learning/learning-synthesizer.mjs"`,
      critical: false,
    },
    {
      name: 'Reflection Engine',
      cmd: prevSession?.sessionFile
        ? `node "${scriptsDir}/learning/reflection.mjs" "${prevSession.sessionFile}"`
        : null,
      critical: false,
    },
    {
      name: 'Reflection Synthesizer',
      cmd: `node "${scriptsDir}/learning/reflection-synthesizer.mjs"`,
      critical: false,
    },
    {
      name: 'Inbox Processor',
      cmd: `node "${scriptsDir}/maintenance/process-inbox.mjs"`,
      critical: false,
    },
    {
      name: 'Semantic Linker',
      cmd: `node "${scriptsDir}/graph/linker.mjs"`,
      critical: false,
    },
    {
      name: 'Graph Indexer',
      cmd: `node "${scriptsDir}/graph/indexer.mjs"`,
      critical: false,
    },
    {
      name: 'Memory Sync',
      cmd: `node "${scriptsDir}/maintenance/update-memory.mjs"`,
      critical: true, // This one is critical
    },
    {
      name: 'Graph View',
      cmd: `node "${scriptsDir}/maintenance/generate-graph-html.mjs"`,
      critical: false, // This one is critical
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

  console.log(`\n${'═'.repeat(40)}`);
  console.log('[memory-sync] Starting sync pipeline');
  console.log(`[memory-sync] Tasks: ${tasks.filter(t => t.cmd).length} active / ${tasks.length} total`);
  console.log(`${'═'.repeat(40)}\n`);

  // Execute pipeline in background
  (async () => {
    try {
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        try {
          await runner.runWithRetry(task, i + 1, tasks.length);
        } catch (err) {
          runner.failedTasks.push({ name: task.name, error: err.message });
          logger.error(task.name, err);

          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          console.error(`[memory-sync] ✗ ${task.name} failed (${elapsed}s)`);
          console.error(`[memory-sync]   → ${err.message}`);

          if (task.critical) {
            throw new Error(`Critical task "${task.name}" failed: ${err.message}`);
          }

          console.log(`[memory-sync]   → Continuing (non-critical task)...`);
        }
      }

      const totalTime = ((Date.now() - startedAt) / 1000).toFixed(1);
      const allSuccess = runner.failedTasks.length === 0;

      statusManager.write(allSuccess ? 'completed' : 'completed_with_errors', {
        durationSeconds: totalTime,
        completedTasks: runner.completedTasks,
        failedTasks: runner.failedTasks,
        totalTasks: tasks.length,
      });

      lockManager.removeLock();

      console.log(`\n${'═'.repeat(40)}`);
      if (allSuccess) {
        console.log(`[memory-sync] ✓ COMPLETED (${totalTime}s)`);
      } else {
        console.log(`[memory-sync] ⚠ COMPLETED WITH ERRORS (${totalTime}s)`);
        console.log(`[memory-sync] Failed: ${runner.failedTasks.map(t => t.name).join(', ')}`);
      }
      console.log(`${'═'.repeat(40)}\n`);
    } catch (error) {
      const totalTime = ((Date.now() - startedAt) / 1000).toFixed(1);
      logger.error('Critical Background Handler', error);
      statusManager.write('failed', {
        error: error.message,
        durationSeconds: totalTime,
        failedTasks: runner.failedTasks,
      });
      lockManager.removeLock();

      console.error(`\n${'═'.repeat(40)}`);
      console.error(`[memory-sync] ✗ FATAL ERROR (${totalTime}s)`);
      console.error(`[memory-sync] ${error.message}`);
      console.error(`${'═'.repeat(40)}\n`);
    }
  })();

  event.messages.push('🔄 New session started. Memory sync is running in the background...');
};

module.exports = handler;