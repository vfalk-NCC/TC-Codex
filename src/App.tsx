import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DemoScene from './DemoScene';
import { DemoViewer } from './demo';
import { applyTheme, storedTheme, type Theme } from './theme';
import { connectTrimble, type ModelInfo, type ObjRef, type ViewerPort } from './viewer';
import { Dialog, GenerateDialog, Icon, ImportDialog, MaskDialog, ToolsDialog, count, message } from './parts';
import {
  LinkResolver, OwnerIndex, PALETTE, Painter, STATUS_COLOR, STATUS_LABEL, TYPE_LABEL, axisTicks, duplicateActivity, emptyPlan, eventDays, formatDay,
  importDates, isLate, isoWeek, linkCount, loadPlan, makeLinks, mergeLinks, moveActivity, newId, parsePlan, phaseOf, planRange, progress, removeArea,
  savePlan, shiftDates, statusCounts, toCsv, toDay, toIso, today,
  type Activity, type ActivityType, type Area, type Link, type Plan, type Status, type ViewMode,
} from './schedule';

/** SHA-256 of the access code. This only keeps casual visitors out: the app is a public static site, so it is not real access control. */
const ACCESS_HASH = '8bb0cf6eb9b17d0f7d22b456f121257dc1254e1f01665370476383ea776df414';
const ACCESS_KEY = 'tc-codex-4d:unlocked';

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function wasUnlocked() {
  try { return sessionStorage.getItem(ACCESS_KEY) === ACCESS_HASH; } catch { return false; }
}

export default function App() {
  const [unlocked, setUnlocked] = useState(wasUnlocked);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);

  if (unlocked) return <Connected />;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((await sha256(password)) !== ACCESS_HASH) { setWrong(true); return; }
    try { sessionStorage.setItem(ACCESS_KEY, ACCESS_HASH); } catch { /* asks again next time */ }
    setUnlocked(true);
  };
  return (
    <main className="splash">
      <h1>4D-light</h1>
      <form className="lock" onSubmit={(e) => void submit(e)}>
        <label>Lösenord
          <input type="password" value={password} autoFocus autoComplete="current-password" onChange={(e) => { setPassword(e.target.value); setWrong(false); }} />
        </label>
        {wrong && <p className="error" role="alert">Fel lösenord.</p>}
        <button className="primary" disabled={!password}>Öppna</button>
      </form>
    </main>
  );
}

function Connected() {
  const [viewer, setViewer] = useState<ViewerPort | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (window.parent === window) { setViewer(new DemoViewer()); return; }
    let alive = true;
    connectTrimble().then((v) => alive && setViewer(v), (e) => alive && setError(message(e)));
    return () => { alive = false; };
  }, []);

  if (viewer) return <Studio viewer={viewer} />;
  return (
    <main className="splash">
      <h1>4D-light</h1>
      {error
        ? <><p>Kunde inte ansluta till Trimble Connect ({error}).</p><button className="primary" onClick={() => setViewer(new DemoViewer())}>Öppna demoläge</button></>
        : <p>Ansluter till Trimble Connect…</p>}
    </main>
  );
}

type History = { past: Plan[]; present: Plan; future: Plan[]; at: number; key: string };

