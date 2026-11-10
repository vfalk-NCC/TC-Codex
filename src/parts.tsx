import { useEffect, useMemo, useState } from 'react';
import type { ModelInfo, ObjRef, ViewerPort } from './viewer';
import {
  CLASS_KEY, activitiesFromGroups, findMatching, groupsByHeight, groupsFromProperty, makeLinks, newId, scanProperties, sortedKeys, today, traitsOf,
  type Activity, type Area, type Mask, type Plan, type PropertyIndex, type Trait, type Unlinked,
} from './schedule';

export const count = (refs: ObjRef[]) => refs.reduce((n, r) => n + r.ids.length, 0);
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const ICONS: Record<string, string> = {
  play: 'M7 4l13 8-13 8z', pause: 'M8 4v16M16 4v16', left: 'M15 5l-7 7 7 7', right: 'M9 5l7 7-7 7',
  skipBack: 'M19 5l-9 7 9 7zM6 5v14', skipForward: 'M5 5l9 7-9 7zM18 5v14', plus: 'M12 5v14M5 12h14',
  pencil: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3', x: 'M6 6l12 12M18 6L6 18',
  undo: 'M8 5L3 10l5 5M3 10h11a6 6 0 010 12h-3', redo: 'M16 5l5 5-5 5M21 10H10a6 6 0 000 12h3',
  more: 'M5 12h.01M12 12h.01M19 12h.01', search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeOff: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM4 4l16 16',
  target: 'M12 2v5M12 17v5M2 12h5M17 12h5M12 8a4 4 0 100 8 4 4 0 000-8z', copy: 'M9 9h11v11H9zM5 15V4h11',
  down: 'M6 9l6 6 6-6', grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01', layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  const dots = name === 'more' || name === 'grip';
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill={name === 'play' ? 'currentColor' : 'none'} stroke="currentColor"
      strokeWidth={dots ? 3 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-label={title}>
        <header><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label="Stäng"><Icon name="x" /></button></header>
        {children}
      </section>
    </div>
  );
}

const HEIGHT = '__height';

export function GenerateDialog(props: {
  viewer: ViewerPort; models: ModelInfo[]; selected: number; hasPlan: boolean; areas: Area[];
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
  const [areaId, setAreaId] = useState('');
  const [replace, setReplace] = useState(false);
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
      const activities = await activitiesFromGroups(viewer, props.models, groups, start, days, 0);
      props.onDone(activities.map((a) => ({ ...a, areaId: areaId || undefined })), replace);
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
      {!index && !!total && <div className="progress"><i style={{ width: `${scan * 100}%` }} /></div>}
      {key === HEIGHT && <label>Antal etapper<input type="number" min={2} max={50} value={steps} onChange={(e) => setSteps(Math.min(50, Math.max(2, Number(e.target.value) || 2)))} /></label>}
      <div className="pair">
        <label>Startdatum<input type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} /></label>
        <label>Dagar per aktivitet<input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.min(365, Math.max(1, Number(e.target.value) || 1)))} /></label>
      </div>
      {props.areas.length > 0 && (
        <label>Lägg i område
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">Utan område</option>
            {props.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
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

export function ImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <Dialog title="Importera datum" onClose={onClose}>
      <p className="hint">En rad per aktivitet: namn, start, slut och valfritt område. Klistra in från Excel eller välj en CSV-fil. Aktiviteter med samma namn får nya datum, övriga läggs till.</p>
      <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Grovgjutning E16;2026-01-12;2026-01-23;745 - Fläkthus'} />
      <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => void e.target.files?.[0]?.text().then(setText)} />
      <div className="dialog-actions">
        <button onClick={onClose}>Avbryt</button>
        <button className="primary" disabled={!text.trim()} onClick={() => onImport(text)}>Importera</button>
      </div>
    </Dialog>
  );
}

