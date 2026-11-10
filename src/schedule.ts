import type { ModelInfo, ObjRef, ObjState, ViewerPort } from './viewer';

export type ActivityType = 'build' | 'demolish' | 'temp';
/** Objects of one model, stored by persistent id when the model has them. */
export type Link = { modelId: string; modelName: string; guids?: string[]; runtimeIds?: number[] };
/** `areaId` places the activity in a WBS area; activities without one are listed under "Utan område". */
export type Status = 'todo' | 'doing' | 'done';
export type Activity = { id: string; name: string; start: string; end: string; type: ActivityType; color: string; links: Link[]; areaId?: string; status?: Status };
/** A user-defined WBS area, e.g. "741 - Sektionsfickor". */
export type Area = { id: string; name: string };
export type Unlinked = 'show' | 'ghost' | 'hide';
export type ColorBy = 'activity' | 'type';
/** Objects kept out of the way (e.g. large slabs or cladding) no matter what the schedule says. */
export type Mask = { id: string; name: string; mode: 'hide' | 'ghost'; on: boolean; links: Link[] };
export type Plan = { version: 1; unlinked: Unlinked; colorBy: ColorBy; areas: Area[]; masks: Mask[]; activities: Activity[] };
/** 'plan' simulates the schedule at a date; 'status' colours by reported progress. */
export type ViewMode = 'plan' | 'status';
export type Group = { name: string; refs: ObjRef[] };
/** property key -> value -> modelId -> runtime ids */
export type PropertyIndex = Map<string, Map<string, Map<string, number[]>>>;

export const TYPE_LABEL: Record<ActivityType, string> = { build: 'Bygg', demolish: 'Riv', temp: 'Tillfällig' };
export const PALETTE = ['#2f80ed', '#f2994a', '#27ae60', '#9b51e0', '#eb5757', '#00a3a3', '#d4a017', '#e84393'];
export const CLASS_KEY = 'IFC-klass';
export const STATUS_LABEL: Record<Status, string> = { todo: 'Ej påbörjad', doing: 'Pågår', done: 'Klar' };
export const TYPE_COLOR: Record<ActivityType, string> = { build: '#22c55e', demolish: '#ef4444', temp: '#f59e0b' };
export const STATUS_COLOR = { todo: '#7c8db5', doing: '#ffb020', done: '#22c55e', late: '#ff3b6b' };
const GHOST: ObjState = { color: '#9aa3ad', alpha: 50 };
const MASK_GHOST: ObjState = { color: '#9aa3ad', alpha: 22 };
const MAX_VALUES = 400;
const CHUNK = 400;

export const emptyPlan = (): Plan => ({ version: 1, unlinked: 'ghost', colorBy: 'activity', areas: [], masks: [], activities: [] });
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

/** Behind plan: not finished after its end date, or not started after its start date. */
export const isLate = (a: Activity, todayDay: number) =>
  a.status !== 'done' && (todayDay > toDay(a.end) || ((a.status ?? 'todo') === 'todo' && todayDay > toDay(a.start)));

/** `live` false shows the model as it is, with only the masks applied. */
export type PaintView = { day: number; mode: ViewMode; todayDay: number; live: boolean };

function lookOf(a: Activity, plan: Plan, view: PaintView): ObjState {
  if (view.mode === 'status') {
    if (isLate(a, view.todayDay)) return { color: STATUS_COLOR.late };
    const status = a.status ?? 'todo';
    return status === 'todo' ? { color: STATUS_COLOR.todo, alpha: 110 } : { color: STATUS_COLOR[status] };
  }
  const phase = phaseOf(a, view.day);
  if (phase === 'active') return { color: plan.colorBy === 'type' ? TYPE_COLOR[a.type] : a.color };
  if (a.type === 'temp') return 'hidden';
  return (a.type === 'build') === (phase === 'after') ? 'natural' : 'hidden';
}

export function statusCounts(plan: Plan, todayDay: number) {
  const counts = { todo: 0, doing: 0, done: 0, late: 0 };
  for (const a of plan.activities) { counts[a.status ?? 'todo']++; if (isLate(a, todayDay)) counts.late++; }
  return counts;
}

/** ISO 8601 week number. */
export function isoWeek(day: number) {
  const date = new Date(day * 864e5);
  const thursday = day + 3 - ((date.getUTCDay() + 6) % 7);
  const yearStart = Date.UTC(new Date(thursday * 864e5).getUTCFullYear(), 0, 1) / 864e5;
  return Math.floor((thursday - yearStart) / 7) + 1;
}

