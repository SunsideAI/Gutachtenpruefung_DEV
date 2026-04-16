# Gutachtenprüfung Integration — Pipedrive Webhook Endpoint

## Kontext

Die Gutachtenprüfung soll direkt aus Pipedrive getriggert werden, wenn ein Projekt auf dem Board "Delivery" in die Phase "Quality Gate" verschoben wird. Der bestehende Zapier-Flow (Google Drive → Gutachten API) wird damit abgelöst.

## Neuer Endpoint

**Route:** `POST /webhooks/pipedrive/gutachten`

Pipedrive schickt bei jedem Project-Change einen Webhook. Die Automation API muss:
1. Prüfen ob das Projekt in die Phase "Quality Gate" verschoben wurde (Filter!)
2. Das verknüpfte Deal aus dem Projekt ermitteln
3. Die neueste PDF-Datei vom Projekt oder Deal holen
4. Die Gutachten API aufrufen mit Deal-ID + PDF
5. Das Ergebnis als Notiz am Deal speichern

## Implementierung

### 1. `src/routes/webhooks.ts` — Neuer Endpoint

```typescript
import { processGutachtenpruefung } from '../services/gutachten';

router.post('/webhooks/pipedrive/gutachten', verifyWebhookSecret, async (req, res) => {
  const start = Date.now();
  try {
    const payload = req.body as PipedriveProjectWebhook;
    
    logger.info({ 
      projectId: payload.current?.id,
      phase: payload.current?.phase_id 
    }, 'Project webhook received');

    const result = await processGutachtenpruefung(payload);

    const duration = Date.now() - start;
    logger.info({ duration, ...result }, 'Gutachten webhook processed');
    res.json({ success: true, ...result });
  } catch (error) {
    // Standard error handling wie in anderen Webhooks
  }
});
```

### 2. `src/services/gutachten.ts` — Neuer Service

```typescript
import { pipedrive } from './pipedrive';
import { config } from '../config';
import axios from 'axios';
import logger from '../utils/logger';
import type { PipedriveProjectWebhook } from '../types/webhooks';

const QUALITY_GATE_PHASE = config.gutachten.qualityGatePhaseId;
const GUTACHTEN_API_URL = config.gutachten.apiUrl;
const GUTACHTEN_API_KEY = config.gutachten.apiKey;

export async function processGutachtenpruefung(
  payload: PipedriveProjectWebhook,
): Promise<{ triggered: boolean; projectId?: number; reason?: string }> {
  const projectId = payload.current?.id;
  const newPhase = payload.current?.phase_id;
  const oldPhase = payload.previous?.phase_id;

  if (!projectId) {
    return { triggered: false, reason: 'No project ID' };
  }

  // Nur wenn Phase tatsächlich auf Quality Gate geändert wurde
  if (newPhase !== QUALITY_GATE_PHASE || oldPhase === QUALITY_GATE_PHASE) {
    logger.info({ projectId, newPhase, oldPhase }, 'Not a Quality Gate transition, skipping');
    return { triggered: false, reason: 'Not Quality Gate transition' };
  }

  // Deal-ID aus Projekt holen
  const project = await pipedrive.getProject(projectId);
  const dealId = project.deal_ids?.[0];

  if (!dealId) {
    logger.warn({ projectId }, 'No deal linked to project');
    return { triggered: false, reason: 'No linked deal' };
  }

  // Neueste PDF holen (Projekt-Files, Fallback auf Deal-Files)
  const pdfFile = await findLatestGutachtenPdf(projectId, dealId);

  if (!pdfFile) {
    logger.error({ projectId, dealId }, 'No PDF found for Gutachtenprüfung');
    return { triggered: false, reason: 'No PDF found' };
  }

  // PDF herunterladen
  const pdfBuffer = await pipedrive.downloadFile(pdfFile.id);

  // Gutachten API aufrufen
  logger.info({ projectId, dealId, fileName: pdfFile.name }, 'Triggering Gutachtenprüfung');
  
  const gutachtenResult = await callGutachtenApi(pdfBuffer, {
    dealId,
    projectId,
    fileName: pdfFile.name,
  });

  // Ergebnis als Notiz am Deal speichern
  await pipedrive.createNote(
    `Gutachtenprüfung abgeschlossen\n\nDatei: ${pdfFile.name}\nScore: ${gutachtenResult.score}\n\n${gutachtenResult.summary}`,
    { deal_id: dealId },
  );

  logger.info({ projectId, dealId, score: gutachtenResult.score }, 'Gutachtenprüfung completed');

  return { triggered: true, projectId, reason: 'success' };
}

async function findLatestGutachtenPdf(projectId: number, dealId: number) {
  // Zuerst Projekt-Files prüfen
  const projectFiles = await pipedrive.listProjectFiles(projectId);
  const projectPdf = projectFiles
    .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
    .sort((a, b) => new Date(b.add_time).getTime() - new Date(a.add_time).getTime())[0];

  if (projectPdf) return projectPdf;

  // Fallback: Deal-Files
  const dealFiles = await pipedrive.listDealFiles(dealId);
  return dealFiles
    .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
    .sort((a, b) => new Date(b.add_time).getTime() - new Date(a.add_time).getTime())[0];
}

async function callGutachtenApi(pdfBuffer: Buffer, meta: { dealId: number; projectId: number; fileName: string }) {
  const formData = new FormData();
  formData.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), meta.fileName);
  formData.append('deal_id', String(meta.dealId));
  formData.append('project_id', String(meta.projectId));

  const res = await axios.post(`${GUTACHTEN_API_URL}/pruefen`, formData, {
    headers: { 'x-api-key': GUTACHTEN_API_KEY },
    timeout: 5 * 60 * 1000, // 5 Minuten — Gutachtenprüfung dauert lang
  });

  return res.data;
}
```

