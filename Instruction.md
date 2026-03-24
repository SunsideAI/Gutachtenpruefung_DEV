# Gutachtenprüfung API — Claude Code Spec

## Projektziel

Baue eine Node.js/Express API-App (Deployment auf Railway), die ein Immobiliengutachten (PDF) über einen einzigen API-Call entgegennimmt und intern **13 sequentielle Claude-API-Prüfungen** durchführt. Das PDF wird einmal heruntergeladen und per Prompt Caching wiederverwendet. Alle Ergebnisse werden als ein JSON-Objekt an Zapier zurückgegeben.

**Aktueller Zustand:** Ein 40-Step Zapier-Zap, bei dem das PDF bei jedem Prüfschritt separat an die Anthropic API hochgeladen wird (~10 separate Webhook-Calls).

**Zielzustand:** Ein Zapier-Webhook-Call → Railway App → 13 sequentielle Claude-Calls mit gecachtem PDF → ein JSON-Response mit allen Ergebnissen.

---

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
- **Modell:** claude-sonnet-4-20250514 (konfigurierbar über ENV `CLAUDE_MODEL`)

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

Jeder Prüfschritt nutzt die gleiche Funktion:

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
- System-Prompt ebenfalls mit `cache_control: { type: 'ephemeral' }`
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

Alle Prompts sind bereits fertig und müssen 1:1 übernommen werden. Die Datei enthält:

### Shared Blocks (DRY)
- `SYSTEM_ROLE` — Sachverständigen-Rolle für KO-Kriterien
- `KO_SPEC_BLOCK(n)` — JSON-Output Spezifikationen für KO-Kriterien
- `KO_CONTEXT` — Kontext-Block für KO-Kriterien
- `KO_NOTES(n)` — Notizen-Block für KO-Kriterien
- `KO_RULE` — Bewertungsregel (Ja nur wenn alle Teilaspekte erfüllt)
- `PRUEF_SPEC_BLOCK` — Spezifikationen für Prüfkriterien (Bullet Points, 500 Zeichen, Bewertung: X/10)
- `PRUEF_CONTEXT` — Kontext-Block für Prüfkriterien
- `PRUEF_NOTES` — Notizen-Block für Prüfkriterien
- `BEWERTUNGSSKALA` — Punkteskala 0–10

### KO-Kriterien Prompts
- `KO_1` — Formalia und Anlagen, Rechtliche Verhältnisse, Lage und Marktdaten (3 Kategorien)
- `KO_2` — Baurecht, Grund und Boden (2 Kategorien)
- `KO_3` — Tatsächliche Nutzung, Gebäude und Flächen, Wertermittlungsverfahren (3 Kategorien)
- `KO_4` — Besondere Merkmale, Plausibilisierung Verkehrswert (2 Kategorien)

### Prüfkriterien Prompts (Text + Score Output)
- `FORMALER_AUFBAU`
- `DARSTELLUNG_BEFUND`
- `FACHLICHER_INHALT`
- `BODENWERTERMITTLUNG` — gibt "Nicht vorhanden" wenn nicht im Gutachten
- `ERTRAGSWERTBERECHNUNG` — gibt "Nicht vorhanden" wenn nicht im Gutachten
- `SACHWERTBERECHNUNG` — gibt "Nicht vorhanden" wenn nicht im Gutachten
- `VERGLEICHSWERTBERECHNUNG` — gibt "Nicht vorhanden" wenn nicht im Gutachten

### Meta-Prompts
- `IMMOBILIENBESCHREIBUNG` — Objektbeschreibung (3–5 Sätze Fließtext, kein PDF-Upload nötig... doch, braucht PDF)
- `ZUSAMMENFASSUNG(results)` — Funktion die die Ergebnistexte als Parameter nimmt und den Prompt generiert (KEIN PDF nötig)

---

## Prompt-Texte im Detail

Hier sind die vollständigen Prompt-Texte die in prompts.js übernommen werden müssen:

### SYSTEM_ROLE (nur für KO-Kriterien)
```
Du bist ein hochqualifizierter, sehr kritischer Sachverständiger für Immobilienbewertung mit fundierter Expertise in der Analyse und Bewertung von Verkehrswertgutachten nach § 194 BauGB. Deine Prüfung erfolgt nach den Anforderungen der DIAZert und gängiger Bewertungsstandards.
```

### KO_1 Prompt

**Kategorien:** formalia_und_anlagen, rechtliche_verhaeltnisse, lage_und_marktdaten
**Output:** JSON mit erfuellt (Ja/Nein) + kommentar (max 250 Zeichen)

Prüfkategorien:
- Formalia und Anlagen: Alle formalen Angaben (SV, Gutachtennummer, Objekt, Stichtage, VW), Schlussformel mit Unterschrift/Stempel, vollständige Anlagen inkl. Fotodokumentation mit Herkunftsangabe
- Rechtliche Verhältnisse: Auftraggeber (ggf. anonymisiert), Zweck/Art des Gutachtens, Ortstermin-Daten inkl. Teilnehmer, Umfang und Einschränkungen
- Lage und Marktdaten: Makro-/Mikrolage (Infrastruktur, Umweltfaktoren), Marktdaten (Immobilienmarkt, Demografie, Kaufkraft, Arbeitsmarkt, makroökonomische Größen)

