#!/usr/bin/env node

/**
 * Migration Script: Airtable PDFs → Supabase Storage
 *
 * Downloads all Gutachten PDF attachments from Airtable (User_Datenbank_Einzelprüfung)
 * and uploads them to Supabase Storage. Creates/updates gutachten records in Supabase
 * for records that don't already exist (from score migration).
 *
 * Usage:
 *   node scripts/migrate-pdfs-to-supabase.js --dry-run   # Preview only
 *   node scripts/migrate-pdfs-to-supabase.js              # Live migration
 *
 * Required ENV vars:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Config ───────────────────────────────────────────────────────────

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_EINZELPRUEFUNG = 'tblcxiIPGJ3Y7jxk8';
const SUPABASE_BUCKET = 'gutachten-pdfs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Validate ─────────────────────────────────────────────────────────

function validateConfig() {
  const missing = [];
  if (!AIRTABLE_API_KEY) missing.push('AIRTABLE_API_KEY');
  if (!AIRTABLE_BASE_ID) missing.push('AIRTABLE_BASE_ID');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length > 0) {
    console.error(`Missing: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ── Airtable API ─────────────────────────────────────────────────────

async function fetchAirtableRecords() {
  const allRecords = [];
  let offset = null;

  console.log('[airtable] Fetching User_Datenbank_Einzelprüfung...');

  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_EINZELPRUEFUNG}`);
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

// ── Download PDF from Airtable Attachment URL ────────────────────────

async function downloadPdf(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      // Verify it's a PDF
      if (buffer.length < 5 || buffer.toString('ascii', 0, 5) !== '%PDF-') {
        console.warn(`    Warning: File does not start with %PDF- (${buffer.length} bytes)`);
      }
      return buffer;
    } catch (err) {
      if (attempt < retries) {
        console.warn(`    Download attempt ${attempt} failed, retrying...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      } else {
        throw err;
      }
    }
  }
}

// ── Ensure Supabase Storage Bucket Exists ────────────────────────────

async function ensureBucket(supabase) {
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some(b => b.name === SUPABASE_BUCKET);

  if (!exists) {
    console.log(`[supabase] Creating bucket "${SUPABASE_BUCKET}"...`);
    const { error } = await supabase.storage.createBucket(SUPABASE_BUCKET, {
      public: false
    });
    if (error) throw new Error(`Bucket creation failed: ${error.message}`);
    console.log(`[supabase] Bucket created.`);
  } else {
    console.log(`[supabase] Bucket "${SUPABASE_BUCKET}" exists.`);
  }
}

// ── Upload PDF to Supabase Storage ───────────────────────────────────

async function uploadToStorage(supabase, buffer, storagePath) {
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  if (error) throw new Error(`Upload failed: ${error.message}`);
  return data.path;
}

// ── Sanitize filename for storage path ───────────────────────────────

function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9äöüÄÖÜß._\-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Airtable PDFs → Supabase Storage Migration ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  validateConfig();

  // 1. Fetch Airtable records
  const atRecords = await fetchAirtableRecords();

  // 2. Extract records with PDF attachments
  const withPdf = [];
  const withoutPdf = [];

  for (const rec of atRecords) {
    const fields = rec.fields;
    const gutachten = fields['Gutachten'];

    // Airtable attachments are arrays of { id, url, filename, size, type }
    if (gutachten && Array.isArray(gutachten) && gutachten.length > 0) {
      withPdf.push({
        airtable_id: rec.id,
        email: fields['E-Mail Adresse'] || '',
        vorname: fields['Vorname'] || '',
        nachname: fields['Name'] || '',
        erstellt: fields['Erstellt'] || fields['Letzte Aktualisierung'] || '',
        kunden_id: fields['Kunden-ID'],
        attachments: gutachten
      });
    } else {
      withoutPdf.push(rec.id);
    }
  }

  console.log('--- Summary ---');
  console.log(`Total records:        ${atRecords.length}`);
  console.log(`With PDF attachment:  ${withPdf.length}`);
  console.log(`Without PDF:          ${withoutPdf.length}`);

  // Count total PDFs (some records might have multiple attachments)
  const totalPdfs = withPdf.reduce((sum, r) => sum + r.attachments.length, 0);
  console.log(`Total PDF files:      ${totalPdfs}`);
  console.log('');

  // 3. Show sample
  console.log('--- Sample (first 5) ---');
  for (const rec of withPdf.slice(0, 5)) {
    for (const att of rec.attachments) {
      const sizeMB = att.size ? (att.size / 1024 / 1024).toFixed(1) : '?';
      console.log(`  #${rec.kunden_id} ${rec.vorname} ${rec.nachname} — ${att.filename} (${sizeMB} MB)`);
    }
  }
  console.log('');

  if (DRY_RUN) {
    // Calculate total size
    const totalSize = withPdf.reduce((sum, r) =>
      sum + r.attachments.reduce((s, a) => s + (a.size || 0), 0), 0);
    console.log(`Total size: ~${(totalSize / 1024 / 1024).toFixed(0)} MB`);
    console.log('\n[dry-run] No data written. Remove --dry-run to migrate.');
    return;
  }

  // 4. Init Supabase
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  await ensureBucket(supabase);

  // 5. Process each record
  let uploaded = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < withPdf.length; i++) {
    const rec = withPdf[i];
    const progress = `[${i + 1}/${withPdf.length}]`;

    for (const att of rec.attachments) {
      const filename = att.filename || `gutachten_${rec.kunden_id}.pdf`;
      const safeName = sanitizeFilename(filename);
      const storagePath = `einzelpruefung/${rec.kunden_id || rec.airtable_id}/${safeName}`;

      try {
        // Check if already uploaded
        const { data: existing } = await supabase.storage
          .from(SUPABASE_BUCKET)
          .list(`einzelpruefung/${rec.kunden_id || rec.airtable_id}`);

        if (existing?.some(f => f.name === safeName)) {
          skipped++;
          continue;
        }

        console.log(`${progress} Downloading ${filename}...`);
        const buffer = await downloadPdf(att.url);

        console.log(`${progress} Uploading → ${storagePath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
        await uploadToStorage(supabase, buffer, storagePath);

        // 6. Upsert gutachten record in Supabase DB
        const { error: dbError } = await supabase
          .from('gutachten')
          .upsert({
            fillout_submission_id: `migration_einzelpruefung_${rec.airtable_id}`,
            vorname: rec.vorname,
            nachname: rec.nachname,
            email: rec.email,
            pdf_filename: filename,
            pdf_url: `${SUPABASE_BUCKET}/${storagePath}`,
            status: 'Geprüft',
          }, { onConflict: 'fillout_submission_id' });

        if (dbError) {
          console.warn(`${progress} DB upsert warning: ${dbError.message}`);
        }

        uploaded++;
      } catch (err) {
        console.error(`${progress} FAILED ${filename}: ${err.message}`);
        failed++;
      }
    }

    // Rate limiting: small pause every 10 records
    if (i > 0 && i % 10 === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n=== Migration complete ===`);
  console.log(`Uploaded:  ${uploaded}`);
  console.log(`Skipped:   ${skipped} (already exist)`);
  console.log(`Failed:    ${failed}`);
}

main().catch(err => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
