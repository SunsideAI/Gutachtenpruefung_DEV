const { google } = require('googleapis');

let driveClient = null;

function getDriveClient() {
  if (driveClient) return driveClient;

  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    // Support Base64-encoded JSON or raw JSON
    try {
      const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      credentials = JSON.parse(
        raw.startsWith('ey') || raw.startsWith('ew')
          ? Buffer.from(raw, 'base64').toString()
          : raw
      );
    } catch {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    }
  } else {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON environment variable is required');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

/**
 * Upload a file to Google Drive
 * @param {Buffer} buffer - File content
 * @param {string} filename - File name
 * @param {string} folderId - Google Drive folder ID
 * @param {string} mimeType - MIME type (e.g. 'application/pdf')
 * @returns {{ fileId: string, webViewLink: string }}
 */
async function uploadFile(buffer, filename, folderId, mimeType = 'application/pdf') {
  const drive = getDriveClient();
  const { Readable } = require('stream');

  const response = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId]
    },
    media: {
      mimeType,
      body: Readable.from(buffer)
    },
    fields: 'id, webViewLink'
  });

  // Make file accessible via link
  await drive.permissions.create({
    fileId: response.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone'
    }
  });

  // Get the sharing link
  const file = await drive.files.get({
    fileId: response.data.id,
    fields: 'webViewLink'
  });

  return {
    fileId: response.data.id,
    webViewLink: file.data.webViewLink
  };
}

/**
 * Get sharing link for an existing file
 */
async function getFileLink(fileId) {
  const drive = getDriveClient();
  const file = await drive.files.get({
    fileId,
    fields: 'webViewLink'
  });
  return file.data.webViewLink;
}

module.exports = { uploadFile, getFileLink };
