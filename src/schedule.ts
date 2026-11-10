import type { ModelInfo, ObjRef, ObjState, ViewerPort } from './viewer';

export type ActivityType = 'build' | 'demolish' | 'temp';
/** Objects of one model, stored by persistent id when the model has them. */
export type Link = { modelId: string; modelName: string; guids?: string[]; runtimeIds?: number[] };
/** `areaId` places the activity in a WBS area; activities without one are listed under "Utan område". */
export type Activity = { id: string; name: string; start: string; end: string; type: ActivityType; color: string; links: Link[]; areaId?: string };
/** A user-defined WBS area, e.g. "741 - Sektionsfickor". */
export type Area = { id: string; name: string };
export type Unlinked = 'show' | 'ghost' | 'hide';
export type Plan = { version: 1; unlinked: Unlinked; areas: Area[]; activities: Activity[] };
export type Group = { name: string; refs: ObjRef[] };
/** property key -> value -> modelId -> runtime ids */
export type PropertyIndex = Map<string, Map<string, Map<string, number[]>>>;

export const TYPE_LABEL: Record<ActivityType, string> = { build: 'Bygg', demolish: 'Riv', temp: 'Tillfällig' };
export const PALETTE = ['#2f80ed', '#f2994a', '#27ae60', '#9b51e0', '#eb5757', '#00a3a3', '#d4a017', '#e84393'];
export const CLASS_KEY = 'IFC-klass';
const GHOST: ObjState = { color: '#9aa3ad', alpha: 50 };
const MAX_VALUES = 400;
const CHUNK = 400;

export const emptyPlan = (): Plan => ({ version: 1, unlinked: 'ghost', areas: [], activities: [] });
export const newId = () => Math.random().toString(36).slice(2, 10);
export const toDay = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 864e5);
export const toIso = (day: number) => new Date(day * 864e5).toISOString().slice(0, 10);
export const today = () => toIso(Math.floor(Date.now() / 864e5));
export const linkCount = (a: Activity) => a.links.reduce((n, l) => n + (l.guids?.length ?? l.runtimeIds?.length ?? 0), 0);

const dateFormat = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const formatDay = (day: number) => dateFormat.format(new Date(day * 864e5));

export function planRange(plan: Plan) {
  if (!plan.activities.length) { const t = toDay(today()); return { start: t, end: t + 30 }; }
  return {
    start: Math.min(...plan.activities.map((a) => toDay(a.start))),
    end: Math.max(...plan.activities.map((a) => toDay(a.end))),
  };
}

export type Phase = 'before' | 'active' | 'after';
export const phaseOf = (a: Activity, day: number): Phase => (day < toDay(a.start) ? 'before' : day > toDay(a.end) ? 'after' : 'active');

function lookOf(a: Activity, day: number): ObjState {
  const phase = phaseOf(a, day);
  if (phase === 'active') return { color: a.color };
  if (a.type === 'temp') return 'hidden';
  return (a.type === 'build') === (phase === 'after') ? 'natural' : 'hidden';
}

export function progress(plan: Plan, day: number) {
  let total = 0, done = 0;
  const active: Activity[] = [];
  for (const a of plan.activities) {
    const phase = phaseOf(a, day);
    if (phase === 'active') active.push(a);
    if (a.type === 'temp') continue;
    total += linkCount(a);
    if (phase === 'after') done += linkCount(a);
  }
  return { total, done, active };
}

/* ---------- WBS areas ---------- */

/** Moves an activity into an area (undefined = no area), before `beforeId` or last when omitted. */
export function moveActivity(plan: Plan, id: string, areaId: string | undefined, beforeId?: string): Plan {
  const moving = plan.activities.find((a) => a.id === id);
  if (!moving || id === beforeId) return plan;
  const rest = plan.activities.filter((a) => a.id !== id);
  const at = beforeId ? rest.findIndex((a) => a.id === beforeId) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, { ...moving, areaId });
  return { ...plan, activities: rest };
}

export function removeArea(plan: Plan, areaId: string): Plan {
  return {
    ...plan,
    areas: plan.areas.filter((a) => a.id !== areaId),
    activities: plan.activities.map((a) => (a.areaId === areaId ? { ...a, areaId: undefined } : a)),
  };
}

