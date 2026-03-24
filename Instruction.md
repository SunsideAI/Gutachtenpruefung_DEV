# Gutachtenprüfung API — Claude Code Spec

## Projektziel

Baue eine Node.js/Express API-App (Deployment auf Railway), die ein Immobiliengutachten (PDF) über einen einzigen API-Call entgegennimmt und intern **13 sequentielle Claude-API-Prüfungen** durchführt. Das PDF wird einmal heruntergeladen und per Prompt Caching wiederverwendet. Alle Ergebnisse werden als ein JSON-Objekt an Zapier zurückgegeben.

**Aktueller Zustand:** Ein 40-Step Zapier-Zap, bei dem das PDF bei jedem Prüfschritt separat an die Anthropic API hochgeladen wird (~10 separate Webhook-Calls).

**Zielzustand:** Ein Zapier-Webhook-Call → Railway App → 13 sequentielle Claude-Calls mit gecachtem PDF → ein JSON-Response mit allen Ergebnissen.

---
.
## Architektur

```
Zapier Webhook (POST /evaluate)
  ├── pdf_url (Google Drive Download-Link)
  ├── ag_vorname
  └── datum
        │
        ▼
  Railway App (Node.js/Express)
        │
        ├── 1. PDF herunterladen → Base64
        │
        ├── 2. Sequentielle Claude API-Calls (alle mit dem gleichen PDF als cache_control: ephemeral):
        │   ├── Immobilienbeschreibung
        │   ├── KO-Kriterium 1 (Formalia, Recht, Lage)          → JSON
        │   ├── KO-Kriterium 2 (Baurecht, Boden)                → JSON
        │   ├── KO-Kriterium 3 (Nutzung, Gebäude, Verfahren)    → JSON
        │   ├── KO-Kriterium 4 (Merkmale, Plausi)               → JSON
        │   ├── Formaler Aufbau                                   → Text + Score
        │   ├── Darstellung Befund                                → Text + Score
        │   ├── Fachlicher Inhalt                                 → Text + Score
        │   ├── Bodenwertermittlung                               → Text + Score
        │   ├── Ertragswertberechnung                             → Text + Score
        │   ├── Sachwertberechnung                                → Text + Score
        │   └── Vergleichswertberechnung                          → Text + Score
        │
        ├── 3. Zusammenfassung (Claude-Call OHNE PDF, nur mit den Ergebnistexten)
        │
        └── 4. JSON-Response mit allen Variablen
```

---

## Tech Stack

- **Runtime:** Node.js 20+
- **Framework:** Express
- **API Client:** @anthropic-ai/sdk
- **Deployment:** Railway (Dockerfile)
- **Modell:** claude-opus-4-6 (konfigurierbar über ENV `CLAUDE_MODEL`, siehe Modellwahl unten)

---

## Dateistruktur

```
gutachten-app/
├── index.js          # Express Server + /evaluate Endpoint
├── prompts.js        # Alle Prompt-Texte als exportierte Konstanten
├── package.json
├── Dockerfile
├── .env.example
└── README.md
```

---

## API Endpoint: POST /evaluate

### Request

```json
{
  "pdf_url": "https://drive.google.com/uc?export=download&id=...",
  "ag_vorname": "Max Mustermann",
  "datum": "2026-03-24"
}
```

Header: `x-api-key: sk-ant-...` (oder über ENV `ANTHROPIC_API_KEY`)

### Response

Alle diese Felder müssen im JSON-Response enthalten sein (= die Variablen die Zapier erwartet):

