#!/usr/bin/env node

/**
 * Migration Script: Airtable → Supabase
 *
 * Migrates 300 Gutachten score records from Airtable (Gutachten_Scores)
 * into Supabase (gutachten table).
 *
 * Airtable structure:
 *   - Gutachten Titel, Anzahl, Formaler Aufbau, Darstellung Befund...,
 *     Fachlicher Inhalt, Bodenwertermittlung, Ertragswertberechnung,
 *     Sachwertberechnung, Vergleichswertberechnung, Zusammenfassung,
 *     Meta Link, Ranking
 *   - All scores are pure numbers (no text extraction needed)
 *   - No AG field — all records belong to one Abonnement
 *
 * Usage:
 *   node scripts/migrate-airtable-to-supabase.js --dry-run   # Preview
 *   node scripts/migrate-airtable-to-supabase.js              # Live migration
 *
 * Required ENV vars:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Config ───────────────────────────────────────────────────────────

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Gutachten_Scores';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Airtable → Supabase Field Mapping ────────────────────────────────

const SCORE_FIELD_MAP = {
  'Formaler Aufbau':                             'formaler_aufbau_score',
  'Darstellung Befund und Anknuepfungstatsachen': 'darstellung_befund_score',
  'Fachlicher Inhalt':                           'fachlicher_inhalt_score',
  'Bodenwertermittlung':                         'bodenwertermittlung_score',
  'Ertragswertberechnung':                       'ertragswertberechnung_score',
  'Sachwertberechnung':                          'sachwertberechnung_score',
  'Vergleichswertberechnung':                    'vergleichswertberechnung_score',
  'Zusammenfassung':                             'zusammenfassung_score',
};

// ── Validate Config ──────────────────────────────────────────────────

function validateConfig() {
  const missing = [];
  if (!AIRTABLE_API_KEY) missing.push('AIRTABLE_API_KEY');
  if (!AIRTABLE_BASE_ID) missing.push('AIRTABLE_BASE_ID');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');

  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ── Airtable API ─────────────────────────────────────────────────────

async function fetchAirtableRecords() {
  const allRecords = [];
  let offset = null;

  console.log(`[airtable] Fetching from "${AIRTABLE_TABLE_NAME}"...`);

  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`);
    if (offset) url.searchParams.set('offset', offset);

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Airtable API error ${response.status}: ${body}`);
    }

    const data = await response.json();
    allRecords.push(...data.records);
    offset = data.offset || null;

    console.log(`[airtable] ${allRecords.length} records...`);
  } while (offset);

  console.log(`[airtable] Total: ${allRecords.length} records\n`);
  return allRecords;
}

// ── Transform Record ─────────────────────────────────────────────────

function transformRecord(atRecord) {
  const fields = atRecord.fields;
  const row = {};

  // Use Airtable record ID as unique identifier for migrated data
  row.fillout_submission_id = `migration_${atRecord.id}`;

  // Gutachten Titel → pdf_filename
  row.pdf_filename = fields['Gutachten Titel'] || null;

  // Ranking from Airtable (already calculated)
  const ranking = fields['Ranking'];

  // Map all score fields (pure numbers)
  for (const [atField, sbField] of Object.entries(SCORE_FIELD_MAP)) {
    const value = fields[atField];
    row[sbField] = (value !== undefined && value !== null && value !== '')
      ? parseFloat(value)
      : null;
  }

  // Calculate gesamtscore (average of 7 evaluation scores, excluding zusammenfassung)
  const evalScores = [
    row.formaler_aufbau_score,
    row.darstellung_befund_score,
    row.fachlicher_inhalt_score,
    row.bodenwertermittlung_score,
    row.ertragswertberechnung_score,
    row.sachwertberechnung_score,
    row.vergleichswertberechnung_score,
  ].filter(s => s !== null && s !== undefined && !isNaN(s));

  row.gesamtscore = evalScores.length > 0
    ? Math.round((evalScores.reduce((a, b) => a + b, 0) / evalScores.length) * 10) / 10
    : null;

  // Status for migrated records
  row.status = 'Geprüft';

  return { row, ranking };
}

// ── Supabase Insert ──────────────────────────────────────────────────

async function insertToSupabase(supabase, rows) {
  console.log(`[supabase] Inserting ${rows.length} gutachten records...`);

  const BATCH_SIZE = 50;
  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const { data, error } = await supabase
      .from('gutachten')
      .upsert(batch, { onConflict: 'fillout_submission_id' })
      .select('id');

    if (error) {
      console.error(`[supabase] Batch ${Math.floor(i / BATCH_SIZE) + 1} error:`, error.message);
      // Fallback: insert individually
      for (const row of batch) {
        const { error: singleErr } = await supabase
          .from('gutachten')
          .upsert(row, { onConflict: 'fillout_submission_id' });
        if (singleErr) {
          console.error(`  Skipped ${row.pdf_filename}: ${singleErr.message}`);
          skipped++;
        } else {
          inserted++;
        }
      }
    } else {
      inserted += (data?.length || batch.length);
    }
  }

  console.log(`[supabase] Done: ${inserted} inserted/updated, ${skipped} skipped`);
  return { inserted, skipped };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Airtable → Supabase Migration ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

  validateConfig();

  // 1. Fetch from Airtable
  const atRecords = await fetchAirtableRecords();

  if (atRecords.length === 0) {
    console.log('No records found. Nothing to migrate.');
    return;
  }

  // 2. Transform records
  const transformed = atRecords.map(transformRecord);
  const rows = transformed.map(t => t.row);

  // 3. Stats
  const withScores = rows.filter(r => r.gesamtscore !== null);
  const withErtrag = rows.filter(r => r.ertragswertberechnung_score !== null).length;
  const withSach = rows.filter(r => r.sachwertberechnung_score !== null).length;

  console.log('--- Summary ---');
  console.log(`Total records:          ${rows.length}`);
  console.log(`Records with scores:    ${withScores.length}`);
  console.log(`With Ertragswert:       ${withErtrag}`);
  console.log(`With Sachwert:          ${withSach}`);
  console.log('');

  // 4. Score distribution
  const gesamtscores = withScores.map(r => r.gesamtscore).sort((a, b) => b - a);
  const avg = gesamtscores.length > 0
    ? Math.round((gesamtscores.reduce((a, b) => a + b, 0) / gesamtscores.length) * 10) / 10
    : 0;
  console.log('--- Score Distribution ---');
  console.log(`Highest:  ${gesamtscores[0]}`);
  console.log(`Lowest:   ${gesamtscores[gesamtscores.length - 1]}`);
  console.log(`Average:  ${avg}`);
  console.log('');

  // 5. Sample records
  console.log('--- Sample (first 5) ---');
  for (const { row, ranking } of transformed.slice(0, 5)) {
    const scores = [
      `FA=${row.formaler_aufbau_score ?? '-'}`,
      `DB=${row.darstellung_befund_score ?? '-'}`,
      `FI=${row.fachlicher_inhalt_score ?? '-'}`,
      `BW=${row.bodenwertermittlung_score ?? '-'}`,
      `EW=${row.ertragswertberechnung_score ?? '-'}`,
      `SW=${row.sachwertberechnung_score ?? '-'}`,
      `VW=${row.vergleichswertberechnung_score ?? '-'}`,
      `ZF=${row.zusammenfassung_score ?? '-'}`,
    ].join(', ');
    console.log(`  #${ranking ?? '?'} ${row.pdf_filename}`);
    console.log(`     ${scores} → Gesamt: ${row.gesamtscore}`);
  }
  console.log('');

  // 6. Insert to Supabase
  if (DRY_RUN) {
    console.log('[dry-run] No data written. Remove --dry-run to migrate.');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { inserted, skipped } = await insertToSupabase(supabase, rows);

  console.log(`\n=== Migration complete ===`);
  console.log(`${inserted} records migrated, ${skipped} skipped`);
}

main().catch(err => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