/* ---------- Linking objects ---------- */

export async function makeLinks(viewer: ViewerPort, models: ModelInfo[], refs: ObjRef[]): Promise<Link[]> {
  const links: Link[] = [];
  for (const ref of refs) {
    if (!ref.ids.length) continue;
    const modelName = models.find((m) => m.id === ref.modelId)?.name ?? ref.modelId;
    const guids = await viewer.toExternalIds(ref.modelId, ref.ids);
    links.push(guids ? { modelId: ref.modelId, modelName, guids } : { modelId: ref.modelId, modelName, runtimeIds: ref.ids });
  }
  return links;
}

export function mergeLinks(a: Link[], b: Link[]): Link[] {
  const out = a.map((l) => ({ ...l }));
  for (const link of b) {
    const same = out.find((l) => l.modelId === link.modelId && !!l.guids === !!link.guids);
    if (!same) out.push(link);
    else if (same.guids) same.guids = [...new Set([...same.guids, ...link.guids!])];
    else same.runtimeIds = [...new Set([...same.runtimeIds!, ...link.runtimeIds!])];
  }
  return out;
}

/** Turns stored links back into runtime ids for the models that are loaded right now. */
export class LinkResolver {
  private cache = new WeakMap<Link, Promise<ObjRef | null>>();
  constructor(private viewer: ViewerPort, private models: ModelInfo[]) {}

  private one(link: Link): Promise<ObjRef | null> {
    let hit = this.cache.get(link);
    if (!hit) {
      hit = (async () => {
        const model = this.models.find((m) => m.id === link.modelId) ?? (link.guids && this.models.find((m) => m.name === link.modelName));
        if (!model) return null;
        if (!link.guids) return { modelId: model.id, ids: link.runtimeIds ?? [] };
        const ids = await this.viewer.toRuntimeIds(model.id, link.guids);
        return { modelId: model.id, ids: ids.filter((id): id is number => id !== null) };
      })().catch(() => null);
      this.cache.set(link, hit);
    }
    return hit;
  }

  async refs(activity: Activity): Promise<ObjRef[]> {
    const refs = await Promise.all(activity.links.map((l) => this.one(l)));
    return refs.filter((r): r is ObjRef => !!r && r.ids.length > 0);
  }
}

/* ---------- Painting the model ---------- */

type PaintJob = { plan: Plan; resolver: LinkResolver; day: number } | 'clear';

/** Applies the plan to the viewer, touching only activities whose look changed since the last call. */
export class Painter {
  private applied = new Map<string, string>();
  private dirty = true;
  private running = false;
  private queued: PaintJob | null = null;
  constructor(private viewer: ViewerPort) {}

  /** Forces the next paint to start from a reset model. */
  invalidate() { this.dirty = true; }
  paint(plan: Plan, resolver: LinkResolver, day: number) { return this.request({ plan, resolver, day }); }
  /** Restores the model's own colours and visibility. */
  clear() { return this.request('clear'); }