```json
{
  "AG_Vorname": "string",
  "Datum": "string",
  "Objektbeschreibung": "string",

  "Formalia_Erfuellt": "Ja|Nein",
  "Formalia_Kommentar": "string (max 250 Zeichen)",
  "Recht_Erfuellt": "Ja|Nein",
  "Recht_Kommentar": "string",
  "Lage_Erfuellt": "Ja|Nein",
  "Lage_Kommentar": "string",
  "Baurecht_Erfuellt": "Ja|Nein",
  "Baurecht_Kommentar": "string",
  "Boden_Erfuellt": "Ja|Nein",
  "Boden_Kommentar": "string",
  "Nutzung_Erfuellt": "Ja|Nein",
  "Nutzung_Kommentar": "string",
  "Gebaeude_Erfuellt": "Ja|Nein",
  "Gebaeude_Kommentar": "string",
  "Verfahren_Erfuellt": "Ja|Nein",
  "Verfahren_Kommentar": "string",
  "Merkmale_Erfuellt": "Ja|Nein",
  "Merkmale_Kommentar": "string",
  "Plausi_Erfuellt": "Ja|Nein",
  "Plausi_Kommentar": "string",

  "Formaler_Aufbau": "string (Freitext, max 500 Zeichen, Bullet Points mit •)",
  "Darstellung_Befund_und_Anknuepfungstatsachen": "string",
  "Fachlicher_Inhalt": "string",
  "Bodenwertermittlung": "string (oder 'Nicht vorhanden')",
  "Ertragswertberechnung": "string (oder 'Nicht vorhanden')",
  "Sachwertberechnung": "string (oder 'Nicht vorhanden')",
  "Vergleichswertberechnung": "string (oder 'Nicht vorhanden')",
  "Zusammenfassung": "string",

  "Formaler_Aufbau_Score": "number|null",
  "Darstellung_Befund_Score": "number|null",
  "Fachlicher_Inhalt_Score": "number|null",
  "Bodenwertermittlung_Score": "number|null",
  "Ertragswertberechnung_Score": "number|null",
  "Sachwertberechnung_Score": "number|null",
  "Vergleichswertberechnung_Score": "number|null",
  "Zusammenfassung_Score": "number|null",

  "_processing_time_seconds": "string",
  "_errors": "array|undefined",
  "_model": "string"
}
```

---

## Implementierungsdetails

### 1. PDF herunterladen

- URL kommt von Google Drive (ggf. Redirects folgen)
- `Buffer` → `.toString('base64')`
- Fehlerbehandlung wenn Download fehlschlägt

### 2. Claude API-Call Funktion

Jeder Prüfschritt nutzt die gleiche Funktion. Die Rolle (Sachverständiger) ist bereits in jedem Prompt enthalten — kein separater System-Prompt nötig.

```javascript
// Wichtig: cache_control auf dem PDF-Document-Block
const messages = [{
  role: 'user',
  content: [
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: pdfBase64
      },
      cache_control: { type: 'ephemeral' }  // ← DAS ist der Schlüssel!
    },
    {
      type: 'text',
      text: promptText
    }
  ]
}];

// Header für Prompt Caching:
// headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' }
```

**Wichtig:** Das PDF wird als `type: 'document'` mit `media_type: 'application/pdf'` gesendet. Claude rendert jede Seite als Bild — Tabellen, Grafiken, Fotos, Stempel, alles wird visuell erkannt.

### 3. Prompt Caching

- Der PDF-Base64-Content bekommt `cache_control: { type: 'ephemeral' }`
- Beim ersten Call wird das PDF voll berechnet (~100% Kosten)
- Alle Folge-Calls: PDF-Tokens kosten nur noch 10%
- Beta-Header setzen: `anthropic-beta: prompt-caching-2024-07-31`

### 4. KO-Kriterien Parsing

KO-Calls liefern reines JSON. Parsing-Logik:
1. `text.trim()` → Markdown-Fences (`\`\`\`json`) entfernen
2. `JSON.parse()` versuchen
3. Fallback: Regex `/{[\s\S]*}/` um JSON im Text zu finden
4. JSON-Keys sind lowercase_snake_case (z.B. `formalia_und_anlagen`, `rechtliche_verhaeltnisse`)