### 3. `src/services/pipedrive.ts` — Neue Methoden

```typescript
async getProject(projectId: number): Promise<Project> {
  const res = await this.client.get<PipedriveResponse<Project>>(`/projects/${projectId}`);
  return res.data.data;
}

async listProjectFiles(projectId: number): Promise<PipedriveFile[]> {
  const res = await this.client.get<PipedriveResponse<PipedriveFile[]>>(
    `/projects/${projectId}/files`,
  );
  return res.data.data || [];
}
```

### 4. `src/config.ts` — Neue Config

```typescript
gutachten: {
  apiUrl: requireEnv('GUTACHTEN_API_URL'),
  apiKey: requireEnv('GUTACHTEN_API_KEY'),
  qualityGatePhaseId: parseInt(requireEnv('GUTACHTEN_QUALITY_GATE_PHASE_ID'), 10),
},
```

### 5. `src/types/webhooks.ts` — Neuer Typ

```typescript
export interface PipedriveProjectWebhook {
  v: number;
  event: string;
  current: {
    id: number;
    title: string;
    phase_id: number;
    board_id: number;
    deal_ids?: number[];
    [key: string]: unknown;
  };
  previous: {
    id: number;
    phase_id: number;
    [key: string]: unknown;
  };
  meta: {
    action: string;
    object: string;
    [key: string]: unknown;
  };
}
```

### 6. `.env.example` ergänzen

```env
# Gutachten API
GUTACHTEN_API_URL=https://gutachtenpruefung-dev.up.railway.app
GUTACHTEN_API_KEY=xxx
GUTACHTEN_QUALITY_GATE_PHASE_ID=4
```

## Wichtig zum Testen

- **Phase-ID für Quality Gate** muss ermittelt werden. In der Sandbox heißt das Board "Delivery" und hat die Phasen Kick-off, Planning, Implementation, **Quality Gate**, Closing. Die Phase-ID bekommen wir aus dem ersten Webhook-Payload wenn das Projekt verschoben wird.
- Die Logik prüft bewusst auf **Transition IN Quality Gate** (nicht wenn es schon drin ist), damit wiederholte Updates am Projekt nicht den Trigger auslösen.
- Error-Notifications sind schon integriert — bei Fehlern kommt automatisch eine Mail.