  /** Latest request wins; viewer calls never overlap. */
  private async request(job: PaintJob) {
    if (this.running) { this.queued = job; return; }
    this.running = true;
    try {
      for (let next: PaintJob | null = job; next; ) {
        await this.run(next);
        next = this.queued;
        this.queued = null;
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: PaintJob) {
    if (job === 'clear') {
      this.dirty = true;
      this.applied.clear();
      await this.viewer.resetAll();
      return;
    }
    const { plan, resolver, day } = job;
    if (this.dirty) {
      this.dirty = false;
      this.applied.clear();
      await this.viewer.resetAll();
      if (plan.unlinked !== 'show') await this.viewer.apply(undefined, plan.unlinked === 'hide' ? 'hidden' : GHOST);
    }
    for (const activity of plan.activities) {
      const look = lookOf(activity, day);
      const key = typeof look === 'string' ? look : look.color;
      if (this.applied.get(activity.id) === key) continue;
      const refs = await resolver.refs(activity);
      if (refs.length) await this.viewer.apply(refs, look);
      this.applied.set(activity.id, key);
    }
  }
}

/* ---------- Creating activities from the model ---------- */

type Progress = (done: number, total: number) => void;

async function eachChunk(scope: ObjRef[], onProgress: Progress, cancelled: () => boolean, work: (modelId: string, ids: number[]) => Promise<void>) {
  const total = scope.reduce((n, r) => n + r.ids.length, 0);
  let done = 0;
  for (const ref of scope) {
    for (let i = 0; i < ref.ids.length; i += CHUNK) {
      if (cancelled()) return;
      const ids = ref.ids.slice(i, i + CHUNK);
      await work(ref.modelId, ids);
      done += ids.length;
      onProgress(done, total);
    }
  }
}

export async function scanProperties(viewer: ViewerPort, scope: ObjRef[], onProgress: Progress, cancelled: () => boolean): Promise<PropertyIndex> {
  const index: PropertyIndex = new Map();
  const tooMany = new Set<string>();
  const put = (key: string, value: string, modelId: string, id: number) => {
    if (tooMany.has(key)) return;
    let values = index.get(key);
    if (!values) index.set(key, (values = new Map()));
    let models = values.get(value);
    if (!models) {
      if (values.size >= MAX_VALUES) { tooMany.add(key); index.delete(key); return; }
      values.set(value, (models = new Map()));
    }
    const ids = models.get(modelId);
    if (ids) ids.push(id); else models.set(modelId, [id]);
  };
  await eachChunk(scope, onProgress, cancelled, async (modelId, ids) => {
    for (const o of await viewer.getProperties(modelId, ids)) {
      if (o.cls) put(CLASS_KEY, o.cls, modelId, o.id);
      for (const key in o.props) put(key, o.props[key], modelId, o.id);
    }
  });
  for (const [key, values] of index) if (values.size < 2) index.delete(key);
  return index;
}

const LIKELY = /storey|level|våning|plan|etapp|phase|fas|littera|floor|zon|zone|sekvens|sequence/i;
export function sortedKeys(index: PropertyIndex) {
  const rank = (k: string) => (k === CLASS_KEY ? 1 : LIKELY.test(k) ? 0 : 2);
  return [...index.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'sv'));
}

export function groupsFromProperty(index: PropertyIndex, key: string): Group[] {
  const values = index.get(key) ?? new Map<string, Map<string, number[]>>();
  return [...values.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'sv', { numeric: true }))
    .map(([name, models]) => ({ name, refs: [...models.entries()].map(([modelId, ids]) => ({ modelId, ids })) }));
}

/** Splits the objects into equally tall bands, bottom first. Works on any model, with or without properties. */
export async function groupsByHeight(viewer: ViewerPort, scope: ObjRef[], steps: number, onProgress: Progress, cancelled: () => boolean): Promise<Group[]> {
  const all: { modelId: string; id: number; z: number }[] = [];
  await eachChunk(scope, onProgress, cancelled, async (modelId, ids) => {
    for (const o of await viewer.getBottomZ(modelId, ids)) if (Number.isFinite(o.z)) all.push({ modelId, id: o.id, z: o.z });
  });
  if (!all.length) return [];
  let min = Infinity, max = -Infinity;
  for (const o of all) { if (o.z < min) min = o.z; if (o.z > max) max = o.z; }
  const band = (max - min) / steps || 1;
  const buckets = Array.from({ length: steps }, () => new Map<string, number[]>());
  for (const o of all) {
    const bucket = buckets[Math.min(steps - 1, Math.floor((o.z - min) / band))];
    const ids = bucket.get(o.modelId);
    if (ids) ids.push(o.id); else bucket.set(o.modelId, [o.id]);
  }
  const m = (z: number) => `${z >= 0 ? '+' : ''}${z.toFixed(1)}`;
  return buckets
    .map((bucket, i) => ({ name: `Etapp ${i + 1} (${m(min + i * band)} till ${m(min + (i + 1) * band)} m)`, refs: [...bucket.entries()].map(([modelId, ids]) => ({ modelId, ids })) }))
    .filter((g) => g.refs.length)
    .map((g, i) => ({ ...g, name: g.name.replace(/^Etapp \d+/, `Etapp ${i + 1}`) }));
}

