const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  return transporter;
}

/**
 * Send confirmation email that the Gutachten is being processed
 */
async function sendConfirmation(to, vorname, dateiname) {
  const transport = getTransporter();

  await transport.sendMail({
    from: process.env.SMTP_FROM || 'Sunside AI Gutachtenprüfung <pruefung@sunside-ai.de>',
    to,
    subject: `Ihr Gutachten wird geprüft – ${dateiname}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">Gutachtenprüfung gestartet</h2>
        <p>Sehr geehrte/r ${vorname},</p>
        <p>Ihr Gutachten <strong>"${dateiname}"</strong> wurde erfolgreich empfangen und wird nun automatisiert geprüft.</p>
        <p>Sie erhalten das Ergebnis in wenigen Minuten per E-Mail.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">Sunside AI Gutachtenprüfung</p>
      </div>
    `
  });

  console.log(`[mailer] Confirmation sent to ${to}`);
}

/**
 * Send result email with evaluation summary and report link
 */
async function sendResult(to, vorname, dateiname, zusammenfassung, gesamtscore, reportUrl) {
  const transport = getTransporter();

  const scoreDisplay = gesamtscore !== null ? `${gesamtscore}/10` : 'n/a';

  await transport.sendMail({
    from: process.env.SMTP_FROM || 'Sunside AI Gutachtenprüfung <pruefung@sunside-ai.de>',
    to,
    subject: `Prüfergebnis – ${dateiname} – ${scoreDisplay}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">Prüfergebnis</h2>
        <p>Sehr geehrte/r ${vorname},</p>
        <p>die Prüfung Ihres Gutachtens <strong>"${dateiname}"</strong> ist abgeschlossen.</p>

        <div style="background: #f8f9fa; border-left: 4px solid #1a1a2e; padding: 15px; margin: 20px 0;">
          <p style="margin: 0 0 10px 0;"><strong>Gesamtbewertung: ${scoreDisplay}</strong></p>
          <p style="margin: 0; white-space: pre-line;">${zusammenfassung || ''}</p>
        </div>

        ${reportUrl ? `
        <p>Den vollständigen Prüfbericht finden Sie hier:</p>
        <p><a href="${reportUrl}" style="display: inline-block; background: #1a1a2e; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Prüfbericht öffnen</a></p>
        ` : ''}

        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">Sunside AI Gutachtenprüfung</p>
      </div>
    `
  });

  console.log(`[mailer] Result sent to ${to} (score: ${scoreDisplay})`);
}

module.exports = { sendConfirmation, sendResult };
