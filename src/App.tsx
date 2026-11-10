import { useEffect, useMemo, useRef, useState } from 'react';
import DemoScene from './DemoScene';
import { DemoViewer } from './demo';
import { connectTrimble, type ModelInfo, type ObjRef, type ViewerPort } from './viewer';
import {
  CLASS_KEY, LinkResolver, PALETTE, Painter, TYPE_LABEL, activitiesFromGroups, formatDay, groupsByHeight, groupsFromProperty,
  importDates, linkCount, loadPlan, makeLinks, mergeLinks, newId, parsePlan, phaseOf, planRange, progress, savePlan, scanProperties,
  sortedKeys, toDay, toIso, today,
  type Activity, type ActivityType, type Plan, type PropertyIndex, type Unlinked,
} from './schedule';

const count = (refs: ObjRef[]) => refs.reduce((n, r) => n + r.ids.length, 0);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

function Studio({ viewer }: { viewer: ViewerPort }) {
  const [plan, setPlan] = useState<Plan>(() => loadPlan(viewer.projectId));
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [live, setLive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(7);
  const [dayState, setDay] = useState(() => toDay(today()));
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'generate' | 'import' | null>(null);
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const range = useMemo(() => planRange(plan), [plan]);
  const min = range.start - 1, max = range.end + 1;
  const day = Math.min(max, Math.max(min, dayState));
  const painter = useMemo(() => new Painter(viewer), [viewer]);
  const resolver = useMemo(() => new LinkResolver(viewer, models), [viewer, models]);
  const stats = useMemo(() => progress(plan, day), [plan, day]);

  useEffect(() => {
    const refresh = (what: 'models' | 'selection') => {
      if (what === 'models') viewer.getModels().then(setModels, () => setModels([]));
      else viewer.getSelection().then((s) => setSelected(count(s)), () => setSelected(0));
    };
    refresh('models');
    refresh('selection');
    return viewer.onChange(refresh);
  }, [viewer]);

  useEffect(() => {
    if (!savePlan(viewer.projectId, plan)) setNotice('Planen kunde inte sparas i webbläsaren. Exportera den för att inte förlora den.');
  }, [viewer, plan]);

  // A changed plan or model set means everything has to be repainted from a clean model.
  useEffect(() => { painter.invalidate(); }, [painter, plan, resolver]);
  useEffect(() => {
    if (live) painter.paint(plan, resolver, day).catch((e) => setNotice(`Modellen kunde inte uppdateras: ${message(e)}`));
  }, [painter, live, plan, resolver, day]);

  useEffect(() => {
    if (!playing) return;
    let position = day >= max ? min : day;
    const timer = setInterval(() => {
      position += speed / 10;
      if (position >= max) { position = max; setPlaying(false); }
      setDay(Math.floor(position));
    }, 100);
    return () => clearInterval(timer);
    // The loop owns the position while it runs.
  }, [playing, speed, min, max]);

  const showAt = (next: number) => { setLive(true); setDay(next); };
  const toggleLive = () => {
    if (live) { setPlaying(false); void painter.clear().catch(() => undefined); }
    setLive(!live);
  };
  const update = (id: string, patch: Partial<Activity>) =>
    setPlan((p) => ({ ...p, activities: p.activities.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));

  const link = async (activity: Activity, mode: 'set' | 'add') => {
    try {
      const links = await makeLinks(viewer, models, await viewer.getSelection());
      if (!links.length) { setNotice('Markera objekt i modellen först.'); return; }
      update(activity.id, { links: mode === 'add' ? mergeLinks(activity.links, links) : links });
    } catch (e) {
      setNotice(`Kunde inte koppla objekten: ${message(e)}`);
    }
  };
  const selectObjects = async (activity: Activity) => {
    const refs = await resolver.refs(activity);
    if (refs.length) await viewer.select(refs);
    else setNotice('Aktivitetens objekt finns inte i de modeller som är laddade.');
  };
  const addActivity = () => {
    const start = toIso(plan.activities.length ? range.end + 1 : toDay(today()));
    const activity: Activity = { id: newId(), name: `Aktivitet ${plan.activities.length + 1}`, start, end: toIso(toDay(start) + 4), type: 'build', color: PALETTE[plan.activities.length % PALETTE.length], links: [] };
    setPlan((p) => ({ ...p, activities: [...p.activities, activity] }));
    setOpen(activity.id);
  };
  const exportPlan = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `4d-plan-${viewer.projectName.replace(/[^\wåäöÅÄÖ-]+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importPlan = async (file: File | undefined) => {
    if (!file) return;
    const next = parsePlan(await file.text());
    if (next) { setPlan(next); setNotice(`Planen lästes in: ${next.activities.length} aktiviteter.`); }
    else setNotice('Filen är inte en giltig 4D-plan.');
  };

  const span = Math.max(1, max - min);
  const panel = (
    <div className="panel">
      <header>
        <div>
          <h1>4D-light</h1>
          <small>{viewer.projectName}{viewer.kind === 'demo' ? ' · demoläge' : ''}</small>
        </div>
        <label className="switch" title="Färga modellen efter tidplanen">
          <input type="checkbox" checked={live} onChange={toggleLive} /> Visa i modell
        </label>
      </header>

      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Stäng">×</button></div>}
      {!models.length && <div className="notice">Ingen modell är laddad. Öppna 3D-vyn och ladda en modell.</div>}

      <section className="player">
        <div className="date-line">
          <strong>{formatDay(day)}</strong>
          <span>{stats.total ? `${Math.round((stats.done / stats.total) * 100)} % färdigt` : 'Inga kopplade objekt'}</span>
        </div>
        <input className="timeline" type="range" min={min} max={max} value={day} aria-label="Datum" onChange={(e) => { setPlaying(false); showAt(Number(e.target.value)); }} />
        <div className="controls">
          <button className="primary" disabled={!plan.activities.length} onClick={() => { setLive(true); setPlaying(!playing); }}>{playing ? 'Pausa' : 'Spela upp'}</button>
          <button onClick={() => { setPlaying(false); showAt(day - 1); }} aria-label="En dag bakåt">‹</button>
          <button onClick={() => { setPlaying(false); showAt(day + 1); }} aria-label="En dag framåt">›</button>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Hastighet">
            <option value={1}>1 dag/s</option>
            <option value={7}>1 vecka/s</option>
            <option value={30}>1 månad/s</option>
          </select>
        </div>
        <div className="active-line">{stats.active.length ? `Pågår: ${stats.active.map((a) => a.name).join(', ')}` : ' '}</div>
      </section>

      <section className="activities">
        {!plan.activities.length && (
          <div className="empty">
            <p>Skapa en tidplan direkt från modellen, till exempel en aktivitet per våning eller nedifrån och upp.</p>
            <button className="primary" disabled={!models.length} onClick={() => setDialog('generate')}>Skapa från modell</button>
          </div>
        )}
        {plan.activities.map((a) => (
          <ActivityRow key={a.id} activity={a} phase={phaseOf(a, day)} expanded={open === a.id} selected={selected}
            left={((toDay(a.start) - min) / span) * 100} width={((toDay(a.end) - toDay(a.start) + 1) / span) * 100} cursor={((day - min) / span) * 100}
            onToggle={() => setOpen(open === a.id ? null : a.id)} onChange={(patch) => update(a.id, patch)}
            onLink={(mode) => void link(a, mode)} onSelect={() => void selectObjects(a).catch((e) => setNotice(message(e)))}
            onDelete={() => setPlan((p) => ({ ...p, activities: p.activities.filter((x) => x.id !== a.id) }))} />
        ))}
      </section>

      <footer>
        <button onClick={addActivity}>+ Aktivitet</button>
        <button disabled={!models.length} onClick={() => setDialog('generate')}>Skapa från modell</button>
        <button onClick={() => setDialog('import')}>Importera datum</button>
        <button onClick={exportPlan} disabled={!plan.activities.length}>Exportera plan</button>
        <button onClick={() => fileInput.current?.click()}>Öppna plan</button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => { void importPlan(e.target.files?.[0]); e.target.value = ''; }} />
        <label className="unlinked">Objekt utan aktivitet
          <select value={plan.unlinked} onChange={(e) => setPlan((p) => ({ ...p, unlinked: e.target.value as Unlinked }))}>
            <option value="ghost">Tona ner</option>
            <option value="show">Visa</option>
            <option value="hide">Dölj</option>
          </select>
        </label>
      </footer>

      {dialog === 'generate' && (
        <GenerateDialog viewer={viewer} models={models} selected={selected} hasPlan={plan.activities.length > 0} onClose={() => setDialog(null)}
          onDone={(activities, replace) => {
            setPlan((p) => ({ ...p, activities: replace ? activities : [...p.activities, ...activities] }));
            setDialog(null);
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
    </div>
  );

  if (viewer instanceof DemoViewer) return <div className="demo-layout"><DemoScene viewer={viewer} />{panel}</div>;
  return panel;
}

function ActivityRow(props: {
  activity: Activity; phase: string; expanded: boolean; selected: number; left: number; width: number; cursor: number;
  onToggle: () => void; onChange: (patch: Partial<Activity>) => void; onLink: (mode: 'set' | 'add') => void; onSelect: () => void; onDelete: () => void;
}) {
  const { activity: a, expanded, selected, onChange } = props;
  const objects = linkCount(a);
  return (
    <article className={`activity ${props.phase}`}>
      <button className="row" onClick={props.onToggle} aria-expanded={expanded}>
        <span className="dot" style={{ background: a.color }} />
        <span className="name">{a.name}</span>
        <span className="meta">{objects} obj</span>
        <span className="bar-track">
          <span className="bar" style={{ left: `${props.left}%`, width: `${props.width}%`, background: a.color }} />
          <span className="cursor" style={{ left: `${props.cursor}%` }} />
        </span>
      </button>
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
          <label>Färg<input type="color" value={a.color} onChange={(e) => onChange({ color: e.target.value })} /></label>
          <div className="wide buttons">
            <button disabled={!selected} onClick={() => props.onLink('set')}>Koppla markerade ({selected})</button>
            <button disabled={!selected || !objects} onClick={() => props.onLink('add')}>Lägg till markerade</button>
            <button disabled={!objects} onClick={props.onSelect}>Markera i modell</button>
            <button className="danger" onClick={props.onDelete}>Ta bort</button>
          </div>
        </div>
      )}
    </article>
  );
}

const HEIGHT = '__height';

function GenerateDialog(props: {
  viewer: ViewerPort; models: ModelInfo[]; selected: number; hasPlan: boolean;
  onClose: () => void; onDone: (activities: Activity[], replace: boolean) => void;
}) {
  const { viewer } = props;
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [refs, setRefs] = useState<ObjRef[] | null>(null);
  const [index, setIndex] = useState<PropertyIndex | null>(null);
  const [scan, setScan] = useState(0);
  const [key, setKey] = useState(HEIGHT);
  const [steps, setSteps] = useState(5);
  const [start, setStart] = useState(today());
  const [days, setDays] = useState(5);
  const [replace, setReplace] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setRefs(null); setIndex(null); setScan(0); setKey(HEIGHT); setError('');
    (async () => {
      const found = (scope === 'all' ? await viewer.getAllObjects() : await viewer.getSelection()).filter((r) => r.ids.length);
      if (cancelled) return;
      setRefs(found);
      if (!found.length) return;
      const result = await scanProperties(viewer, found, (done, total) => !cancelled && setScan(done / total), () => cancelled);
      if (cancelled) return;
      setIndex(result);
      const first = sortedKeys(result)[0];
      if (first && first !== CLASS_KEY) setKey((k) => (k === HEIGHT ? first : k));
    })().catch((e) => !cancelled && setError(message(e)));
    return () => { cancelled = true; };
  }, [viewer, scope]);

  const keys = useMemo(() => (index ? sortedKeys(index) : []), [index]);
  const total = refs ? count(refs) : 0;
  const amount = key === HEIGHT ? steps : index?.get(key)?.size ?? 0;

  const create = async () => {
    if (!refs) return;
    setWorking(true); setError('');
    try {
      const groups = key === HEIGHT ? await groupsByHeight(viewer, refs, steps, () => undefined, () => false) : groupsFromProperty(index!, key);
      if (!groups.length) throw new Error('Inga objekt att skapa aktiviteter av.');
      props.onDone(await activitiesFromGroups(viewer, props.models, groups, start, days, 0), replace);
    } catch (e) {
      setError(message(e));
      setWorking(false);
    }
  };

  return (
    <Dialog title="Skapa från modell" onClose={props.onClose}>
      <label>Objekt
        <select value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'selected')}>
          <option value="all">Alla laddade modeller</option>
          <option value="selected">Endast markerade ({props.selected})</option>
        </select>
      </label>
      <label>En aktivitet per
        <select value={key} onChange={(e) => setKey(e.target.value)}>
          <option value={HEIGHT}>Höjdnivå – nedifrån och upp</option>
          {keys.map((k) => <option key={k} value={k}>{k} ({index!.get(k)!.size})</option>)}
        </select>
      </label>
      <p className="hint">
        {!refs ? 'Hämtar objekt…' : !total ? 'Inga objekt hittades.' : index ? `${total} objekt, ${keys.length} egenskaper att dela upp på.` : `Läser egenskaper… ${Math.round(scan * 100)} %`}
      </p>
      {key === HEIGHT && <label>Antal etapper<input type="number" min={2} max={50} value={steps} onChange={(e) => setSteps(Math.min(50, Math.max(2, Number(e.target.value) || 2)))} /></label>}
      <div className="pair">
        <label>Startdatum<input type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} /></label>
        <label>Dagar per aktivitet<input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.min(365, Math.max(1, Number(e.target.value) || 1)))} /></label>
      </div>
      {props.hasPlan && <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Ersätt befintliga aktiviteter</label>}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={props.onClose}>Avbryt</button>
        <button className="primary" disabled={!total || !amount || working} onClick={() => void create()}>
          {working ? 'Skapar…' : key === HEIGHT ? `Skapa upp till ${amount} aktiviteter` : `Skapa ${amount} aktiviteter`}
        </button>
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <Dialog title="Importera datum" onClose={onClose}>
      <p className="hint">En rad per aktivitet: namn, start, slut. Klistra in från Excel eller välj en CSV-fil. Aktiviteter med samma namn får nya datum, övriga läggs till.</p>
      <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Plan 1;2026-01-12;2026-01-23\nPlan 2;2026-01-26;2026-02-06'} />
      <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => void e.target.files?.[0]?.text().then(setText)} />
      <div className="dialog-actions">
        <button onClick={onClose}>Avbryt</button>
        <button className="primary" disabled={!text.trim()} onClick={() => onImport(text)}>Importera</button>
      </div>
    </Dialog>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  );
}