**KO-1 Keys:** `formalia_und_anlagen`, `rechtliche_verhaeltnisse`, `lage_und_marktdaten`
**KO-2 Keys:** `baurecht`, `grund_und_boden`
**KO-3 Keys:** `tatsaechliche_nutzung`, `gebaeude_und_flaechen`, `wertermittlungsverfahren`
**KO-4 Keys:** `besondere_merkmale`, `plausibilisierung_verkehrswert`

Jeder Key hat `{ "erfuellt": "Ja"|"Nein", "kommentar": "..." }`.

### 5. Score Extraction

Prüfkriterien-Calls liefern Freitext mit Score am Ende. Regex:
```
/Bewertung:\s*(\d+(?:[.,]\d+)?)\s*\/\s*10/i
```
Für Zusammenfassung: `/Gesamtbewertung:\s*(\d+(?:[.,]\d+)?)\s*\/\s*10/i`

Wenn "Nicht vorhanden" → Score = null.

### 6. Text-Bereinigung (ersetzt den separaten "Textprüfung"-GPT-Step)

Claude generiert manchmal technische Referenzen. Diese inline entfernen:
- `citeturn...`, `file X`, `turnfile...`, `(vgl. citeturn...)` → entfernen
- Seitenzahlen wie "Seite 7", "S. 12" → behalten

### 7. Zusammenfassung

Separater Claude-Call **ohne PDF** — nur die Ergebnistexte der 7 Prüfkriterien werden als Input übergeben. Falls ein Prüfkriterium "Nicht vorhanden" ist, wird es bei der Gesamtbewertung ignoriert.

### 8. Error Handling

- Jeder Prüfschritt ist in try/catch gewrapped
- Wenn ein Step fehlschlägt, wird er mit `error` markiert und die restlichen Steps laufen weiter
- Alle Errors werden in `_errors` Array gesammelt
- Fatal Error (PDF Download, API Key) → 500 Response

---

## Prompt-Texte (prompts.js)

**Die Datei prompts.js enthält alle Prompts 1:1 aus dem Original-DOCX.** Es wurde NICHTS am Prompt-Text verändert — nur das Zapier-Escaping (`\\n` → Newline, `\"` → `"`) aufgelöst und die Zapier-Template-Variablen (`{{303093445__answer[]text}}`) durch JS-Template-Variablen (`${results.formaler_aufbau}`) ersetzt.

Die Datei ist bereits fertig und muss nicht neu geschrieben werden — einfach in das Projekt übernehmen.

### Exportierte Konstanten:
- `KO_1` — Formalia und Anlagen, Rechtliche Verhältnisse, Lage und Marktdaten (3 Kategorien, JSON-Output)
- `KO_2` — Baurecht, Grund und Boden (2 Kategorien, JSON-Output)
- `KO_3` — Tatsächliche Nutzung, Gebäude und Flächen, Wertermittlungsverfahren (3 Kategorien, JSON-Output)
- `KO_4` — Besondere Merkmale, Plausibilisierung Verkehrswert (2 Kategorien, JSON-Output)
- `FORMALER_AUFBAU` — Text + Score
- `DARSTELLUNG_BEFUND` — Text + Score
- `FACHLICHER_INHALT` — Text + Score
- `BODENWERTERMITTLUNG` — Text + Score (oder "Nicht vorhanden")
- `ERTRAGSWERTBERECHNUNG` — Text + Score (oder "Nicht vorhanden")
- `SACHWERTBERECHNUNG` — Text + Score (oder "Nicht vorhanden")
- `VERGLEICHSWERTBERECHNUNG` — Text + Score (oder "Nicht vorhanden")
- `ZUSAMMENFASSUNG(results)` — Funktion, nimmt Ergebnistexte als Parameter, generiert Prompt (KEIN PDF nötig)
- `IMMOBILIENBESCHREIBUNG` — Objektbeschreibung (3–5 Sätze Fließtext, braucht PDF)
- `TEXTPRUEFUNG` — Prompt zum Bereinigen technischer Referenzen (optional als Post-Processing nutzbar)