/** Days where something starts or has just finished, for stepping through the plan event by event. */
export function eventDays(plan: Plan) {
  const days = new Set<number>();
  for (const a of plan.activities) { days.add(toDay(a.start)); days.add(toDay(a.end) + 1); }
  return [...days].sort((x, y) => x - y);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
/** Labels for the time axis: weeks for short plans, months or years for long ones. */
export function axisTicks(min: number, max: number): { at: number; label: string }[] {
  const span = max - min, ticks: { at: number; label: string }[] = [];
  if (span <= 70) {
    const step = span <= 35 ? 7 : 14;
    for (let d = min + ((11 - new Date(min * 864e5).getUTCDay()) % 7); d <= max; d += step) ticks.push({ at: d, label: `v.${isoWeek(d)}` });
    return ticks;
  }
  const first = new Date(min * 864e5);
  const stepMonths = span <= 400 ? 1 : span <= 1200 ? 3 : 12;
  for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); ; m += 1) {
    const d = Date.UTC(y, m, 1) / 864e5;
    if (d > max) break;
    const month = ((m % 12) + 12) % 12;
    if (d >= min && month % stepMonths === 0) ticks.push({ at: d, label: stepMonths === 12 || month === 0 ? String(y + Math.floor(m / 12)) : MONTHS[month] });
  }
  return ticks;
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

/** Moves every activity (or those of one area) by a number of days. */
export function shiftDates(plan: Plan, days: number, areaId?: string | null): Plan {
  const hit = (a: Activity) => areaId === undefined || (a.areaId ?? null) === areaId;
  return { ...plan, activities: plan.activities.map((a) => (hit(a) ? { ...a, start: toIso(toDay(a.start) + days), end: toIso(toDay(a.end) + days) } : a)) };
}

export function duplicateActivity(plan: Plan, id: string): Plan {
  const at = plan.activities.findIndex((a) => a.id === id);
  if (at < 0) return plan;
  const source = plan.activities[at];
  const length = toDay(source.end) - toDay(source.start);
  const copy: Activity = { ...source, id: newId(), name: `${source.name} (kopia)`, links: [], status: 'todo', start: toIso(toDay(source.end) + 1), end: toIso(toDay(source.end) + 1 + length) };
  return { ...plan, activities: [...plan.activities.slice(0, at + 1), copy, ...plan.activities.slice(at + 1)] };
}

