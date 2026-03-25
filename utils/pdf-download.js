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
  // If we got HTML instead of PDF, retry with confirm param (Google Drive virus scan warning)
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

/**
 * Downloads PDF and returns raw Buffer (for Google Drive upload etc.)
 */
async function downloadPdfBuffer(url) {
  const base64 = await downloadPdf(url);
  return Buffer.from(base64, 'base64');
}

module.exports = { downloadPdf, downloadPdfBuffer };