---

## Prompt-Texte im Detail

**Die Datei `prompts.js` ist bereits fertig und enthält alle Prompts 1:1 aus dem Original-DOCX.** Einfach in das Projekt übernehmen — nichts ändern.

Wichtige Details für die Implementierung:

**KO-Kriterien (KO_1–KO_4):** Output ist reines JSON. Die Keys sind:
- KO_1: `formalia_und_anlagen`, `rechtliche_verhaeltnisse`, `lage_und_marktdaten`
- KO_2: `baurecht`, `grund_und_boden`
- KO_3: `tatsaechliche_nutzung`, `gebaeude_und_flaechen`, `wertermittlungsverfahren`
- KO_4: `besondere_merkmale`, `plausibilisierung_verkehrswert`
Jeder Key hat `{ "erfuellt": "Ja"|"Nein", "kommentar": "..." }`.

**Prüfkriterien:** Output ist Fließtext mit Bullet Points (•) und "Bewertung: X/10" am Ende. Bodenwertermittlung, Ertragswert, Sachwert, Vergleichswert können "Nicht vorhanden" zurückgeben.

**Zusammenfassung:** Ist eine Funktion `ZUSAMMENFASSUNG(results)` — aufrufen mit Objekt das die 7 Prüfergebnisse enthält. Braucht kein PDF.

**Textprüfung:** `TEXTPRUEFUNG` enthält den Prompt zum Bereinigen technischer Referenzen. Kann optional als Post-Processing-Step genutzt werden, oder die Bereinigung wird per Regex im Code gemacht.

---

## Vorgehen (Schritt für Schritt)

### Phase 1: Projekt-Setup
1. `npm init -y`
2. `npm install express @anthropic-ai/sdk`
3. Dockerfile erstellen (Node 20 Alpine)
4. `.env.example` mit `ANTHROPIC_API_KEY`, `PORT`, `CLAUDE_MODEL=claude-opus-4-6`

### Phase 2: prompts.js
1. **Datei ist bereits fertig** — einfach `prompts.js` ins Projekt kopieren
2. Testen: `node -e "const p = require('./prompts'); console.log(Object.keys(p))"`
3. Verifizieren: `typeof p.ZUSAMMENFASSUNG === 'function'`

### Phase 3: index.js — Core Logic
1. Express Server mit JSON-Body-Parsing (50mb Limit)
2. `downloadFile(url)` — HTTP/HTTPS mit Redirect-Following
3. `callClaude(client, pdfBase64, prompt, useSystem)` — Claude API Call mit Prompt Caching
4. `callClaudeText(client, prompt)` — Ohne PDF (für Zusammenfassung)
5. `parseKoResponse(text)` — JSON aus KO-Antwort extrahieren
6. `extractScore(text)` — Score aus "Bewertung: X/10" extrahieren
7. `cleanText(text)` — Technische Referenzen entfernen

### Phase 4: /evaluate Endpoint
1. Request validieren (pdf_url required, API key required)
2. PDF herunterladen → Base64
3. 13 Steps sequentiell durchlaufen (jeweils try/catch)
4. Zusammenfassung generieren (ohne PDF)
5. Response-JSON zusammenbauen mit allen Zapier-Variablen
6. Logging (Step-Name, Dauer, Errors)

### Phase 5: Testing
1. Health-Check: `GET /health`
2. Test mit echtem Gutachten-PDF
3. Prüfen: Alle Variablen im Response vorhanden?
4. Prüfen: KO-JSON korrekt geparst?
5. Prüfen: Scores korrekt extrahiert?
6. Prüfen: "Nicht vorhanden" korrekt gehandelt?

### Phase 6: Railway Deployment
1. GitHub Repo erstellen + pushen
2. Railway Projekt → Deploy from GitHub
3. ENV Vars setzen: `ANTHROPIC_API_KEY`, `PORT=3000`, `CLAUDE_MODEL=claude-opus-4-6`
4. Test-Call von Postman/curl

