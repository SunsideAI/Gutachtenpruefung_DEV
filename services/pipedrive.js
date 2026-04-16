/**
 * Pipedrive API Client
 * Handles project/deal queries, file downloads, and note creation.
 */

const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PIPEDRIVE_BASE_URL = 'https://api.pipedrive.com/v1';

function apiUrl(path, params = {}) {
  const url = new URL(`${PIPEDRIVE_BASE_URL}${path}`);
  url.searchParams.set('api_token', PIPEDRIVE_API_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

async function apiGet(path, params) {
  if (!PIPEDRIVE_API_TOKEN) throw new Error('PIPEDRIVE_API_TOKEN is required');
  const res = await fetch(apiUrl(path, params));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pipedrive API ${path} failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  return json.data;
}

async function apiPost(path, body) {
  if (!PIPEDRIVE_API_TOKEN) throw new Error('PIPEDRIVE_API_TOKEN is required');
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pipedrive API POST ${path} failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  return json.data;
}

/**
 * Get a project by ID
 */
async function getProject(projectId) {
  return apiGet(`/projects/${projectId}`);
}

/**
 * List files attached to a project
 */
async function listProjectFiles(projectId) {
  const data = await apiGet(`/projects/${projectId}/files`);
  return data || [];
}

/**
 * List files attached to a deal
 */
async function listDealFiles(dealId) {
  const data = await apiGet(`/deals/${dealId}/files`);
  return data || [];
}

/**
 * Get deal details
 */
async function getDeal(dealId) {
  return apiGet(`/deals/${dealId}`);
}

/**
 * Get user by ID — returns { email, name, ... }
 */
async function getUser(userId) {
  return apiGet(`/users/${userId}`);
}

/**
 * Download a file by ID — returns Buffer
 */
async function downloadFile(fileId) {
  if (!PIPEDRIVE_API_TOKEN) throw new Error('PIPEDRIVE_API_TOKEN is required');
  const url = apiUrl(`/files/${fileId}/download`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`File download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Create a note on a deal
 */
async function createNote(content, { deal_id }) {
  return apiPost('/notes', {
    content,
    deal_id,
    pinned_to_deal_flag: 1
  });
}

/**
 * Upload a file to a Pipedrive project
 * @param {number} projectId
 * @param {string} fileName
 * @param {Buffer} data - File content
 */
async function uploadFileToProject(projectId, fileName, data) {
  if (!PIPEDRIVE_API_TOKEN) throw new Error('PIPEDRIVE_API_TOKEN is required');

  const boundary = '----FormBoundary' + Date.now().toString(16);
  const crlf = '\r\n';

  // Build multipart body manually (no external FormData dependency needed)
  const parts = [];
  parts.push(`--${boundary}${crlf}`);
  parts.push(`Content-Disposition: form-data; name="file"; filename="${fileName}"${crlf}`);
  parts.push(`Content-Type: application/pdf${crlf}${crlf}`);
  const header = Buffer.from(parts.join(''));
  const footer = Buffer.from(`${crlf}--${boundary}${crlf}Content-Disposition: form-data; name="project_id"${crlf}${crlf}${projectId}${crlf}--${boundary}--${crlf}`);

  const body = Buffer.concat([header, data, footer]);

  const url = apiUrl('/files');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`File upload to project failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  return json.data;
}

/**
 * Find the latest PDF file from a project or its linked deal
 * @returns {{ id, name, add_time } | null}
 */
async function findLatestPdf(projectId, dealId) {
  // First: project files
  try {
    const projectFiles = await listProjectFiles(projectId);
    const projectPdf = (projectFiles || [])
      .filter(f => f.name && f.name.toLowerCase().endsWith('.pdf'))
      .sort((a, b) => new Date(b.add_time) - new Date(a.add_time))[0];
    if (projectPdf) return projectPdf;
  } catch (err) {
    console.warn(`[pipedrive] Could not list project files: ${err.message}`);
  }

  // Fallback: deal files
  if (dealId) {
    try {
      const dealFiles = await listDealFiles(dealId);
      const dealPdf = (dealFiles || [])
        .filter(f => f.name && f.name.toLowerCase().endsWith('.pdf'))
        .sort((a, b) => new Date(b.add_time) - new Date(a.add_time))[0];
      if (dealPdf) return dealPdf;
    } catch (err) {
      console.warn(`[pipedrive] Could not list deal files: ${err.message}`);
    }
  }

  return null;
}

module.exports = {
  getProject,
  getDeal,
  getUser,
  listProjectFiles,
  listDealFiles,
  downloadFile,
  createNote,
  uploadFileToProject,
  findLatestPdf
};
