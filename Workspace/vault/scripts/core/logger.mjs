import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');
const LOGS_DIR = path.join(WORKSPACE_ROOT, 'vault', 'logs');

export function logError(scriptName, error) {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  
  const timestamp = new Date().toISOString();
  
  // Safely extract error message and stack
  let errorMessage = 'Unknown error';
  let errorStack = '';
  
  if (error instanceof Error) {
    errorMessage = error.message;
    errorStack = error.stack || '';
  } else if (typeof error === 'string') {
    errorMessage = error;
  } else if (error && typeof error === 'object') {
    errorMessage = error.message || JSON.stringify(error);
    errorStack = error.stack || '';
  }
  
  const logMessage = `[${timestamp}] [${scriptName}] ERROR: ${errorMessage}\n${errorStack}\n${'-'.repeat(40)}\n`;
  const logFile = path.join(LOGS_DIR, 'errors.log');
  
  fs.appendFileSync(logFile, logMessage, 'utf8');
  console.error(`❌ Error logged to ${logFile}`);
}

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

export const log = {
  info: (msg) => console.log(`${colors.cyan}${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}${msg}${colors.reset}`),
  step: (msg) => console.log(`${colors.magenta}${msg}${colors.reset}`),
  debug: (msg) => console.log(`${colors.dim}${msg}${colors.reset}`),
  title: (msg) => console.log(`\n${colors.bold}${colors.blue}=== ${msg} ===${colors.reset}\n`),
  plain: (msg) => console.log(msg),
};
