import { TCPS, type FileEntry, type FileSystemEntry, type FolderEntry, type Project } from 'trimble-connect-sdk';

export type ConnectEntry = FileEntry | FolderEntry;

/** Uses the user's short lived Trimble Identity token in memory only. */
export class ConnectFiles {
  private readonly client: TCPS;

  private constructor(readonly project: Project, token: string) {
    this.client = new TCPS({ credentials: { token } });
  }

  static async open(projectId: string, token: string) {
    const client = new TCPS({ credentials: { token } });
    const project = (await client.getProject(projectId)).data;
    return new ConnectFiles(project, token);
  }

  async list(folder?: FolderEntry) {
    const parent: Project | FolderEntry = folder ?? this.project;
    return (await this.client.listFolderEntries(parent)).data;
  }

  async download(entry: FileEntry) {
    const { data } = await this.client.getFileDownloadUrl(entry, entry.versionId);
    const response = await fetch(data.url);
    if (!response.ok) throw new Error(`Filhämtningen misslyckades (${response.status}).`);
    return new File([await response.blob()], entry.name, { lastModified: Date.now() });
  }

  async upload(file: File, folder?: FolderEntry) {
    const parentId = folder?.id ?? this.project.rootId;
    const responses = await this.client.uploadFileContent(this.project, [file], parentId, 'FOLDER');
    const failed = responses.find((item) => !item.response.ok);
    if (failed) throw new Error(`Uppladdningen misslyckades (${failed.response.status}).`);
    return responses[0]?.data;
  }
}

export function isConnectFolder(entry: ConnectEntry): entry is FolderEntry {
  return entry.type === 'FOLDER';
}

export function isSupportedConnectModel(entry: FileSystemEntry) {
  const extension = entry.name.split('.').pop()?.toLowerCase();
  return ['ifc', 'dxf', 'las', 'laz', 'ply', 'e57', 'copc', 'pcd', 'pts', 'xyz'].includes(extension || '');
}
