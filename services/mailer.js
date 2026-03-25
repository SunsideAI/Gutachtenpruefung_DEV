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
const BCC = 'contact@sunsideai.de';
const INTERNAL_TO = ['niklas@sunsideai.de', 'paul@sunsideai.de'];

const SIGNATURE = `
    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 14px; color: #333; text-align: center;">
      <p><strong>Patrick Beier</strong><br>
        <span style="color: #779D93; font-weight: bold;">Inhaber / Partner</span>
      </p>
      <p style="font-size: 12px; color: #555; text-align: center;">Von der IHK Stade öffentlich bestellter und vereidigter Sachverständiger für die Bewertung von bebauten und unbebauten Grundstücken,<br>
        zertifizierter Sachverständiger für die Markt- und Beleihungswertermittlung von Immobilien, DIA Zert LF (alle Immobilienarten),<br>
        Bankkaufmann (IHK), Mediator (FH)
      </p>
      <img src="https://www.sachverstandmitherz.de/wp-content/uploads/beier-partner-logo.png.webp" alt="Beier &amp; Partner Logo" style="max-width: 100%; width: 180px; display: block; margin: 20px auto;">
      <p><strong>Sachverständigenbüro Beier &amp; Partner</strong><br>
        Inhaber: Patrick Beier<br>
        Schölischer Str. 101a, 21682 Stade<br>
        0 41 41 / 80 29 08 - 0<br>
        <a href="mailto:p.beier@beierundpartner.de">p.beier@beierundpartner.de</a><br>
        <a href="https://www.sachverstandmitherz.de">www.sachverstandmitherz.de</a>
      </p>
    </div>`;

const EMAIL_STYLES = `
  <style>
    body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
    .container { max-width: 100%; width: 90%; margin: 20px auto; background: #ffffff; padding: 20px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
    .header { font-size: 20px; font-weight: bold; color: #333333; text-align: center; }
    .content { margin-top: 15px; font-size: 16px; color: #555555; line-height: 1.5; text-align: center; }
    .button { display: block; margin: 20px auto; padding: 12px 20px; background-color: #779D93; color: #FFFFFF !important; text-decoration: none; border-radius: 5px; font-size: 16px; font-weight: bold; text-align: center; width: fit-content; }
    @media (max-width: 600px) {
      .container { width: 95%; padding: 15px; }
      .header { font-size: 18px; }
      .content { font-size: 14px; }
      .button { font-size: 14px; padding: 10px 15px; }
    }
  </style>`;

/**
 * Send confirmation email to the customer that the Gutachten is being processed
 */
async function sendConfirmation(to, vorname, dateiname) {
  const { error } = await getClient().emails.send({
    from: FROM,
    to,
    bcc: BCC,
    subject: `Ihr Gutachten wird geprüft – ${dateiname}`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${EMAIL_STYLES}</head><body>
      <div class="container">
        <p class="header">Guten Tag ${vorname},</p>
        <p class="content">
          vielen Dank für Ihr eingereichtes Gutachten <strong>"${dateiname}"</strong>. Wir haben es erhalten und es wird nun automatisiert geprüft.
        </p>
        <p class="content">
          Sie erhalten das Ergebnis in wenigen Minuten per E-Mail.
        </p>
        <p class="content">
          Sollten Sie Fragen haben, stehen wir Ihnen jederzeit gerne zur Verfügung.
        </p>
        <p class="content">Mit freundlichen Grüßen</p>
        ${SIGNATURE}
      </div>
    </body></html>`
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[mailer] Confirmation sent to ${to}`);
}

/**
 * Send result email to the customer with evaluation summary and report link
 */
async function sendResult(to, vorname, dateiname, zusammenfassung, gesamtscore, reportUrl) {
  const scoreDisplay = gesamtscore !== null ? `${gesamtscore}/10` : 'n/a';

  const { error } = await getClient().emails.send({
    from: FROM,
    to,
    bcc: BCC,
    subject: `Prüfergebnis – ${dateiname} – ${scoreDisplay}`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${EMAIL_STYLES}</head><body>
      <div class="container">
        <p class="header">Guten Tag ${vorname},</p>
        <p class="content">
          vielen Dank für Ihr eingereichtes Gutachten. Wir haben es sorgfältig geprüft und stellen Ihnen nun unsere Kurzbewertung sowie eine Einschätzung zur Verfügung.
        </p>
        ${reportUrl ? `
        <p class="content">
          Im folgenden Link können Sie die Bewertung direkt als PDF-Dokument einsehen.
        </p>
        <a href="${reportUrl}" class="button">Prüfbericht öffnen</a>
        ` : ''}
        <p class="content">
          Sollten Sie Fragen zu Ihrer Bewertung haben, stehen wir Ihnen jederzeit gerne zur Verfügung.
        </p>
        <p class="content">Mit freundlichen Grüßen</p>
        ${SIGNATURE}
      </div>
    </body></html>`
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[mailer] Result sent to ${to} (score: ${scoreDisplay})`);
}

/**
 * Send internal notification to Niklas & Paul that a new Gutachten was submitted
 */
async function sendInternalNotification(dateiname, vorname, nachname, datum) {
  const { error } = await getClient().emails.send({
    from: FROM,
    to: INTERNAL_TO,
    bcc: BCC,
    subject: `Neues Gutachten eingereicht – ${dateiname}`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${EMAIL_STYLES}</head><body>
      <div class="container">
        <p class="header">Guten Tag Niklas und Paul,</p>
        <p class="content">
          Ein Sachverständiger hat am <strong>${datum || new Date().toLocaleDateString('de-DE')}</strong> ein Gutachten zur Prüfung eingereicht.
        </p>
        <p class="content">
          <strong>${vorname} ${nachname}</strong> – "${dateiname}"
        </p>
        <p class="content">
          Bitte stellt sicher, dass das Gutachten zeitnah geprüft wird!
        </p>
        <p class="content">Mit freundlichen Grüßen</p>
        ${SIGNATURE}
      </div>
    </body></html>`
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[mailer] Internal notification sent`);
}

module.exports = { sendConfirmation, sendResult, sendInternalNotification };
