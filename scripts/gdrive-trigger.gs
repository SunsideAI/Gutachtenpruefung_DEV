/**
 * Google Apps Script: Gutachten-Prüfung Trigger für Patrick Beier
 *
 * Feuert SOFORT wenn eine neue Datei im Drive-Ordner erscheint.
 *
 * Setup:
 * 1. Öffne https://script.google.com → Neues Projekt
 * 2. Kopiere diesen Code hinein
 * 3. Setze FOLDER_ID und WEBHOOK_URL (unten)
 * 4. Führe einmal "installTrigger" aus (Funktion auswählen → Ausführen)
 *    → Berechtigungen genehmigen
 * 5. Fertig! Jede neue Datei im Ordner triggert automatisch die Prüfung.
 */

// ── Konfiguration ──────────────────────────────────────────────────

const FOLDER_ID = 'HIER_ORDNER_ID_EINSETZEN';
const WEBHOOK_URL = 'https://gutachtenpruefungdev-production.up.railway.app/webhook/gdrive?secret=Sunside2025';

// ── Einmalig ausführen: Installiert den Drive-Trigger ──────────────

function installTrigger() {
  // Alte Trigger entfernen
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => ScriptApp.deleteTrigger(t));

  // Neuen Trigger auf den Ordner setzen
  ScriptApp.newTrigger('onNewFile')
    .forUserDriveEvents()
    .onFileCreated()
    .build();

  Logger.log('Trigger installiert. Neue Dateien im Drive werden automatisch erkannt.');
}

// ── Wird bei jeder neuen Datei in Drive aufgerufen ─────────────────

function onNewFile(event) {
  try {
    // Event hat die file ID
    const fileId = event.triggerUid ? null : null; // DriveApp-Fallback nötig

    // DriveApp: Prüfe ob Datei im richtigen Ordner liegt
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const recentFiles = getRecentFiles(folder, 2); // Dateien der letzten 2 Minuten

    for (const file of recentFiles) {
      if (file.getMimeType() !== 'application/pdf') continue;

      // Prüfe ob bereits gesendet (via Properties)
      const props = PropertiesService.getScriptProperties();
      const sentKey = 'sent_' + file.getId();
      if (props.getProperty(sentKey)) continue;

      // An Webhook senden
      const success = sendToWebhook(file);
      if (success) {
        props.setProperty(sentKey, new Date().toISOString());
        Logger.log('Gesendet: ' + file.getName());
      }
    }
  } catch (err) {
    Logger.log('Fehler in onNewFile: ' + err.message);
    // Fallback: Ordner scannen
    fallbackScan();
  }
}

// ── Dateien der letzten X Minuten im Ordner finden ─────────────────

function getRecentFiles(folder, minutesAgo) {
  const since = new Date(Date.now() - minutesAgo * 60 * 1000);
  const files = folder.getFiles();
  const recent = [];

  while (files.hasNext()) {
    const file = files.next();
    if (file.getDateCreated() > since) {
      recent.push(file);
    }
  }
  return recent;
}

// ── Fallback: Ordner scannen (falls Event-Trigger nicht auslöst) ───

function fallbackScan() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const recentFiles = getRecentFiles(folder, 10);
  const props = PropertiesService.getScriptProperties();

  for (const file of recentFiles) {
    if (file.getMimeType() !== 'application/pdf') continue;

    const sentKey = 'sent_' + file.getId();
    if (props.getProperty(sentKey)) continue;

    const success = sendToWebhook(file);
    if (success) {
      props.setProperty(sentKey, new Date().toISOString());
      Logger.log('Fallback gesendet: ' + file.getName());
    }
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
    if (code === 200) return true;
    Logger.log('Webhook Fehler ' + code + ': ' + response.getContentText());
    return false;
  } catch (err) {
    Logger.log('Webhook fehlgeschlagen: ' + err.message);
    return false;
  }
}

// ── Manueller Test ─────────────────────────────────────────────────

function testManual() {
  fallbackScan();
}

// ── Cleanup: Alte sent_ Properties aufräumen (>7 Tage) ─────────────

function cleanup() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('sent_') && new Date(value).getTime() < weekAgo) {
      props.deleteProperty(key);
    }
  }
  Logger.log('Cleanup abgeschlossen.');
}
