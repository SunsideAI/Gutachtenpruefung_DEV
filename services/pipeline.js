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
 * Main pipeline: processes a single Gutachten end-to-end
 */
async function processGutachten(payload) {
  const startTime = Date.now();
  const logPrefix = `[pipeline:${payload.fillout_submission_id?.slice(0, 8)}]`;
  let gutachtenId = null;

  try {
    console.log(`${logPrefix} Starting processing: ${payload.pdf_filename}`);

    // 1. Create Supabase record
    const record = await supabase.createGutachten(payload);
    gutachtenId = record.id;
    console.log(`${logPrefix} Supabase record created: ${gutachtenId}`);

    // 2. Set status to "Wird geprüft"
    await supabase.setStatus(gutachtenId, 'Wird geprüft');

    // 3. Send confirmation email
    try {
      await mailer.sendConfirmation(payload.email, payload.vorname, payload.pdf_filename);
    } catch (err) {
      console.error(`${logPrefix} Confirmation email failed (non-fatal):`, err.message);
    }

    // 4. Download PDF
    console.log(`${logPrefix} Downloading PDF...`);
    const pdfBase64 = await downloadPdf(payload.pdf_url);
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    console.log(`${logPrefix} PDF downloaded (${Math.round(pdfBuffer.length / 1024)} KB)`);

    // 5. Upload original PDF to Supabase Storage
    let gutachtenStorageUrl = null;
    try {
      const storagePath = `gutachten/${gutachtenId}/${payload.pdf_filename}`;
      gutachtenStorageUrl = await supabase.uploadPdf(pdfBuffer, storagePath);
      console.log(`${logPrefix} Original PDF uploaded to Supabase Storage`);
    } catch (err) {
      console.error(`${logPrefix} Storage upload failed (non-fatal):`, err.message);
    }

    // 6. Run 13-step Claude evaluation + TEXTPRUEFUNG
    console.log(`${logPrefix} Starting Claude evaluation...`);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { result, errors } = await runEvaluation(client, pdfBase64, {
      ag_vorname: payload.vorname,
      useTextpruefung: true
    });
    console.log(`${logPrefix} Evaluation complete (${errors.length} errors)`);

    // 7. Calculate Gesamtscore
    const gesamtscore = calculateGesamtscore(result);
    console.log(`${logPrefix} Gesamtscore: ${gesamtscore}`);

    // 8. Save results to Supabase
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
    await supabase.updateGutachten(gutachtenId, {
      ...mapResultToSupabaseFields(result),
      gesamtscore,
      pdf_url: gutachtenStorageUrl || payload.pdf_url,
      processing_errors: errors.length > 0 ? errors : null,
      processing_time_seconds: parseFloat(processingTime),
      status: 'Geprüft'
    });
    console.log(`${logPrefix} Results saved to Supabase`);

    // 9. Calculate AG averages
    const agRecords = await supabase.getGutachtenByAG(payload.unternehmensname);
    const averages = calculateAverages(agRecords);
    console.log(`${logPrefix} AG averages calculated (${agRecords.length} records)`);

    // 10. Calculate rankings across all AGs
    let platzierung = null;
    try {
      const allRecords = await supabase.getAllAGAverages();
      // Group by unternehmensname
      const agGroups = {};
      for (const rec of allRecords) {
        const key = rec.unternehmensname;
        if (!agGroups[key]) {
          agGroups[key] = { unternehmensname: key, vorname: rec.vorname, nachname: rec.nachname, email: rec.email, records: [] };
        }
        agGroups[key].records.push(rec);
      }
      // Calculate averages per AG
      const agAveragesList = Object.values(agGroups).map(ag => {
        const { records, ...agInfo } = ag;
        return { ...agInfo, ...calculateAverages(records) };
      });
      const rankings = calculateRankings(agAveragesList);
      await supabase.upsertRanking(rankings);
      platzierung = rankings.find(r => r.unternehmensname === payload.unternehmensname)?.platzierung || null;
      console.log(`${logPrefix} Rankings updated. AG Platzierung: ${platzierung}`);
    } catch (err) {
      console.error(`${logPrefix} Ranking calculation failed (non-fatal):`, err.message);
    }

    // 11. Generate PDF report via PDFMonkey
    let reportStorageUrl = null;
    try {
      const reportPayload = buildPdfMonkeyPayload(result, gesamtscore, averages, platzierung, payload);
      console.log(`${logPrefix} Generating PDF report...`);
      const docId = await pdfmonkey.generateDocument(process.env.PDFMONKEY_TEMPLATE_ID, reportPayload);
      const { download_url } = await pdfmonkey.waitForDocument(docId);
      const reportBuffer = await pdfmonkey.downloadDocument(download_url);
      console.log(`${logPrefix} PDF report generated`);

      // 12. Upload report to Supabase Storage
      const reportPath = `berichte/${gutachtenId}/Pruefbericht_${payload.pdf_filename}`;
      reportStorageUrl = await supabase.uploadPdf(reportBuffer, reportPath);
      console.log(`${logPrefix} Report uploaded to Supabase Storage`);

      await supabase.updateGutachten(gutachtenId, {
        pruefbericht_drive_link: reportStorageUrl
      });
    } catch (err) {
      console.error(`${logPrefix} PDF report generation/upload failed (non-fatal):`, err.message);
    }

    // 13. Send result email
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

    // 14. Set final status
    await supabase.setStatus(gutachtenId, 'Abgeschlossen');
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`${logPrefix} Pipeline complete in ${totalTime}s`);

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
