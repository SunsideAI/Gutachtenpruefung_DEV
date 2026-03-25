const { Resend } = require('resend');

let resendClient = null;

function getClient() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is required');
  }
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const FROM = process.env.EMAIL_FROM || 'Sunside AI Gutachtenprüfung <pruefung@sunsideai.de>';

/**
 * Send confirmation email that the Gutachten is being processed
 */
async function sendConfirmation(to, vorname, dateiname) {
  const { error } = await getClient().emails.send({
    from: FROM,
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

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[mailer] Confirmation sent to ${to}`);
}

/**
 * Send result email with evaluation summary and report link
 */
async function sendResult(to, vorname, dateiname, zusammenfassung, gesamtscore, reportUrl) {
  const scoreDisplay = gesamtscore !== null ? `${gesamtscore}/10` : 'n/a';

  const { error } = await getClient().emails.send({
    from: FROM,
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

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[mailer] Result sent to ${to} (score: ${scoreDisplay})`);
}

module.exports = { sendConfirmation, sendResult };
