# Dataset Inspection Report

## 1. Existing Project Architecture
The workspace is organized into several directories:
- `dataset/`: Contains the approved bilingual translations and glossaries.
- `db_source/`: Contains the source SQLite databases for English and Tamil sermons.
- `GoogleGemini/`: The current working directory containing the translation plan (`GeminiTranslatePlan.txt`) and API keys (`Key.secure.txt`).

## 2. Existing SQLite Database Structure
The source databases are located in `db_source/`:
- **English Database** (`en_sermons_vogr.sqlite`):
  - `sermons` table: `id`, `title`, `date`, `year`, `duration`, `location`, `session`, `vogr_sid`, `total_paragraphs`.
  - `paragraphs` table: `id`, `sermon_id`, `paragraph_label`, `text`, `html`.
- **Tamil Database** (`ta_sermons_vogr.sqlite`):
  - `tamil_sermons` table: `id`, `title`, `series`, `DATE`, `YEAR`, `duration`, `location`, `SESSION`, `vogr_sid`, `total_paragraphs`.
  - `tamil_paragraphs` table: `id`, `sermon_id`, `paragraph_label`, `TEXT`, `html`.

## 3. Location and Format of Approved English-Tamil Translations
- **Location**: `dataset/` directory.
- **Format**: 419 individual JSON files named `sermon_{id}.json`.
- **Structure**: Each file contains a `sermon_id` and an array of `paragraphs`, where each paragraph is an object with `english` and `tamil` text fields.
- **Additional Files**: `parallel_dataset.json` (144 MB), `translation_memory.json` (1.6 MB), `glossary.json`, and `phrase_glossary.json`.

## 4. Location and Format of Pending English Sermons
- **Location**: `db_source/en_sermons_vogr.sqlite`.
- **Format**: SQLite database records in the `sermons` and `paragraphs` tables.

## 5. Total Number of Records
- **English Database**: 1,217 sermons, 104,786 paragraphs.
- **Tamil Database**: 151 sermons, 16,185 paragraphs.
- **Dataset (Approved Translations)**: 419 sermons, 80,761 paragraphs.
- **Pending English Sermons**: 799 sermons awaiting translation.

## 6. File Sizes
- **Dataset Directory**: ~306 MB total.
- **parallel_dataset.json**: 144 MB.
- **en_sermons_vogr.sqlite**: 390 MB.
- **ta_sermons_vogr.sqlite**: 519 MB.

## 7. Duplicate Records
- **Dataset**: 82 non-empty duplicate paragraphs found across the 419 approved sermon JSON files.

## 8. Missing English or Tamil Content
- **Dataset**: 
  - 4,840 paragraphs are missing English content or have empty strings.
  - 452 paragraphs are missing Tamil content or have empty strings.

## 9. Sermon IDs and Paragraph Numbering
- **Sermon IDs**: Formatted as `YY-MMDD` (e.g., `47-0412`, `65-1212`). Some include session suffixes like `M`, `E`, `S` (e.g., `53-0405S`).
- **Paragraph Numbering**: Paragraphs are tracked using `paragraph_label` in the SQLite databases, which maintains the original sequence and numbering.
