const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function getClient() {
  if (supabase) return supabase;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  }
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return supabase;
}

/**
 * Create a new gutachten record from Fillout webhook data
 */
async function createGutachten(data) {
  const { data: record, error } = await getClient()
    .from('gutachten')
    .insert({
      fillout_submission_id: data.fillout_submission_id,
      vorname: data.vorname,
      nachname: data.nachname,
      email: data.email,
      unternehmensname: data.unternehmensname,
      adresse: data.adresse,
      pdf_url: data.pdf_url,
      pdf_filename: data.pdf_filename,
      stripe_payment_id: data.stripe_payment_id,
      stripe_amount: data.stripe_amount,
      status: 'Empfangen'
    })
    .select()
    .single();

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  return record;
}

/**
 * Update gutachten record fields
 */
async function updateGutachten(id, fields) {
  const { data: record, error } = await getClient()
    .from('gutachten')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  return record;
}

/**
 * Set status (and optionally error details)
 */
async function setStatus(id, status, errorMsg) {
  const fields = { status };
  if (errorMsg) fields.fehler_details = errorMsg;
  return updateGutachten(id, fields);
}

/**
 * Get all gutachten records for a given AG (by Unternehmensname)
 */
async function getGutachtenByAG(unternehmensname) {
  const { data, error } = await getClient()
    .from('gutachten')
    .select('*')
    .eq('unternehmensname', unternehmensname)
    .in('status', ['Geprüft', 'Abgeschlossen']);

  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return data || [];
}

/**
 * Get all unique AGs with their gutachten for ranking calculation
 */
async function getAllAGAverages() {
  const { data, error } = await getClient()
    .from('gutachten')
    .select('unternehmensname, vorname, nachname, email, gesamtscore, formaler_aufbau_score, darstellung_befund_score, fachlicher_inhalt_score, bodenwertermittlung_score, ertragswertberechnung_score, sachwertberechnung_score, vergleichswertberechnung_score')
    .in('status', ['Geprüft', 'Abgeschlossen']);

  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return data || [];
}

/**
 * Upsert ranking entries (one per AG)
 */
async function upsertRanking(rankings) {
  if (rankings.length === 0) return;

  const { error } = await getClient()
    .from('ag_rankings')
    .upsert(
      rankings.map(r => ({
        ...r,
        updated_at: new Date().toISOString()
      })),
      { onConflict: 'unternehmensname' }
    );

  if (error) throw new Error(`Supabase ranking upsert failed: ${error.message}`);
}

/**
 * Find an existing gutachten by PDF hash (for duplicate detection)
 * Returns the full record if found, null otherwise
 */
async function findByPdfHash(pdfHash) {
  const { data, error } = await getClient()
    .from('gutachten')
    .select('*')
    .eq('pdf_hash', pdfHash)
    .in('status', ['Geprüft', 'Abgeschlossen'])
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

const STORAGE_BUCKET = 'gutachten-pdfs';

/**
 * Ensure storage bucket exists
 */
async function ensureBucket() {
  const client = getClient();
  const { data: buckets } = await client.storage.listBuckets();
  if (!buckets?.some(b => b.name === STORAGE_BUCKET)) {
    const { error } = await client.storage.createBucket(STORAGE_BUCKET, { public: false });
    if (error) throw new Error(`Bucket creation failed: ${error.message}`);
  }
}

/**
 * Upload a PDF to Supabase Storage
 * @param {Buffer} buffer - PDF content
 * @param {string} storagePath - Path within bucket (e.g. "gutachten/abc123/file.pdf")
 * @returns {string} Public URL of the uploaded file
 */
async function uploadPdf(buffer, storagePath) {
  const client = getClient();
  await ensureBucket();

  const { error } = await client.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  // Generate a signed URL (valid for 10 years — effectively permanent for reports)
  const { data: signedData, error: signError } = await client.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 365 * 10);

  if (signError) {
    // Fallback: return the path reference
    return `${STORAGE_BUCKET}/${storagePath}`;
  }

  return signedData.signedUrl;
}

module.exports = {
  getClient,
  createGutachten,
  updateGutachten,
  setStatus,
  getGutachtenByAG,
  getAllAGAverages,
  upsertRanking,
  uploadPdf,
  findByPdfHash
};
