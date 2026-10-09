import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, Box, Check, ChevronDown, ChevronRight,
  CircleHelp, Cloud, Command, Cuboid, FileBox, FileImage, FilePlus2, Folder,
  FolderOpen, Grid2X2, HardDrive, Layers3, Link2, ListFilter, Maximize2,
  MoreHorizontal, MousePointer2, PanelLeftClose, PanelRightClose, Plus, Search,
  Settings2, Share2, SlidersHorizontal, Sparkles, Upload, X,
} from 'lucide-react';
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { Renderer } from '@ifc-lite/renderer';
import { createDecodeWorkerSource, LazStreamingSource } from '@ifc-lite/pointcloud';
import { ConnectFiles, isConnectFolder, isSupportedConnectModel, type ConnectEntry } from './connect';
import type { FolderEntry } from 'trimble-connect-sdk';
import DxfParser from 'dxf-parser';
import * as WorkspaceAPI from 'trimble-connect-workspace-api';

type LocalModel = { name: string; size: string; kind: 'IFC' | 'DXF' | 'Punktmoln'; entities?: number; file?: File };

const starterModels: LocalModel[] = [
  { name: 'Exempelmodell.ifc', size: '84,2 MB', kind: 'IFC', entities: 18462 },
  { name: 'Exempelritning.dxf', size: '12,8 MB', kind: 'DXF', entities: 324 },
  { name: 'Exempelscan.laz', size: '1,24 GB', kind: 'Punktmoln' },
];

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function fileKind(file: File): LocalModel['kind'] | null {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'ifc') return 'IFC';
  if (ext === 'dxf') return 'DXF';
  if (['las', 'laz', 'ply', 'e57', 'copc', 'pcd', 'pts', 'xyz'].includes(ext || '')) return 'Punktmoln';
  return null;
}

