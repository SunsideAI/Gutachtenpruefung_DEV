#!/usr/bin/env node

/**
 * Migration Script: Airtable → Supabase
 *
 * Migrates score data and rankings from Airtable to Supabase.
 * Only scores + metadata are migrated (no KO-Kriterien, no full texts).
 *
 * Usage:
 *   1. Set env vars (see below) or create a .env file
 *   2. Run: node scripts/migrate-airtable-to-supabase.js
 *   3. Optional: --dry-run to preview without writing
 *
 * Required ENV vars:
 *   AIRTABLE_API_KEY     - Airtable Personal Access Token (pat...)
 *   AIRTABLE_BASE_ID     - Airtable Base ID (app...)
 *   AIRTABLE_TABLE_NAME  - Airtable table name (default: "Gutachten")
 *   SUPABASE_URL         - Supabase project URL
 *   SUPABASE_SERVICE_KEY - Supabase service role key
 */

const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Config ───────────────────────────────────────────────────────────

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Gutachten';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Airtable → Supabase Field Mapping ────────────────────────────────

const SCORE_FIELD_MAP = {
  'Formaler Aufbau':                          'formaler_aufbau_score',
  'Darstellung Befund und Anknuepfungstatsachen': 'darstellung_befund_score',
  'Fachlicher Inhalt':                        'fachlicher_inhalt_score',
  'Bodenwertermittlung':                      'bodenwertermittlung_score',
  'Ertragswertberechnung':                    'ertragswertberechnung_score',
  'Sachwertberechnung':                       'sachwertberechnung_score',
  'Vergleichswertberechnung':                 'vergleichswertberechnung_score',
  'Zusammenfassung':                          'zusammenfassung_score',
};

const META_FIELD_MAP = {
  'Gutachten Titel':  'pdf_filename',
  'Meta Link':        'gutachten_drive_link',
  'AG_Vorname':       'vorname',
};

// ── Validate Config ──────────────────────────────────────────────────

function validateConfig() {
  const missing = [];
  if (!AIRTABLE_API_KEY) missing.push('AIRTABLE_API_KEY');
  if (!AIRTABLE_BASE_ID) missing.push('AIRTABLE_BASE_ID');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('\nSet them in your environment or in a .env file.');
    process.exit(1);
  }
}

// ── Airtable API (using fetch, no SDK dependency needed) ─────────────

async function fetchAirtableRecords() {
  const allRecords = [];
  let offset = null;

  console.log(`[airtable] Fetching records from table "${AIRTABLE_TABLE_NAME}"...`);

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

    console.log(`[airtable] Fetched ${allRecords.length} records so far...`);
  } while (offset);

  console.log(`[airtable] Total: ${allRecords.length} records`);
  return allRecords;
}

// ── Transform Airtable Record → Supabase Row ────────────────────────

function transformRecord(atRecord) {
  const fields = atRecord.fields;
  const row = {};

  // Use Airtable record ID as fillout_submission_id (unique identifier for migrated data)
  row.fillout_submission_id = atRecord.id;

  // Map AG_Vorname → vorname (the AG identifier field)
  row.vorname = fields['AG_Vorname'] || null;

  // Map metadata fields
  row.pdf_filename = fields['Gutachten Titel'] || null;
  row.gutachten_drive_link = fields['Meta Link'] || null;

  // Map score fields (pure numbers)
  for (const [atField, sbField] of Object.entries(SCORE_FIELD_MAP)) {
    const value = fields[atField];
    row[sbField] = (value !== undefined && value !== null && value !== '')
      ? parseFloat(value)
      : null;
  }

  // Calculate gesamtscore (average of non-null scores, excluding zusammenfassung)
  const scoreValues = [
    row.formaler_aufbau_score,
    row.darstellung_befund_score,
    row.fachlicher_inhalt_score,
    row.bodenwertermittlung_score,
    row.ertragswertberechnung_score,
    row.sachwertberechnung_score,
    row.vergleichswertberechnung_score,
  ].filter(s => s !== null && s !== undefined && !isNaN(s));

  row.gesamtscore = scoreValues.length > 0
    ? Math.round((scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length) * 10) / 10
    : null;

  // Set status for migrated records
  row.status = 'Geprüft';

  return row;
}

// ── Calculate Rankings ───────────────────────────────────────────────