Regel: Nur "Ja" wenn ALLE Teilaspekte vollständig. Sobald ein Aspekt fehlt → "Nein" mit konkretem Grund.

### KO_2 Prompt

**Kategorien:** baurecht, grund_und_boden

Prüfkategorien:
- Baurecht: Bauleitplanung (FNP, B-Plan, §§ 34/35 BauGB), zulässige Nutzung (BauNVO), besondere Regelungen (Bodenordnung, Sanierungsgebiete, Baumschutzsatzung)
- Grund und Boden: Grundbuch-/Katasterdaten, Baulasten, Altlasten, Erschließung, privatrechtliche Rechte, WEG, Denkmalschutz, Naturgefahren

### KO_3 Prompt

**Kategorien:** tatsaechliche_nutzung, gebaeude_und_flaechen, wertermittlungsverfahren

Prüfkategorien:
- Tatsächliche Nutzung: Wohnwirtschaftlich/gewerblich/gemischt inkl. Verträge
- Gebäude und Flächen: Gebäudeart, Baujahr, Modernisierungen, Bauweise, Zustand, Energie, Barrierefreiheit, GRZ/GFZ/WF/NF/BGF mit Quellen und Plausibilitätsprüfung
- Wertermittlungsverfahren: Verfahrenswahl begründet, Schritte korrekt angewendet (VW/EW/SW je nach Verfahren), Quellen und objektspezifische Begründungen

### KO_4 Prompt

**Kategorien:** besondere_merkmale, plausibilisierung_verkehrswert

Prüfkategorien:
- Besondere Merkmale: Objektspezifische Merkmale (Baumängel, Rechte, PV-Anlage etc.) nachvollziehbar hergeleitet
- Plausibilisierung: Ergebnis plausibilisiert durch Vergleichspreise/Wertfaktoren/Marktanalysen. Erfüllt nur wenn: (1) zweites Verfahren angewendet ODER (2) explizite textliche Plausibilisierung. Abweichung >10% zwischen Verfahren muss begründet sein.

### Prüfkriterien-Prompts (Formaler Aufbau, Darstellung Befund, etc.)

Alle folgen dem gleichen Schema:
1. Rolle als SV für Immobilienbewertung
2. Prüfe nach DIAZert-Standards
3. Identifiziere Schwächen/Stärken mit Seitenzahlen
4. Konkrete Handlungsempfehlungen
5. Bewertung 1–10

**Output-Format:**
- Bullet Points mit • (nicht -)
- Max 500 Zeichen
- "Bewertung: X/10" am Ende mit Absatz davor
- Kein Markdown, kein Markup
- Formelle Anrede "Sie"
- Kein Text nach der Bewertung

**Bodenwertermittlung/Ertragswert/Sachwert/Vergleichswert:**
- Erst prüfen ob das Verfahren im Gutachten vorkommt
- Falls nicht → nur "Nicht vorhanden" ausgeben
- Falls ja → normale Prüfung + Bewertung

### Immobilienbeschreibung

3–5 Sätze Fließtext: Objektart, Nutzung, Lage, Wohnfläche, Grundstücksfläche, Baujahr, Art des Gutachtens, Anlass. Nur was im PDF steht. Keine Klarnamen. Keine Quellenverweise.

### Zusammenfassung

Funktion die 7 Prüfergebnisse als Input nimmt. Berechnet Gesamtbewertung als Durchschnitt (gerundet auf 1 Nachkommastelle). "Nicht vorhanden" ignorieren. Max 500 Zeichen. "Gesamtbewertung: X/10" am Ende. Kein PDF nötig — nur Text-Input.

---

## Vorgehen (Schritt für Schritt)

### Phase 1: Projekt-Setup
1. `npm init -y`
2. `npm install express @anthropic-ai/sdk`
3. Dockerfile erstellen (Node 20 Alpine)
4. `.env.example` mit `ANTHROPIC_API_KEY`, `PORT`, `CLAUDE_MODEL`

### Phase 2: prompts.js
1. Alle Prompt-Texte als Konstanten exportieren
2. Shared Blocks (Spezifikationen, Kontext, Notizen) als wiederverwendbare Strings/Funktionen
3. `ZUSAMMENFASSUNG` als Funktion die `results`-Objekt nimmt
4. Testen: `node -e "const p = require('./prompts'); console.log(Object.keys(p))"`

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
3. ENV Vars setzen: `ANTHROPIC_API_KEY`, `PORT=3000`, `CLAUDE_MODEL`
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

## Kosten-Schätzung (pro Gutachten)

**Ohne diese App (aktuell):**
- ~10 separate PDF-Uploads × ~50 Seiten × ~1.500 Tokens/Seite = ~750.000 Input-Tokens
- Sonnet: ~$2.25 nur für Input

**Mit dieser App (Prompt Caching):**
- 1× volle PDF-Kosten: ~75.000 Tokens × $3/MTok = $0.23
- 12× gecachte PDF: ~75.000 × 12 × $0.30/MTok = $0.27
- Prompt-Tokens + Output: ~$0.30
- **Total: ~$0.80 pro Gutachten** (ca. 65% günstiger)