/** Plan state with undo and redo. Consecutive edits with the same `mergeKey` (typing in one field) count as one step. */
function usePlanHistory(initial: () => Plan) {
  const [history, setHistory] = useState<History>(() => ({ past: [], present: initial(), future: [], at: 0, key: '' }));
  const setPlan = useCallback((update: Plan | ((p: Plan) => Plan), mergeKey = '') => {
    const now = Date.now();
    setHistory((h) => {
      const next = typeof update === 'function' ? update(h.present) : update;
      if (next === h.present) return h;
      const merge = !!mergeKey && mergeKey === h.key && now - h.at < 2000 && h.past.length > 0;
      return { past: merge ? h.past : [...h.past.slice(-49), h.present], present: next, future: [], at: now, key: mergeKey };
    });
  }, []);
  const undo = useCallback(() => setHistory((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], at: 0, key: '' } : h)), []);
  const redo = useCallback(() => setHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), at: 0, key: '' } : h)), []);
  return { plan: history.present, setPlan, undo, redo, canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const NEXT_STATUS: Record<Status, Status> = { todo: 'doing', doing: 'done', done: 'todo' };
type DialogName = 'generate' | 'import' | 'tools' | 'mask' | null;

function Studio({ viewer }: { viewer: ViewerPort }) {
  const { plan, setPlan, undo, redo, canUndo, canRedo } = usePlanHistory(() => loadPlan(viewer.projectId));
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selection, setSelection] = useState<ObjRef[]>([]);
  const [owner, setOwner] = useState<OwnerIndex | null>(null);
  const [mode, setMode] = useState<ViewMode>('plan');
  const [live, setLive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [dayState, setDay] = useState(() => toDay(today()));
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; applyTheme(next); setTheme(next); };

  const todayDay = useMemo(() => toDay(today()), []);
  const range = useMemo(() => planRange(plan), [plan]);
  const min = range.start - 1, max = range.end + 1, span = Math.max(1, max - min);
  const day = mode === 'status' ? Math.min(max, Math.max(min, todayDay)) : Math.min(max, Math.max(min, dayState));
  const painter = useMemo(() => new Painter(viewer), [viewer]);
  const resolver = useMemo(() => new LinkResolver(viewer, models), [viewer, models]);
  const stats = useMemo(() => progress(plan, day), [plan, day]);
  const counts = useMemo(() => statusCounts(plan, todayDay), [plan, todayDay]);
  const ticks = useMemo(() => axisTicks(min, max), [min, max]);
  const selected = count(selection);
  const hits = useMemo(() => (owner && selected ? owner.activitiesOf(selection) : new Set<string>()), [owner, selection, selected]);
  const pct = (d: number) => ((d - min) / span) * 100;

  useEffect(() => {
    const refresh = (what: 'models' | 'selection') => {
      if (what === 'models') viewer.getModels().then(setModels, () => setModels([]));
      else viewer.getSelection().then(setSelection, () => setSelection([]));
    };
    refresh('models');
    refresh('selection');
    return viewer.onChange(refresh);
  }, [viewer]);

  useEffect(() => {
    if (!savePlan(viewer.projectId, plan)) setNotice('Planen kunde inte sparas i webbläsaren. Spara den som fil för att inte förlora den.');
  }, [viewer, plan]);

  useEffect(() => {
    painter.paint(plan, resolver, { day, mode, todayDay, live }).catch((e) => setNotice(`Modellen kunde inte uppdateras: ${message(e)}`));
  }, [painter, plan, resolver, day, mode, todayDay, live]);

  // Rebuild the object-to-activity lookup only when the links themselves change.
  const linkSets = useRef<Link[][]>([]);
  const indexedWith = useRef<LinkResolver | null>(null);
  useEffect(() => {
    const next = plan.activities.map((a) => a.links);
    if (indexedWith.current === resolver && next.length === linkSets.current.length && next.every((l, i) => l === linkSets.current[i])) return;
    linkSets.current = next;
    indexedWith.current = resolver;
    let alive = true;
    OwnerIndex.build(plan.activities, resolver).then((index) => alive && setOwner(index), () => undefined);
    return () => { alive = false; };
  }, [plan.activities, resolver]);

  const daysPerSecond = speed || Math.max(1, span / 30);
  useEffect(() => {
    if (!playing) return;
    let position = day >= max ? min : day;
    const timer = setInterval(() => {
      position += daysPerSecond / 10;
      if (position >= max) { position = max; setPlaying(false); }
      setDay(Math.floor(position));
    }, 100);
    return () => clearInterval(timer);
    // The loop owns the position while it runs.
  }, [playing, daysPerSecond, min, max]);

  const showAt = (next: number) => { setPlaying(false); setMode('plan'); setLive(true); setDay(Math.min(max, Math.max(min, next))); };
  const togglePlay = () => { if (!plan.activities.length) return; setMode('plan'); setLive(true); setPlaying((p) => !p); };
  const jump = (direction: 1 | -1) => {
    const events = eventDays(plan);
    const target = direction > 0 ? events.find((d) => d > day) : [...events].reverse().find((d) => d < day);
    showAt(target ?? (direction > 0 ? max : min));
  };

  // Keep the latest handlers reachable from the one keyboard listener.
  const keys = useRef({ togglePlay, showAt, day, undo, redo });
  keys.current = { togglePlay, showAt, day, undo, redo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [role="dialog"]')) return;
      const k = keys.current;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) k.redo(); else k.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); k.redo(); }
      else if (e.key === ' ' && !(e.target as HTMLElement).closest('button')) { e.preventDefault(); k.togglePlay(); }
      else if (e.key === 'ArrowRight') k.showAt(k.day + 1);
      else if (e.key === 'ArrowLeft') k.showAt(k.day - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const update = (id: string, patch: Partial<Activity>) =>
    setPlan((p) => ({ ...p, activities: p.activities.map((a) => (a.id === id ? { ...a, ...patch } : a)) }), 'name' in patch || 'color' in patch ? `${id}:${Object.keys(patch)}` : '');
  const link = async (activity: Activity, how: 'set' | 'add') => {
    try {
      const links = await makeLinks(viewer, models, await viewer.getSelection());
      if (!links.length) { setNotice('Markera objekt i modellen först.'); return; }
      update(activity.id, { links: how === 'add' ? mergeLinks(activity.links, links) : links });
    } catch (e) {
      setNotice(`Kunde inte koppla objekten: ${message(e)}`);
    }
  };
  const withObjects = async (activity: Activity, action: (refs: ObjRef[]) => Promise<void>) => {
    try {
      const refs = await resolver.refs(activity);
      if (refs.length) await action(refs);
      else setNotice('Aktivitetens objekt finns inte i de modeller som är laddade.');
    } catch (e) {
      setNotice(message(e));
    }
  };
  const addActivity = (areaId?: string) => {
    const start = toIso(plan.activities.length ? range.end + 1 : todayDay);
    const activity: Activity = { id: newId(), name: `Aktivitet ${plan.activities.length + 1}`, start, end: toIso(toDay(start) + 4), type: 'build', color: PALETTE[plan.activities.length % PALETTE.length], links: [], areaId, status: 'todo' };
    setPlan((p) => ({ ...p, activities: [...p.activities, activity] }));
    setOpen(activity.id);
    setQuery('');
  };
  const addArea = () => {
    const area: Area = { id: newId(), name: 'Nytt område' };
    setPlan((p) => ({ ...p, areas: [...p.areas, area] }));
    setRenaming(area.id);
  };
  const dropOn = (areaId: string | undefined, beforeId?: string) => {
    if (drag) setPlan((p) => moveActivity(p, drag, areaId, beforeId));
    setDrag(null);
    setOver(null);
  };
  const toggleCollapsed = (key: string) => setCollapsed((c) => { const next = new Set(c); if (!next.delete(key)) next.add(key); return next; });
  const reveal = (id: string) => {
    const activity = plan.activities.find((a) => a.id === id);
    if (!activity) return;
    setQuery('');
    setCollapsed((c) => { const next = new Set(c); next.delete(activity.areaId ?? ''); return next; });
    setOpen(id);
    setTimeout(() => document.getElementById(`act-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
  };
  const maskSelection = async () => {
    try {
      const links = await makeLinks(viewer, models, await viewer.getSelection());
      if (!links.length) { setNotice('Markera objekten som är i vägen först.'); return; }
      setPlan((p) => ({ ...p, masks: [...p.masks, { id: newId(), name: `Släckt ${p.masks.length + 1}`, mode: 'hide', on: true, links }] }));
      await viewer.select([]).catch(() => undefined);
    } catch (e) {
      setNotice(message(e));
    }
  };
  const selectUnlinked = async () => {
    try {
      const index = await OwnerIndex.build(plan.activities, resolver);
      const refs = index.unlinked(await viewer.getAllObjects());
      if (refs.length) await viewer.select(refs);
      setNotice(refs.length ? `${count(refs)} objekt saknar aktivitet och är nu markerade.` : 'Alla objekt är kopplade till en aktivitet.');
      setDialog(null);
    } catch (e) {
      setNotice(message(e));
    }
  };
  const openPlan = async (file: File | undefined) => {
    if (!file) return;
    const next = parsePlan(await file.text());
    if (next) { setPlan(next); setNotice(`Planen lästes in: ${next.activities.length} aktiviteter.`); }
    else setNotice('Filen är inte en giltig 4D-plan.');
  };
  const fileName = (ext: string) => `4d-plan-${viewer.projectName.replace(/[^\wåäöÅÄÖ-]+/g, '_')}.${ext}`;

  const needle = query.trim().toLowerCase();
  const visible = (a: Activity) => !needle || a.name.toLowerCase().includes(needle);
  const row = (a: Activity) => (
    <ActivityRow key={a.id} activity={a} areas={plan.areas} phase={phaseOf(a, day)} late={isLate(a, todayDay)} hit={hits.has(a.id)}
      expanded={open === a.id} selected={selected} min={min} span={span} cursor={pct(day)}
      dragging={drag === a.id} over={over === `act:${a.id}`} canDrop={!!drag && drag !== a.id}
      onDragStart={() => setDrag(a.id)} onDragEnd={() => { setDrag(null); setOver(null); }}
      onDragOver={() => setOver(`act:${a.id}`)} onDrop={() => dropOn(a.areaId, a.id)}
      onToggle={() => setOpen(open === a.id ? null : a.id)} onChange={(patch) => update(a.id, patch)}
      onLink={(how) => void link(a, how)} onSelect={() => void withObjects(a, (refs) => viewer.select(refs))} onFocus={() => void withObjects(a, (refs) => viewer.focus(refs))}
      onDuplicate={() => setPlan((p) => duplicateActivity(p, a.id))}
      onDelete={() => setPlan((p) => ({ ...p, activities: p.activities.filter((x) => x.id !== a.id) }))} />
  );

  const panel = (
    <div className="panel">
      <header className="top">
        <div className="brand"><span className="orb" /><div><h1>4D-light</h1><small>{viewer.projectName}{viewer.kind === 'demo' ? ' · demoläge' : ''}</small></div></div>
        <div className="top-actions">
          <button className="ghost" disabled={!canUndo} onClick={undo} aria-label="Ångra" title="Ångra (Ctrl+Z)"><Icon name="undo" /></button>
          <button className="ghost" disabled={!canRedo} onClick={redo} aria-label="Gör om" title="Gör om (Ctrl+Y)"><Icon name="redo" /></button>
          <button className="ghost" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Byt till ljust tema' : 'Byt till mörkt tema'} title={theme === 'dark' ? 'Ljust tema' : 'Mörkt tema'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <button className="ghost" onClick={() => setDialog('tools')} aria-label="Verktyg" title="Verktyg"><Icon name="more" /></button>
          <label className="switch" title="Färga modellen efter tidplanen">
            <input type="checkbox" checked={live} onChange={() => { setPlaying(false); setLive(!live); }} /><span className="knob" /><span className="label">Visa i modell</span>
          </label>
        </div>
      </header>

      {notice && <div className="notice" role="status"><span>{notice}</span><button className="ghost" onClick={() => setNotice('')} aria-label="Stäng"><Icon name="x" size={14} /></button></div>}
      {!models.length && <div className="notice"><span>Ingen modell är laddad. Öppna 3D-vyn och ladda en modell.</span></div>}

      <section className="player">
        <div className="seg" role="tablist" aria-label="Visningsläge">
          <button role="tab" aria-selected={mode === 'plan'} onClick={() => setMode('plan')}>Tidplan</button>
          <button role="tab" aria-selected={mode === 'status'} onClick={() => { setPlaying(false); setMode('status'); setLive(true); }}>Status</button>
        </div>
        {mode === 'plan' ? <>
          <div className="date-line">
            <strong>{formatDay(day)}</strong><span className="week">v.{isoWeek(day)}</span>
            <span className="pct">{stats.total ? `${Math.round((stats.done / stats.total) * 100)} %` : '–'}<small>färdigt</small></span>
          </div>
          <input className="timeline" type="range" min={min} max={max} value={day} aria-label="Datum" style={{ '--p': `${pct(day)}%` } as React.CSSProperties} onChange={(e) => showAt(Number(e.target.value))} />
          <div className="controls">
            <button className="ghost" onClick={() => jump(-1)} aria-label="Föregående händelse" title="Föregående händelse"><Icon name="skipBack" /></button>
            <button className="ghost" onClick={() => showAt(day - 1)} aria-label="En dag bakåt" title="En dag bakåt (←)"><Icon name="left" /></button>
            <button className="primary play" disabled={!plan.activities.length} onClick={togglePlay} aria-label={playing ? 'Pausa' : 'Spela upp'}><Icon name={playing ? 'pause' : 'play'} /><span className="label">{playing ? 'Pausa' : 'Spela upp'}</span></button>
            <button className="ghost" onClick={() => showAt(day + 1)} aria-label="En dag framåt" title="En dag framåt (→)"><Icon name="right" /></button>
            <button className="ghost" onClick={() => jump(1)} aria-label="Nästa händelse" title="Nästa händelse"><Icon name="skipForward" /></button>
            <button onClick={() => showAt(todayDay)} title="Gå till dagens datum">Idag</button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Hastighet">
              <option value={0}>Hela på 30 s</option>
              <option value={1}>1 dag/s</option>
              <option value={7}>1 vecka/s</option>
              <option value={30}>1 månad/s</option>
            </select>
          </div>
          <div className="active-line">{stats.active.length ? <>Pågår: {stats.active.map((a) => <button key={a.id} className="chip" style={{ '--c': a.color } as React.CSSProperties} onClick={() => reveal(a.id)}>{a.name}</button>)}</> : ' '}</div>
        </> : <>
          <div className="date-line"><strong>Läget idag</strong><span className="week">v.{isoWeek(todayDay)}</span><span className="pct">{plan.activities.length ? `${Math.round((counts.done / plan.activities.length) * 100)} %` : '–'}<small>klart</small></span></div>
          <div className="legend">
            {(['todo', 'doing', 'done', 'late'] as const).map((k) => (
              <span key={k} className="chip" style={{ '--c': STATUS_COLOR[k] } as React.CSSProperties}>{k === 'late' ? 'Försenad' : STATUS_LABEL[k]} <b>{counts[k]}</b></span>
            ))}
          </div>
          <p className="hint">Modellen färgas efter aktiviteternas status. Klicka på statusknappen på en aktivitet för att ändra den.</p>
        </>}
        {hits.size > 0 && <div className="hit-line">Markerat objekt tillhör: {[...hits].slice(0, 4).map((id) => { const a = plan.activities.find((x) => x.id === id); return a && <button key={id} className="chip" style={{ '--c': a.color } as React.CSSProperties} onClick={() => reveal(id)}>{a.name}</button>; })}</div>}
      </section>

      <section className="masks">
        <div className="masks-head">
          <span><Icon name="layers" size={14} /> Släckt i modellen</span>
          <button disabled={!selected} onClick={() => void maskSelection()} title="Släck de markerade objekten">Släck markerade{selected ? ` (${selected})` : ''}</button>
          <button disabled={!selected} onClick={() => setDialog('mask')} title="Släck alla objekt som liknar det markerade">Släck liknande…</button>
        </div>
        {plan.masks.map((m) => (
          <div key={m.id} className={`mask${m.on ? '' : ' off'}`}>
            <button className="ghost" aria-pressed={m.on} aria-label={m.on ? `Visa ${m.name} igen` : `Släck ${m.name}`} title={m.on ? 'Visa igen' : 'Släck'}
              onClick={() => setPlan((p) => ({ ...p, masks: p.masks.map((x) => (x.id === m.id ? { ...x, on: !x.on } : x)) }))}><Icon name={m.on ? 'eyeOff' : 'eye'} /></button>
            <input value={m.name} aria-label="Namn på släckt grupp" onChange={(e) => setPlan((p) => ({ ...p, masks: p.masks.map((x) => (x.id === m.id ? { ...x, name: e.target.value } : x)) }), `mask:${m.id}`)} />
            <span className="meta">{m.links.reduce((n, l) => n + (l.guids?.length ?? l.runtimeIds?.length ?? 0), 0)} obj</span>
            <select value={m.mode} aria-label="Visa som" onChange={(e) => setPlan((p) => ({ ...p, masks: p.masks.map((x) => (x.id === m.id ? { ...x, mode: e.target.value === 'ghost' ? 'ghost' : 'hide' } : x)) }))}>
              <option value="hide">Dold</option>
              <option value="ghost">Genomskinlig</option>
            </select>
            <button className="ghost" aria-label={`Ta bort ${m.name}`} title="Ta bort" onClick={() => setPlan((p) => ({ ...p, masks: p.masks.filter((x) => x.id !== m.id) }))}><Icon name="x" /></button>
          </div>
        ))}
      </section>

      <div className="toolbar">
        <label className="search"><Icon name="search" size={14} /><input value={query} placeholder="Sök aktivitet" aria-label="Sök aktivitet" onChange={(e) => setQuery(e.target.value)} /></label>
        <button onClick={() => addActivity()}><Icon name="plus" size={14} />Aktivitet</button>
        <button onClick={addArea}><Icon name="plus" size={14} />Område</button>
        <button disabled={!models.length} onClick={() => setDialog('generate')}>Från modell</button>
      </div>

      <section className="activities">
        {plan.activities.length > 0 && (
          <div className="axis" onClick={(e) => { const box = e.currentTarget.getBoundingClientRect(); showAt(Math.round(min + ((e.clientX - box.left - 14) / (box.width - 28)) * span)); }} title="Klicka för att gå till ett datum">
            <div className="axis-inner">
              {ticks.map((t) => <span key={t.at} className="tick" style={{ left: `${pct(t.at)}%` }}>{t.label}</span>)}
              {todayDay >= min && todayDay <= max && <span className="today" style={{ left: `${pct(todayDay)}%` }} title="Idag" />}
              <span className="cursor" style={{ left: `${pct(day)}%` }} />
            </div>
          </div>
        )}
        {!plan.activities.length && !plan.areas.length && (
          <div className="empty">
            <span className="orb big" />
            <p>Skapa en tidplan direkt från modellen, till exempel en aktivitet per våning eller nedifrån och upp.</p>
            <button className="primary" disabled={!models.length} onClick={() => setDialog('generate')}>Skapa från modell</button>
          </div>
        )}
        {plan.areas.length === 0 && plan.activities.filter(visible).map(row)}
        {plan.areas.length > 0 && [...plan.areas, null].map((area) => {
          const key = area?.id ?? '';
          const all = plan.activities.filter((a) => (a.areaId ?? '') === key);
          const items = all.filter(visible);
          if (needle && !items.length) return null;
          const from = all.length ? Math.min(...all.map((a) => toDay(a.start))) : min;
          const to = all.length ? Math.max(...all.map((a) => toDay(a.end))) : min - 1;
          const done = all.filter((a) => a.status === 'done').length;
          const isCollapsed = collapsed.has(key) && !needle;
          return (
            <section key={key} className={`area${over === `area:${key}` ? ' over' : ''}`} aria-label={area?.name ?? 'Utan område'}
              onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(`area:${key}`); } }} onDrop={(e) => { e.preventDefault(); dropOn(area?.id); }}>
              <div className="area-head">
                <button className={`ghost fold${isCollapsed ? ' closed' : ''}`} onClick={() => toggleCollapsed(key)} aria-expanded={!isCollapsed} aria-label={isCollapsed ? 'Visa aktiviteter' : 'Dölj aktiviteter'}><Icon name="down" /></button>
                {area && renaming === area.id
                  ? <input className="area-name" autoFocus value={area.name} aria-label="Områdets namn" onFocus={(e) => e.target.select()}
                      onChange={(e) => setPlan((p) => ({ ...p, areas: p.areas.map((x) => (x.id === area.id ? { ...x, name: e.target.value } : x)) }), `area:${area.id}`)}
                      onBlur={() => setRenaming(null)} onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && setRenaming(null)} />
                  : <span className="area-name" onDoubleClick={() => area && setRenaming(area.id)}>{area ? area.name || 'Namnlöst område' : 'Utan område'}</span>}
                <span className="meta">{done}/{all.length} klara</span>
                {area && <>
                  <button className="ghost" onClick={() => addActivity(area.id)} aria-label="Ny aktivitet i området" title="Ny aktivitet i området"><Icon name="plus" /></button>
                  <button className="ghost" onClick={() => setRenaming(area.id)} aria-label="Byt namn" title="Byt namn"><Icon name="pencil" /></button>
                  <button className="ghost" onClick={() => setPlan((p) => removeArea(p, area.id))} aria-label="Ta bort område" title="Ta bort området (aktiviteterna behålls)"><Icon name="x" /></button>
                </>}
                <span className="track">
                  <span className="bar summary" style={{ left: `${pct(from)}%`, width: `${(Math.max(0, to - from + 1) / span) * 100}%` }} />
                  <span className="cursor" style={{ left: `${pct(day)}%` }} />
                </span>
              </div>
              {!isCollapsed && items.map(row)}
              {!isCollapsed && !all.length && <p className="drop-hint">Dra aktiviteter hit</p>}
            </section>
          );
        })}
      </section>

      <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => { void openPlan(e.target.files?.[0]); e.target.value = ''; }} />

      {dialog === 'generate' && (
        <GenerateDialog viewer={viewer} models={models} selected={selected} hasPlan={plan.activities.length > 0} areas={plan.areas} onClose={() => setDialog(null)}
          onDone={(activities, replace) => {
            setPlan((p) => ({ ...p, activities: replace ? activities : [...p.activities, ...activities] }));
            setDialog(null);
            setMode('plan');
            setLive(true);
            setDay(toDay(activities[0].start) - 1);
          }} />
      )}
      {dialog === 'import' && (
        <ImportDialog onClose={() => setDialog(null)} onImport={(text) => {
          const result = importDates(plan, text);
          setPlan(result.plan);
          setNotice(`${result.updated} uppdaterade, ${result.added} nya${result.skipped ? `, ${result.skipped} rader hoppades över` : ''}.`);
          setDialog(null);
        }} />
      )}
      {dialog === 'mask' && <MaskDialog viewer={viewer} models={models} onClose={() => setDialog(null)} onDone={(mask) => { setPlan((p) => ({ ...p, masks: [...p.masks, mask] })); setDialog(null); void viewer.select([]).catch(() => undefined); }} />}
      {dialog === 'tools' && (
        <ToolsDialog plan={plan} onClose={() => setDialog(null)} onPlan={setPlan}
          onShift={(days, areaId) => { setPlan((p) => shiftDates(p, days, areaId)); setNotice(`Datumen flyttades ${days} dagar.`); setDialog(null); }}
          onImportDates={() => setDialog('import')} onSelectUnlinked={() => void selectUnlinked()}
          onExportCsv={() => download(fileName('csv'), `﻿${toCsv(plan)}`, 'text/csv')} onExportPlan={() => download(fileName('json'), JSON.stringify(plan, null, 2), 'application/json')}
          onOpenPlan={() => { setDialog(null); fileInput.current?.click(); }}
          onClear={() => { setPlan(emptyPlan()); setDialog(null); setNotice('Planen tömdes. Ångra med Ctrl+Z.'); }} />
      )}
    </div>
  );

  if (viewer instanceof DemoViewer) return <div className="demo-layout"><DemoScene viewer={viewer} />{panel}</div>;
  return panel;
}

const shortDate = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const short = (day: number) => shortDate.format(new Date(day * 864e5));

function ActivityRow(props: {
  activity: Activity; areas: Area[]; phase: string; late: boolean; hit: boolean; expanded: boolean; selected: number; min: number; span: number; cursor: number;
  dragging: boolean; over: boolean; canDrop: boolean; onDragStart: () => void; onDragEnd: () => void; onDragOver: () => void; onDrop: () => void;
  onToggle: () => void; onChange: (patch: Partial<Activity>) => void; onLink: (how: 'set' | 'add') => void; onSelect: () => void; onFocus: () => void;
  onDuplicate: () => void; onDelete: () => void;
}) {
  const { activity: a, expanded, selected, onChange, min, span } = props;
  const [preview, setPreview] = useState<[number, number] | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const objects = linkCount(a);
  const status = a.status ?? 'todo';
  const [from, to] = preview ?? [toDay(a.start), toDay(a.end)];

  // Drag the bar to move the activity, or its ends to change the dates. Committed on release.
  const dragBar = (e: React.PointerEvent, part: 'move' | 'start' | 'end') => {
    e.preventDefault();
    e.stopPropagation();
    const width = track.current!.getBoundingClientRect().width, x0 = e.clientX, s0 = toDay(a.start), e0 = toDay(a.end);
    const at = (x: number): [number, number] => {
      const d = Math.round(((x - x0) / width) * span);
      return part === 'move' ? [s0 + d, e0 + d] : part === 'start' ? [Math.min(s0 + d, e0), e0] : [s0, Math.max(e0 + d, s0)];
    };
    const move = (ev: PointerEvent) => setPreview(at(ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      const [s, en] = at(ev.clientX);
      setPreview(null);
      if (s !== s0 || en !== e0) onChange({ start: toIso(s), end: toIso(en) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  return (
    <article id={`act-${a.id}`} style={{ '--c': a.color } as React.CSSProperties}
      className={`activity ${props.phase}${props.dragging ? ' dragging' : ''}${props.over ? ' over' : ''}${props.hit ? ' hit' : ''}${expanded ? ' open' : ''}`}
      onDragOver={(e) => { if (props.canDrop) { e.preventDefault(); e.stopPropagation(); props.onDragOver(); } }}
      onDrop={(e) => { if (props.canDrop) { e.preventDefault(); e.stopPropagation(); props.onDrop(); } }}>
      <div className="row" draggable title="Dra för att flytta till ett annat område"
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', a.id); e.dataTransfer.effectAllowed = 'move'; props.onDragStart(); }} onDragEnd={props.onDragEnd}>
        <span className="grip"><Icon name="grip" size={14} /></span>
        <span className="dot" />
        <button className="name" onClick={props.onToggle} aria-expanded={expanded}>{a.name || 'Namnlös aktivitet'}</button>
        <button className={`status ${props.late ? 'late' : status}`} title="Klicka för att byta status" onClick={() => onChange({ status: NEXT_STATUS[status] })}>
          {props.late ? 'Försenad' : STATUS_LABEL[status]}
        </button>
      </div>
      <div className="track" ref={track}>
        <div className="bar" style={{ left: `${((from - min) / span) * 100}%`, width: `${((to - from + 1) / span) * 100}%` }} onPointerDown={(e) => dragBar(e, 'move')} title="Dra för att flytta i tiden">
          <i className="edge start" onPointerDown={(e) => dragBar(e, 'start')} />
          <i className="edge end" onPointerDown={(e) => dragBar(e, 'end')} />
        </div>
        <span className="cursor" style={{ left: `${props.cursor}%` }} />
      </div>
      <div className="dates">{short(from)} – {short(to)} · {to - from + 1} d · v.{isoWeek(from)}{isoWeek(to) !== isoWeek(from) ? `–${isoWeek(to)}` : ''}<span>{objects} obj</span></div>
      {expanded && (
        <div className="editor">
          <label className="wide">Namn<input value={a.name} onChange={(e) => onChange({ name: e.target.value })} /></label>
          <label>Start<input type="date" value={a.start} onChange={(e) => e.target.value && onChange({ start: e.target.value, end: e.target.value > a.end ? e.target.value : a.end })} /></label>
          <label>Slut<input type="date" value={a.end} min={a.start} onChange={(e) => e.target.value && onChange({ end: e.target.value < a.start ? a.start : e.target.value })} /></label>
          <label>Typ
            <select value={a.type} onChange={(e) => onChange({ type: e.target.value as ActivityType })}>
              {Object.entries(TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Status
            <select value={status} onChange={(e) => onChange({ status: e.target.value as Status })}>
              {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {props.areas.length > 0 && (
            <label>Område
              <select value={a.areaId ?? ''} onChange={(e) => onChange({ areaId: e.target.value || undefined })}>
                <option value="">Utan område</option>
                {props.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
              </select>
            </label>
          )}
          <label>Färg<input type="color" value={a.color} onChange={(e) => onChange({ color: e.target.value })} /></label>
          <div className="wide buttons">
            <button className="primary" disabled={!selected} onClick={() => props.onLink('set')}>Koppla markerade ({selected})</button>
            <button disabled={!selected || !objects} onClick={() => props.onLink('add')}>Lägg till markerade</button>
            <button disabled={!objects} onClick={props.onSelect}>Markera i modell</button>
            <button disabled={!objects} onClick={props.onFocus}><Icon name="target" size={14} />Zooma</button>
            <button onClick={props.onDuplicate}><Icon name="copy" size={14} />Duplicera</button>
            <button className="danger" onClick={props.onDelete}>Ta bort</button>
          </div>
        </div>
      )}
    </article>
  );
}