function Drawing({ active, onFit }: { active: LocalModel | null; onFit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [status, setStatus] = useState('Väntar på modell');

  useEffect(() => {
    if (!active?.file || active.kind !== 'DXF' || !canvasRef.current) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    const parse = async () => {
      setStatus('Läser ritning…');
      try {
        const parser = new DxfParser();
        const doc = parser.parseSync(await active.file!.text());
        if (cancelled) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#121612';
        ctx.fillRect(0, 0, rect.width, rect.height);
        const entities = doc?.entities || [];
        const points: Array<[number, number]> = [];
        entities.forEach((entity: any) => {
          (entity.vertices || []).forEach((p: any) => points.push([p.x, p.y]));
          if (entity.center) points.push([entity.center.x - entity.radius, entity.center.y - entity.radius], [entity.center.x + entity.radius, entity.center.y + entity.radius]);
        });
        if (!points.length) throw new Error('Ritningen saknar stödda linjeobjekt.');
        const minX = Math.min(...points.map((p) => p[0]));
        const maxX = Math.max(...points.map((p) => p[0]));
        const minY = Math.min(...points.map((p) => p[1]));
        const maxY = Math.max(...points.map((p) => p[1]));
        const scale = Math.min((rect.width - 100) / Math.max(1, maxX - minX), (rect.height - 100) / Math.max(1, maxY - minY));
        const project = (x: number, y: number) => [50 + (x - minX) * scale, rect.height - 50 - (y - minY) * scale] as const;
        ctx.lineWidth = 1.15;
        ctx.strokeStyle = '#d8e6c0';
        entities.forEach((entity: any) => {
          if (entity.type === 'LINE' && entity.vertices?.length >= 2) {
            const [a, b] = entity.vertices;
            const p = project(a.x, a.y); const q = project(b.x, b.y);
            ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.stroke();
          } else if (entity.type === 'LWPOLYLINE' && entity.vertices?.length >= 2) {
            const first = project(entity.vertices[0].x, entity.vertices[0].y);
            ctx.beginPath(); ctx.moveTo(...first);
            entity.vertices.slice(1).forEach((v: any) => { const p = project(v.x, v.y); ctx.lineTo(...p); });
            if (entity.shape) ctx.closePath(); ctx.stroke();
          } else if (entity.type === 'CIRCLE' && entity.center) {
            const p = project(entity.center.x, entity.center.y);
            ctx.beginPath(); ctx.arc(p[0], p[1], entity.radius * scale, 0, Math.PI * 2); ctx.stroke();
          }
        });
        setDrawn(true); setStatus(`${entities.length.toLocaleString('sv-SE')} objekt · DXF`);
      } catch (error) {
        setDrawn(false); setStatus(error instanceof Error ? error.message : 'Kunde inte läsa DXF-filen.');
      }
    };
    void parse();
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => { if (!active || active.kind === 'DXF') return; setDrawn(false); setStatus(active.kind === 'IFC' ? 'IFC-modell laddas i 3D-vyn' : 'Punktmoln · förhandsvisning'); }, [active]);

  return <div className={`viewport-stage ${active?.kind === 'DXF' && drawn ? 'drawing-mode' : ''}`}>
    <div className="viewport-grid" />
    <canvas ref={canvasRef} className="drawing-canvas" aria-label="DXF-ritning" />
    {(!active || (active.kind === 'IFC' && !active.file) || (active.kind === 'Punktmoln' && !active.file)) && <svg className="model-art" viewBox="0 0 900 600" role="img" aria-label="Modellförhandsvisning">
      <defs><linearGradient id="facade" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#d9e2ca"/><stop offset="1" stopColor="#929d8c"/></linearGradient><linearGradient id="roof" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#777f71"/><stop offset="1" stopColor="#4c554c"/></linearGradient></defs>
      <ellipse cx="454" cy="496" rx="330" ry="53" fill="#0a0d0b" opacity=".42"/>
      <path d="M180 270 487 132 732 218 425 355Z" fill="url(#roof)" stroke="#edf2db" strokeOpacity=".34"/>
      <path d="M180 270 425 355 425 472 180 386Z" fill="#52655c" stroke="#d5dec9" strokeOpacity=".52"/>
      <path d="M425 355 732 218 732 334 425 472Z" fill="url(#facade)" stroke="#f3f5e9" strokeOpacity=".66"/>
      <path d="M218 267 270 244 270 414 218 396ZM295 234 350 210 350 441 295 422ZM489 350 541 327 541 419 489 443ZM568 315 622 290 622 385 568 408ZM649 279 698 257 698 352 649 375Z" fill="#1d3030" stroke="#adbaa7" strokeWidth="2" opacity=".92"/>
      <path d="M425 355 732 218M180 270 487 132M425 355V472M180 270V386M732 218V334" stroke="#f1f5e8" strokeOpacity=".3"/>
      <path d="M162 487h551M199 505h450" stroke="#d6f36a" strokeOpacity=".24" strokeDasharray="5 7"/>
      <path d="m172 484 62-26m-30 42 62-26m474-242 42-19m-40 87 42-19" stroke="#d6f36a" strokeWidth="1.2" opacity=".58"/>
    </svg>}
    {!drawn && <div className="stage-watermark"><span className="watermark-icon"><Cuboid size={20} /></span><span>{active?.name || 'Modellvy'}</span><i />{status}</div>}
    <button className="fit-button" aria-label="Anpassa vy" onClick={onFit}><Maximize2 size={15} /></button>
    <div className="axis-widget"><span>Z</span><div /><span>X</span></div>
  </div>;
}

export default function App() {
  const [route, setRoute] = useState(location.hash === '#/editor' ? 'editor' : location.hash === '#/trimble' ? 'trimble' : 'home');
  const [models, setModels] = useState<LocalModel[]>(starterModels);
  const [active, setActive] = useState<LocalModel | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showProperties, setShowProperties] = useState(true);
  const [activeTab, setActiveTab] = useState<'modell' | 'projekt'>('modell');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [entityTotal, setEntityTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectProject, setConnectProject] = useState<{ id?: string; name?: string; region?: string } | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const parserRef = useRef<IfcParser | null>(null);
  const geometryRef = useRef<GeometryProcessor | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const animationRef = useRef<number | null>(null);
  const pointCloudGeneration = useRef(0);

  const enterEditor = useCallback(() => { location.hash = '/editor'; setRoute('editor'); }, []);
  const goHome = useCallback(() => { location.hash = ''; setRoute('home'); }, []);
  useEffect(() => { const pop = () => setRoute(location.hash === '#/editor' ? 'editor' : location.hash === '#/trimble' ? 'trimble' : 'home'); window.addEventListener('hashchange', pop); return () => window.removeEventListener('hashchange', pop); }, []);

  useEffect(() => {
    if (route !== 'editor' || !window.opener) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.opener || event.data?.type !== 'tc-codex:session') return;
      setConnectProject(event.data.project ?? null);
      setConnectToken(typeof event.data.accessToken === 'string' ? event.data.accessToken : null);
      if (typeof event.data.accessToken === 'string') setNotice('Trimble Connect-session ansluten.');
    };
    window.addEventListener('message', receive);
    window.opener.postMessage({ type: 'tc-codex:editor-ready' }, window.location.origin);
    return () => window.removeEventListener('message', receive);
  }, [route]);

  const initializeIfc = useCallback(async (canvas: HTMLCanvasElement) => {
    if (rendererRef.current) return;
    const renderer = new Renderer(canvas);
    const geometry = new GeometryProcessor();
    await Promise.all([renderer.init(), geometry.init()]);
    rendererRef.current = renderer; geometryRef.current = geometry; parserRef.current = new IfcParser();
    const loop = () => { renderer.render(); animationRef.current = requestAnimationFrame(loop); };
    loop();
  }, []);

  useEffect(() => {
    if (route !== 'editor' || !canvasRef.current || !active?.file || active.kind !== 'IFC') return;
    let cancelled = false;
    const load = async () => {
      setBusy(true); setNotice('Startar IFC-motorn…');
      try {
        await initializeIfc(canvasRef.current!);
        if (cancelled) return;
        const buffer = await active.file!.arrayBuffer();
        const store = await parserRef.current!.parseColumnar(buffer, { onProgress: ({ phase, percent }) => setNotice(`${phase} · ${Math.round(percent)}%`) });
        if (cancelled) return;
        const result = await geometryRef.current!.process(new Uint8Array(buffer));
        if (cancelled) return;
        rendererRef.current!.loadGeometry(result); rendererRef.current!.fitToView();
        setEntityTotal(store.entityCount); setNotice(`${store.entityCount.toLocaleString('sv-SE')} IFC-entiteter inlästa`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'IFC kunde inte öppnas. Kontrollera WebGPU-stöd.');
      } finally { if (!cancelled) setBusy(false); }
    };
    void load();
    return () => { cancelled = true; };
  }, [route, active, initializeIfc]);

  useEffect(() => {
    if (route !== 'editor' || !canvasRef.current || !active?.file || active.kind !== 'Punktmoln') return;
    const generation = ++pointCloudGeneration.current;
    let cancelled = false;
    const load = async () => {
      setBusy(true);
      setEntityTotal(null);
      setNotice('Startar punktmolnsmotorn…');
      let source: ReturnType<typeof createDecodeWorkerSource> | null = null;
      try {
        await initializeIfc(canvasRef.current!);
        if (cancelled) return;
        rendererRef.current!.clearPointClouds();
        const ext = active.file!.name.split('.').pop()?.toLowerCase();
        const format = (ext === 'copc' ? 'laz' : ext) as 'las' | 'laz' | 'ply' | 'e57' | 'pcd' | 'pts' | 'xyz';
        const stride = active.file!.size > 2 * 1024 ** 3 ? 12 : active.file!.size > 800 * 1024 ** 2 ? 5 : active.file!.size > 250 * 1024 ** 2 ? 2 : 1;
        // LAZ loads its WASM module relative to the package URL; decode it in a
        // module context so the asset URL remains resolvable on GitHub Pages.
        source = format === 'laz'
          ? new LazStreamingSource(active.file!, { label: active.name, downsample: { stride } })
          : createDecodeWorkerSource({ format, blob: active.file!, label: active.name, stride });
        const controller = new AbortController();
        const info = await source.open(controller.signal);
        if (cancelled) { source.close(); return; }
        const handle = rendererRef.current!.beginPointCloudStream({ expressId: generation, ifcType: 'IfcBuildingElementProxy' });
        let loaded = 0;
        while (!cancelled) {
          const chunk = await source.next(120_000, controller.signal);
          if (!chunk) break;
          rendererRef.current!.appendPointCloudChunk(handle, chunk);
          loaded += chunk.pointCount;
          setNotice(`Läser punktmoln · ${loaded.toLocaleString('sv-SE')} punkter`);
        }
        if (cancelled) { rendererRef.current!.removePointCloudAsset(handle); return; }
        rendererRef.current!.endPointCloudStream(handle);
        rendererRef.current!.fitToView();
        setEntityTotal(loaded);
        setNotice(`${loaded.toLocaleString('sv-SE')} punkter inlästa${info.totalPointCount > loaded ? ` · glesning ${stride}×` : ''}`);
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? `Punktmolnet kunde inte läsas: ${error.message}` : 'Punktmolnet kunde inte läsas.');
      } finally {
        source?.close();
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [route, active, initializeIfc]);

  useEffect(() => () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); }, []);

  const visibleModels = useMemo(() => models.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())), [models, query]);

  const acceptFile = (file: File) => {
    const kind = fileKind(file);
    if (!kind) { setNotice('Välj en IFC-, DXF-, LAS-, LAZ-, PLY-, E57- eller COPC-fil.'); return; }
    const item: LocalModel = { name: file.name, size: formatBytes(file.size), kind, file };
    setModels((current) => [item, ...current.filter((m) => m.name !== item.name)]);
    setActive(item); setShowImport(false); setRoute('editor'); location.hash = '/editor';
    if (kind === 'Punktmoln') setNotice('Punktmolnsfilen har lagts till.');
  };

  const openModel = (model: LocalModel) => {
    setActive(model); setEntityTotal(model.entities ?? null); setShowFiles(false); setRoute('editor');
    location.hash = '/editor';
    if (model.kind === 'Punktmoln' && !model.file) setNotice('Välj en lokal punktmolnsfil för att börja.');
    if (model.kind === 'IFC' && !model.file) setNotice('Exempelfilen finns i modellistan. Importera en lokal IFC för att visa geometrin.');
    if (model.kind === 'DXF' && !model.file) setNotice('Importera en lokal DXF-fil för att visa ritningsgeometrin.');
  };

  const exportModel = () => {
    if (!active?.file) { setNotice('Öppna en lokal modell för att exportera eller synka den till projektet.'); return; }
    const url = URL.createObjectURL(active.file); const a = document.createElement('a'); a.href = url; a.download = active.name; a.click(); URL.revokeObjectURL(url);
    setNotice(`${active.name} hämtas till din enhet.`);
  };

  const renderFrame = (canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr); ctx.fillStyle = '#121612'; ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.strokeStyle = 'rgba(214,243,106,.18)'; ctx.lineWidth = 1;
    for (let x = rect.width / 2 % 24; x < rect.width; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke(); }
    for (let y = rect.height / 2 % 24; y < rect.height; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke(); }
    ctx.strokeStyle = '#d8e6c0'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(rect.width * .24, rect.height * .38); ctx.lineTo(rect.width * .68, rect.height * .38); ctx.lineTo(rect.width * .68, rect.height * .68); ctx.lineTo(rect.width * .24, rect.height * .68); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rect.width * .24, rect.height * .38); ctx.lineTo(rect.width * .42, rect.height * .22); ctx.lineTo(rect.width * .86, rect.height * .22); ctx.lineTo(rect.width * .68, rect.height * .38); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rect.width * .68, rect.height * .38); ctx.lineTo(rect.width * .86, rect.height * .22); ctx.lineTo(rect.width * .86, rect.height * .52); ctx.lineTo(rect.width * .68, rect.height * .68); ctx.stroke();
    ctx.fillStyle = 'rgba(214,243,106,.1)'; ctx.fillRect(rect.width * .24, rect.height * .38, rect.width * .44, rect.height * .3);
  };

  if (route === 'trimble') return <TrimbleLauncher onOpenLocal={() => inputRef.current?.click()} />;

  if (route === 'home') return <div className="launch-shell">
    <header className="launch-top"><a className="brand" href="/" onClick={(e) => { e.preventDefault(); goHome(); }}><span className="brand-mark">T<span /></span><span className="brand-name">TC <b>Codex</b></span></a><span className="top-divider" /><span className="eyebrow">MODELLSTUDIO</span><div className="top-spacer" /><button className="subtle-button" onClick={() => setShowConnect(true)}><Link2 size={15} /> Trimble Connect <span className="connect-indicator" /></button><button className="avatar">VF</button></header>
      <main className="launch-main"><div className="launch-copy"><span className="kicker"><Sparkles size={14} /> EN NY ARBETSPLATS FÖR DINA MODELLER</span><h1>Från projekt<br />till <em>modellstudio.</em></h1><p>Öppna modeller och ritningar i en rymlig 3D-miljö. Läs in IFC, DXF och punktmoln direkt från din enhet.</p><div className="launch-actions"><button className="primary-button" onClick={enterEditor}>Öppna 3D-editorn <ArrowRight size={17} /></button><button className="secondary-button" onClick={() => setShowConnect(true)}><FolderOpen size={16} /> Bläddra i Connect</button></div><div className="feature-line"><span><Check size={13} /> IFC</span><span><Check size={13} /> DXF</span><span><Check size={13} /> Punktmoln</span></div></div>
      <div className="launch-visual"><div className="visual-top"><span className="live-dot" /> MODELLSTUDIO <span className="visual-project">EXEMPEL · IFC + DXF</span></div><div className="launch-blueprint"><div className="blueprint-grid"/><svg viewBox="0 0 540 330"><path d="m84 174 196-96 170 61-198 98z" fill="#27312a" stroke="#d6f36a" strokeWidth="1.2"/><path d="m84 174 168 63v69L84 242z" fill="#202c27" stroke="#738176"/><path d="m252 237 198-98v69l-198 98z" fill="#45554d" stroke="#c6d1bb"/><path d="m112 173 49-24v75l-49-19zm74-35 47-23v88l-47-18zm108 94 42-21v58l-42 21zm70-35 42-20v58l-42 20z" fill="#182220" stroke="#a4b39f"/><path d="m84 255 168 64 198-98" fill="none" stroke="#d6f36a" strokeDasharray="4 5" opacity=".6"/><circle cx="444" cy="95" r="3" fill="#ff875d"/><path d="M444 95v35" stroke="#ff875d" strokeDasharray="2 3"/></svg><div className="floating-label label-ifc"><Cuboid size={14}/> Exempelmodell <b>IFC</b></div><div className="floating-label label-dxf"><FileImage size={14}/> Exempelritning <b>DXF</b></div><div className="visual-scale">X&nbsp; 4 320&nbsp; Y&nbsp; 1 820&nbsp; Z&nbsp; 1 260 <span>mm</span></div></div><div className="visual-bottom"><span>ARBETSFLÖDE</span><span className="workflow">Connect <ArrowRight size={13}/> Studio <ArrowRight size={13}/> Tillbaka till projektet</span></div></div>
      <div className="launch-lower"><div><span className="section-kicker">EXEMPEL I ARBETSFLÖDET</span><div className="recent-row"><span className="file-chip ifc-chip">IFC</span><div><b>Exempelmodell.ifc</b><span>Förhandsvisning · 18 462 objekt</span></div><button onClick={() => openModel(starterModels[0])}>Öppna <ArrowRight size={14}/></button></div></div><div className="open-files-card"><span className="file-plus"><FilePlus2 size={19}/></span><span><b>Börja med en lokal fil</b><small>IFC · DXF · punktmoln</small></span><button onClick={() => inputRef.current?.click()}><Plus size={16}/></button></div></div>
    </main><footer className="launch-footer"><span>TC CODEX <span className="footer-sep">/</span> EXTERN MODELLSTUDIO</span><span>Utvecklas för projektarbete i Trimble Connect</span><button onClick={() => setShowConnect(true)}><CircleHelp size={14}/> Om kopplingen</button></footer>
    <input ref={inputRef} hidden type="file" accept=".ifc,.dxf,.las,.laz,.ply,.e57,.copc,.pcd,.pts,.xyz" onChange={(e) => e.target.files?.[0] && acceptFile(e.target.files[0])}/>
    {showConnect && <ConnectDialog close={() => setShowConnect(false)} />}{showImport && <ImportDialog close={() => setShowImport(false)} pickFile={() => inputRef.current?.click()} />}
  </div>;

  return <div className="studio-shell">
    <header className="studio-top"><button className="brand compact" onClick={goHome}><span className="brand-mark">T<span /></span><span className="brand-name">TC <b>Codex</b></span></button><span className="top-divider"/><button className="project-select" onClick={() => setShowFiles(true)}><span className="project-glyph">N</span><span><b>{connectProject?.name || 'NSV · DP1, DP2 & DP3'}</b><small>{connectToken ? 'Trimble Connect-session aktiv' : 'Trimble Connect-projekt'}</small></span><ChevronDown size={14}/></button><div className="top-spacer"/><span className="save-state"><span className="live-dot"/> {active?.file ? 'Sparad lokalt' : 'Ingen ändringar'}</span><button className="icon-button" title="Dela" onClick={() => setNotice('Delning aktiveras när en Trimble Connect-session är ansluten.')}><Share2 size={16}/></button><button className="avatar">VF</button></header>
    <nav className="studio-tools"><div className="tool-group"><button className="tool-button" onClick={goHome}><ArrowLeft size={16}/><span>Tillbaka</span></button><span className="tool-separator"/><button className="tool-button selected"><MousePointer2 size={16}/><span>Markera</span></button><button className="tool-button" onClick={() => setNotice('Mätverktyget läggs till efter filkopplingen.')}><SlidersHorizontal size={16}/><span>Mät</span></button><button className="tool-button" onClick={() => setNotice('Snittverktyget kommer i nästa arbetssteg.')}><Layers3 size={16}/><span>Snitt</span></button></div><div className="tool-group"><button className="tool-button" onClick={() => setShowProperties((s) => !s)}><PanelRightClose size={16}/><span>Egenskaper</span></button><span className="tool-separator"/><button className="tool-button" onClick={() => active?.file ? setShowFiles(true) : setShowImport(true)}><Upload size={16}/><span>Spara till Connect</span></button><button className="tool-button more" onClick={() => setNotice('Fler verktyg kommer snart.')}><MoreHorizontal size={17}/></button></div></nav>
    <div className="studio-layout">
      <aside className="left-rail"><button className="rail-active" title="Modeller"><Box size={17}/></button><button title="Trimble Connect-filer" onClick={() => setShowFiles(true)}><Folder size={17}/></button><button title="Lager" onClick={() => setNotice('Lager kopplas till modellen när IFC-filen är inläst.')}><Layers3 size={17}/></button><div className="rail-bottom"><button title="Inställningar" onClick={() => setNotice('Inställningar kommer snart.')}><Settings2 size={17}/></button><button title="Hjälp"><CircleHelp size={17}/></button></div></aside>
      <aside className="model-panel"><div className="panel-heading"><div><span className="panel-eyebrow">ARBETSPLATS</span><h2>Modellfiler</h2></div><button className="mini-icon" title="Lägg till fil" onClick={() => inputRef.current?.click()}><Plus size={16}/></button></div><button className="connect-folder" onClick={() => setShowFiles(true)}><span className="folder-square"><Cloud size={16}/></span><span><b>Trimble Connect</b><small>{connectProject?.name || 'NSV · DP1, DP2 & DP3'}</small></span><ChevronRight size={15}/></button><div className="search-box"><Search size={14}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Sök modell eller ritning"/><kbd>⌘ K</kbd></div><div className="list-heading"><span>ARBETSFILER <b>{visibleModels.length}</b></span><button onClick={() => setShowConnect(true)}><ListFilter size={14}/></button></div><div className="model-list">{visibleModels.map((model, i) => <button key={model.name} onClick={() => openModel(model)} className={`model-row ${active?.name === model.name ? 'model-active' : ''}`}><span className={`file-chip ${model.kind === 'IFC' ? 'ifc-chip' : model.kind === 'DXF' ? 'dxf-chip' : 'cloud-chip'}`}>{model.kind === 'Punktmoln' ? 'LAS' : model.kind}</span><span className="model-info"><b>{model.name}</b><small>{model.size} <i>·</i> {model.entities ? `${model.entities.toLocaleString('sv-SE')} objekt` : 'Connect-fil'}</small></span><span className="row-more"><MoreHorizontal size={15}/></span></button>)}</div><button className="add-model-button" onClick={() => inputRef.current?.click()}><Plus size={15}/> Lägg till lokal fil</button><div className="panel-footer"><span className="storage-icon"><HardDrive size={14}/></span><span><b>Lokala filer</b><small>Bara dina öppna filer</small></span><button onClick={() => setShowConnect(true)}><Link2 size={14}/></button></div></aside>
      <main className="editor-main"><div className="editor-header"><div className="breadcrumb"><span>NSV · DP1, DP2 & DP3</span><ChevronRight size={13}/><b>{active?.name || 'Modellvy'}</b></div><div className="editor-header-actions"><span className="format-pill"><span className={active?.kind === 'DXF' ? 'format-orange' : ''}/>{active?.kind || '3D'}</span><button className="mini-icon" onClick={() => setNotice('Versioner hämtas från Trimble Connect när anslutningen är aktiv.')} title="Versionshistorik"><Command size={15}/></button><button className="mini-icon" onClick={() => setNotice('Fler vyer kommer snart.')} title="Vyinställningar"><Grid2X2 size={15}/></button></div></div><div className="editor-tabs"><button className={activeTab === 'modell' ? 'tab-active' : ''} onClick={() => setActiveTab('modell')}>Modell <span>01</span></button><button className={activeTab === 'projekt' ? 'tab-active' : ''} onClick={() => { setActiveTab('projekt'); setShowFiles(true); }}>Connect <span><Cloud size={12}/></span></button><button className="tab-add" onClick={() => setShowImport(true)}><Plus size={14}/></button></div>
        <div className="viewport-wrap" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files[0]) acceptFile(e.dataTransfer.files[0]); }}>
          {(active?.kind === 'IFC' || active?.kind === 'Punktmoln') && active.file ? <canvas ref={canvasRef} className="ifc-canvas" aria-label={active.kind === 'IFC' ? 'IFC 3D-modell' : 'Punktmoln'} /> : <Drawing active={active} onFit={() => { if (active?.kind === 'IFC' || active?.kind === 'Punktmoln') rendererRef.current?.fitToView(); else if (canvasRef.current) renderFrame(canvasRef.current); setNotice('Vyn anpassad efter modellen.'); }}/ >}
          {active?.kind !== 'DXF' && (!active?.file || (active.kind === 'Punktmoln' && !active.file)) && <div className="scene-model" aria-hidden="true"><svg viewBox="0 0 900 500"><defs><linearGradient id="sfa" x2="1" y2="1"><stop stopColor="#cfdbc5"/><stop offset="1" stopColor="#9aa897"/></linearGradient></defs><ellipse cx="456" cy="407" rx="282" ry="37" fill="#000" opacity=".36"/><path d="m205 213 267-125 221 79-267 125z" fill="#59665d" stroke="#bac9b4"/><path d="m205 213 221 79v93l-221-80z" fill="#314139" stroke="#a8b7a5"/><path d="m426 292 267-125v94L426 385z" fill="url(#sfa)" stroke="#e3ead7"/><path d="m244 210 45-21v100l-45-16zm70-33 45-21v127l-45-16zm158 121 42-20v62l-42 20zm66-31 43-20v62l-43 20zm67-32 42-20v62l-42 20z" fill="#192624" stroke="#89998c"/><path d="m426 292 267-125M205 213l267-125" stroke="#f0f4e5" opacity=".56"/></svg></div>}
          <div className="viewport-hud"><span className="hud-live"><i/>{active?.file ? 'LOKAL MODELL' : 'FÖRHANDSVISNING'}</span><span className="hud-coords">X 0,00 &nbsp; Y 0,00 &nbsp; Z 0,00 m</span></div><div className="view-controls"><button className="viewcube">TOP</button><button onClick={() => setNotice('Perspektivvy aktiv.')}><Cuboid size={15}/></button><button onClick={() => setNotice('Objektisolering kommer snart.')}><Maximize2 size={15}/></button></div>
          {busy && <div className="loading-banner"><span className="spinner"/>{notice || 'Laddar modell…'}</div>}
        </div><div className="statusbar"><span><span className="status-dot"/>{notice || (active?.file ? 'Modellen finns på din enhet' : 'Anslut Trimble Connect för att öppna projektfiler')}</span><span>{entityTotal ? `${entityTotal.toLocaleString('sv-SE')} entiteter` : 'METER'} <i/> ORTHO <i/> 1:100</span></div>
      </main>
      {showProperties && <aside className="properties-panel"><div className="properties-heading"><div><span className="panel-eyebrow">INSPEKTÖR</span><h2>Detaljer</h2></div><button className="mini-icon" onClick={() => setShowProperties(false)}><PanelRightClose size={16}/></button></div><div className="properties-tabs"><button className="property-active">Egenskaper</button><button onClick={() => setNotice('Mätningar visas när en modell är vald.')}>Mätningar</button></div>{active ? <><div className="selected-object"><div className="object-icon"><Cuboid size={18}/></div><div><b>{active.name}</b><small>{active.kind === 'IFC' ? 'IFC Building Model' : active.kind === 'DXF' ? 'CAD-ritning' : 'Punktmoln'}</small></div><button className="mini-icon" onClick={() => setNotice('Objektmeny öppnas efter import.')}><MoreHorizontal size={16}/></button></div><div className="property-section"><button className="property-section-title"><ChevronDown size={14}/> ÖVERSIKT</button><div className="property-row"><span>Format</span><b>{active.kind}</b></div><div className="property-row"><span>Storlek</span><b>{active.size}</b></div><div className="property-row"><span>Objekt</span><b>{entityTotal?.toLocaleString('sv-SE') || active.entities?.toLocaleString('sv-SE') || '—'}</b></div><div className="property-row"><span>Koordinatsystem</span><b className="unknown-value">Ej inläst</b></div></div><div className="property-section"><button className="property-section-title"><ChevronRight size={14}/> PLATSERING</button></div><div className="property-section"><button className="property-section-title"><ChevronRight size={14}/> EGENSKAPER</button></div></> : <div className="empty-inspector"><span><Cuboid size={21}/></span><b>Välj ett objekt</b><small>Markera ett objekt i vyn för att se dess egenskaper.</small></div>}<div className="inspector-bottom"><span className="inspector-help"><Sparkles size={14}/><span><b>Modellassistent</b><small>Fråga om modellen när den är ansluten.</small></span></span><button onClick={() => setNotice('Assistenten aktiveras efter att IFC-modellen är inläst.')}><ArrowRight size={15}/></button></div></aside>}
    </div>
    <input ref={inputRef} hidden type="file" accept=".ifc,.dxf,.las,.laz,.ply,.e57,.copc,.pcd,.pts,.xyz" onChange={(e) => e.target.files?.[0] && acceptFile(e.target.files[0])}/>
    {showConnect && <ConnectDialog close={() => setShowConnect(false)} />}{showFiles && <FilesDialog close={() => setShowFiles(false)} models={models} open={openModel} projectId={connectProject?.id} projectName={connectProject?.name} token={connectToken} activeFile={active?.file} onImport={acceptFile} onNotice={setNotice} />}{showImport && <ImportDialog close={() => setShowImport(false)} pickFile={() => inputRef.current?.click()} />}
    <div className="toast-host">{notice && <button className="toast" onClick={() => setNotice('')}><span className="toast-icon"><Check size={14}/></span>{notice}<X size={14}/></button>}</div>
  </div>;
}

