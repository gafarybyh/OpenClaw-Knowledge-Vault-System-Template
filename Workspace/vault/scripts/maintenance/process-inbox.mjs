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
            log.error(`Error: ${INBOX_PATH} tidak ditemukan.`);
            process.exit(0);
        }

        if (!fs.existsSync(KNOWLEDGE_PATH)) {
            fs.mkdirSync(KNOWLEDGE_PATH, { recursive: true });
        }

        const files = fs.readdirSync(INBOX_PATH);

        if (files.length === 0) {
            log.info("Inbox kosong. Tidak ada yang perlu diproses.");
            process.exit(0);
        }

        files.forEach(file => {
            // Abaikan folder archive dan file yang sudah diproses
            if (file === 'archive' || file.startsWith('[PROCESSED]_')) {
                return;
            }

            const oldPath = path.join(INBOX_PATH, file);
            const baseName = path.basename(file, '.md').toLowerCase();
            let fileName = file;
            
            // Tentukan folder tujuan berdasarkan prefix
            let destinationPath = KNOWLEDGE_PATH;
            if (baseName.startsWith('ref-')) {
                destinationPath = REFERENCE_PATH;
                log.info(`Reference detected: "${file}" will be moved to reference vault.`);
            } else {
                // LOGIKA DETEKSI KLAIM (Hanya untuk file non-referensi)
                
                // 1. Cek apakah mengandung kata kunci generik
                const hasGenericKeyword = GENERIC_KEYWORDS.some(keyword => baseName.includes(keyword));
                
                // 2. Cek apakah terlalu pendek (Klaim biasanya adalah kalimat/pernyataan)
                const isTooShort = baseName.length < 12;
                
                // 3. Cek apakah tidak memiliki pemisah (terlalu sederhana)
                const lacksSeparators = !baseName.includes('-') && !baseName.includes('_');

                // Jika memenuhi salah satu kriteria di atas, maka dianggap BUKAN klaim
                if (hasGenericKeyword || isTooShort || lacksSeparators) {
                    fileName = `[NEEDS_CLAIM]_${file}`;
                    log.info(`Warning: "${file}" terdeteksi generik. Menambahkan tag [NEEDS_CLAIM].`);
                } else {
                    log.info(`Valid Claim: "${file}" memenuhi standar penamaan.`);
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
                log.info(`Berhasil memindahkan: ${file} -> ${path.basename(finalPath)}`);

            } catch (err) {
                log.error(`Gagal memproses ${file}: ${err.message}`);
                logError('process-inbox.mjs (File Move)', err);
            }
        });
    } catch (err) {
        console.error('Fatal Error processing inbox:', err.message);
        logError('process-inbox.mjs', err);
        process.exit(1);
    }
}

processInbox();
