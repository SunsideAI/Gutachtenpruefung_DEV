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
 * Tries multiple strategies since Pipedrive file-project linking is inconsistent
 */
async function listProjectFiles(projectId) {
  // Strategy 1: v2 API
  try {
    const v2Url = `https://api.pipedrive.com/api/v2/projects/${projectId}/files?api_token=${PIPEDRIVE_API_TOKEN}`;
    const res = await fetch(v2Url);
    if (res.ok) {
      const json = await res.json();
      const files = json.data || [];
      if (files.length > 0) {
        console.log(`[pipedrive] Found ${files.length} project files via v2 API`);
        return files;
      }
    }
  } catch (err) {
    console.warn(`[pipedrive] v2 project files failed: ${err.message}`);
  }

  // Strategy 2: v1 global /files — log all files for debugging
  const data = await apiGet('/files', { limit: '500', sort: 'add_time DESC' });
  const allFiles = data || [];

  // Try project_id match
  const byProjectId = allFiles.filter(f => String(f.project_id) === String(projectId));
  if (byProjectId.length > 0) return byProjectId;

  // Log first 5 GA_ files found globally for debugging
  const gaFiles = allFiles.filter(f => f.name && f.name.startsWith('GA_'));
  if (gaFiles.length > 0) {
    console.log(`[pipedrive] Global GA_ files (${gaFiles.length}): ${gaFiles.slice(0, 5).map(f => `${f.name} (deal:${f.deal_id}, person:${f.person_id}, org:${f.org_id}, project:${f.project_id})`).join(' | ')}`);
  }

  // Try matching via project's linked deal_ids, person_ids, or org_ids
  try {
    const project = await getProject(projectId);
    const linkedDealIds = (project.deal_ids || []).map(String);
    const linkedPersonIds = (project.person_ids || []).map(String);
    const linkedOrgIds = (project.org_ids || []).map(String);

    const linked = allFiles.filter(f =>
      (f.deal_id && linkedDealIds.includes(String(f.deal_id))) ||
      (f.person_id && linkedPersonIds.includes(String(f.person_id))) ||
      (f.org_id && linkedOrgIds.includes(String(f.org_id)))
    );

    if (linked.length > 0) {
      console.log(`[pipedrive] Found ${linked.length} files via project entity links`);
      return linked;
    }
  } catch (err) {
    console.warn(`[pipedrive] Could not resolve project links: ${err.message}`);
  }

  return [];
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
 * Upload a file to a Pipedrive project (v2 API) with deal fallback
 * @param {number} projectId
 * @param {string} fileName
 * @param {Buffer} data - File content
 * @param {number} [dealId] - Fallback: attach to deal if project upload fails
 */
async function uploadFileToProject(projectId, fileName, data, dealId) {
  if (!PIPEDRIVE_API_TOKEN) throw new Error('PIPEDRIVE_API_TOKEN is required');

  const boundary = '----FormBoundary' + Date.now().toString(16);
  const crlf = '\r\n';

  function buildMultipartBody(fieldName, fieldValue) {
    const parts = [];
    parts.push(`--${boundary}${crlf}`);
    parts.push(`Content-Disposition: form-data; name="file"; filename="${fileName}"${crlf}`);
    parts.push(`Content-Type: application/pdf${crlf}${crlf}`);
    const header = Buffer.from(parts.join(''));
    const footer = Buffer.from(
      `${crlf}--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="${fieldName}"${crlf}${crlf}` +
      `${fieldValue}${crlf}--${boundary}--${crlf}`
    );
    return Buffer.concat([header, data, footer]);
  }

  const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };

  // Variante A: Pipedrive v2 API with project_id
  try {
    const v2Url = `https://api.pipedrive.com/api/v2/files?api_token=${PIPEDRIVE_API_TOKEN}`;
    const body = buildMultipartBody('project_id', projectId);
    const res = await fetch(v2Url, { method: 'POST', headers, body });

    if (res.ok) {
      const json = await res.json();
      console.log(`[pipedrive] File uploaded to project ${projectId} via v2 API`);
      return json.data;
    }

    const errText = await res.text();
    console.warn(`[pipedrive] v2 project upload failed (${res.status}): ${errText}`);
  } catch (err) {
    console.warn(`[pipedrive] v2 API error: ${err.message}`);
  }

  // Variante B: Fallback — attach to deal via v1 API
  if (dealId) {
    console.log(`[pipedrive] Falling back to deal upload (deal ${dealId})`);
    const body = buildMultipartBody('deal_id', dealId);
    const v1Url = apiUrl('/files');
    const res = await fetch(v1Url, { method: 'POST', headers, body });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`File upload to deal failed (${res.status}): ${text}`);
    }

    const json = await res.json();
    console.log(`[pipedrive] File uploaded to deal ${dealId} via v1 API`);
    return json.data;
  }

  throw new Error('File upload failed: v2 project upload failed and no dealId for fallback');
}

/**
 * Find the latest PDF file from a project or its linked deal
 * @returns {{ id, name, add_time } | null}
 */
async function findLatestPdf(projectId, dealId) {
  const isGutachtenPdf = f => f.name && f.name.toLowerCase().endsWith('.pdf') && f.name.startsWith('GA_');

  // Strategy 1: Deal files (most reliable — Pipedrive always has deal_id on files)
  if (dealId) {
    try {
      const dealFiles = await listDealFiles(dealId);
      console.log(`[pipedrive] Deal ${dealId} files: ${dealFiles.length} total, names: ${dealFiles.map(f => f.name).join(', ') || '(none)'}`);
      const dealPdf = (dealFiles || [])
        .filter(isGutachtenPdf)
        .sort((a, b) => new Date(b.add_time) - new Date(a.add_time))[0];
      if (dealPdf) return dealPdf;
    } catch (err) {
      console.warn(`[pipedrive] Could not list deal files: ${err.message}`);
    }
  }

  // Strategy 2: Global files filtered by project_id
  try {
    const projectFiles = await listProjectFiles(projectId);
    console.log(`[pipedrive] Project ${projectId} files: ${projectFiles.length} total, names: ${projectFiles.map(f => f.name).join(', ') || '(none)'}`);
    const projectPdf = (projectFiles || [])
      .filter(isGutachtenPdf)
      .sort((a, b) => new Date(b.add_time) - new Date(a.add_time))[0];
    if (projectPdf) return projectPdf;
  } catch (err) {
    console.warn(`[pipedrive] Could not list project files: ${err.message}`);
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