function TrimbleLauncher({ onOpenLocal }: { onOpenLocal: () => void }) {
  const [status, setStatus] = useState('Ansluter till projektet…');
  const [project, setProject] = useState<{ id?: string; name?: string } | null>(null);
  const [api, setApi] = useState<any>(null);
  const tokenRef = useRef<string | null>(null);
  const projectRef = useRef<{ id?: string; name?: string } | null>(null);
  const childRef = useRef<Window | null>(null);
  useEffect(() => {
    let alive = true;
    const onEvent = (event: string, args: any) => {
      if (event === 'extension.accessToken' && typeof args?.data === 'string') {
        tokenRef.current = args.data; setStatus('Projekt och användarsession anslutna.');
        childRef.current?.postMessage({ type: 'tc-codex:session', project: projectRef.current, accessToken: args.data }, location.origin);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== childRef.current || event.data?.type !== 'tc-codex:editor-ready') return;
      childRef.current?.postMessage({ type: 'tc-codex:session', project: projectRef.current, accessToken: tokenRef.current }, location.origin);
    };
    window.addEventListener('message', onMessage);
    void (async () => {
      try {
        // Workspace API handshakes can take longer while the Connect viewer initializes.
        const connection = await WorkspaceAPI.connect(window.parent, onEvent, 15000);
        if (!alive) return;
        setApi(connection);
        const current = await connection.project.getCurrentProject();
        if (!alive) return;
        const rawProject = current as any;
        const projectInfo = { id: rawProject?.id ?? rawProject?.projectId, name: rawProject?.name ?? rawProject?.projectName };
        projectRef.current = projectInfo;
        setProject(projectInfo); setStatus(projectInfo.name ? `Ansluten till ${projectInfo.name}` : 'Trimble Connect är redo.');
      } catch (reason) {
        if (alive) {
          const detail = reason instanceof Error ? ` (${reason.message})` : '';
          setStatus(`Workspace API kunde inte ansluta. Öppna appen från Connect-projektet${detail}`);
        }
      }
    })();
    return () => { alive = false; window.removeEventListener('message', onMessage); };
  }, []);
  const launch = async () => {
    if (!api || !projectRef.current?.id) {
      setStatus('Ingen Connect-session hittades. Öppna TC Codex från Apps & Capabilities i samma projekt.');
      return;
    }
    const child = window.open(`${location.origin}${location.pathname}#/editor`, '_blank');
    if (!child) { setStatus('Tillåt popup-fönster för att öppna editorn.'); return; }
    childRef.current = child;
    setStatus('Begär åtkomst till projektet…');
    try {
      const token = await api?.extension.requestPermission('accesstoken');
      if (typeof token === 'string' && token !== 'pending' && token !== 'denied') {
        tokenRef.current = token;
        child.postMessage({ type: 'tc-codex:session', project: projectRef.current, accessToken: token }, location.origin);
        setStatus('Editorn öppnas med projektets session.');
      } else if (token === 'denied') setStatus('Åtkomst nekades. Ändra tillståndet i extensionens inställningar.');
      else setStatus('Godkänn Connect-åtkomst i Trimble Connect. Editorn väntar på sessionen.');
    } catch {
      setStatus('Editorn öppnas. Connect-sessionen kunde inte hämtas.');
    }
  };
  return <main className="trimble-launcher"><div className="trimble-card"><div className="trimble-brand"><span className="brand-mark">T<span/></span><span>TC <b>Codex</b></span><span className="trimble-tag">MODELLSTUDIO</span></div><span className="panel-eyebrow">EXTERN 3D-EDITOR</span><h1>Modellen vidare.<br/><em>Arbetet samlat.</em></h1><p>Öppna IFC, DXF och punktmoln i en fristående arbetsyta. Hämta och spara filer i projektets Connect-mappar.</p><div className="trimble-project"><span className="project-glyph">N</span><span><small>AKTIVT PROJEKT</small><b>{project?.name || 'Trimble Connect-projekt'}</b></span><span className="connect-state"><i/>{status}</span></div><button className="primary-button full-button" onClick={() => void launch()}>Öppna extern editor <ArrowRight size={16}/></button><button className="trimble-local" onClick={onOpenLocal}><Upload size={14}/> Öppna en lokal modell <span>IFC · DXF · PUNKTMOLN</span></button><div className="trimble-footer"><span><Check size={13}/> IFC</span><span><Check size={13}/> DXF</span><span>Punktmoln</span></div></div><div className="trimble-side"><span className="live-dot"/> Trimble Connect <span>/</span> Modellstudio</div></main>;
}

