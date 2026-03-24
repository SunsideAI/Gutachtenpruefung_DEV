const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const {
  KO_1, KO_2, KO_3, KO_4,
  FORMALER_AUFBAU, DARSTELLUNG_BEFUND, FACHLICHER_INHALT,
  BODENWERTERMITTLUNG, ERTRAGSWERTBERECHNUNG, SACHWERTBERECHNUNG, VERGLEICHSWERTBERECHNUNG,
  ZUSAMMENFASSUNG, IMMOBILIENBESCHREIBUNG, TEXTPRUEFUNG
} = require('./prompts');

// ── Utility Functions ───────────────────────────────────────────────

async function downloadPdf(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    // Google Drive sometimes needs confirm param for large files
    if (response.headers.get('content-type')?.includes('text/html')) {
      const retryUrl = url.includes('?') ? `${url}&confirm=t` : `${url}?confirm=t`;
      const retry = await fetch(retryUrl, { redirect: 'follow' });
      if (!retry.ok) throw new Error(`PDF download failed: ${retry.status} ${retry.statusText}`);
      const buffer = Buffer.from(await retry.arrayBuffer());
      return buffer.toString('base64');
    }
    throw new Error(`PDF download failed: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type') || '';
  // If we got HTML instead of PDF, retry with confirm param
  if (contentType.includes('text/html')) {
    const retryUrl = url.includes('?') ? `${url}&confirm=t` : `${url}?confirm=t`;
    const retry = await fetch(retryUrl, { redirect: 'follow' });
    if (!retry.ok) throw new Error(`PDF download failed after confirm retry: ${retry.status}`);
    const buffer = Buffer.from(await retry.arrayBuffer());
    return buffer.toString('base64');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString('base64');
}

async function callClaude(client, pdfBase64, promptText) {
  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBase64
          },
          cache_control: { type: 'ephemeral' }
        },
        {
          type: 'text',
          text: promptText
        }
      ]
    }]
  }, {
    headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' }
  });
  return response.content[0].text;
}

async function callClaudeText(client, promptText) {
  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: promptText
    }]
  });
  return response.content[0].text;
}

function parseKoResponse(text) {
  let cleaned = text.trim();
  // Remove markdown fences
  cleaned = cleaned.replace(/```json?\s*/g, '').replace(/```\s*/g, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: extract JSON object from text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractScore(text, isZusammenfassung = false) {
  if (!text) return null;
  // Check for "Nicht vorhanden" first
  if (/nicht\s+vorhanden/i.test(text)) return null;
  const pattern = isZusammenfassung
    ? /Gesamtbewertung:\s*(\d+(?:[.,]\d+)?)\s*\/\s*10/i
    : /Bewertung:\s*(\d+(?:[.,]\d+)?)\s*\/\s*10/i;
  const match = text.match(pattern);
  if (match) {
    return parseFloat(match[1].replace(',', '.'));
  }
  return null;
}

function cleanText(text) {
  if (!text) return text;
  let cleaned = text;
  // Remove machine-generated references
  cleaned = cleaned.replace(/\(vgl\.\s*citeturn[^)]*\)/g, '');
  cleaned = cleaned.replace(/\(citeturn[^)]*\)/g, '');
  cleaned = cleaned.replace(/citeturn\d*file\d*\S*/g, '');
  cleaned = cleaned.replace(/turnfile\d+\S*/g, '');
  cleaned = cleaned.replace(/\bfile\s+\d+\b/gi, '');
  // Collapse multiple spaces and trim
  cleaned = cleaned.replace(/  +/g, ' ').trim();
  return cleaned;
}

// ── Express Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
    timestamp: new Date().toISOString()
  });
});

app.post('/evaluate', async (req, res) => {
  const startTime = Date.now();
  const errors = [];

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

  // 4. Initialize result object
  const result = {
    AG_Vorname: ag_vorname || '',
    Datum: datum || new Date().toISOString().split('T')[0],
    Objektbeschreibung: '',
    Formalia_Erfuellt: '', Formalia_Kommentar: '',
    Recht_Erfuellt: '', Recht_Kommentar: '',
    Lage_Erfuellt: '', Lage_Kommentar: '',
    Baurecht_Erfuellt: '', Baurecht_Kommentar: '',
    Boden_Erfuellt: '', Boden_Kommentar: '',
    Nutzung_Erfuellt: '', Nutzung_Kommentar: '',
    Gebaeude_Erfuellt: '', Gebaeude_Kommentar: '',
    Verfahren_Erfuellt: '', Verfahren_Kommentar: '',
    Merkmale_Erfuellt: '', Merkmale_Kommentar: '',
    Plausi_Erfuellt: '', Plausi_Kommentar: '',
    Formaler_Aufbau: '', Formaler_Aufbau_Score: null,
    Darstellung_Befund_und_Anknuepfungstatsachen: '', Darstellung_Befund_Score: null,
    Fachlicher_Inhalt: '', Fachlicher_Inhalt_Score: null,
    Bodenwertermittlung: '', Bodenwertermittlung_Score: null,
    Ertragswertberechnung: '', Ertragswertberechnung_Score: null,
    Sachwertberechnung: '', Sachwertberechnung_Score: null,
    Vergleichswertberechnung: '', Vergleichswertberechnung_Score: null,
    Zusammenfassung: '', Zusammenfassung_Score: null
  };

  // ── Step 1: Immobilienbeschreibung ──
  try {
    console.log('[evaluate] Step 1/13: Immobilienbeschreibung');
    const text = await callClaude(client, pdfBase64, IMMOBILIENBESCHREIBUNG);
    result.Objektbeschreibung = cleanText(text);
  } catch (err) {
    errors.push(`Immobilienbeschreibung: ${err.message}`);
    console.error('[evaluate] Step 1 failed:', err.message);
  }

  // ── Step 2: KO-Kriterium 1 ──
  try {
    console.log('[evaluate] Step 2/13: KO-1 (Formalia, Recht, Lage)');
    const text = await callClaude(client, pdfBase64, KO_1);
    const parsed = parseKoResponse(text);
    if (parsed) {
      if (parsed.formalia_und_anlagen) {
        result.Formalia_Erfuellt = parsed.formalia_und_anlagen.erfuellt || '';
        result.Formalia_Kommentar = parsed.formalia_und_anlagen.kommentar || '';
      }
      if (parsed.rechtliche_verhaeltnisse) {
        result.Recht_Erfuellt = parsed.rechtliche_verhaeltnisse.erfuellt || '';
        result.Recht_Kommentar = parsed.rechtliche_verhaeltnisse.kommentar || '';
      }
      if (parsed.lage_und_marktdaten) {
        result.Lage_Erfuellt = parsed.lage_und_marktdaten.erfuellt || '';
        result.Lage_Kommentar = parsed.lage_und_marktdaten.kommentar || '';
      }
    } else {
      errors.push('KO_1: JSON parsing failed');
    }
  } catch (err) {
    errors.push(`KO_1: ${err.message}`);
    console.error('[evaluate] Step 2 failed:', err.message);
  }

  // ── Step 3: KO-Kriterium 2 ──
  try {
    console.log('[evaluate] Step 3/13: KO-2 (Baurecht, Boden)');
    const text = await callClaude(client, pdfBase64, KO_2);
    const parsed = parseKoResponse(text);
    if (parsed) {
      if (parsed.baurecht) {
        result.Baurecht_Erfuellt = parsed.baurecht.erfuellt || '';
        result.Baurecht_Kommentar = parsed.baurecht.kommentar || '';
      }
      if (parsed.grund_und_boden) {
        result.Boden_Erfuellt = parsed.grund_und_boden.erfuellt || '';
        result.Boden_Kommentar = parsed.grund_und_boden.kommentar || '';
      }
    } else {
      errors.push('KO_2: JSON parsing failed');
    }
  } catch (err) {
    errors.push(`KO_2: ${err.message}`);
    console.error('[evaluate] Step 3 failed:', err.message);
  }

  // ── Step 4: KO-Kriterium 3 ──
  try {
    console.log('[evaluate] Step 4/13: KO-3 (Nutzung, Gebäude, Verfahren)');
    const text = await callClaude(client, pdfBase64, KO_3);
    const parsed = parseKoResponse(text);
    if (parsed) {
      if (parsed.tatsaechliche_nutzung) {
        result.Nutzung_Erfuellt = parsed.tatsaechliche_nutzung.erfuellt || '';
        result.Nutzung_Kommentar = parsed.tatsaechliche_nutzung.kommentar || '';
      }
      if (parsed.gebaeude_und_flaechen) {
        result.Gebaeude_Erfuellt = parsed.gebaeude_und_flaechen.erfuellt || '';
        result.Gebaeude_Kommentar = parsed.gebaeude_und_flaechen.kommentar || '';
      }
      if (parsed.wertermittlungsverfahren) {
        result.Verfahren_Erfuellt = parsed.wertermittlungsverfahren.erfuellt || '';
        result.Verfahren_Kommentar = parsed.wertermittlungsverfahren.kommentar || '';
      }
    } else {
      errors.push('KO_3: JSON parsing failed');
    }
  } catch (err) {
    errors.push(`KO_3: ${err.message}`);
    console.error('[evaluate] Step 4 failed:', err.message);
  }

  // ── Step 5: KO-Kriterium 4 ──
  try {
    console.log('[evaluate] Step 5/13: KO-4 (Merkmale, Plausi)');
    const text = await callClaude(client, pdfBase64, KO_4);
    const parsed = parseKoResponse(text);
    if (parsed) {
      if (parsed.besondere_merkmale) {
        result.Merkmale_Erfuellt = parsed.besondere_merkmale.erfuellt || '';
        result.Merkmale_Kommentar = parsed.besondere_merkmale.kommentar || '';
      }
      if (parsed.plausibilisierung_verkehrswert) {
        result.Plausi_Erfuellt = parsed.plausibilisierung_verkehrswert.erfuellt || '';
        result.Plausi_Kommentar = parsed.plausibilisierung_verkehrswert.kommentar || '';
      }
    } else {
      errors.push('KO_4: JSON parsing failed');
    }
  } catch (err) {
    errors.push(`KO_4: ${err.message}`);
    console.error('[evaluate] Step 5 failed:', err.message);
  }

  // ── Step 6: Formaler Aufbau ──
  try {
    console.log('[evaluate] Step 6/13: Formaler Aufbau');
    const text = await callClaude(client, pdfBase64, FORMALER_AUFBAU);
    result.Formaler_Aufbau = cleanText(text);
    result.Formaler_Aufbau_Score = extractScore(text);
  } catch (err) {
    errors.push(`Formaler_Aufbau: ${err.message}`);
    console.error('[evaluate] Step 6 failed:', err.message);
  }

  // ── Step 7: Darstellung Befund ──
  try {
    console.log('[evaluate] Step 7/13: Darstellung Befund');
    const text = await callClaude(client, pdfBase64, DARSTELLUNG_BEFUND);
    result.Darstellung_Befund_und_Anknuepfungstatsachen = cleanText(text);
    result.Darstellung_Befund_Score = extractScore(text);
  } catch (err) {
    errors.push(`Darstellung_Befund: ${err.message}`);
    console.error('[evaluate] Step 7 failed:', err.message);
  }

  // ── Step 8: Fachlicher Inhalt ──
  try {
    console.log('[evaluate] Step 8/13: Fachlicher Inhalt');
    const text = await callClaude(client, pdfBase64, FACHLICHER_INHALT);
    result.Fachlicher_Inhalt = cleanText(text);
    result.Fachlicher_Inhalt_Score = extractScore(text);
  } catch (err) {
    errors.push(`Fachlicher_Inhalt: ${err.message}`);
    console.error('[evaluate] Step 8 failed:', err.message);
  }

  // ── Step 9: Bodenwertermittlung ──
  try {
    console.log('[evaluate] Step 9/13: Bodenwertermittlung');
    const text = await callClaude(client, pdfBase64, BODENWERTERMITTLUNG);
    result.Bodenwertermittlung = cleanText(text);
    result.Bodenwertermittlung_Score = extractScore(text);
  } catch (err) {
    errors.push(`Bodenwertermittlung: ${err.message}`);
    console.error('[evaluate] Step 9 failed:', err.message);
  }

  // ── Step 10: Ertragswertberechnung ──
  try {
    console.log('[evaluate] Step 10/13: Ertragswertberechnung');
    const text = await callClaude(client, pdfBase64, ERTRAGSWERTBERECHNUNG);
    result.Ertragswertberechnung = cleanText(text);
    result.Ertragswertberechnung_Score = extractScore(text);
  } catch (err) {
    errors.push(`Ertragswertberechnung: ${err.message}`);
    console.error('[evaluate] Step 10 failed:', err.message);
  }

  // ── Step 11: Sachwertberechnung ──
  try {
    console.log('[evaluate] Step 11/13: Sachwertberechnung');
    const text = await callClaude(client, pdfBase64, SACHWERTBERECHNUNG);
    result.Sachwertberechnung = cleanText(text);
    result.Sachwertberechnung_Score = extractScore(text);
  } catch (err) {
    errors.push(`Sachwertberechnung: ${err.message}`);
    console.error('[evaluate] Step 11 failed:', err.message);
  }

  // ── Step 12: Vergleichswertberechnung ──
  try {
    console.log('[evaluate] Step 12/13: Vergleichswertberechnung');
    const text = await callClaude(client, pdfBase64, VERGLEICHSWERTBERECHNUNG);
    result.Vergleichswertberechnung = cleanText(text);
    result.Vergleichswertberechnung_Score = extractScore(text);
  } catch (err) {
    errors.push(`Vergleichswertberechnung: ${err.message}`);
    console.error('[evaluate] Step 12 failed:', err.message);
  }

  // ── Step 13: Zusammenfassung (without PDF) ──
  try {
    console.log('[evaluate] Step 13/13: Zusammenfassung');
    const zusammenfassungPrompt = ZUSAMMENFASSUNG({
      formaler_aufbau: result.Formaler_Aufbau,
      darstellung_befund: result.Darstellung_Befund_und_Anknuepfungstatsachen,
      fachlicher_inhalt: result.Fachlicher_Inhalt,
      bodenwertermittlung: result.Bodenwertermittlung,
      ertragswertberechnung: result.Ertragswertberechnung,
      sachwertberechnung: result.Sachwertberechnung,
      vergleichswertberechnung: result.Vergleichswertberechnung
    });
    const text = await callClaudeText(client, zusammenfassungPrompt);
    result.Zusammenfassung = cleanText(text);
    result.Zusammenfassung_Score = extractScore(text, true);
  } catch (err) {
    errors.push(`Zusammenfassung: ${err.message}`);
    console.error('[evaluate] Step 13 failed:', err.message);
  }

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

// ── Start Server ────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Gutachtenprüfung API running on port ${PORT}`);
  console.log(`Model: ${process.env.CLAUDE_MODEL || 'claude-opus-4-6'}`);
});

// Set server timeout to 300s for long-running evaluations
server.timeout = 300000;
server.keepAliveTimeout = 300000;
