import fs from 'fs';
import path from 'path';
import { logError, log } from '../core/logger.mjs';

const INBOX_PATH = path.join('./vault', '00_inbox');
const THINKING_PATH = path.join('./vault', '01_thinking');
const KNOWLEDGE_PATH = path.join(THINKING_PATH, 'knowledge');
const REFERENCE_PATH = path.join('./vault', '02_reference');

// Kata kunci yang dianggap generik (bukan klaim pengetahuan)
const GENERIC_KEYWORDS = ['raw', 'data', 'test', 'catatan', 'note', 'temp', 'dump', 'input', 'untitled', 'document'];

function processInbox() {
    try {
        if (!fs.existsSync(INBOX_PATH)) {
            log.warn(`[ProcessInbox] Inbox directory not found: ${INBOX_PATH}`);
            return;
        }

        if (!fs.existsSync(KNOWLEDGE_PATH)) {
            fs.mkdirSync(KNOWLEDGE_PATH, { recursive: true });
        }

        const files = fs.readdirSync(INBOX_PATH);

        if (files.length === 0) {
            log.info('[ProcessInbox] Inbox is empty. Nothing to process.');
            return;
        }

        let movedCount = 0;
        let skippedCount = 0;

        for (const file of files) {
            // Abaikan folder archive dan file yang sudah diproses
            if (file === 'archive' || file.startsWith('[PROCESSED]_')) {
                skippedCount++;
                continue;
            }

            const oldPath = path.join(INBOX_PATH, file);
            const baseName = path.basename(file, '.md').toLowerCase();
            let fileName = file;
            
            // Tentukan folder tujuan berdasarkan prefix
            let destinationPath = KNOWLEDGE_PATH;
            if (baseName.startsWith('ref-')) {
                destinationPath = REFERENCE_PATH;
                log.info(`[ProcessInbox] Reference detected: "${file}" → reference vault.`);
            } else {
                // LOGIKA DETEKSI KLAIM (Hanya untuk file non-referensi)
                
                // 1. Cek apakah mengandung kata kunci generik
                const hasGenericKeyword = GENERIC_KEYWORDS.some(kw => baseName.includes(kw));
                
                // 2. Cek apakah terlalu pendek (Klaim biasanya adalah kalimat/pernyataan)
                const isTooShort = baseName.length < 12;
                
                // 3. Cek apakah tidak memiliki pemisah (terlalu sederhana)
                const lacksSeparators = !baseName.includes('-') && !baseName.includes('_');

                // Jika memenuhi salah satu kriteria di atas, maka dianggap BUKAN klaim
                if (hasGenericKeyword || isTooShort || lacksSeparators) {
                    fileName = `[NEEDS_CLAIM]_${file}`;
                    log.warn(`[ProcessInbox] "${file}" is generic. Adding [NEEDS_CLAIM] tag.`);
                } else {
                    log.info(`[ProcessInbox] Valid claim: "${file}"`);
                }
            }

            const newPath = path.join(destinationPath, fileName);
            
            try {
                // Jika file tujuan sudah ada, tambahkan timestamp agar tidak overwrite
                let finalPath = newPath;
                if (fs.existsSync(newPath)) {
                    const timestamp = Date.now();
                    finalPath = path.join(destinationPath, `${path.basename(fileName, '.md')}_${timestamp}.md`);
                }
                
                // Memindahkan file langsung ke tujuan agar tidak terjadi duplikasi indeks
                fs.renameSync(oldPath, finalPath);
                log.success(`[ProcessInbox] Moved: ${file} → ${path.basename(finalPath)}`);
                movedCount++;

            } catch (err) {
                log.error(`[ProcessInbox] Failed to process ${file}: ${err.message}`);
                logError('process-inbox.mjs (File Move)', err);
            }
        }

        log.info(`[ProcessInbox] Done. Moved: ${movedCount}, Skipped: ${skippedCount}`);
    } catch (err) {
        log.error(`[ProcessInbox] ❌ Fatal error: ${err.message}`);
        logError('process-inbox.mjs', err);
        process.exit(1);
    }
}

processInbox();
