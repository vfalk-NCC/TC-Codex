import type { ObjInfo, ObjRef, ObjState, ViewerPort } from './viewer';

export type DemoBox = {
  id: number; cls: string; props: Record<string, string>; color: string;
  x: number; y: number; z: number; w: number; d: number; h: number;
};
export type DemoLook = { visible: boolean; color: string; alpha: number };

const MODEL = 'demo-model';
const FLOORS = 4;
const FLOOR_H = 3.2;

function buildScene(): DemoBox[] {
  const boxes: DemoBox[] = [];
  const add = (cls: string, floor: string, type: string, color: string, x: number, y: number, z: number, w: number, d: number, h: number) =>
    boxes.push({ id: boxes.length + 1, cls, props: { 'Demo.Våning': floor, 'Demo.Typ': type }, color, x, y, z, w, d, h });

  add('IfcFooting', 'Grund', 'Grundplatta', '#9aa0a8', -0.5, -0.5, -0.6, 25, 13, 0.6);
  for (let f = 0; f < FLOORS; f++) {
    const z = f * FLOOR_H;
    const floor = `Plan ${f + 1}`;
    for (let i = 0; i < 4; i++) add('IfcWall', floor, 'Vägg', '#cdbb9f', i * 6, 0, z, 6, 0.3, 2.9);
    for (let j = 0; j < 2; j++) add('IfcWall', floor, 'Vägg', '#cdbb9f', 0, j * 6, z, 0.3, 6, 2.9);
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 2; j++) add('IfcColumn', floor, 'Pelare', '#b4b9c2', i * 6 - 0.2, j * 6 - 0.2, z, 0.4, 0.4, 2.9);
    add('IfcSlab', floor, 'Bjälklag', '#dfe2e7', -0.3, -0.3, z + 2.9, 24.6, 12.6, 0.3);
  }
  add('IfcRoof', 'Tak', 'Tak', '#7d8794', -0.6, -0.6, FLOORS * FLOOR_H, 25.2, 13.2, 0.4);
  add('IfcBuildingElementProxy', 'Tillfälligt', 'Byggkran', '#e0aa2e', -6, 14, 0, 1, 1, 18);
  add('IfcBuildingElementProxy', 'Tillfälligt', 'Byggkran', '#e0aa2e', -6, 8, 17, 1, 7, 1);
  return boxes;
}

/** A tiny in-memory "viewer" so the app can be tried and tested outside Trimble Connect. */
export class DemoViewer implements ViewerPort {
  kind = 'demo' as const;
  projectId = 'demo';
  projectName = 'Demoprojekt';
  boxes = buildScene();
  looks = new Map<number, DemoLook>();
  selected = new Set<number>();
  private listeners = new Set<(what: 'models' | 'selection') => void>();
  private redraw = new Set<() => void>();

  private allIds() { return this.boxes.map((b) => b.id); }
  private changed() { this.redraw.forEach((cb) => cb()); }

  subscribe(cb: () => void) { this.redraw.add(cb); return () => { this.redraw.delete(cb); }; }

  toggle(id: number, additive: boolean) {
    const had = this.selected.has(id);
    if (!additive) this.selected.clear();
    if (had) this.selected.delete(id); else this.selected.add(id);
    this.changed();
    this.listeners.forEach((cb) => cb('selection'));
  }

  async getModels() { return [{ id: MODEL, name: 'Demohus.ifc' }]; }
  async getAllObjects(): Promise<ObjRef[]> { return [{ modelId: MODEL, ids: this.allIds() }]; }
  async getSelection(): Promise<ObjRef[]> { return this.selected.size ? [{ modelId: MODEL, ids: [...this.selected] }] : []; }
  async select(refs: ObjRef[]) {
    this.selected = new Set(refs.flatMap((r) => r.ids));
    this.changed();
    this.listeners.forEach((cb) => cb('selection'));
  }
  async apply(refs: ObjRef[] | undefined, state: ObjState) {
    for (const id of refs ? refs.flatMap((r) => r.ids) : this.allIds()) {
      if (state === 'natural') this.looks.delete(id);
      else if (state === 'hidden') this.looks.set(id, { visible: false, color: '', alpha: 1 });
      else this.looks.set(id, { visible: true, color: state.color, alpha: (state.alpha ?? 255) / 255 });
    }
    this.changed();
  }
  async resetAll() { this.looks.clear(); this.changed(); }
  async focus() { /* the demo camera is fixed */ }
  async getProperties(_modelId: string, ids: number[]): Promise<ObjInfo[]> {
    const wanted = new Set(ids);
    return this.boxes.filter((b) => wanted.has(b.id)).map((b) => ({ id: b.id, cls: b.cls, props: b.props }));
  }
  async getBottomZ(_modelId: string, ids: number[]) {
    const wanted = new Set(ids);
    return this.boxes.filter((b) => wanted.has(b.id)).map((b) => ({ id: b.id, z: b.z }));
  }
  async toExternalIds(_modelId: string, ids: number[]) { return ids.map((id) => `demo-${id}`); }
  async toRuntimeIds(_modelId: string, externalIds: string[]) {
    return externalIds.map((e) => { const id = Number(e.replace('demo-', '')); return this.boxes.some((b) => b.id === id) ? id : null; });
  }
  onChange(cb: (what: 'models' | 'selection') => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
}
