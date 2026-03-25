const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { downloadPdf } = require('./utils/pdf-download');
const { runEvaluation } = require('./services/claude');
const queue = require('./utils/queue');

// ── Express Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
    queue: queue.status,
    timestamp: new Date().toISOString()
  });
});

// ── POST /evaluate (Phase 1 — backward compatible) ─────────────────

app.post('/evaluate', async (req, res) => {
  const startTime = Date.now();

  // 1. Validate request
  const { pdf_url, ag_vorname, datum } = req.body;
  if (!pdf_url) {
    return res.status(400).json({ error: 'pdf_url is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required (ANTHROPIC_API_KEY env or x-api-key header)' });
  }

  // 2. Download PDF
  let pdfBase64;
  try {
    console.log('[evaluate] Downloading PDF...');
    pdfBase64 = await downloadPdf(pdf_url);
    console.log(`[evaluate] PDF downloaded (${Math.round(pdfBase64.length / 1024)} KB base64)`);
  } catch (err) {
    console.error('[evaluate] PDF download failed:', err.message);
    return res.status(500).json({ error: `PDF download failed: ${err.message}` });
  }

  // 3. Initialize Anthropic client
  const client = new Anthropic({ apiKey });

  // 4. Run evaluation pipeline
  const { result, errors } = await runEvaluation(client, pdfBase64, {
    ag_vorname: ag_vorname || '',
    datum: datum || new Date().toISOString().split('T')[0],
    useTextpruefung: true
  });

  // 5. Assemble response
  const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[evaluate] Done in ${processingTime}s with ${errors.length} error(s)`);

  res.json({
    ...result,
    _processing_time_seconds: processingTime,
    _errors: errors.length > 0 ? errors : undefined,
    _model: process.env.CLAUDE_MODEL || 'claude-opus-4-6'
  });
});

// ── POST /webhook/fillout (Phase 2 — Fillout webhook trigger) ──────

app.post('/webhook/fillout', (req, res) => {
  const body = req.body;

  // Validate webhook secret (from body, query param, or header)
  const secret = body.webhook_secret || req.query.secret || req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Log incoming payload for debugging
  console.log('[webhook] Received fields:', Object.keys(body).join(', '));
  console.log('[webhook] Body:', JSON.stringify(body, null, 2).substring(0, 3000));

  // Validate payment status (skip check if no payment field — e.g. test submissions)
  if (body.status && body.status !== 'succeeded') {
    return res.status(400).json({ error: 'Payment not succeeded', status: body.status });
  }

  // Find PDF URL (try known field names)
  const pdfUrl = body['Gof 6 Url'] || body['pdf_url'] || body['file_url'];
  if (!pdfUrl) {
    // Return all field names to help debug field mapping
    return res.status(400).json({
      error: 'No PDF URL found',
      received_fields: Object.keys(body),
      hint: 'Check which field contains the PDF URL and update the mapping'
    });
  }

  const submissionId = body['Submission Id'];

  // Map Fillout fields to internal format
  const payload = {
    fillout_submission_id: submissionId,
    vorname: body['Vorname'] || '',
    nachname: body['Nachname'] || '',
    email: body['E-Mail'] || '',
    unternehmensname: body['Unternehmensname'] || '',
    adresse: {
      strasse: body['Xh En Address'] || '',
      stadt: body['Xh En City'] || '',
      bundesland: body['Xh En State'] || '',
      plz: body['Xh En Zip Code'] || '',
      land: body['Xh En Country'] || ''
    },
    pdf_url: pdfUrl,
    pdf_filename: body['Gof 6 Filename'] || 'gutachten.pdf',
    stripe_payment_id: body['paymentId'] || '',
    stripe_amount: body['totalAmount'] || 0,
    submission_time: body['Submission Time'] || new Date().toISOString()
  };

  // Respond immediately
  res.status(200).json({
    status: 'accepted',
    submission_id: submissionId,
    message: 'Gutachtenprüfung gestartet'
  });

  // Process in background via queue
  const { processGutachten } = require('./services/pipeline');
  queue.enqueue(() => processGutachten(payload)).catch(err => {
    console.error(`[webhook] Background processing failed for ${submissionId}:`, err);
  });
});

// ── Start Server ────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Gutachtenprüfung API running on port ${PORT}`);
  console.log(`Model: ${process.env.CLAUDE_MODEL || 'claude-opus-4-6'}`);
});

// Set server timeout to 300s for long-running evaluations
server.timeout = 300000;
server.keepAliveTimeout = 300000;
