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

  // Validate webhook secret (from query param, header, or body)
  const secret = req.query.secret || req.headers['x-webhook-secret'] || body.webhook_secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse Fillout submission format:
  // { formId, formName, submission: { submissionId, questions: [{ name, value, ... }] } }
  const submission = body.submission || {};
  const questions = submission.questions || [];

  // Build a flat key→value map from questions array
  const fields = {};
  for (const q of questions) {
    if (q.name && q.value !== undefined && q.value !== null) {
      fields[q.name] = q.value;
    }
  }

  console.log('[webhook] Submission:', submission.submissionId);
  console.log('[webhook] Fields:', Object.keys(fields).join(', '));

  // Validate payment status (from Fillout payment fields)
  const paymentStatus = fields['status'] || submission.payment?.status;
  if (paymentStatus && paymentStatus !== 'succeeded') {
    return res.status(400).json({ error: 'Payment not succeeded', status: paymentStatus });
  }

  // Find PDF — Fillout file uploads have value as array: [{ url, name }] or string URL
  let pdfUrl = null;
  let pdfFilename = 'gutachten.pdf';

  for (const q of questions) {
    if (q.type === 'FileUpload' || q.type === 'file_upload') {
      const val = q.value;
      if (Array.isArray(val) && val.length > 0) {
        pdfUrl = val[0].url || val[0];
        pdfFilename = val[0].name || val[0].fileName || pdfFilename;
      } else if (typeof val === 'string') {
        pdfUrl = val;
      }
      break;
    }
  }

  // Fallback: try known field names
  if (!pdfUrl) {
    pdfUrl = fields['Gutachten PDF'] || fields['PDF'] || fields['Datei'] || fields['File'];
  }

  if (!pdfUrl) {
    return res.status(400).json({
      error: 'No PDF URL found in submission',
      available_fields: Object.keys(fields),
      question_types: questions.map(q => ({ name: q.name, type: q.type }))
    });
  }

  const submissionId = submission.submissionId || `fillout_${Date.now()}`;

  // Map fields to internal format
  const payload = {
    fillout_submission_id: submissionId,
    vorname: fields['Vorname'] || '',
    nachname: fields['Nachname'] || '',
    email: fields['E-Mail'] || fields['Email'] || '',
    unternehmensname: fields['Unternehmensname'] || fields['Unternehmen']
      || [fields['Vorname'], fields['Nachname']].filter(Boolean).join(' ')
      || 'Unbekannt',
    adresse: {
      strasse: fields['Straße'] || fields['Adresse'] || '',
      stadt: fields['Stadt'] || fields['City'] || '',
      bundesland: fields['Bundesland'] || fields['State'] || '',
      plz: fields['PLZ'] || fields['Postleitzahl'] || '',
      land: fields['Land'] || fields['Country'] || 'Deutschland'
    },
    pdf_url: pdfUrl,
    pdf_filename: pdfFilename,
    stripe_payment_id: submission.payment?.paymentId || fields['paymentId'] || '',
    stripe_amount: submission.payment?.totalAmount || fields['totalAmount'] || 0,
    submission_time: submission.submissionTime || new Date().toISOString()
  };

  console.log(`[webhook] Accepted: ${pdfFilename} from ${payload.vorname} ${payload.nachname}`);

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

// ── POST /webhook/gdrive (Patrick Beier — Sonderprüfung ohne Zahlung) ──