export function toCsv(plan: Plan) {
  const cell = (v: string | number) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = plan.activities.map((a) => [
    a.name, a.start, a.end, plan.areas.find((x) => x.id === a.areaId)?.name ?? '', TYPE_LABEL[a.type], STATUS_LABEL[a.status ?? 'todo'], linkCount(a),
  ]);
  return [['Aktivitet', 'Start', 'Slut', 'Område', 'Typ', 'Status', 'Objekt'], ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
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

  async refs(item: { links: Link[] }): Promise<ObjRef[]> {
    const refs = await Promise.all(item.links.map((l) => this.one(l)));
    return refs.filter((r): r is ObjRef => !!r && r.ids.length > 0);
  }
}

/* ---------- Painting the model ---------- */

type PaintJob = { plan: Plan; resolver: LinkResolver; view: PaintView };
type Painted = { key: string; links: Link[]; refs: ObjRef[] };

/**
 * Applies the plan to the viewer with as few viewer calls as possible: only activities whose look
 * changed are touched, and the whole model is reset only when the models or the base look change.
 */
export class Painter {
  private painted = new Map<string, Painted>();
  private base: string | null = null;
  private resolver: LinkResolver | null = null;
  private running = false;
  private queued: PaintJob | null = null;
  constructor(private viewer: ViewerPort) {}

  paint(plan: Plan, resolver: LinkResolver, view: PaintView) { return this.request({ plan, resolver, view }); }

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
    } catch (e) {
      this.base = null;
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async run({ plan, resolver, view }: PaintJob) {
    const masks = plan.masks.filter((m) => m.on);
    // Leave the model untouched until there is something to show.
    if (!view.live && !masks.length && this.base === null) return;

    const baseKey = view.live ? plan.unlinked : 'off';
    const baseLook: ObjState = !view.live || plan.unlinked === 'show' ? 'natural' : plan.unlinked === 'hide' ? 'hidden' : GHOST;
    const items = [
      ...(view.live ? plan.activities.map((a) => ({ id: a.id, links: a.links, look: lookOf(a, plan, view), mask: false })) : []),
      // Masks come last so they win over the schedule.
      ...masks.map((m) => ({ id: `mask:${m.id}`, links: m.links, look: m.mode === 'hide' ? ('hidden' as ObjState) : MASK_GHOST, mask: true })),
    ];

    if (this.base !== baseKey || this.resolver !== resolver) {
      this.base = baseKey;
      this.resolver = resolver;
      this.painted.clear();
      await this.viewer.resetAll();
      if (baseLook !== 'natural') await this.viewer.apply(undefined, baseLook);
    } else {
      // Objects that left an activity or mask go back to the base look.
      const current = new Map(items.map((i) => [i.id, i.links]));
      let released = false;
      for (const [id, entry] of this.painted) {
        if (current.get(id) === entry.links) continue;
        if (entry.refs.length) await this.viewer.apply(entry.refs, baseLook);
        this.painted.delete(id);
        released = true;
      }
      // A released object may also belong to something else, so repaint everything.
      if (released) for (const entry of this.painted.values()) entry.key = '';
    }

    let repainted = false;
    for (const item of items) {
      const key = typeof item.look === 'string' ? item.look : `${item.look.color}/${item.look.alpha ?? 255}`;
      // A repainted activity may have re-shown masked objects, so masks follow any repaint.
      if (this.painted.get(item.id)?.key === key && !(item.mask && repainted)) continue;
      const refs = await resolver.refs(item);
      if (refs.length) await this.viewer.apply(refs, item.look);
      this.painted.set(item.id, { key, links: item.links, refs });
      if (!item.mask) repainted = true;
    }
  }
}

/** Looks up which activities an object belongs to. */
export class OwnerIndex {
  private owners = new Map<string, Map<number, string[]>>();
  static async build(activities: Activity[], resolver: LinkResolver) {
    const index = new OwnerIndex();
    for (const activity of activities) {
      for (const ref of await resolver.refs(activity)) {
        let model = index.owners.get(ref.modelId);
        if (!model) index.owners.set(ref.modelId, (model = new Map()));
        for (const id of ref.ids) { const list = model.get(id); if (list) list.push(activity.id); else model.set(id, [activity.id]); }
      }
    }
    return index;
  }
  activitiesOf(refs: ObjRef[]) {
    const hits = new Set<string>();
    for (const ref of refs) { const model = this.owners.get(ref.modelId); if (model) for (const id of ref.ids) model.get(id)?.forEach((a) => hits.add(a)); }
    return hits;
  }
  /** The objects in `all` that no activity uses. */
  unlinked(all: ObjRef[]): ObjRef[] {
    return all.map((ref) => { const model = this.owners.get(ref.modelId); return { modelId: ref.modelId, ids: model ? ref.ids.filter((id) => !model.has(id)) : ref.ids }; }).filter((r) => r.ids.length);
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

/* ---------- Masks: finding objects that are in the way ---------- */

export type Trait = { key: string; value: string };
const USEFUL = /name|namn|type|typ|material|benämning|description|beskrivning|littera|reference|family|layer|lager|profile|profil/i;
const NOISE = /guid|globalid|\bid$|tag$|handle|\b(area|volume|length|width|height|weight|längd|bredd|höjd|vikt)\b/i;

/** Property values shared by the selected objects, best candidates for "everything like this" first. */
export async function traitsOf(viewer: ViewerPort, selection: ObjRef[]): Promise<Trait[]> {
  const sample: { cls: string; props: Record<string, string> }[] = [];
  for (const ref of selection) {
    if (sample.length >= 25) break;
    sample.push(...(await viewer.getProperties(ref.modelId, ref.ids.slice(0, 25 - sample.length))));
  }
  if (!sample.length) return [];
  const traits: Trait[] = [];
  if (sample[0].cls && sample.every((o) => o.cls === sample[0].cls)) traits.push({ key: CLASS_KEY, value: sample[0].cls });
  for (const key of Object.keys(sample[0].props)) {
    const value = sample[0].props[key];
    if (!NOISE.test(key) && value.length <= 80 && sample.every((o) => o.props[key] === value)) traits.push({ key, value });
  }
  const rank = (t: Trait) => (USEFUL.test(t.key) ? 0 : t.key === CLASS_KEY ? 1 : 2);
  return traits.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key, 'sv')).slice(0, 80);
}

/** Every object in `scope` with the given property value. */
export async function findMatching(viewer: ViewerPort, scope: ObjRef[], trait: Trait, onProgress: Progress, cancelled: () => boolean): Promise<ObjRef[]> {
  const found = new Map<string, number[]>();
  await eachChunk(scope, onProgress, cancelled, async (modelId, ids) => {
    for (const o of await viewer.getProperties(modelId, ids)) {
      if ((trait.key === CLASS_KEY ? o.cls : o.props[trait.key]) !== trait.value) continue;
      const list = found.get(modelId);
      if (list) list.push(o.id); else found.set(modelId, [o.id]);
    }
  });
  return [...found.entries()].map(([modelId, ids]) => ({ modelId, ids }));
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
    const masks: Mask[] = (Array.isArray(raw.masks) ? raw.masks : [])
      .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string' && Array.isArray(m.links))
      .map((m: any) => ({ id: m.id, name: m.name, mode: m.mode === 'ghost' ? 'ghost' : 'hide', on: m.on !== false, links: m.links }));
    const activities: Activity[] = raw.activities
      .filter((a: any) => a && typeof a.name === 'string' && parseDate(String(a.start)) && parseDate(String(a.end)))
      .map((a: any, i: number) => ({
        id: typeof a.id === 'string' ? a.id : newId(), name: a.name, start: a.start, end: a.end,
        type: a.type in TYPE_LABEL ? a.type : 'build', color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : PALETTE[i % PALETTE.length],
        links: Array.isArray(a.links) ? a.links.filter((l: any) => l && typeof l.modelId === 'string' && (Array.isArray(l.guids) || Array.isArray(l.runtimeIds))) : [],
        areaId: areas.some((x) => x.id === a.areaId) ? a.areaId : undefined,
        status: a.status in STATUS_LABEL ? a.status : 'todo',
      }));
    return { version: 1, unlinked: ['show', 'ghost', 'hide'].includes(raw.unlinked) ? raw.unlinked : 'ghost', colorBy: raw.colorBy === 'type' ? 'type' : 'activity', areas, masks, activities };
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