function calculateRankings(rows) {
  // Group by vorname (AG identifier)
  const agGroups = {};
  for (const row of rows) {
    const ag = row.vorname;
    if (!ag) continue;
    if (!agGroups[ag]) agGroups[ag] = [];
    agGroups[ag].push(row);
  }

  const scoreFields = [
    'formaler_aufbau_score',
    'darstellung_befund_score',
    'fachlicher_inhalt_score',
    'bodenwertermittlung_score',
    'ertragswertberechnung_score',
    'sachwertberechnung_score',
    'vergleichswertberechnung_score',
  ];

  const rankings = [];

  for (const [ag, records] of Object.entries(agGroups)) {
    const ranking = {
      unternehmensname: ag,  // Using AG_Vorname as unternehmensname for migrated data
      vorname: ag,
      anzahl_gutachten: records.length,
    };

    // Per-criterion averages
    for (const field of scoreFields) {
      const avgField = field.replace('_score', '_avg');
      const values = records.map(r => r[field]).filter(v => v !== null && v !== undefined);
      ranking[avgField] = values.length > 0
        ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
        : null;
    }

    // Gesamtscore average
    const gesamtscores = records.map(r => r.gesamtscore).filter(v => v !== null);
    ranking.gesamtscore_avg = gesamtscores.length > 0
      ? Math.round((gesamtscores.reduce((a, b) => a + b, 0) / gesamtscores.length) * 10) / 10
      : null;

    rankings.push(ranking);
  }

  // Sort by gesamtscore_avg descending and assign platzierung
  rankings
    .filter(r => r.gesamtscore_avg !== null)
    .sort((a, b) => (b.gesamtscore_avg || 0) - (a.gesamtscore_avg || 0))
    .forEach((r, i) => { r.platzierung = i + 1; });

  return rankings;
}

// ── Supabase Insert ──────────────────────────────────────────────────

async function insertToSupabase(supabase, rows, rankings) {
  console.log(`\n[supabase] Inserting ${rows.length} gutachten records...`);

  // Insert in batches of 50 (Supabase limit recommendation)
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
      // Try individual inserts for failed batch
      for (const row of batch) {
        const { error: singleErr } = await supabase
          .from('gutachten')
          .upsert(row, { onConflict: 'fillout_submission_id' });
        if (singleErr) {
          console.error(`  Skipped ${row.fillout_submission_id}: ${singleErr.message}`);
          skipped++;
        } else {
          inserted++;
        }
      }
    } else {
      inserted += (data?.length || batch.length);
    }

    console.log(`[supabase] Progress: ${inserted + skipped}/${rows.length}`);
  }

  console.log(`[supabase] Gutachten: ${inserted} inserted/updated, ${skipped} skipped`);

  // Insert rankings
  console.log(`[supabase] Upserting ${rankings.length} AG rankings...`);

  const { error: rankErr } = await supabase
    .from('ag_rankings')
    .upsert(
      rankings.map(r => ({ ...r, updated_at: new Date().toISOString() })),
      { onConflict: 'unternehmensname' }
    );

  if (rankErr) {
    console.error(`[supabase] Rankings upsert error:`, rankErr.message);
  } else {
    console.log(`[supabase] Rankings: ${rankings.length} upserted`);
  }

  return { inserted, skipped };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Airtable → Supabase Migration ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log('');

  validateConfig();

  // 1. Fetch from Airtable
  const atRecords = await fetchAirtableRecords();

  if (atRecords.length === 0) {
    console.log('No records found in Airtable. Nothing to migrate.');
    return;
  }

  // 2. Transform records
  const rows = atRecords.map(transformRecord);

  // 3. Show summary
  const withScores = rows.filter(r => r.gesamtscore !== null);
  const uniqueAGs = [...new Set(rows.map(r => r.vorname).filter(Boolean))];

  console.log(`\n--- Migration Summary ---`);
  console.log(`Total records:        ${rows.length}`);
  console.log(`Records with scores:  ${withScores.length}`);
  console.log(`Unique AGs:           ${uniqueAGs.length}`);
  console.log('');

  // 4. Show sample data
  console.log('--- Sample (first 3 records) ---');
  for (const row of rows.slice(0, 3)) {
    console.log(`  ${row.pdf_filename || '(kein Titel)'}`);
    console.log(`    AG: ${row.vorname || '(unbekannt)'}`);
    console.log(`    Scores: FA=${row.formaler_aufbau_score}, DB=${row.darstellung_befund_score}, FI=${row.fachlicher_inhalt_score}`);
    console.log(`    Gesamt: ${row.gesamtscore}`);
    console.log('');
  }

  // 5. Calculate rankings
  const rankings = calculateRankings(rows);

  console.log('--- AG Rankings ---');
  for (const r of rankings.slice(0, 5)) {
    console.log(`  #${r.platzierung || '-'} ${r.unternehmensname}: ${r.gesamtscore_avg} avg (${r.anzahl_gutachten} Gutachten)`);
  }
  if (rankings.length > 5) {
    console.log(`  ... und ${rankings.length - 5} weitere`);
  }
  console.log('');

  // 6. Insert to Supabase (unless dry run)
  if (DRY_RUN) {
    console.log('[dry-run] Keine Daten geschrieben. Entferne --dry-run zum Migrieren.');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { inserted, skipped } = await insertToSupabase(supabase, rows, rankings);

  console.log('\n=== Migration abgeschlossen ===');
  console.log(`Gutachten: ${inserted} eingefügt, ${skipped} übersprungen`);
  console.log(`Rankings:  ${rankings.length} AGs`);
}

main().catch(err => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
