const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DATASET_DIR = path.join(__dirname, 'dataset');
const CLEAN_DATASET_DIR = path.join(__dirname, 'clean_dataset');
const EN_DB_PATH = path.join(__dirname, 'db_source', 'en_sermons_vogr.sqlite');
const TA_DB_PATH = path.join(__dirname, 'db_source', 'ta_sermons_vogr.sqlite');

// Ensure clean dataset directory exists
if (!fs.existsSync(CLEAN_DATASET_DIR)) {
    fs.mkdirSync(CLEAN_DATASET_DIR, { recursive: true });
}

const enDb = new sqlite3.Database(EN_DB_PATH, sqlite3.OPEN_READONLY);
const taDb = new sqlite3.Database(TA_DB_PATH, sqlite3.OPEN_READONLY);

const report = {
    totalSermonsProcessed: 0,
    totalParagraphsProcessed: 0,
    totalValidParagraphs: 0,
    dropped: {
        missingEnglish: 0,
        missingTamil: 0,
        duplicates: 0,
        unmatchedLabel: 0
    },
    droppedDetails: [] // { sermonId, type, english, tamil }
};

const seenPairs = new Set();

// Pre-load all paragraphs into memory to avoid 800+ individual DB queries which might be slow over SQLite
let allEnParagraphs = [];
let allTaParagraphs = [];

const loadAllParagraphs = () => {
    return new Promise((resolve, reject) => {
        console.log("Loading all English paragraphs into memory...");
        enDb.all('SELECT sermon_id, paragraph_label, text FROM paragraphs', [], (err, rows) => {
            if (err) return reject(err);
            allEnParagraphs = rows || [];
            
            console.log("Loading all Tamil paragraphs into memory...");
            taDb.all('SELECT sermon_id, paragraph_label, TEXT as text FROM tamil_paragraphs', [], (err, rows2) => {
                if (err) return reject(err);
                allTaParagraphs = rows2 || [];
                resolve();
            });
        });
    });
};

const getEnParagraphs = (sermonId) => {
    return allEnParagraphs.filter(r => r.sermon_id === sermonId);
};

const getTaParagraphs = (sermonId) => {
    return allTaParagraphs.filter(r => r.sermon_id === sermonId);
};

// Helper to normalize text for matching
const normalize = (str) => {
    if (!str) return '';
    return str.trim().replace(/\s+/g, ' ').toLowerCase();
};

async function processDataset() {
    await loadAllParagraphs();
    
    const files = fs.readdirSync(DATASET_DIR).filter(f => f.startsWith('sermon_') && f.endsWith('.json'));
    console.log(`Starting processing of ${files.length} files...`);
    report.totalSermonsProcessed = 0; // Fix: start at 0, increment later

    for (const file of files) {
        const filePath = path.join(DATASET_DIR, file);
        const sermonData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const sermonId = sermonData.sermon_id;

        if (report.totalSermonsProcessed % 10 === 0) {
            console.log(`Processed ${report.totalSermonsProcessed} / ${files.length} sermons...`);
        }
        
        const enRows = getEnParagraphs(sermonId);
        const taRows = getTaParagraphs(sermonId);

        // Create lookup maps based on normalized text
        // Instead of exact match, we just match the first 50 chars to avoid minor punctuation diffs
        const getPrefix = (str) => str.substring(0, 50);
        
        const enTextToLabel = new Map();
        enRows.forEach(r => enTextToLabel.set(getPrefix(normalize(r.text)), r.paragraph_label));

        const taTextToLabel = new Map();
        taRows.forEach(r => taTextToLabel.set(getPrefix(normalize(r.text)), r.paragraph_label));

        const cleanParagraphs = [];

        for (const p of sermonData.paragraphs) {
            report.totalParagraphsProcessed++;

            const enText = normalize(p.english);
            const taText = normalize(p.tamil);

            // 1. Check for missing content
            if (!enText) {
                report.dropped.missingEnglish++;
                report.droppedDetails.push({ sermonId, type: 'missingEnglish', english: p.english, tamil: p.tamil });
                continue;
            }
            if (!taText) {
                report.dropped.missingTamil++;
                report.droppedDetails.push({ sermonId, type: 'missingTamil', english: p.english, tamil: p.tamil });
                continue;
            }

            // 2. Check for duplicates across the entire corpus
            const pairKey = `${enText}|||${taText}`;
            if (seenPairs.has(pairKey)) {
                report.dropped.duplicates++;
                report.droppedDetails.push({ sermonId, type: 'duplicate', english: p.english, tamil: p.tamil });
                continue;
            }

            // 3. Attempt to find the original paragraph label
            // We prioritize the English label, fallback to Tamil label
            let label = enTextToLabel.get(getPrefix(enText));
            if (!label) {
                label = taTextToLabel.get(getPrefix(taText));
            }

            // If we still can't find a label, we might drop it or keep it with a generated label.
            // For a pristine reference corpus, we want exact matches to the DB.
            if (!label) {
                report.dropped.unmatchedLabel++;
                report.droppedDetails.push({ sermonId, type: 'unmatchedLabel', english: p.english, tamil: p.tamil });
                // We will still keep it but mark label as unknown, or we can drop it.
                // Let's keep it with a null label for now, but flag it.
            }

            seenPairs.add(pairKey);
            report.totalValidParagraphs++;
            
            cleanParagraphs.push({
                paragraph_label: label || null,
                english: p.english,
                tamil: p.tamil
            });
        }

        // Write the clean sermon file
        const cleanSermonData = {
            sermon_id: sermonId,
            paragraphs: cleanParagraphs
        };
        fs.writeFileSync(
            path.join(CLEAN_DATASET_DIR, file),
            JSON.stringify(cleanSermonData, null, 2)
        );
        
        report.totalSermonsProcessed++;
    }

    // Write the report
    fs.writeFileSync(
        path.join(__dirname, 'data-quality-report.json'),
        JSON.stringify(report, null, 2)
    );

    console.log('Dataset preparation complete.');
    console.log(`Processed ${report.totalSermonsProcessed} sermons.`);
    console.log(`Total paragraphs: ${report.totalParagraphsProcessed}`);
    console.log(`Valid paragraphs retained: ${report.totalValidParagraphs}`);
    console.log(`Dropped - Missing English: ${report.dropped.missingEnglish}`);
    console.log(`Dropped - Missing Tamil: ${report.dropped.missingTamil}`);
    console.log(`Dropped - Duplicates: ${report.dropped.duplicates}`);
    console.log(`Flagged - Unmatched Labels: ${report.dropped.unmatchedLabel}`);

    enDb.close();
    taDb.close();
}

processDataset().catch(console.error);
