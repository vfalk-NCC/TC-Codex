export type ConnectFolder = {
  id: string;
  name: string;
  type: 'FOLDER';
  size?: number;
  modifiedOn?: string;
};

export type ConnectFile = {
  id: string;
  name: string;
  type: 'FILE';
  size?: number;
  modifiedOn?: string;
  versionId?: string;
};

export type ConnectEntry = ConnectFile | ConnectFolder;

type ConnectProject = {
  id: string;
  name?: string;
  location?: string;
  rootId?: string;
  rootFolderId?: string;
};

const regionFallbacks: Record<string, string> = {
  europe: 'https://app21.connect.trimble.com/tc/api/2.0',
  asia: 'https://app31.connect.trimble.com/tc/api/2.0',
  australia: 'https://app32.connect.trimble.com/tc/api/2.0',
};

async function jsonResponse<T>(response: Response, action: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`${action} misslyckades (${response.status})${body ? `: ${body}` : ''}`);
  try { return JSON.parse(body) as T; }
  catch { throw new Error(`${action}: Trimble Connect returnerade ett ogiltigt svar.`); }
}

/** Uses the approved short lived Workspace API token in memory only. */
export class ConnectFiles {
  private constructor(
    readonly project: ConnectProject,
    private readonly token: string,
    private readonly apiBase: string,
  ) {}

  static async open(projectId: string, token: string, projectLocation?: string) {
    const headers = { Authorization: `Bearer ${token}` };
    let apiBase = regionFallbacks[String(projectLocation || '').toLowerCase()];
    try {
      const regions = await jsonResponse<Array<Record<string, string>>>(
        await fetch('https://app.connect.trimble.com/tc/api/2.0/regions', { headers }),
        'Hitta projektets Connect-region',
      );
      const location = String(projectLocation || '').toLowerCase();
      const match = regions.find((region) =>
        String(region.location || region.region || '').toLowerCase() === location,
      );
      const discovered = match && (
        match['tc-api'] || match.tcApi || match.serviceUri ||
        (match.origin ? `https://${match.origin}/tc/api/2.0` : '')
      );
      if (discovered) apiBase = discovered.replace(/\/$/, '');
    } catch {
      // Older/limited regions may not expose discovery; use the known regional endpoint.
    }
    apiBase ||= 'https://app.connect.trimble.com/tc/api/2.0';

    const project = await jsonResponse<ConnectProject>(
      await fetch(`${apiBase}/projects/${encodeURIComponent(projectId)}`, { headers }),
      'Läsa Connect-projektet',
    );
    if (!project.rootId && !project.rootFolderId) throw new Error('Projektet saknar rotmapp i Connect API-svaret.');
    return new ConnectFiles(project, token, apiBase);
  }

  async list(folder?: ConnectFolder): Promise<ConnectEntry[]> {
    const folderId = folder?.id || this.project.rootId || this.project.rootFolderId;
    if (!folderId) throw new Error('Projektets rotmapp kunde inte hittas.');
    const items = await jsonResponse<Array<Record<string, unknown>>>(
      await fetch(`${this.apiBase}/folders/${encodeURIComponent(folderId)}/items`, {
        headers: { Authorization: `Bearer ${this.token}` },
      }),
      'Läsa Connect-mappen',
    );
    return items.map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
      type: String(item.type || '').toUpperCase() === 'FOLDER' ? 'FOLDER' as const : 'FILE' as const,
      size: Number(item.size || item.filesize || 0) || 0,
      modifiedOn: String(item.modifiedOn || item.modified || item.createdOn || ''),
      ...(item.versionId ? { versionId: String(item.versionId) } : {}),
    })).filter((item) => item.id).sort((a, b) => (
      a.type === b.type
        ? a.name.localeCompare(b.name, 'sv', { numeric: true })
        : a.type === 'FOLDER' ? -1 : 1
    ));
  }

  async download(entry: ConnectFile) {
    const query = entry.versionId ? `?versionId=${encodeURIComponent(entry.versionId)}` : '';
    let url = '';
    let lastError = '';
    for (const path of [
      `files/fs/${encodeURIComponent(entry.id)}/downloadurl${query}`,
      `files/${encodeURIComponent(entry.id)}/downloadurl${query}`,
    ]) {
      try {
        const response = await fetch(`${this.apiBase}/${path}`, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (!response.ok) { lastError = String(response.status); continue; }
        const body = await response.text();
        let parsed: unknown = body;
        try { parsed = JSON.parse(body); } catch { /* API may return a plain URL string. */ }
        url = typeof parsed === 'string'
          ? parsed.replace(/^"|"$/g, '')
          : String((parsed as Record<string, unknown>)?.url || (parsed as Record<string, unknown>)?.downloadUrl || (parsed as Record<string, unknown>)?.downloadURL || '');
        if (url) break;
      } catch (reason) {
        lastError = reason instanceof Error ? reason.message : 'nätverksfel';
      }
    }
    if (!url) throw new Error(`Kunde inte hämta nedladdningslänken från Connect (${lastError || 'ingen länk'}).`);

    let response = await fetch(url);
    if (response.status === 401 || response.status === 403) {
      response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    }
    if (!response.ok) throw new Error(`Nedladdningen av ${entry.name} misslyckades (${response.status}).`);
    return new File([await response.blob()], entry.name, { lastModified: Date.now() });
  }

  async upload(file: File, folder?: ConnectFolder) {
    const parentId = folder?.id || this.project.rootId || this.project.rootFolderId;
    if (!parentId) throw new Error('Projektets rotmapp kunde inte hittas.');
    const headers = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
    const init = await jsonResponse<{ uploadURL?: string; uploadUrl?: string; uploadId?: string }>(
      await fetch(`${this.apiBase}/files/fs/initiate`, {
        method: 'POST', headers,
        body: JSON.stringify({ parentId, parentType: 'FOLDER', name: file.name }),
      }),
      `Starta uppladdningen av ${file.name}`,
    );
    const uploadUrl = init.uploadURL || init.uploadUrl;
    if (!uploadUrl || !init.uploadId) throw new Error(`Connect gav ingen uppladdningsadress för ${file.name}.`);
    const uploaded = await fetch(uploadUrl, { method: 'PUT', body: file });
    if (!uploaded.ok) throw new Error(`Uppladdningen av ${file.name} misslyckades (${uploaded.status}).`);
    return jsonResponse(
      await fetch(`${this.apiBase}/files/fs/commit`, {
        method: 'POST', headers, body: JSON.stringify({ uploadId: init.uploadId }),
      }),
      `Spara ${file.name} i Connect-mappen`,
    );
  }
}

export function isConnectFolder(entry: ConnectEntry): entry is ConnectFolder {
  return entry.type === 'FOLDER';
}

export function isSupportedConnectModel(entry: ConnectEntry) {
  const extension = entry.name.split('.').pop()?.toLowerCase();
  return ['ifc', 'dxf', 'las', 'laz', 'ply', 'e57', 'copc', 'pcd', 'pts', 'xyz'].includes(extension || '');
}