### Phase 7: Zapier umbauen
1. Steps 7–30 des alten Zaps löschen (KO-Webhooks, Anthropic-Calls, Code-Steps für Variable-Extraction)
2. Neuen Webhook-Step einfügen: POST an Railway-App
3. Timeout auf 300s setzen
4. Response-Felder in nachfolgende Steps mappen (Airtable, PDFMonkey, SMTP)
5. Testen mit echtem Gutachten

---

## Timeout-Problem bei Zapier

Die Prüfung dauert 2–5 Minuten. Zapier Webhook hat standardmäßig 30s Timeout. Lösungen:

**Option A (empfohlen für Zapier Professional+):** Zapier "Webhooks by Zapier" Custom Request → Timeout auf 300s setzen (nur bei Professional+ Plan möglich).

**Option B (für alle Pläne):** Asynchroner Ansatz:
1. Zapier sendet POST an `/evaluate-async` → bekommt sofort `{ "job_id": "..." }` zurück
2. Railway App verarbeitet im Hintergrund
3. Wenn fertig → Railway App sendet POST an einen Zapier Catch Hook mit allen Ergebnissen
4. Separater Zap wird durch den Catch Hook getriggert

Falls Option B nötig ist, muss die App erweitert werden um:
- `/evaluate-async` Endpoint (gibt sofort job_id zurück)
- Background Processing (z.B. mit Promise, nicht await)
- Callback-URL als Parameter (`callback_url` im Request Body)
- POST mit Ergebnissen an die Callback-URL wenn fertig

---

## Modellwahl

**Empfehlung: Claude Opus 4.6 (`claude-opus-4-6`)**

Für diesen Use Case — fachlich komplexe Immobilienbewertung nach DIAZert-Standards, visuelle Erkennung von Tabellen/Stempeln/Karten in PDFs, Erkennung fehlender Angaben — ist Opus 4.6 die richtige Wahl. Der Preisunterschied ist pro Gutachten nur ~$0.50–$0.70 mehr als Sonnet, aber die Qualität bei tiefem Reasoning über lange, fachlich dichte Dokumente ist messbar besser.

| Modell | Input/MTok | Output/MTok | Kontext | API String |
|--------|-----------|-------------|---------|------------|
| Claude Opus 4.6 | $5 | $25 | 1M Tokens | `claude-opus-4-6` |
| Claude Sonnet 4.6 | $3 | $15 | 1M Tokens | `claude-sonnet-4-6` |

Beide Modelle haben 1M Token Kontext ohne Preisaufschlag und unterstützen Prompt Caching. Das Modell ist über die ENV-Variable `CLAUDE_MODEL` konfigurierbar — falls die Kosten irgendwann ein Thema werden, kann jederzeit auf Sonnet umgestellt werden, ohne Code-Änderung.

**In .env.example:**
```
CLAUDE_MODEL=claude-opus-4-6
```

---

## Kosten-Schätzung (pro Gutachten, ~50 Seiten PDF)

**Ohne diese App (aktuell, ~10 separate Uploads):**
- ~10 separate PDF-Uploads × ~75.000 Tokens/PDF = ~750.000 Input-Tokens
- Mit Opus: ~$3.75 nur für Input
- Mit Sonnet: ~$2.25 nur für Input

**Mit dieser App (Prompt Caching, 13 sequentielle Calls):**

| | Opus 4.6 | Sonnet 4.6 |
|---|---------|------------|
| 1× voller PDF-Upload | $0.38 | $0.23 |
| 12× gecachtes PDF (10% Kosten) | $0.45 | $0.27 |
| Prompt-Tokens (13 Calls) | $0.15 | $0.09 |
| Output-Tokens (13 Calls) | $0.50 | $0.30 |
| **Total pro Gutachten** | **~$1.50** | **~$0.90** |
| **Ersparnis vs. aktuell** | **~60%** | **~60%** |
