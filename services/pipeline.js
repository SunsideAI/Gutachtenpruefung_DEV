const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { downloadPdf } = require('../utils/pdf-download');
const { runEvaluation } = require('./claude');
const { calculateGesamtscore, calculateAverages, calculateRankings } = require('../utils/scores');
const supabase = require('./supabase');
const pdfmonkey = require('./pdfmonkey');
const mailer = require('./mailer');

/**
 * Map evaluation result (PascalCase) to Supabase fields (snake_case)
 */
function mapResultToSupabaseFields(result) {
  return {
    objektbeschreibung: result.Objektbeschreibung,
    formalia_erfuellt: result.Formalia_Erfuellt,
    formalia_kommentar: result.Formalia_Kommentar,
    recht_erfuellt: result.Recht_Erfuellt,
    recht_kommentar: result.Recht_Kommentar,
    lage_erfuellt: result.Lage_Erfuellt,
    lage_kommentar: result.Lage_Kommentar,
    baurecht_erfuellt: result.Baurecht_Erfuellt,
    baurecht_kommentar: result.Baurecht_Kommentar,
    boden_erfuellt: result.Boden_Erfuellt,
    boden_kommentar: result.Boden_Kommentar,
    nutzung_erfuellt: result.Nutzung_Erfuellt,
    nutzung_kommentar: result.Nutzung_Kommentar,
    gebaeude_erfuellt: result.Gebaeude_Erfuellt,
    gebaeude_kommentar: result.Gebaeude_Kommentar,
    verfahren_erfuellt: result.Verfahren_Erfuellt,
    verfahren_kommentar: result.Verfahren_Kommentar,
    merkmale_erfuellt: result.Merkmale_Erfuellt,
    merkmale_kommentar: result.Merkmale_Kommentar,
    plausi_erfuellt: result.Plausi_Erfuellt,
    plausi_kommentar: result.Plausi_Kommentar,
    formaler_aufbau: result.Formaler_Aufbau,
    formaler_aufbau_score: result.Formaler_Aufbau_Score,
    darstellung_befund: result.Darstellung_Befund_und_Anknuepfungstatsachen,
    darstellung_befund_score: result.Darstellung_Befund_Score,
    fachlicher_inhalt: result.Fachlicher_Inhalt,
    fachlicher_inhalt_score: result.Fachlicher_Inhalt_Score,
    bodenwertermittlung: result.Bodenwertermittlung,
    bodenwertermittlung_score: result.Bodenwertermittlung_Score,
    ertragswertberechnung: result.Ertragswertberechnung,
    ertragswertberechnung_score: result.Ertragswertberechnung_Score,
    sachwertberechnung: result.Sachwertberechnung,
    sachwertberechnung_score: result.Sachwertberechnung_Score,
    vergleichswertberechnung: result.Vergleichswertberechnung,
    vergleichswertberechnung_score: result.Vergleichswertberechnung_Score,
    zusammenfassung: result.Zusammenfassung,
    zusammenfassung_score: result.Zusammenfassung_Score
  };
}

/**
 * Build PDFMonkey payload from evaluation results
 */
