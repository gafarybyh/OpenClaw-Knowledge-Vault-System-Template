import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError, log } from '../core/logger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');

const MEMORY_FILE = path.join(WORKSPACE_ROOT, 'MEMORY.md');
const MOC_PATH = path.join(WORKSPACE_ROOT, 'vault', '01_thinking', 'moc');
const CREATING_PATH = path.join(WORKSPACE_ROOT, 'vault', '03_creating');
const PUBLISHED_PATH = path.join(WORKSPACE_ROOT, 'vault', '04_published');

function updateMemory() {
    try {
        if (!fs.existsSync(MEMORY_FILE)) {
            log.error("Cannot find MEMORY.md. Please create the file first.");
            process.exit(1);
        }

        let content = fs.readFileSync(MEMORY_FILE, 'utf-8');
        const now = new Date().toISOString().split('T')[0];

        // 1. Update Timestamp
        content = content.replace(/>\s*\*\*Agent:\*\*.*\| \*\*Updated:\*\* .*/, `> **Updated:** ${now}`);

        // 2. Sync Vault Map (Global Pointers)
        const vaultMap = `## Vault Map
| Folder | Purpose | Pointer |
|--------|---------|---------|
| Inbox | Raw Input | \`vault/00_inbox/\` |
| Thinking | Synthesis & MOCs | \`vault/01_thinking/\` |
| Knowledge | Atomic Concepts | \`vault/01_thinking/knowledge/\` |
| Reference | Static Library | \`vault/02_reference/\` |
| Creating | Drafts & Work | \`vault/03_creating/\` |
| Published | Finalized | \`vault/04_published/\` |
| Archive | Obsolete | \`vault/05_archive/\` |
| System | Maintenance & Philosophy | \`vault/06_system/\` |
| Scripts | Automation & Graph Tools | \`vault/scripts/\` |
| Workers | Sub-agent Skill Definitions | \`vault/workers/\` |
| Logs | Execution Logs | \`vault/logs/\` |
`;
        const mapRegex = /## Vault Map\n[\s\S]*?(?=\n##|$)/;
        if (mapRegex.test(content)) {
            content = content.replace(mapRegex, vaultMap);
        } else {
            // Insert after Header/Timestamp and before Active Projects
            content = content.replace(/(\n\n## Active Projects)/, `\n\n${vaultMap}\n$1`);
        }

        // 3. Sync Active Projects from MOCs (Thinking)
        if (fs.existsSync(MOC_PATH)) {
            const files = fs.readdirSync(MOC_PATH).filter(f => f.endsWith('-MOC.md'));
            let projectTable = '| Project | Status | Pointer |\n|---------|--------|---------|';
            if (files.length > 0) {
                files.forEach(file => {
                    const projectName = file.replace('-MOC.md', '').replace(/_/g, ' ');
                    projectTable += `\n| ${projectName} | Active | \`vault/01_thinking/moc/${file}\``;
                });
            } else {
                projectTable += `\n| No active projects | - | - |`;
            }
            const regex = /## Active Projects\n[\s\S]*?(?=\n##|$)/;
            content = content.replace(regex, `## Active Projects\n${projectTable}\n`);
        }

        // 4. Sync Current Drafts (Creating)
        if (fs.existsSync(CREATING_PATH)) {
            const allFiles = fs.readdirSync(CREATING_PATH).filter(f => f.endsWith('.md'));
            let draftTable = '| Draft | Status | Pointer |\n|-------|--------|---------|';
            if (allFiles.length > 0) {
                const files = allFiles
                    .map(f => ({
                        name: f,
                        mtime: fs.statSync(path.join(CREATING_PATH, f)).mtimeMs
                    }))
                    .sort((a, b) => b.mtime - a.mtime)
                    .slice(0, 7); // Cap at 7 most recent drafts

                files.forEach(file => {
                    const name = path.basename(file.name, '.md').replace(/_/g, ' ');
                    draftTable += `\n| ${name} | In Progress | \`vault/03_creating/${file.name}\``;
                });
            } else {
                draftTable += `\n| No drafts found | - | - |`;
            }

            const regex = /## Current Drafts\n[\s\S]*?(?=\n##|$)/;
            if (regex.test(content)) {
                content = content.replace(regex, `## Current Drafts\n${draftTable}\n`);
            } else {
                content = content.replace(/## Key People/, `## Current Drafts\n${draftTable}\n\n## Key People`);
            }
        }

        // 5. Sync Recent Published (Published - Capped to 10)
        if (fs.existsSync(PUBLISHED_PATH)) {
            const allFiles = fs.readdirSync(PUBLISHED_PATH).filter(f => f.endsWith('.md'));
            let publishedTable = '| Work | Date | Pointer |\n|------|------|---------|';

            if (allFiles.length > 0) {
                const files = allFiles
                    .map(f => ({
                        name: f,
                        mtime: fs.statSync(path.join(PUBLISHED_PATH, f)).mtimeMs
                    }))
                    .sort((a, b) => b.mtime - a.mtime)
                    .slice(0, 10);

                files.forEach(f => {
                    const date = new Date(f.mtime).toISOString().split('T')[0];
                    const name = f.name.replace('.md', '').replace(/_/g, ' ');
                    publishedTable += `\n| ${name} | ${date} | \`vault/04_published/${f.name}\``;
                });
            } else {
                publishedTable += `\n| No published work found | - | - |`;
            }

            const regex = /## Recent Published\n[\s\S]*?(?=\n##|$)/;
            if (regex.test(content)) {
                content = content.replace(regex, `## Recent Published\n${publishedTable}\n`);
            } else {
                content = content.replace(/## Key Tools/, `## Recent Published\n${publishedTable}\n\n## Key Tools`);
            }
        }


        fs.writeFileSync(MEMORY_FILE, content);
        log.info(`MEMORY.md successfully updated at ${now}`);
    } catch (err) {
        console.error('Fatal Error updating memory:', err.message);
        logError('update-memory.mjs', err);
        process.exit(1);
    }
}

updateMemory();