/** One activity per group, scheduled back to back. */
export async function activitiesFromGroups(viewer: ViewerPort, models: ModelInfo[], groups: Group[], startIso: string, days: number, colorOffset: number): Promise<Activity[]> {
  const activities: Activity[] = [];
  let day = toDay(startIso);
  for (const [i, group] of groups.entries()) {
    activities.push({
      id: newId(), name: group.name, type: 'build', color: PALETTE[(colorOffset + i) % PALETTE.length],
      start: toIso(day), end: toIso(day + days - 1), links: await makeLinks(viewer, models, group.refs),
    });
    day += days;
  }
  return activities;
}

/* ---------- Import, export and storage ---------- */

function parseDate(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (!m) { const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t); if (dmy) m = [t, dmy[3], dmy[2], dmy[1]] as unknown as RegExpExecArray; }
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || toIso(toDay(iso)) !== iso ? null : iso;
}

/** Rows of "name; start; end[; area]". Updates activities with the same name and adds the rest as new ones. */
export function importDates(plan: Plan, text: string): { plan: Plan; updated: number; added: number; skipped: number } {
  const activities = plan.activities.map((a) => ({ ...a }));
  const areas = [...plan.areas];
  const areaFor = (name: string | undefined) => {
    if (!name) return undefined;
    let area = areas.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
    if (!area) areas.push((area = { id: newId(), name }));
    return area.id;
  };
  let updated = 0, added = 0, skipped = 0;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const delimiter = ['\t', ';', ','].find((d) => lines[0]?.includes(d)) ?? ';';
  lines.forEach((line, row) => {
    const [name, a, b, areaName] = line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ''));
    const start = parseDate(a ?? ''), end = parseDate(b ?? '');
    if (!name || !start || !end || end < start) { if (row > 0 || start || end) skipped++; return; }
    const existing = activities.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
    const areaId = areaFor(areaName);
    if (existing) { existing.start = start; existing.end = end; if (areaId) existing.areaId = areaId; updated++; }
    else { activities.push({ id: newId(), name, start, end, type: 'build', color: PALETTE[activities.length % PALETTE.length], links: [], areaId }); added++; }
  });
  return { plan: { ...plan, areas, activities }, updated, added, skipped };
}

export function parsePlan(json: string): Plan | null {
  try {
    const raw = JSON.parse(json);
    if (!raw || !Array.isArray(raw.activities)) return null;
    const areas: Area[] = (Array.isArray(raw.areas) ? raw.areas : [])
      .filter((a: any) => a && typeof a.id === 'string' && typeof a.name === 'string')
      .map((a: any) => ({ id: a.id, name: a.name }));
    const activities: Activity[] = raw.activities
      .filter((a: any) => a && typeof a.name === 'string' && parseDate(String(a.start)) && parseDate(String(a.end)))
      .map((a: any, i: number) => ({
        id: typeof a.id === 'string' ? a.id : newId(), name: a.name, start: a.start, end: a.end,
        type: a.type in TYPE_LABEL ? a.type : 'build', color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : PALETTE[i % PALETTE.length],
        links: Array.isArray(a.links) ? a.links.filter((l: any) => l && typeof l.modelId === 'string' && (Array.isArray(l.guids) || Array.isArray(l.runtimeIds))) : [],
        areaId: areas.some((x) => x.id === a.areaId) ? a.areaId : undefined,
      }));
    return { version: 1, unlinked: ['show', 'ghost', 'hide'].includes(raw.unlinked) ? raw.unlinked : 'ghost', areas, activities };
  } catch {
    return null;
  }
}

const storageKey = (projectId: string) => `tc-codex-4d:${projectId}`;
export function loadPlan(projectId: string): Plan {
  try { return parsePlan(localStorage.getItem(storageKey(projectId)) ?? '') ?? emptyPlan(); } catch { return emptyPlan(); }
}
export function savePlan(projectId: string, plan: Plan): boolean {
  try { localStorage.setItem(storageKey(projectId), JSON.stringify(plan)); return true; } catch { return false; }
}
