/**
 * Google Apps Script: Gutachten-Prüfung Trigger für Patrick Beier
 *
 * Überwacht einen Google Drive Ordner auf neue PDF-Dateien und
 * sendet sie automatisch an die Gutachtenprüfungs-API.
 *
 * Setup:
 * 1. Öffne https://script.google.com und erstelle ein neues Projekt
 * 2. Kopiere diesen Code hinein
 * 3. Setze FOLDER_ID und WEBHOOK_URL (unten)
 * 4. Klicke auf "Trigger" (Uhr-Symbol) → "Trigger hinzufügen"
 *    - Funktion: checkForNewFiles
 *    - Ereignisquelle: Zeitgesteuert
 *    - Typ: Minutentimer → Alle 5 Minuten
 * 5. Berechtigungen genehmigen wenn gefragt
 */

// ── Konfiguration ──────────────────────────────────────────────────

const FOLDER_ID = 'HIER_ORDNER_ID_EINSETZEN';  // Google Drive Ordner-ID
const WEBHOOK_URL = 'https://gutachtenpruefungdev-production.up.railway.app/webhook/gdrive?secret=Sunside2025';

// ── Hauptfunktion (wird alle 5 Minuten aufgerufen) ─────────────────

function checkForNewFiles() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const props = PropertiesService.getScriptProperties();

  // Letzten Check-Zeitpunkt laden (oder vor 10 Minuten als Default)
  const lastCheck = props.getProperty('lastCheckTime');
  const since = lastCheck ? new Date(lastCheck) : new Date(Date.now() - 10 * 60 * 1000);

  // Alle Dateien im Ordner durchgehen
  const files = folder.getFiles();
  let newFilesCount = 0;

  while (files.hasNext()) {
    const file = files.next();
    const created = file.getDateCreated();

    // Nur neue Dateien seit letztem Check
    if (created > since) {
      // Nur PDFs verarbeiten
      if (file.getMimeType() === 'application/pdf') {
        const success = sendToWebhook(file);
        if (success) {
          newFilesCount++;
          Logger.log('Gesendet: ' + file.getName());
        }
      }
    }
  }

  // Zeitpunkt aktualisieren
  props.setProperty('lastCheckTime', new Date().toISOString());

  if (newFilesCount > 0) {
    Logger.log(newFilesCount + ' neue Gutachten gefunden und gesendet.');
  }
}

// ── Webhook aufrufen ───────────────────────────────────────────────

function sendToWebhook(file) {
  const payload = {
    file_id: file.getId(),
    file_name: file.getName(),
    file_url: 'https://drive.google.com/uc?id=' + file.getId() + '&export=download',
    timestamp: new Date().toISOString()
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(WEBHOOK_URL, options);
    const code = response.getResponseCode();

    if (code === 200) {
      return true;
    } else {
      Logger.log('Webhook Fehler ' + code + ': ' + response.getContentText());
      return false;
    }
  } catch (err) {
    Logger.log('Webhook Aufruf fehlgeschlagen: ' + err.message);
    return false;
  }
}

// ── Manueller Test ─────────────────────────────────────────────────

function testManual() {
  // Setzt den letzten Check-Zeitpunkt auf vor 24 Stunden zurück
  // und prüft den Ordner erneut (findet alle Dateien der letzten 24h)
  const props = PropertiesService.getScriptProperties();
  props.setProperty('lastCheckTime', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  checkForNewFiles();
}