/** Finds every object that shares a property with the selection and turns them into a mask. */
export function MaskDialog(props: { viewer: ViewerPort; models: ModelInfo[]; onClose: () => void; onDone: (mask: Mask) => void }) {
  const { viewer } = props;
  const [traits, setTraits] = useState<Trait[] | null>(null);
  const [pick, setPick] = useState(0);
  const [mode, setMode] = useState<'hide' | 'ghost'>('hide');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [cancel] = useState({ now: false });

  useEffect(() => {
    viewer.getSelection().then((s) => traitsOf(viewer, s)).then(setTraits, (e) => setError(message(e)));
    return () => { cancel.now = true; };
  }, [viewer, cancel]);

  const run = async () => {
    const trait = traits![pick];
    setProgress(0); setError('');
    try {
      const found = await findMatching(viewer, await viewer.getAllObjects(), trait, (done, total) => setProgress(done / total), () => cancel.now);
      if (cancel.now) return;
      if (!found.length) throw new Error('Inga objekt matchade.');
      props.onDone({ id: newId(), name: trait.value, mode, on: true, links: await makeLinks(viewer, props.models, found) });
    } catch (e) {
      setError(message(e));
      setProgress(null);
    }
  };

  return (
    <Dialog title="Släck liknande objekt" onClose={props.onClose}>
      <p className="hint">Markera ett objekt som är i vägen, till exempel ett bjälklag eller en Paroc-vägg. Alla objekt i modellen med samma egenskap släcks.</p>
      {!traits && !error && <p className="hint">Läser det markerade objektet…</p>}
      {traits && !traits.length && <p className="error">Markera minst ett objekt i modellen först. Om flera är markerade måste de ha något gemensamt.</p>}
      {traits && traits.length > 0 && <>
        <label>Släck alla objekt där
          <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
            {traits.map((t, i) => <option key={i} value={i}>{t.key} = {t.value}</option>)}
          </select>
        </label>
        <label>Visa som
          <select value={mode} onChange={(e) => setMode(e.target.value as 'hide' | 'ghost')}>
            <option value="hide">Dolda</option>
            <option value="ghost">Genomskinliga</option>
          </select>
        </label>
      </>}
      {progress !== null && <><p className="hint">Söker i modellen… {Math.round(progress * 100)} %</p><div className="progress"><i style={{ width: `${progress * 100}%` }} /></div></>}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={props.onClose}>Avbryt</button>
        <button className="primary" disabled={!traits?.length || progress !== null} onClick={() => void run()}>Släck</button>
      </div>
    </Dialog>
  );
}

export function ToolsDialog(props: {
  plan: Plan; onClose: () => void; onPlan: (update: (p: Plan) => Plan) => void; onShift: (days: number, areaId: string | null | undefined) => void;
  onImportDates: () => void; onExportCsv: () => void; onExportPlan: () => void; onOpenPlan: () => void; onSelectUnlinked: () => void; onClear: () => void;
}) {
  const { plan } = props;
  const [days, setDays] = useState(7);
  const [scope, setScope] = useState('*');
  return (
    <Dialog title="Verktyg" onClose={props.onClose}>
      <h3>Visning</h3>
      <div className="pair">
        <label>Objekt utan aktivitet
          <select value={plan.unlinked} onChange={(e) => props.onPlan((p) => ({ ...p, unlinked: e.target.value as Unlinked }))}>
            <option value="ghost">Tona ner</option>
            <option value="show">Visa</option>
            <option value="hide">Dölj</option>
          </select>
        </label>
        <label>Färg under arbete
          <select value={plan.colorBy} onChange={(e) => props.onPlan((p) => ({ ...p, colorBy: e.target.value === 'type' ? 'type' : 'activity' }))}>
            <option value="activity">Aktivitetens färg</option>
            <option value="type">Bygg grön, riv röd, tillfällig gul</option>
          </select>
        </label>
      </div>

      <h3>Förskjut datum</h3>
      <div className="shift">
        <input type="number" value={days} aria-label="Antal dagar" onChange={(e) => setDays(Math.round(Number(e.target.value)) || 0)} />
        <span>dagar för</span>
        <select value={scope} aria-label="Omfattning" onChange={(e) => setScope(e.target.value)}>
          <option value="*">hela planen</option>
          {plan.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          {plan.areas.length > 0 && <option value="">Utan område</option>}
        </select>
        <button disabled={!days || !plan.activities.length} onClick={() => props.onShift(days, scope === '*' ? undefined : scope || null)}>Förskjut</button>
      </div>
      <p className="hint">Negativt tal flyttar bakåt i tiden.</p>

      <h3>Modell</h3>
      <button onClick={props.onSelectUnlinked}>Markera objekt utan aktivitet</button>

      <h3>Import och export</h3>
      <div className="grid-buttons">
        <button onClick={props.onImportDates}>Importera datum</button>
        <button disabled={!plan.activities.length} onClick={props.onExportCsv}>Exportera till Excel (CSV)</button>
        <button onClick={props.onOpenPlan}>Öppna plan</button>
        <button disabled={!plan.activities.length} onClick={props.onExportPlan}>Spara plan som fil</button>
      </div>

      <h3>Rensa</h3>
      <button className="danger" disabled={!plan.activities.length && !plan.areas.length && !plan.masks.length} onClick={props.onClear}>Töm hela planen</button>
    </Dialog>
  );
}