app.post('/webhook/gdrive', (req, res) => {
  const body = req.body;

  // Validate secret
  const secret = body.secret || req.query.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const fileId = body.file_id;
  const fileName = body.file_name;
  const fileUrl = body.file_url || `https://drive.google.com/uc?id=${fileId}&export=download`;

  if (!fileId || !fileName) {
    return res.status(400).json({ error: 'file_id and file_name are required' });
  }

  console.log(`[webhook:gdrive] New file: ${fileName} (${fileId})`);

  // Patrick Beier's fixed data — Sonderprüfung without payment
  const payload = {
    fillout_submission_id: `gdrive_${fileId}`,
    vorname: 'Patrick',
    nachname: 'Beier',
    email: process.env.BEIER_EMAIL || 'p.beier@beierundpartner.de',
    unternehmensname: 'Sachverständigenbüro Beier & Partner',
    adresse: {
      strasse: 'Schölischer Str. 101a',
      stadt: 'Stade',
      bundesland: 'Niedersachsen',
      plz: '21682',
      land: 'Deutschland'
    },
    pdf_url: fileUrl,
    pdf_filename: fileName,
    stripe_payment_id: '',
    stripe_amount: 0,
    submission_time: body.timestamp || new Date().toISOString()
  };

  // Respond immediately
  res.status(200).json({
    status: 'accepted',
    file_id: fileId,
    message: 'Gutachtenprüfung gestartet (Beier Sonderprüfung)'
  });

  // Process in background
  const { processGutachten } = require('./services/pipeline');
  queue.enqueue(() => processGutachten(payload)).catch(err => {
    console.error(`[webhook:gdrive] Background processing failed for ${fileId}:`, err);
  });
});

// ── POST /webhooks/pipedrive/gutachten (Pipedrive Quality Gate trigger) ──