function buildPdfMonkeyPayload(result, gesamtscore, agAverages, platzierung, payload) {
  // Variable names MUST match the PDFMonkey HTML template (PascalCase with underscores)
  return {
    // Personal Info
    AG_Vorname: payload.vorname,
    AG_Nachname: payload.nachname,
    Datum: new Date().toLocaleDateString('de-DE'),
    Gutachten: payload.pdf_filename,
    Objektbeschreibung: result.Objektbeschreibung || '',
    // KO-Kriterien
    Formalia_Erfuellt: result.Formalia_Erfuellt,
    Formalia_Kommentar: result.Formalia_Kommentar,
    Recht_Erfuellt: result.Recht_Erfuellt,
    Recht_Kommentar: result.Recht_Kommentar,
    Lage_Erfuellt: result.Lage_Erfuellt,
    Lage_Kommentar: result.Lage_Kommentar,
    Baurecht_Erfuellt: result.Baurecht_Erfuellt,
    Baurecht_Kommentar: result.Baurecht_Kommentar,
    Boden_Erfuellt: result.Boden_Erfuellt,
    Boden_Kommentar: result.Boden_Kommentar,
    Nutzung_Erfuellt: result.Nutzung_Erfuellt,
    Nutzung_Kommentar: result.Nutzung_Kommentar,
    Gebaeude_Erfuellt: result.Gebaeude_Erfuellt,
    Gebaeude_Kommentar: result.Gebaeude_Kommentar,
    Verfahren_Erfuellt: result.Verfahren_Erfuellt,
    Verfahren_Kommentar: result.Verfahren_Kommentar,
    Merkmale_Erfuellt: result.Merkmale_Erfuellt,
    Merkmale_Kommentar: result.Merkmale_Kommentar,
    Plausi_Erfuellt: result.Plausi_Erfuellt,
    Plausi_Kommentar: result.Plausi_Kommentar,
    // Prüfkriterien (text + score)
    Formaler_Aufbau: result.Formaler_Aufbau,
    Formaler_Aufbau_Score: result.Formaler_Aufbau_Score,
    Darstellung_Befund_und_Anknuepfungstatsachen: result.Darstellung_Befund_und_Anknuepfungstatsachen,
    Darstellung_Befund_Score: result.Darstellung_Befund_Score,
    Fachlicher_Inhalt: result.Fachlicher_Inhalt,
    Fachlicher_Inhalt_Score: result.Fachlicher_Inhalt_Score,
    Bodenwertermittlung: result.Bodenwertermittlung,
    Bodenwertermittlung_Score: result.Bodenwertermittlung_Score,
    Ertragswertberechnung: result.Ertragswertberechnung,
    Ertragswertberechnung_Score: result.Ertragswertberechnung_Score,
    Sachwertberechnung: result.Sachwertberechnung,
    Sachwertberechnung_Score: result.Sachwertberechnung_Score,
    Vergleichswertberechnung: result.Vergleichswertberechnung,
    Vergleichswertberechnung_Score: result.Vergleichswertberechnung_Score,
    Zusammenfassung: result.Zusammenfassung,
    Zusammenfassung_Score: result.Zusammenfassung_Score,
    // Ranking + Averages
    Platzierung: platzierung || null,
    Anzahl_Gutachten: agAverages?.anzahl_gutachten || 1,
    Anzahl_Berichte: agAverages?.anzahl_gutachten || 1,
    Zusammenfassung_Score_Durchschnitt: agAverages?.gesamtscore_avg || gesamtscore,
    // Per-criterion averages for comparison table
    Formaler_Aufbau_Score_Durchschnitt: agAverages?.formaler_aufbau_avg || result.Formaler_Aufbau_Score,
    Darstellung_Befund_Score_Durchschnitt: agAverages?.darstellung_befund_avg || result.Darstellung_Befund_Score,
    Fachlicher_Inhalt_Score_Durchschnitt: agAverages?.fachlicher_inhalt_avg || result.Fachlicher_Inhalt_Score,
    Bodenwertermittlung_Score_Durchschnitt: agAverages?.bodenwertermittlung_avg || result.Bodenwertermittlung_Score,
    Ertragswertberechnung_Score_Durchschnitt: agAverages?.ertragswertberechnung_avg || result.Ertragswertberechnung_Score,
    Sachwertberechnung_Score_Durchschnitt: agAverages?.sachwertberechnung_avg || result.Sachwertberechnung_Score,
    Vergleichswertberechnung_Score_Durchschnitt: agAverages?.vergleichswertberechnung_avg || result.Vergleichswertberechnung_Score,
  };
}

/**
 * Finish pipeline: ranking, report generation, email (shared by normal + duplicate paths)
 */
