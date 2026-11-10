import * as Workspace from 'trimble-connect-workspace-api';

/** Runtime object ids within one loaded model. */
export type ObjRef = { modelId: string; ids: number[] };
export type ObjState = 'hidden' | 'natural' | { color: string; alpha?: number };
export type ObjInfo = { id: number; cls: string; props: Record<string, string> };
export type ModelInfo = { id: string; name: string };

/** The small part of a 3D viewer that 4D-light needs. Implemented for Trimble Connect and for the built-in demo. */
export interface ViewerPort {
  kind: 'trimble' | 'demo';
  projectId: string;
  projectName: string;
  getModels(): Promise<ModelInfo[]>;
  getAllObjects(): Promise<ObjRef[]>;
  getSelection(): Promise<ObjRef[]>;
  select(refs: ObjRef[]): Promise<void>;
  /** `refs` undefined means every object in the loaded models. */
  apply(refs: ObjRef[] | undefined, state: ObjState): Promise<void>;
  resetAll(): Promise<void>;
  /** Moves the camera so the objects fill the view. */
  focus(refs: ObjRef[]): Promise<void>;
  getProperties(modelId: string, ids: number[]): Promise<ObjInfo[]>;
  getBottomZ(modelId: string, ids: number[]): Promise<{ id: number; z: number }[]>;
  /** Persistent ids (IFC GUIDs). Null when the model has none. */
  toExternalIds(modelId: string, ids: number[]): Promise<string[] | null>;
  toRuntimeIds(modelId: string, externalIds: string[]): Promise<(number | null)[]>;
  onChange(cb: (what: 'models' | 'selection') => void): () => void;
}

export function hexToRgb(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const selector = (refs: ObjRef[] | undefined) =>
  refs && { modelObjectIds: refs.map((r) => ({ modelId: r.modelId, objectRuntimeIds: r.ids })) };

export async function connectTrimble(): Promise<ViewerPort> {
  const listeners = new Set<(what: 'models' | 'selection') => void>();
  const api = await Workspace.connect(window.parent, (event: string) => {
    if (event === 'viewer.onSelectionChanged') listeners.forEach((cb) => cb('selection'));
    if (event === 'viewer.onModelStateChanged' || event === 'viewer.onModelReset') listeners.forEach((cb) => cb('models'));
  }, 30000);
  const project: any = await api.project.getProject().catch(() => null);
  const viewer = api.viewer;

  return {
    kind: 'trimble',
    projectId: String(project?.id ?? 'unknown'),
    projectName: String(project?.name ?? 'Trimble Connect'),
    async getModels() {
      const models = await viewer.getModels('loaded');
      return models.map((m) => ({ id: m.id, name: m.name }));
    },
    async getAllObjects() {
      const all = await viewer.getObjects();
      return all.map((m) => ({ modelId: m.modelId, ids: m.objects.map((o) => o.id) }));
    },
    async getSelection() {
      const selection = await viewer.getSelection();
      return selection.map((s) => ({ modelId: s.modelId, ids: s.objectRuntimeIds ?? [] }));
    },
    async select(refs) {
      await viewer.setSelection(selector(refs)!, 'set');
    },
    async apply(refs, state) {
      if (state === 'hidden') return viewer.setObjectState(selector(refs), { visible: false });
      if (state === 'natural') return viewer.setObjectState(selector(refs), { visible: true, color: 'reset' });
      const color = { ...hexToRgb(state.color), a: state.alpha ?? 255 };
      return viewer.setObjectState(selector(refs), { visible: true, color });
    },
    async resetAll() {
      await viewer.setObjectState(undefined, { visible: 'reset', color: 'reset' });
    },
    async focus(refs) {
      await viewer.setCamera(selector(refs)!, { animationTime: 400 });
    },
    async getProperties(modelId, ids) {
      const objects = await viewer.getObjectProperties(modelId, ids);
      return objects.map((o) => {
        const props: Record<string, string> = {};
        for (const set of o.properties ?? []) {
          for (const p of set.properties ?? []) {
            if (p.value !== undefined && p.value !== null && p.value !== '') props[`${set.name ?? ''}.${p.name}`] = String(p.value);
          }
        }
        return { id: o.id, cls: o.class ?? '', props };
      });
    },
    async getBottomZ(modelId, ids) {
      const boxes = await viewer.getObjectBoundingBoxes(modelId, ids);
      return boxes.map((b) => ({ id: b.id, z: b.boundingBox.min.z }));
    },
    async toExternalIds(modelId, ids) {
      try {
        const external = await viewer.convertToObjectIds(modelId, ids);
        return external.length === ids.length && external.every((e) => typeof e === 'string' && e) ? external : null;
      } catch {
        return null;
      }
    },
    async toRuntimeIds(modelId, externalIds) {
      const ids = await viewer.convertToObjectRuntimeIds(modelId, externalIds);
      return ids.map((id) => (typeof id === 'number' ? id : null));
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