function ConnectDialog({ close }: { close: () => void }) {
  return <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}><section className="connect-modal"><button className="modal-close" onClick={close}><X size={17}/></button><span className="modal-mark"><Cloud size={21}/></span><span className="panel-eyebrow">TRIMBLE CONNECT</span><h2>Hämta filer från projektet</h2><p>Starta Modellstudio från din Connect-projektvy för att läsa in projekt och mappar med din användarsession.</p><div className="connect-steps"><div><span>01</span><b>Öppna i Connect</b><small>Starta TC Codex från projektets Apps & Capabilities.</small></div><ArrowRight size={15}/><div><span>02</span><b>Välj mapp</b><small>Välj en Connect-fil för att hämta den till 3D-editorn.</small></div></div><div className="modal-note"><span className="live-dot"/> Ingen Connect-session hittades i den här fliken ännu.</div><button className="primary-button full-button" onClick={close}>Tillbaka till arbetsplatsen <ArrowRight size={16}/></button><small className="modal-footnote">När projektets session är ansluten finns mapphämtning och uppladdning i editorns Connect-panel.</small></section></div>;
}

function FilesDialog({ close, models, open, projectId, projectName, token, activeFile, onImport, onNotice }: {
  close: () => void; models: LocalModel[]; open: (model: LocalModel) => void;
  projectId?: string; projectName?: string; token: string | null; activeFile?: File;
  onImport: (file: File) => void; onNotice: (message: string) => void;
}) {
  const [client, setClient] = useState<ConnectFiles | null>(null);
  const [path, setPath] = useState<FolderEntry[]>([]);
  const [entries, setEntries] = useState<ConnectEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!projectId || !token) return;
    let alive = true;
    setLoading(true);
    void ConnectFiles.open(projectId, token).then((connection) => {
      if (alive) { setClient(connection); setError(''); }
    }).catch((reason) => {
      if (alive) setError(reason instanceof Error ? reason.message : 'Kunde inte ansluta till Trimble Connect Core API.');
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, token]);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    setLoading(true);
    void client.list(path.at(-1)).then((items) => {
      if (alive) { setEntries(items as ConnectEntry[]); setError(''); }
    }).catch((reason) => {
      if (alive) setError(reason instanceof Error ? reason.message : 'Kunde inte läsa mappens innehåll.');
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [client, path]);

  const importEntry = async (entry: ConnectEntry) => {
    if (isConnectFolder(entry) || !client) return;
    setLoading(true);
    try {
      const file = await client.download(entry);
      onImport(file);
      close();
      onNotice(`${file.name} hämtad från Trimble Connect.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Filen kunde inte hämtas från Connect.');
    } finally { setLoading(false); }
  };

  const uploadActive = async () => {
    if (!client || !activeFile) return;
    setUploading(true);
    try {
      await client.upload(activeFile, path.at(-1));
      const refreshed = await client.list(path.at(-1));
      setEntries(refreshed as ConnectEntry[]);
      onNotice(`${activeFile.name} uppladdad till ${projectName || 'Trimble Connect'}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Filen kunde inte laddas upp till Connect.');
    } finally { setUploading(false); }
  };

  return <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}><section className="files-modal"><button className="modal-close" onClick={close}><X size={17}/></button><span className="modal-mark"><FolderOpen size={20}/></span><span className="panel-eyebrow">TRIMBLE CONNECT · {projectName || 'PROJEKT'}</span><h2>Projektfiler</h2><p>Bläddra i mappar. Välj en modell för att hämta den till editorn, eller ladda upp den aktiva filen.</p><div className="connect-path"><Cloud size={15}/><span>{projectName || 'Projekt'}</span><ChevronRight size={13}/><span>{path.map((folder) => folder.name).join(' / ') || 'Filer'}</span></div>
    {path.length > 0 && <button className="connect-back" onClick={() => setPath((current) => current.slice(0, -1))}><ArrowLeft size={13}/> Tillbaka en mapp</button>}
    <div className="remote-file-list">{loading ? <div className="remote-empty">Ansluter eller läser mapp…</div> : entries.map((entry) => {
      const folder = isConnectFolder(entry);
      const supported = isSupportedConnectModel(entry);
      return <button key={`${entry.type}-${entry.id}`} disabled={loading || (!folder && !supported)} onClick={() => folder ? setPath((current) => [...current, entry]) : void importEntry(entry)}>
        <span className={`file-chip ${folder ? 'cloud-chip' : entry.name.toLowerCase().endsWith('.dxf') ? 'dxf-chip' : 'ifc-chip'}`}>{folder ? 'MAP' : entry.name.split('.').pop()?.toUpperCase()}</span>
        <span><b>{entry.name}</b><small>{folder ? 'Öppna mapp' : supported ? 'Hämta till editorn' : 'Formatet stöds inte i editorn'}</small></span>
        {folder ? <ChevronRight size={15}/> : <ArrowDownToLine size={15}/>}
      </button>;
    })}{!loading && client && entries.length === 0 && <div className="remote-empty">Mappen är tom.</div>}</div>
    {activeFile && client && <button className="secondary-button full-button" onClick={() => void uploadActive()} disabled={uploading}>{uploading ? 'Laddar upp…' : `Ladda upp ${activeFile.name} hit`} <Upload size={14}/></button>}
    {error && <div className="modal-note connect-error"><span>{error}</span></div>}
    {!token && <div className="modal-note"><HardDrive size={14}/> Öppna editorn från TC Codex i Trimble Connect för att ansluta projektet.</div>}
    <div className="connect-local"><b>Lokala arbetsfiler</b>{models.filter((model) => model.file).map((model) => <button key={model.name} onClick={() => open(model)}><span>{model.name}</span><small>{model.size}</small></button>)}</div>
    </section></div>;
}

function ImportDialog({ close, pickFile }: { close: () => void; pickFile: () => void }) {
  return <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}><section className="import-modal"><button className="modal-close" onClick={close}><X size={17}/></button><span className="modal-mark"><Upload size={20}/></span><span className="panel-eyebrow">IMPORTERA MODELL</span><h2>Öppna en fil</h2><p>Välj en modell från projektet eller dra in en fil från datorn.</p><button className="drop-zone" onClick={() => { close(); pickFile(); }}><span className="drop-icon"><FilePlus2 size={20}/></span><b>Välj filer från datorn</b><small>IFC · DXF · LAS · LAZ · PLY · E57 · PCD · PTS · XYZ</small><span className="drop-outline">Bläddra bland filer <ArrowRight size={14}/></span></button><div className="supported-types"><span>IFC <Check size={12}/></span><span>DXF <Check size={12}/></span><span>POINT CLOUD <Check size={12}/></span></div></section></div>;
}