async function finishPipeline(logPrefix, gutachtenId, result, gesamtscore, payload, startTime) {
  // Calculate AG averages
  const agRecords = await supabase.getGutachtenByAG(payload.unternehmensname);
  const averages = calculateAverages(agRecords);
  console.log(`${logPrefix} AG averages calculated (${agRecords.length} records)`);

  // Calculate rankings across all AGs
  let platzierung = null;
  try {
    const allRecords = await supabase.getAllAGAverages();
    const agGroups = {};
    for (const rec of allRecords) {
      const key = rec.unternehmensname;
      if (!agGroups[key]) {
        agGroups[key] = { unternehmensname: key, vorname: rec.vorname, nachname: rec.nachname, email: rec.email, records: [] };
      }
      agGroups[key].records.push(rec);
    }
    const agAveragesList = Object.values(agGroups).map(ag => {
      const { records, ...agInfo } = ag;
      return { ...agInfo, ...calculateAverages(records) };
    });
    const rankings = calculateRankings(agAveragesList);
    await supabase.upsertRanking(rankings);
    platzierung = rankings.find(r => r.unternehmensname === payload.unternehmensname)?.platzierung || null;
    console.log(`${logPrefix} Rankings updated. Platzierung: ${platzierung}`);
  } catch (err) {
    console.error(`${logPrefix} Ranking calculation failed (non-fatal):`, err.message);
  }

  // Generate PDF report via PDFMonkey
  let reportStorageUrl = null;
  let reportBuffer = null;
  try {
    const reportPayload = buildPdfMonkeyPayload(result, gesamtscore, averages, platzierung, payload);
    console.log(`${logPrefix} Generating PDF report...`);
    const docId = await pdfmonkey.generateDocument(process.env.PDFMONKEY_TEMPLATE_ID, reportPayload);
    const { download_url } = await pdfmonkey.waitForDocument(docId);
    reportBuffer = await pdfmonkey.downloadDocument(download_url);
    console.log(`${logPrefix} PDF report generated`);

    const reportPath = `berichte/${gutachtenId}/Pruefbericht_${payload.pdf_filename}`;
    reportStorageUrl = await supabase.uploadPdf(reportBuffer, reportPath);
    console.log(`${logPrefix} Report uploaded to Supabase Storage`);

    await supabase.updateGutachten(gutachtenId, {
      pruefbericht_drive_link: reportStorageUrl
    });
  } catch (err) {
    console.error(`${logPrefix} PDF report generation/upload failed (non-fatal):`, err.message);
  }

  // Send result email
  try {
    await mailer.sendResult(
      payload.email,
      payload.vorname,
      payload.pdf_filename,
      result.Zusammenfassung,
      gesamtscore,
      reportStorageUrl
    );
  } catch (err) {
    console.error(`${logPrefix} Result email failed (non-fatal):`, err.message);
  }

  // Set final status
  await supabase.setStatus(gutachtenId, 'Abgeschlossen');
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`${logPrefix} Pipeline complete in ${totalTime}s`);

  return { reportBuffer, reportStorageUrl, gesamtscore, zusammenfassung: result.Zusammenfassung };
}

/**
 * Main pipeline: processes a single Gutachten end-to-end
 */
