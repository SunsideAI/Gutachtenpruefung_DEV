const PDFMONKEY_API = 'https://api.pdfmonkey.io/api/v1';

function getHeaders() {
  return {
    'Authorization': `Bearer ${process.env.PDFMONKEY_API_KEY}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Start PDF document generation
 * @param {string} templateId - PDFMonkey template ID
 * @param {Object} payload - Template data
 * @returns {string} Document ID
 */
async function generateDocument(templateId, payload) {
  const response = await fetch(`${PDFMONKEY_API}/documents`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      document: {
        document_template_id: templateId,
        status: 'pending',
        payload
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PDFMonkey generate failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.document.id;
}

/**
 * Poll until document is ready
 * @param {string} documentId - Document ID from generateDocument
 * @param {number} intervalMs - Polling interval (default 5000ms)
 * @param {number} timeoutMs - Max wait time (default 120000ms)
 * @returns {{ download_url: string, status: string }}
 */
async function waitForDocument(documentId, intervalMs = 5000, timeoutMs = 120000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const response = await fetch(`${PDFMONKEY_API}/documents/${documentId}`, {
      headers: getHeaders()
    });

    if (!response.ok) {
      throw new Error(`PDFMonkey status check failed (${response.status})`);
    }

    const data = await response.json();
    const doc = data.document;

    if (doc.status === 'success') {
      return {
        download_url: doc.download_url,
        status: doc.status
      };
    }

    if (doc.status === 'failure') {
      throw new Error(`PDFMonkey document generation failed: ${doc.failure_cause || 'unknown'}`);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error(`PDFMonkey timeout: document ${documentId} not ready after ${timeoutMs / 1000}s`);
}

/**
 * Download the generated PDF
 * @param {string} downloadUrl - URL from waitForDocument
 * @returns {Buffer} PDF file buffer
 */
async function downloadDocument(downloadUrl) {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`PDFMonkey download failed (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

module.exports = { generateDocument, waitForDocument, downloadDocument };