app.post('/webhooks/pipedrive/gutachten', async (req, res) => {
  const start = Date.now();
  const payload = req.body;

  console.log('[webhook:pipedrive] Raw payload:', JSON.stringify(req.body, null, 2));

  // Validate webhook secret
  const secret = req.query.secret || req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // v2.0 + v1.0 compatible field extraction
  const projectId = payload.data?.id || payload.current?.id;
  const newPhase = payload.data?.phase_id || payload.current?.phase_id;
  const oldPhase = payload.previous?.phase_id;
  const webhookDealIds = payload.data?.deal_ids || payload.current?.deal_ids;
  const permittedUserIds = payload.meta?.permitted_user_ids || [];
  const qualityGatePhaseId = parseInt(process.env.GUTACHTEN_QUALITY_GATE_PHASE_ID || '0');

  console.log(`[webhook:pipedrive] Project ${projectId}: phase ${oldPhase} → ${newPhase} (QG=${qualityGatePhaseId})`);

  if (!projectId) {
    return res.json({ triggered: false, reason: 'No project ID' });
  }

  // Only trigger on transition INTO Quality Gate phase
  if (newPhase !== qualityGatePhaseId || oldPhase === qualityGatePhaseId) {
    return res.json({ triggered: false, reason: 'Not Quality Gate transition' });
  }

  // Respond immediately, process in background
  res.json({ triggered: true, projectId, message: 'Gutachtenprüfung gestartet' });

  // Background processing
  const pipedrive = require('./services/pipedrive');
  const { processGutachten } = require('./services/pipeline');
  const mailer = require('./services/mailer');

  (async () => {
    try {
      // Get project and linked deal
      const project = await pipedrive.getProject(projectId);
      const dealId = webhookDealIds?.[0] || project.deal_ids?.[0];

      if (!dealId) {
        console.error(`[webhook:pipedrive] No deal linked to project ${projectId}`);
        return;
      }

      // Find latest PDF
      const pdfFile = await pipedrive.findLatestPdf(projectId, dealId);
      if (!pdfFile) {
        console.error(`[webhook:pipedrive] No PDF found for project ${projectId} / deal ${dealId}`);
        return;
      }

      console.log(`[webhook:pipedrive] Found PDF: ${pdfFile.name} — downloading...`);

      // Download PDF from Pipedrive
      const pdfBuffer = await pipedrive.downloadFile(pdfFile.id);
      const pdfBase64 = pdfBuffer.toString('base64');

      // Get deal details for AG info
      let deal = {};
      try {
        deal = await pipedrive.getDeal(dealId);
      } catch (err) {
        console.warn(`[webhook:pipedrive] Could not get deal details: ${err.message}`);
      }

      // Collect recipient emails from project participants
      const recipientEmails = new Set();

      // Add project owner
      const ownerId = project.owner_id || payload.data?.owner_id;
      if (ownerId) {
        try {
          const owner = await pipedrive.getUser(ownerId);
          if (owner?.email) recipientEmails.add(owner.email);
        } catch (err) {
          console.warn(`[webhook:pipedrive] Could not get owner ${ownerId}: ${err.message}`);
        }
      }

      // Add permitted users from webhook meta
      for (const userId of permittedUserIds) {
        try {
          const user = await pipedrive.getUser(userId);
          if (user?.email) recipientEmails.add(user.email);
        } catch (err) {
          console.warn(`[webhook:pipedrive] Could not get user ${userId}: ${err.message}`);
        }
      }

      // Add deal contact email if available
      if (deal.person_id?.email?.[0]?.value) {
        recipientEmails.add(deal.person_id.email[0].value);
      }

      // Fallback to BEIER_EMAIL if no recipients found
      const recipients = [...recipientEmails].filter(Boolean);
      if (recipients.length === 0 && process.env.BEIER_EMAIL) {
        recipients.push(process.env.BEIER_EMAIL);
      }
      console.log(`[webhook:pipedrive] Recipients: ${recipients.join(', ') || '(none)'}`);

      // Build pipeline payload
      const pipelinePayload = {
        fillout_submission_id: `pipedrive_project_${projectId}_${Date.now()}`,
        vorname: deal.person_name?.split(' ')[0] || project.title || '',
        nachname: deal.person_name?.split(' ').slice(1).join(' ') || '',
        email: recipients[0] || '',
        unternehmensname: deal.org_name || deal.person_name || project.title || 'Pipedrive',
        adresse: {},
        pdf_url: `pipedrive_file://${pdfFile.id}`,
        pdf_filename: pdfFile.name,
        stripe_payment_id: '',
        stripe_amount: 0,
        submission_time: new Date().toISOString(),
        _pipedrive: { projectId, dealId, pdfFileId: pdfFile.id },
        _pdfBase64Override: pdfBase64
      };

      // Run pipeline
      const pipelineResult = await queue.enqueue(() => processGutachten(pipelinePayload));

      // Upload Prüfbericht PDF to Pipedrive project
      if (pipelineResult?.reportBuffer) {
        try {
          const reportFileName = `Pruefbericht_${pdfFile.name}`;
          await pipedrive.uploadFileToProject(projectId, reportFileName, pipelineResult.reportBuffer, dealId);
          console.log(`[webhook:pipedrive] Prüfbericht uploaded to project ${projectId}`);
        } catch (err) {
          console.error(`[webhook:pipedrive] Report upload to Pipedrive failed (non-fatal):`, err.message);
        }

        // Send result email to all recipients with report link
        if (recipients.length > 0 && pipelineResult.reportStorageUrl) {
          try {
            for (const email of recipients) {
              await mailer.sendResult(
                email,
                pipelinePayload.vorname,
                pdfFile.name,
                pipelineResult.zusammenfassung,
                pipelineResult.gesamtscore,
                pipelineResult.reportStorageUrl
              );
            }
            console.log(`[webhook:pipedrive] Result email sent to ${recipients.length} recipient(s)`);
          } catch (err) {
            console.error(`[webhook:pipedrive] Result email failed (non-fatal):`, err.message);
          }
        }
      }

      // Save result as note on deal
      const duration = ((Date.now() - start) / 1000).toFixed(0);
      const score = pipelineResult?.gesamtscore ?? 'n/a';
      const summary = pipelineResult?.zusammenfassung || '';
      await pipedrive.createNote(
        `<b>Gutachtenprüfung abgeschlossen</b> (${duration}s)\n\n` +
        `<b>Datei:</b> ${pdfFile.name}\n` +
        `<b>Score:</b> ${score}/10\n\n` +
        `${summary}\n\n` +
        `<i>Der vollständige Prüfbericht wurde am Projekt hinterlegt.</i>`,
        { deal_id: dealId }
      );

      console.log(`[webhook:pipedrive] Pipeline complete for project ${projectId} (Score: ${score})`);
    } catch (err) {
      console.error(`[webhook:pipedrive] Background processing failed for project ${projectId}:`, err);
    }
  })();
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