async function processGutachten(payload) {
  const startTime = Date.now();
  const logPrefix = `[pipeline:${payload.fillout_submission_id?.slice(0, 8)}]`;
  let gutachtenId = null;

  try {
    console.log(`${logPrefix} Starting processing: ${payload.pdf_filename}`);

    // 1. Create Supabase record (or get existing if duplicate submission)
    const record = await supabase.createGutachten(payload);
    gutachtenId = record.id;

    if (record._duplicate) {
      console.log(`${logPrefix} Duplicate submission — already processed as ${gutachtenId}. Skipping.`);
      return;
    }

    console.log(`${logPrefix} Supabase record created: ${gutachtenId}`);

    // 2. Set status to "Wird geprüft"
    await supabase.setStatus(gutachtenId, 'Wird geprüft');

    // 3. Send confirmation email + internal notification
    try {
      await mailer.sendConfirmation(payload.email, payload.vorname, payload.pdf_filename);
    } catch (err) {
      console.error(`${logPrefix} Confirmation email failed (non-fatal):`, err.message);
    }
    try {
      await mailer.sendInternalNotification(payload.pdf_filename, payload.vorname, payload.nachname);
    } catch (err) {
      console.error(`${logPrefix} Internal notification failed (non-fatal):`, err.message);
    }

    // 4. Download PDF (or use pre-downloaded buffer from Pipedrive)
    let pdfBase64;
    let pdfBuffer;
    if (payload._pdfBase64Override) {
      pdfBase64 = payload._pdfBase64Override;
      pdfBuffer = Buffer.from(pdfBase64, 'base64');
      console.log(`${logPrefix} Using pre-downloaded PDF (${Math.round(pdfBuffer.length / 1024)} KB)`);
    } else {
      console.log(`${logPrefix} Downloading PDF...`);
      pdfBase64 = await downloadPdf(payload.pdf_url);
      pdfBuffer = Buffer.from(pdfBase64, 'base64');
      console.log(`${logPrefix} PDF downloaded (${Math.round(pdfBuffer.length / 1024)} KB)`);
    }

    // 5. Calculate PDF hash for duplicate detection
    const pdfHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    console.log(`${logPrefix} PDF hash: ${pdfHash.slice(0, 12)}...`);

    // 5a. Check for duplicate — same PDF already evaluated?
    const existingRecord = await supabase.findByPdfHash(pdfHash);
    if (existingRecord) {
      console.log(`${logPrefix} DUPLICATE DETECTED — reusing results from record ${existingRecord.id}`);

      // Copy evaluation results from existing record
      const copyFields = [
        'objektbeschreibung',
        'formalia_erfuellt', 'formalia_kommentar', 'recht_erfuellt', 'recht_kommentar',
        'lage_erfuellt', 'lage_kommentar', 'baurecht_erfuellt', 'baurecht_kommentar',
        'boden_erfuellt', 'boden_kommentar', 'nutzung_erfuellt', 'nutzung_kommentar',
        'gebaeude_erfuellt', 'gebaeude_kommentar', 'verfahren_erfuellt', 'verfahren_kommentar',
        'merkmale_erfuellt', 'merkmale_kommentar', 'plausi_erfuellt', 'plausi_kommentar',
        'formaler_aufbau', 'formaler_aufbau_score',
        'darstellung_befund', 'darstellung_befund_score',
        'fachlicher_inhalt', 'fachlicher_inhalt_score',
        'bodenwertermittlung', 'bodenwertermittlung_score',
        'ertragswertberechnung', 'ertragswertberechnung_score',
        'sachwertberechnung', 'sachwertberechnung_score',
        'vergleichswertberechnung', 'vergleichswertberechnung_score',
        'zusammenfassung', 'zusammenfassung_score', 'gesamtscore'
      ];
      const copiedFields = {};
      for (const f of copyFields) {
        if (existingRecord[f] !== undefined) copiedFields[f] = existingRecord[f];
      }

      await supabase.updateGutachten(gutachtenId, {
        ...copiedFields,
        pdf_hash: pdfHash,
        pdf_url: payload.pdf_url,
        processing_time_seconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(1)),
        status: 'Geprüft'
      });

      // Still generate report and send email with cached results
      // (skip to step 9 — ranking, report, email)
      console.log(`${logPrefix} Cached results saved. Skipping Claude evaluation.`);

      // Build result object from existing record for report generation
      const result = {
        Objektbeschreibung: existingRecord.objektbeschreibung,
        Formalia_Erfuellt: existingRecord.formalia_erfuellt,
        Formalia_Kommentar: existingRecord.formalia_kommentar,
        Recht_Erfuellt: existingRecord.recht_erfuellt,
        Recht_Kommentar: existingRecord.recht_kommentar,
        Lage_Erfuellt: existingRecord.lage_erfuellt,
        Lage_Kommentar: existingRecord.lage_kommentar,
        Baurecht_Erfuellt: existingRecord.baurecht_erfuellt,
        Baurecht_Kommentar: existingRecord.baurecht_kommentar,
        Boden_Erfuellt: existingRecord.boden_erfuellt,
        Boden_Kommentar: existingRecord.boden_kommentar,
        Nutzung_Erfuellt: existingRecord.nutzung_erfuellt,
        Nutzung_Kommentar: existingRecord.nutzung_kommentar,
        Gebaeude_Erfuellt: existingRecord.gebaeude_erfuellt,
        Gebaeude_Kommentar: existingRecord.gebaeude_kommentar,
        Verfahren_Erfuellt: existingRecord.verfahren_erfuellt,
        Verfahren_Kommentar: existingRecord.verfahren_kommentar,
        Merkmale_Erfuellt: existingRecord.merkmale_erfuellt,
        Merkmale_Kommentar: existingRecord.merkmale_kommentar,
        Plausi_Erfuellt: existingRecord.plausi_erfuellt,
        Plausi_Kommentar: existingRecord.plausi_kommentar,
        Formaler_Aufbau: existingRecord.formaler_aufbau,
        Formaler_Aufbau_Score: existingRecord.formaler_aufbau_score,
        Darstellung_Befund_und_Anknuepfungstatsachen: existingRecord.darstellung_befund,
        Darstellung_Befund_Score: existingRecord.darstellung_befund_score,
        Fachlicher_Inhalt: existingRecord.fachlicher_inhalt,
        Fachlicher_Inhalt_Score: existingRecord.fachlicher_inhalt_score,
        Bodenwertermittlung: existingRecord.bodenwertermittlung,
        Bodenwertermittlung_Score: existingRecord.bodenwertermittlung_score,
        Ertragswertberechnung: existingRecord.ertragswertberechnung,
        Ertragswertberechnung_Score: existingRecord.ertragswertberechnung_score,
        Sachwertberechnung: existingRecord.sachwertberechnung,
        Sachwertberechnung_Score: existingRecord.sachwertberechnung_score,
        Vergleichswertberechnung: existingRecord.vergleichswertberechnung,
        Vergleichswertberechnung_Score: existingRecord.vergleichswertberechnung_score,
        Zusammenfassung: existingRecord.zusammenfassung,
        Zusammenfassung_Score: existingRecord.zusammenfassung_score,
      };
      const gesamtscore = existingRecord.gesamtscore;

      // Jump to ranking + report + email (steps 9-14)
      return await finishPipeline(logPrefix, gutachtenId, result, gesamtscore, payload, startTime);
    }

    // 6. Upload original PDF to Supabase Storage
    let gutachtenStorageUrl = null;
    try {
      const storagePath = `gutachten/${gutachtenId}/${payload.pdf_filename}`;
      gutachtenStorageUrl = await supabase.uploadPdf(pdfBuffer, storagePath);
      console.log(`${logPrefix} Original PDF uploaded to Supabase Storage`);
    } catch (err) {
      console.error(`${logPrefix} Storage upload failed (non-fatal):`, err.message);
    }

    // 7. Run 13-step Claude evaluation + TEXTPRUEFUNG
    console.log(`${logPrefix} Starting Claude evaluation...`);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { result, errors } = await runEvaluation(client, pdfBase64, {
      ag_vorname: payload.vorname,
      useTextpruefung: true
    });
    console.log(`${logPrefix} Evaluation complete (${errors.length} errors)`);

    // 8. Calculate Gesamtscore
    const gesamtscore = calculateGesamtscore(result);
    console.log(`${logPrefix} Gesamtscore: ${gesamtscore}`);

    // 9. Save results to Supabase
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
    await supabase.updateGutachten(gutachtenId, {
      ...mapResultToSupabaseFields(result),
      gesamtscore,
      pdf_hash: pdfHash,
      pdf_url: gutachtenStorageUrl || payload.pdf_url,
      processing_errors: errors.length > 0 ? errors : null,
      processing_time_seconds: parseFloat(processingTime),
      status: 'Geprüft'
    });
    console.log(`${logPrefix} Results saved to Supabase`);

    // 10. Finish pipeline (ranking, report, email)
    return await finishPipeline(logPrefix, gutachtenId, result, gesamtscore, payload, startTime);

  } catch (err) {
    console.error(`${logPrefix} Fatal error:`, err);
    if (gutachtenId) {
      try {
        await supabase.setStatus(gutachtenId, 'Fehler', err.message);
      } catch (statusErr) {
        console.error(`${logPrefix} Could not set error status:`, statusErr.message);
      }
    }
    throw err;
  }
}

module.exports = { processGutachten };
