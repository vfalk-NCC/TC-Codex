import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, Box, Check, ChevronDown, ChevronRight,
  CircleHelp, Cloud, Command, Cuboid, FileBox, FileImage, FilePlus2, Folder,
  FolderOpen, Grid2X2, HardDrive, Layers3, Link2, ListFilter, Maximize2,
  MoreHorizontal, MousePointer2, PanelLeftClose, PanelRightClose, Plus, Search,
  Settings2, Share2, SlidersHorizontal, Sparkles, Upload, X, Eye, EyeOff,
  Ruler, Scissors, ExternalLink, KeyRound, Download, Move3D, Copy,
} from 'lucide-react';
import { IfcParser, extractPropertiesOnDemand, extractQuantitiesOnDemand, extractEntityAttributesOnDemand, parseStepValue, serializeValue, ref as stepRef, type IfcDataStore, type StepValue } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { Renderer } from '@ifc-lite/renderer';
import { createDecodeWorkerSource, LazStreamingSource } from '@ifc-lite/pointcloud';
import { ConnectFiles, isConnectFolder, isSupportedConnectModel, type ConnectEntry, type ConnectFolder } from './connect';
import DxfParser from 'dxf-parser';
import * as WorkspaceAPI from 'trimble-connect-workspace-api';
import { unzipSync } from 'fflate';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

type LocalModel = { name: string; size: string; kind: 'IFC' | 'DXF' | 'Punktmoln' | 'GLTF'; entities?: number; file?: File };

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

type DxfTranslation = { dx: number; dy: number };
type DxfTransform = { rotation: number; scale: number };
function applyDxfTranslations(source: string, changes: Map<string, DxfTranslation>, transforms = new Map<string, DxfTransform>()) {
  const lines = source.split(/\r?\n/);
  let entityType = '', handle = '';
  let dxfLineType = 0, pendingXIndex = -1;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    const value = lines[i + 1];
    if (code === 0) { entityType = value.trim().toUpperCase(); handle = ''; dxfLineType = 0; pendingXIndex = -1; continue; }
    if (code === 5) { handle = value.trim().toUpperCase(); continue; }
    const change = changes.get(handle);
    const transform = transforms.get(handle);
    if (!change && !transform) continue;
    if (transform && (code === 10 || code === 11)) { pendingXIndex = i + 1; dxfLineType = code; continue; }
    if (transform && pendingXIndex >= 0 && (code === 20 || code === 21) && (dxfLineType === 10 ? code === 20 : code === 21)) {
      const x = Number(lines[pendingXIndex]), y = Number(value.trim()), angle = transform.rotation * Math.PI / 180;
      const sx = x * transform.scale, sy = y * transform.scale;
      const nx = sx * Math.cos(angle) - sy * Math.sin(angle), ny = sx * Math.sin(angle) + sy * Math.cos(angle);
      lines[pendingXIndex] = `${nx + (change?.dx || 0)}`; lines[i + 1] = `${ny + (change?.dy || 0)}`; pendingXIndex = -1;
      continue;
    }
    if (transform && ['CIRCLE', 'ARC', 'TEXT', 'MTEXT', 'ATTDEF'].includes(entityType)) {
      if (code === 40) { const size = Number(value.trim()); if (Number.isFinite(size)) lines[i + 1] = `${size * transform.scale}`; }
      if ((code === 50 || code === 51) && ['ARC', 'TEXT', 'MTEXT', 'ATTDEF'].includes(entityType)) { const degrees = Number(value.trim()); if (Number.isFinite(degrees)) lines[i + 1] = `${degrees + transform.rotation}`; }
    }
    if (!change) continue;
    let amount = 0;
    if (entityType === 'LINE' && (code === 10 || code === 11)) dxfLineType = code;
    if ((entityType === 'LINE' && dxfLineType && (code === 20 || code === 21)) || (['LWPOLYLINE', 'CIRCLE', 'ARC'].includes(entityType) && (code === 20))) amount = change.dy;
    if ((entityType === 'LINE' && (code === 10 || code === 11)) || (['LWPOLYLINE', 'CIRCLE', 'ARC'].includes(entityType) && code === 10)) amount = change.dx;
    if (amount) {
      const number = Number(value.trim());
      if (Number.isFinite(number)) lines[i + 1] = `${number + amount}`;
    }
  }
  return lines.join('\n');
}

function createDxfEntity(type: 'LINE' | 'CIRCLE', handle: string, layer: string, values: number[]) {
  const pairs = type === 'LINE'
    ? [[0, 'LINE'], [5, handle], [8, layer], [10, values[0]], [20, values[1]], [30, 0], [11, values[2]], [21, values[3]], [31, 0]]
    : [[0, 'CIRCLE'], [5, handle], [8, layer], [10, values[0]], [20, values[1]], [30, 0], [40, Math.max(0.001, values[2])]];
  return pairs.map(([code, value]) => `${code}\n${value}`).join('\n');
}

function appendDxfEntities(source: string, additions: string[]) {
  if (!additions.length) return source;
  const section = /(\r?\n0\r?\nSECTION\r?\n2\r?\nENTITIES[\s\S]*?)(\r?\n0\r?\nENDSEC)/i;
  if (!section.test(source)) throw new Error('DXF-filens ENTITIES-sektion kunde inte hittas.');
  return source.replace(section, (_match, body, end) => `${body}\n${additions.join('\n')}${end}`);
}

function removeDxfEntities(source: string, handles: Set<string>) {
  if (!handles.size) return source;
  const lines = source.split(/\r?\n/), kept: string[] = [];
  let block: string[] = [], currentHandle = '', inEntities = false;
  const flush = () => { if (!handles.has(currentHandle)) kept.push(...block); block = []; currentHandle = ''; };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim()), value = lines[i + 1];
    if (code === 0) {
      flush(); block = [lines[i], value];
      const type = value.trim().toUpperCase();
      if (type === 'SECTION') inEntities = false;
      if (type === 'ENDSEC') inEntities = false;
      if (type === 'ENDSEC') { kept.push(...block); block = []; continue; }
      if (type === 'LINE' || type === 'LWPOLYLINE' || type === 'CIRCLE' || type === 'ARC' || type === 'TEXT' || type === 'MTEXT' || type === 'POINT') currentHandle = '';
      continue;
    }
    if (code === 2 && value.trim().toUpperCase() === 'ENTITIES') inEntities = true;
    if (inEntities && code === 5) currentHandle = value.trim().toUpperCase();
    block.push(lines[i], value);
  }
  flush();
  if (lines.length % 2) kept.push(lines.at(-1)!);
  return kept.join('\n');
}

type StepReference = { ref: number };
type StepRecord = { id: number; type: string; args: StepValue[]; offset: number; length: number };
function stepReference(value: StepValue | undefined): number | null {
  return value && typeof value === 'object' && 'ref' in value ? (value as StepReference).ref : null;
}
function readStepRecord(store: IfcDataStore, id: number): StepRecord | null {
  const source = store.source;
  const entityRef = store.entityIndex.byId.get(id);
  if (!entityRef || entityRef.byteLength <= 0) return null;
  const raw = new TextDecoder().decode(source.subarray(entityRef.byteOffset, entityRef.byteOffset + entityRef.byteLength));
  const match = raw.match(/^\s*#\d+\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*)\)\s*;?\s*$/i);
  if (!match) return null;
  const parsed = parseStepValue(`(${match[2]})`);
  if (!Array.isArray(parsed)) return null;
  return { id, type: match[1].toUpperCase(), args: parsed as StepValue[], offset: entityRef.byteOffset, length: entityRef.byteLength };
}
type AxisBasis = [number[], number[], number[]];
const identityBasis: AxisBasis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const normalize3 = (value: number[]) => { const length = Math.hypot(value[0], value[1], value[2]) || 1; return value.map((n) => n / length); };
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const rotateBy = (basis: AxisBasis, vector: number[]) => basis[0].map((_, i) => basis[0][i] * vector[0] + basis[1][i] * vector[1] + basis[2][i] * vector[2]);
function ifcPlacementBasis(store: IfcDataStore, placementId: number | null, trail = new Set<number>()): AxisBasis {
  if (!placementId || trail.has(placementId)) return identityBasis;
  trail.add(placementId);
  const local = readStepRecord(store, placementId);
  if (!local || local.type !== 'IFCLOCALPLACEMENT') throw new Error('Objektets IFC-placering stöds inte för flytt.');
  const parentId = stepReference(local.args[0]);
  const axisId = stepReference(local.args[1]);
  const axisPlacement = axisId ? readStepRecord(store, axisId) : null;
  if (!axisPlacement || !axisPlacement.type.startsWith('IFCAXIS2PLACEMENT')) throw new Error('Objektets IFC-axelplacering saknas.');
  const direction = (id: number | null, fallback: number[]) => {
    const record = id ? readStepRecord(store, id) : null;
    const ratios = record?.args[0];
    return Array.isArray(ratios) ? normalize3(ratios.map((part) => Number(part))) : fallback;
  };
  const localZ = direction(stepReference(axisPlacement.args[1]), [0, 0, 1]);
  let localX = direction(stepReference(axisPlacement.args[2]), [1, 0, 0]);
  localX = normalize3(localX.map((component, i) => component - dot3(localX, localZ) * localZ[i]));
  const localY = normalize3(cross3(localZ, localX));
  const parentBasis = ifcPlacementBasis(store, parentId, trail);
  return [rotateBy(parentBasis, localX), rotateBy(parentBasis, localY), rotateBy(parentBasis, localZ)];
}
function createTranslatedIfcFile(file: File, store: IfcDataStore, moves: Map<number, [number, number, number]>) {
  const replacements: Array<{ offset: number; length: number; bytes: Uint8Array }> = [];
  const appended: string[] = [];
  let nextId = Math.max(...Array.from(store.entityIndex.byId.keys())) + 1;
  for (const [expressId, viewerMove] of moves) {
    if (viewerMove.every((value) => Math.abs(value) < 1e-9)) continue;
    const product = readStepRecord(store, expressId);
    const originalPlacementId = product && stepReference(product.args[5]);
    const originalPlacement = originalPlacementId ? readStepRecord(store, originalPlacementId) : null;
    if (!product || !originalPlacement || originalPlacement.type !== 'IFCLOCALPLACEMENT') throw new Error(`IFC-objekt #${expressId} saknar en redigerbar IfcLocalPlacement.`);
    const relativeId = stepReference(originalPlacement.args[1]);
    const axisPlacement = relativeId ? readStepRecord(store, relativeId) : null;
    if (!axisPlacement || axisPlacement.type !== 'IFCAXIS2PLACEMENT3D') throw new Error(`IFC-objekt #${expressId} använder en placering som inte kan flyttas säkert.`);
    const pointId = stepReference(axisPlacement.args[0]);
    const point = pointId ? readStepRecord(store, pointId) : null;
    if (!point || point.type !== 'IFCCARTESIANPOINT' || !Array.isArray(point.args[0])) throw new Error(`IFC-objekt #${expressId} saknar en giltig koordinatpunkt.`);
    const scale = store.lengthUnitScale || 1;
    const deltaIfcWorld = [viewerMove[0] / scale, -viewerMove[2] / scale, viewerMove[1] / scale];
    const parentBasis = ifcPlacementBasis(store, stepReference(originalPlacement.args[0]));
    const deltaParent = [0, 1, 2].map((axis) => dot3(parentBasis[axis], deltaIfcWorld));
    const coords = (point.args[0] as StepValue[]).map((value, i) => Number(value) + (deltaParent[i] || 0));
    const pointIdNew = nextId++, axisIdNew = nextId++, placementIdNew = nextId++;
    appended.push(`#${pointIdNew}=IFCCARTESIANPOINT(${serializeValue([coords])});`);
    const axisArgs = [...axisPlacement.args]; axisArgs[0] = stepRef(pointIdNew);
    appended.push(`#${axisIdNew}=IFCAXIS2PLACEMENT3D(${axisArgs.map((value) => serializeValue(value)).join(',')});`);
    const placementArgs = [...originalPlacement.args]; placementArgs[1] = stepRef(axisIdNew);
    appended.push(`#${placementIdNew}=IFCLOCALPLACEMENT(${placementArgs.map((value) => serializeValue(value)).join(',')});`);
    const productArgs = [...product.args]; productArgs[5] = stepRef(placementIdNew);
    const updated = `#${product.id}=${product.type}(${productArgs.map((value) => serializeValue(value)).join(',')});`;
    replacements.push({ offset: product.offset, length: product.length, bytes: new TextEncoder().encode(updated) });
  }
  if (replacements.length === 0) throw new Error('Inga IFC-förflyttningar att spara.');
  const source = store.source;
  const marker = new TextEncoder().encode('ENDSEC;');
  let insertAt = -1;
  outer: for (let i = source.length - marker.length; i >= 0; i--) {
    for (let j = 0; j < marker.length; j++) if (source[i + j] !== marker[j]) continue outer;
    insertAt = i; break;
  }
  if (insertAt < 0) throw new Error('IFC-filens DATA-sektion kunde inte hittas.');
  replacements.push({ offset: insertAt, length: 0, bytes: new TextEncoder().encode(`${appended.join('\n')}\n`) });
  replacements.sort((a, b) => a.offset - b.offset);
  const chunks: Uint8Array[] = []; let cursor = 0;
  for (const item of replacements) {
    if (item.offset < cursor) throw new Error('IFC-ändringarna överlappar i STEP-filen.');
    chunks.push(source.subarray(cursor, item.offset), item.bytes); cursor = item.offset + item.length;
  }
  chunks.push(source.subarray(cursor));
  const suffix = `_redigerad_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
  const dot = file.name.lastIndexOf('.'); const name = dot > 0 ? `${file.name.slice(0, dot)}${suffix}${file.name.slice(dot)}` : `${file.name}${suffix}.ifc`;
  return new File(chunks, name, { type: 'application/x-step', lastModified: Date.now() });
}

function createIfcDuplicate(file: File, store: IfcDataStore, expressId: number) {
  const product = readStepRecord(store, expressId);
  if (!product || product.args.length < 7 || !product.type.startsWith('IFC')) throw new Error('Det valda IFC-objektet kan inte dupliceras säkert.');
  const placementId = stepReference(product.args[5]), placement = placementId ? readStepRecord(store, placementId) : null;
  const axisId = placement && stepReference(placement.args[1]), axis = axisId ? readStepRecord(store, axisId) : null;
  const pointId = axis && stepReference(axis.args[0]), point = pointId ? readStepRecord(store, pointId) : null;
  if (!placement || placement.type !== 'IFCLOCALPLACEMENT' || !axis || axis.type !== 'IFCAXIS2PLACEMENT3D' || !point || point.type !== 'IFCCARTESIANPOINT' || !Array.isArray(point.args[0])) throw new Error('Objektets placering kan inte dupliceras säkert.');
  let nextId = Math.max(...Array.from(store.entityIndex.byId.keys())) + 1;
  const newPointId = nextId++, newAxisId = nextId++, newPlacementId = nextId++, newProductId = nextId++;
  const coordinates = [...point.args[0] as StepValue[]];
  const axisScale = store.lengthUnitScale || 1;
  coordinates[0] = Number(coordinates[0]) + 1 / axisScale;
  const newPoint = `#${newPointId}=IFCCARTESIANPOINT(${serializeValue([coordinates])});`;
  const axisArgs = [...axis.args]; axisArgs[0] = stepRef(newPointId);
  const newAxis = `#${newAxisId}=IFCAXIS2PLACEMENT3D(${axisArgs.map((value) => serializeValue(value)).join(',')});`;
  const placementArgs = [...placement.args]; placementArgs[1] = stepRef(newAxisId);
  const newPlacement = `#${newPlacementId}=IFCLOCALPLACEMENT(${placementArgs.map((value) => serializeValue(value)).join(',')});`;
  const productArgs = [...product.args];
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  const random = new Uint8Array(22); crypto.getRandomValues(random);
  productArgs[0] = Array.from(random, (value) => alphabet[value & 63]).join('');
  productArgs[5] = stepRef(newPlacementId);
  productArgs[2] = typeof productArgs[2] === 'string' ? `${productArgs[2]} (kopia)` : productArgs[2];
  const newProduct = `#${newProductId}=${product.type}(${productArgs.map((value) => serializeValue(value)).join(',')});`;
  const replacements: Array<{ offset: number; length: number; bytes: Uint8Array }> = [];
  const relationAdds: number[] = [];
  for (const id of store.entityIndex.byId.keys()) {
    const record = readStepRecord(store, id);
    const related = record?.args[4];
    if (!record || !record.type.startsWith('IFCREL') || !Array.isArray(related) || !related.some((value) => stepReference(value) === expressId)) continue;
    const relationArgs = [...record.args]; relationArgs[4] = [...related, stepRef(newProductId)];
    replacements.push({ offset: record.offset, length: record.length, bytes: new TextEncoder().encode(`#${record.id}=${record.type}(${relationArgs.map((value) => serializeValue(value)).join(',')});`) });
    relationAdds.push(record.id);
  }
  if (!relationAdds.length) throw new Error('Objektet saknar en IFC-relation som kan kopieras.');
  const source = store.source, marker = new TextEncoder().encode('ENDSEC;'); let insertAt = -1;
  outer: for (let i = source.length - marker.length; i >= 0; i--) { for (let j = 0; j < marker.length; j++) if (source[i + j] !== marker[j]) continue outer; insertAt = i; break; }
  if (insertAt < 0) throw new Error('IFC-filens DATA-sektion kunde inte hittas.');
  replacements.push({ offset: insertAt, length: 0, bytes: new TextEncoder().encode(`${[newPoint, newAxis, newPlacement, newProduct].join('\n')}\n`) });
  replacements.sort((a, b) => a.offset - b.offset);
  const chunks: Uint8Array[] = []; let cursor = 0;
  for (const item of replacements) { chunks.push(source.subarray(cursor, item.offset), item.bytes); cursor = item.offset + item.length; }
  chunks.push(source.subarray(cursor));
  const dot = file.name.lastIndexOf('.'), name = dot > 0 ? `${file.name.slice(0, dot)}_kopia${file.name.slice(dot)}` : `${file.name}_kopia.ifc`;
  return new File(chunks, name, { type: 'application/x-step', lastModified: Date.now() });
}

function createIfcDeletedCopy(file: File, store: IfcDataStore, expressId: number) {
  const product = readStepRecord(store, expressId);
  if (!product || !product.type.startsWith('IFC')) throw new Error('Det valda IFC-objektet kan inte tas bort.');
  const contains = (value: StepValue): boolean => stepReference(value) === expressId || (Array.isArray(value) && value.some(contains));
  const stripReference = (value: StepValue): StepValue | null => {
    if (stepReference(value) === expressId) return null;
    if (Array.isArray(value)) return value.map(stripReference).filter((item): item is StepValue => item !== null);
    return value;
  };
  const replacements: Array<{ offset: number; length: number; bytes: Uint8Array }> = [
    { offset: product.offset, length: product.length, bytes: new Uint8Array() },
  ];
  for (const id of store.entityIndex.byId.keys()) {
    if (id === expressId) continue;
    const record = readStepRecord(store, id);
    if (!record || !record.type.startsWith('IFCREL') || !record.args.some(contains)) continue;
    const args = record.args.map(stripReference);
    if (args.some((value) => value === null) || args[4] === null || (Array.isArray(args[4]) && args[4].length === 0)) {
      replacements.push({ offset: record.offset, length: record.length, bytes: new Uint8Array() });
      continue;
    }
    replacements.push({ offset: record.offset, length: record.length, bytes: new TextEncoder().encode(`#${record.id}=${record.type}(${args.map((value) => serializeValue(value)).join(',')});`) });
  }
  replacements.sort((a, b) => a.offset - b.offset);
  const chunks: Uint8Array[] = []; let cursor = 0;
  for (const item of replacements) { chunks.push(store.source.subarray(cursor, item.offset), item.bytes); cursor = item.offset + item.length; }
  chunks.push(store.source.subarray(cursor));
  const suffix = `_utan_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
  const dot = file.name.lastIndexOf('.'), name = dot > 0 ? `${file.name.slice(0, dot)}${suffix}${file.name.slice(dot)}` : `${file.name}${suffix}.ifc`;
  return new File(chunks, name, { type: 'application/x-step', lastModified: Date.now() });
}

function GltfViewport({ file, onStatus }: { file: File; onStatus: (message: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    const urls: string[] = [];
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#121612');
    scene.add(new THREE.HemisphereLight(0xe8f1dc, 0x354138, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.5); key.position.set(5, 8, 6); scene.add(key);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e8); camera.position.set(5, 4, 7);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const controls = new OrbitControls(camera, canvas); controls.enableDamping = true;
    const grid = new THREE.GridHelper(20, 40, 0x71806b, 0x333c33); grid.position.y = -0.01; scene.add(grid);
    const resize = () => { const rect = canvas.getBoundingClientRect(); renderer.setSize(rect.width, rect.height, false); camera.aspect = Math.max(.01, rect.width / Math.max(1, rect.height)); camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    let frame = 0;
    const animate = () => { if (disposed) return; controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(animate); };
    animate();
    const load = async () => {
      try {
        const loader = new GLTFLoader();
        const ext = file.name.split('.').pop()?.toLowerCase();
        let input: ArrayBuffer | string = await file.arrayBuffer();
        if (ext === 'zip') {
          const archive = unzipSync(new Uint8Array(input as ArrayBuffer));
          const gltfPath = Object.keys(archive).find((path) => path.toLowerCase().endsWith('.gltf'));
          if (!gltfPath) throw new Error('ZIP-arkivet innehåller ingen .gltf-fil.');
          const json = JSON.parse(new TextDecoder().decode(archive[gltfPath]));
          const base = gltfPath.includes('/') ? gltfPath.slice(0, gltfPath.lastIndexOf('/') + 1) : '';
          for (const buffer of [...(json.buffers || []), ...(json.images || [])]) {
            const uri = buffer.uri as string | undefined;
            if (!uri || uri.startsWith('data:') || /^https?:/i.test(uri)) continue;
            const path = decodeURIComponent(`${base}${uri}`).replace(/\\/g, '/');
            const bytes = archive[path] || archive[path.replace(/^\.\//, '')];
            if (!bytes) continue;
            const type = /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'application/octet-stream';
            const url = URL.createObjectURL(new Blob([bytes], { type })); urls.push(url); buffer.uri = url;
          }
          input = JSON.stringify(json);
        }
        loader.parse(input, '', (gltf) => {
          if (disposed) return;
          const model = gltf.scene; scene.add(model);
          const bounds = new THREE.Box3().setFromObject(model);
          const size = bounds.getSize(new THREE.Vector3()); const center = bounds.getCenter(new THREE.Vector3());
          model.position.sub(center);
          const radius = Math.max(size.x, size.y, size.z, 1);
          camera.position.set(radius * 1.8, radius * 1.35, radius * 1.8); camera.near = radius / 1000; camera.far = radius * 100; camera.updateProjectionMatrix();
          controls.target.set(0, 0, 0); controls.minDistance = radius * .01; controls.maxDistance = radius * 40; controls.update();
          onStatus(`${file.name} · glTF-modell inläst`);
        }, (error) => { if (!disposed) onStatus(`Modellen kunde inte läsas: ${error.message || 'ogiltigt glTF-format'}`); });
      } catch (error) { if (!disposed) onStatus(error instanceof Error ? error.message : 'Modellen kunde inte läsas.'); }
    };
    void load();
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); renderer.dispose(); urls.forEach(URL.revokeObjectURL); };
  }, [file, onStatus]);
  return <canvas ref={canvasRef} className="ifc-canvas" aria-label="glTF 3D-modell" />;
}

type SketchfabModel = { uid: string; name: string; viewerUrl: string; isDownloadable: boolean; user?: { displayName?: string }; license?: { label?: string }; thumbnails?: { images?: Array<{ url?: string }> } };

function SketchfabDialog({ close, onImport, onNotice }: { close: () => void; onImport: (file: File) => void; onNotice: (message: string) => void }) {
  const [token, setToken] = useState('');
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<SketchfabModel[]>([]);
  const [status, setStatus] = useState('Sök bland nedladdningsbara Sketchfab-modeller.');
  const [busy, setBusy] = useState(false);
  const request = async (url: string, accessToken: string) => {
    let response = await fetch(url, { headers: { Authorization: `Token ${accessToken}` } });
    if (response.status === 401 || response.status === 403) response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    return response;
  };
  const search = async () => {
    if (!query.trim()) { setStatus('Skriv vad du söker efter.'); return; }
    setBusy(true); setStatus('Söker på Sketchfab…');
    try {
      const params = new URLSearchParams({ type: 'models', downloadable: 'true', count: '18', q: query.trim() });
      const response = token.trim() ? await request(`https://api.sketchfab.com/v3/search?${params}`, token.trim()) : await fetch(`https://api.sketchfab.com/v3/search?${params}`);
      if (!response.ok) throw new Error(response.status === 401 ? 'Token nekades. Kontrollera Sketchfab-token.' : `Sketchfab svarade ${response.status}.`);
      const data = await response.json(); setModels(data.results || []); setStatus(`${(data.results || []).length} nedladdningsbara modeller hittades.`);
    } catch (error) { setModels([]); setStatus(error instanceof Error ? error.message : 'Sökningen misslyckades.'); }
    finally { setBusy(false); }
  };
  const download = async (model: SketchfabModel) => {
    if (!token.trim()) { setStatus('Ange en Sketchfab-token för att hämta modeller.'); return; }
    setBusy(true); setStatus(`Begär nedladdning av ${model.name}…`);
    try {
      const response = await request(`https://api.sketchfab.com/v3/models/${encodeURIComponent(model.uid)}/download`, token.trim());
      if (response.status === 401 || response.status === 403) throw new Error('Sketchfab kräver en OAuth access token för nedladdning. En personlig API-token kan räcka för sökning men inte för Download API.');
      if (!response.ok) throw new Error(`Nedladdningsbegäran misslyckades (${response.status}).`);
      const links = await response.json();
      if (!links.gltf?.url) throw new Error('Modellen saknar en nedladdningsbar glTF-fil.');
      setStatus('Hämtar glTF-arkiv…');
      const archive = await fetch(links.gltf.url);
      if (!archive.ok) throw new Error('Sketchfab-arkivet kunde inte hämtas.');
      const file = new File([await archive.blob()], `${model.name.replace(/[\\/:*?"<>|]/g, '_')}.zip`, { type: 'application/zip' });
      onImport(file); close(); onNotice(`Importerade “${model.name}” från Sketchfab. Kontrollera modellens licens på Sketchfab.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Nedladdningen misslyckades.'); }
    finally { setBusy(false); }
  };
  return <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><section className="files-modal asset-modal">
    <button className="modal-close" onClick={close}><X size={16}/></button><span className="modal-mark"><Cuboid size={18}/></span><span className="panel-eyebrow">MODELLBIBLIOTEK</span><h2>Hämta från Sketchfab</h2><p>Sök nedladdningsbara modeller och läs in dem direkt i 3D-vyn. Token används bara i den här fliken.</p>
    <label className="asset-label"><KeyRound size={14}/> API / OAuth-token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Klistra in Sketchfab-token" autoComplete="off"/></label>
    <div className="asset-search"><input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} placeholder="Sök modell, t.ex. pump eller stol"/><button disabled={busy} onClick={() => void search()}><Search size={15}/></button></div>
    <div className="asset-status">{busy && <span className="spinner"/>}{status}</div>
    <div className="asset-results">{models.map((model) => <article className="asset-result" key={model.uid}><img src={model.thumbnails?.images?.[0]?.url || ''} alt=""/><div><b>{model.name}</b><small>{model.user?.displayName || 'Sketchfab'} · {model.license?.label || 'Licens på modellens sida'}</small></div><button disabled={busy || !model.isDownloadable} title="Hämta glTF" onClick={() => void download(model)}><Download size={15}/></button></article>)}</div>
    <div className="modal-note"><span className="live-dot"/>Download API kräver inloggning och en OAuth access token. Granska licens och attribution innan användning.</div>
  </section></div>;
}

function fileKind(file: File): LocalModel['kind'] | null {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'ifc') return 'IFC';
  if (ext === 'dxf') return 'DXF';
  if (['glb', 'gltf', 'zip'].includes(ext || '')) return 'GLTF';
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

function EditableDrawing({ active, onFit, onModified }: { active: LocalModel | null; onFit: () => void; onModified: (file: File) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ handle: string; x: number; y: number } | null>(null);
  const viewRef = useRef<{ minX: number; minY: number; scale: number } | null>(null);
  const [entities, setEntities] = useState<any[]>([]);
  const [sourceText, setSourceText] = useState('');
  const [translations, setTranslations] = useState<Map<string, DxfTranslation>>(new Map());
  const [objectTransforms, setObjectTransforms] = useState<Map<string, DxfTransform>>(new Map());
  const [selectedHandle, setSelectedHandle] = useState<string | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [removedHandles, setRemovedHandles] = useState<Set<string>>(new Set());
  const [additions, setAdditions] = useState<Array<{ type: 'LINE' | 'CIRCLE'; handle: string; layer: string; values: number[] }>>([]);
  const [editMode, setEditMode] = useState<'select' | 'line' | 'circle'>('select');
  const [draftPoint, setDraftPoint] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [snapEnabled, setSnapEnabled] = useState(true);
  const historyRef = useRef<Array<{ translations: Map<string, DxfTranslation>; transforms: Map<string, DxfTransform>; removed: Set<string>; additions: typeof additions }>>([]);
  const redoRef = useRef<typeof historyRef.current>([]);
  const pushHistory = () => { historyRef.current.push({ translations: new Map(translations), transforms: new Map(objectTransforms), removed: new Set(removedHandles), additions: additions.map((item) => ({ ...item, values: [...item.values] })) }); redoRef.current = []; };
  const undo = () => { const item = historyRef.current.pop(); if (!item) return; redoRef.current.push({ translations: new Map(translations), transforms: new Map(objectTransforms), removed: new Set(removedHandles), additions: additions.map((value) => ({ ...value, values: [...value.values] })) }); setTranslations(item.translations); setObjectTransforms(item.transforms); setRemovedHandles(item.removed); setAdditions(item.additions); };
  const redo = () => { const item = redoRef.current.pop(); if (!item) return; historyRef.current.push({ translations: new Map(translations), transforms: new Map(objectTransforms), removed: new Set(removedHandles), additions: additions.map((value) => ({ ...value, values: [...value.values] })) }); setTranslations(item.translations); setObjectTransforms(item.transforms); setRemovedHandles(item.removed); setAdditions(item.additions); };
  const [drawn, setDrawn] = useState(false);
  const [status, setStatus] = useState('Väntar på modell');
  useEffect(() => {
    if (!active?.file || active.kind !== 'DXF') { setEntities([]); setSourceText(''); setTranslations(new Map()); setSelectedHandle(null); setDrawn(false); setStatus(active?.kind === 'IFC' ? 'IFC-modell laddas i 3D-vyn' : 'Väntar på modell'); return; }
    let cancelled = false; setStatus('Läser DXF…');
    void active.file.text().then((text) => {
      if (cancelled) return;
      const doc = new DxfParser().parseSync(text);
      setSourceText(text); setEntities(doc?.entities || []); setTranslations(new Map()); setObjectTransforms(new Map()); setSelectedHandle(null); setHiddenLayers(new Set()); setRemovedHandles(new Set()); setAdditions([]); setZoom(1); setPan({ x: 0, y: 0 }); historyRef.current = []; redoRef.current = [];
      setStatus((doc?.entities || []).length.toLocaleString('sv-SE') + ' objekt · dra för att flytta'); setDrawn(true);
    }).catch((error) => { if (!cancelled) { setDrawn(false); setStatus(error instanceof Error ? error.message : 'Kunde inte läsa DXF-filen.'); } });
    return () => { cancelled = true; };
  }, [active?.file, active?.kind]);
  const geometry = (entity: any, change?: DxfTranslation) => {
    const dx = change?.dx || 0, dy = change?.dy || 0;
    const transform = objectTransforms.get(String(entity.handle || '').toUpperCase()) || { rotation: 0, scale: 1 };
    const move = (point: any) => { const x = point.x * transform.scale, y = point.y * transform.scale, angle = transform.rotation * Math.PI / 180; return { x: x * Math.cos(angle) - y * Math.sin(angle) + dx, y: x * Math.sin(angle) + y * Math.cos(angle) + dy }; };
    const labelPoint = entity.startPoint || entity.position || entity.anchorPoint || entity.insertionPoint;
    return { vertices: (entity.vertices || []).map(move), center: entity.center ? move(entity.center) : null, position: labelPoint ? move(labelPoint) : null, radius: entity.radius * transform.scale };
  };
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas || !drawn) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, rect.width * dpr); canvas.height = Math.max(1, rect.height * dpr);
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#121612'; ctx.fillRect(0, 0, rect.width, rect.height);
      const points: Array<[number, number]> = [];
      entities.filter((entity) => !removedHandles.has(String(entity.handle || '').toUpperCase()) && !hiddenLayers.has(String(entity.layer || '0'))).forEach((entity) => {
        const geo = geometry(entity, translations.get(String(entity.handle).toUpperCase()));
        geo.vertices.forEach((point: any) => points.push([point.x, point.y]));
        if (geo.center) points.push([geo.center.x - geo.radius, geo.center.y - geo.radius], [geo.center.x + geo.radius, geo.center.y + geo.radius]);
        if (geo.position) points.push([geo.position.x, geo.position.y]);
      });
      if (!points.length) return;
      const minX = Math.min(...points.map((p) => p[0])), maxX = Math.max(...points.map((p) => p[0]));
      const minY = Math.min(...points.map((p) => p[1])), maxY = Math.max(...points.map((p) => p[1]));
      const scale = Math.min((rect.width - 100) / Math.max(1, maxX - minX), (rect.height - 100) / Math.max(1, maxY - minY)) * zoom;
      viewRef.current = { minX, minY, scale };
      const project = (x: number, y: number) => [50 + (x - minX) * scale + pan.x, rect.height - 50 - (y - minY) * scale + pan.y] as const;
      entities.filter((entity) => !removedHandles.has(String(entity.handle || '').toUpperCase()) && !hiddenLayers.has(String(entity.layer || '0'))).forEach((entity) => {
        const selected = String(entity.handle).toUpperCase() === selectedHandle, geo = geometry(entity, translations.get(String(entity.handle).toUpperCase()));
        ctx.beginPath(); ctx.strokeStyle = selected ? '#d6f36a' : '#d8e6c0'; ctx.lineWidth = selected ? 2.5 : 1.15;
        if (entity.type === 'LINE' && geo.vertices.length >= 2) { const a = project(geo.vertices[0].x, geo.vertices[0].y), b = project(geo.vertices[1].x, geo.vertices[1].y); ctx.moveTo(...a); ctx.lineTo(...b); }
        else if (entity.type === 'LWPOLYLINE' && geo.vertices.length >= 2) { ctx.moveTo(...project(geo.vertices[0].x, geo.vertices[0].y)); geo.vertices.slice(1).forEach((p: any) => ctx.lineTo(...project(p.x, p.y))); if (entity.shape) ctx.closePath(); }
        else if (entity.type === 'CIRCLE' && geo.center) { const p = project(geo.center.x, geo.center.y); ctx.arc(p[0], p[1], geo.radius * scale, 0, Math.PI * 2); }
        else if (entity.type === 'ARC' && geo.center) { const p = project(geo.center.x, geo.center.y); ctx.arc(p[0], p[1], geo.radius * scale, -(entity.endAngle + (objectTransforms.get(String(entity.handle).toUpperCase())?.rotation || 0) * Math.PI / 180), -(entity.startAngle + (objectTransforms.get(String(entity.handle).toUpperCase())?.rotation || 0) * Math.PI / 180)); }
        else if ((entity.type === 'TEXT' || entity.type === 'MTEXT' || entity.type === 'DIMENSION') && geo.position) {
          const p = project(geo.position.x, geo.position.y); ctx.fillStyle = selected ? '#d6f36a' : '#d8e6c0'; ctx.font = `${Math.max(9, (entity.textHeight || entity.height || 2) * scale)}px sans-serif`;
          const label = String(entity.text || (entity.actualMeasurement ? entity.actualMeasurement.toFixed(2) : '')).replace(/\\P/g, '\n');
          label.split('\n').forEach((line: string, index: number) => ctx.fillText(line, p[0], p[1] + index * Math.max(10, (entity.textHeight || entity.height || 2) * scale)));
        }
        ctx.stroke();
      });
      additions.forEach((entity) => {
        if (hiddenLayers.has(entity.layer)) return;
        ctx.beginPath(); ctx.strokeStyle = '#d6f36a'; ctx.lineWidth = 1.5;
        if (entity.type === 'LINE') { const a = project(entity.values[0], entity.values[1]), b = project(entity.values[2], entity.values[3]); ctx.moveTo(...a); ctx.lineTo(...b); }
        else { const center = project(entity.values[0], entity.values[1]); ctx.arc(center[0], center[1], entity.values[2] * scale, 0, Math.PI * 2); }
        ctx.stroke();
      });
    };
    draw(); const observer = new ResizeObserver(draw); observer.observe(canvas); return () => observer.disconnect();
  }, [entities, translations, objectTransforms, selectedHandle, drawn, hiddenLayers, removedHandles, additions, zoom, pan]);
  const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget, rect = canvas.getBoundingClientRect(), view = viewRef.current; if (!view) return;
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    if (event.button === 1 || event.button === 2) { dragRef.current = { handle: '__pan__', x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); event.preventDefault(); return; }
    const rawWorld = { x: (px - 50 - pan.x) / view.scale + view.minX, y: ((rect.height - 50 + pan.y) - py) / view.scale + view.minY };
    const world = snapEnabled ? { x: Math.round(rawWorld.x * 10) / 10, y: Math.round(rawWorld.y * 10) / 10 } : rawWorld;
    if (editMode !== 'select') {
      if (!draftPoint) { setDraftPoint(world); setStatus(editMode === 'line' ? 'Välj linjens slutpunkt' : 'Välj cirkelns radie'); return; }
      pushHistory();
      const handle = (0x100000 + additions.length + Date.now() % 0xffff).toString(16).toUpperCase();
      const values = editMode === 'line' ? [draftPoint.x, draftPoint.y, world.x, world.y] : [draftPoint.x, draftPoint.y, Math.hypot(world.x - draftPoint.x, world.y - draftPoint.y)];
      setAdditions((items) => [...items, { type: editMode === 'line' ? 'LINE' : 'CIRCLE', handle, layer: '0', values }]); setDraftPoint(null); setStatus(`${editMode === 'line' ? 'Linje' : 'Cirkel'} skapad på lager 0.`); return;
    }
    let closest: { handle: string; distance: number } | null = null;
    const screen = (point: any) => [50 + (point.x - view.minX) * view.scale + pan.x, rect.height - 50 - (point.y - view.minY) * view.scale + pan.y];
    const segmentDistance = (a: any, b: any) => {
      const [ax, ay] = screen(a), [bx, by] = screen(b), vx = bx - ax, vy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
      return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
    };
    entities.filter((entity) => !removedHandles.has(String(entity.handle || '').toUpperCase()) && !hiddenLayers.has(String(entity.layer || '0'))).forEach((entity) => {
      const handle = String(entity.handle || '').toUpperCase(); if (!handle) return;
      const geo = geometry(entity, translations.get(handle)); let distance = Infinity;
      if (entity.type === 'LINE' && geo.vertices.length >= 2) distance = segmentDistance(geo.vertices[0], geo.vertices[1]);
      if (entity.type === 'LWPOLYLINE' && geo.vertices.length >= 2) for (let i = 1; i < geo.vertices.length; i++) distance = Math.min(distance, segmentDistance(geo.vertices[i - 1], geo.vertices[i]));
      if (['CIRCLE', 'ARC'].includes(entity.type) && geo.center) { const [cx, cy] = screen(geo.center); distance = Math.abs(Math.hypot(px - cx, py - cy) - geo.radius * view.scale); }
      if (['TEXT', 'MTEXT', 'DIMENSION', 'POINT'].includes(entity.type) && geo.position) { const [x, y] = screen(geo.position); distance = Math.hypot(px - x, py - y); }
      if (distance < 13 && (!closest || distance < closest.distance)) closest = { handle, distance };
    });
    if (!closest) { setSelectedHandle(null); return; }
    const handle = (closest as { handle: string }).handle;
    setSelectedHandle(handle); pushHistory(); dragRef.current = { handle, x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId);
    setStatus((entities.find((entity) => String(entity.handle).toUpperCase() === handle)?.type || 'DXF-objekt') + ' · dra för att flytta');
  };
  const pointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current, scale = viewRef.current?.scale; if (!drag || !scale) return;
    if (drag.handle === '__pan__') { setPan((value) => ({ x: value.x + event.clientX - drag.x, y: value.y + event.clientY - drag.y })); drag.x = event.clientX; drag.y = event.clientY; return; }
    const dx = (event.clientX - drag.x) / scale, dy = -(event.clientY - drag.y) / scale;
    if (Math.abs(dx) < 1e-8 && Math.abs(dy) < 1e-8) return;
    setTranslations((current) => { const next = new Map(current), old = next.get(drag.handle) || { dx: 0, dy: 0 }; next.set(drag.handle, { dx: old.dx + dx, dy: old.dy + dy }); return next; });
    drag.x = event.clientX; drag.y = event.clientY;
  };
  const saveDrawing = () => {
    if (!active?.file || (translations.size === 0 && objectTransforms.size === 0 && removedHandles.size === 0 && additions.length === 0)) return;
    let text = applyDxfTranslations(sourceText, translations, objectTransforms);
    text = removeDxfEntities(text, removedHandles);
    text = appendDxfEntities(text, additions.map((item) => createDxfEntity(item.type, item.handle, item.layer, item.values)));
    const suffix = '_redigerad_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const dot = active.file.name.lastIndexOf('.'), name = dot > 0 ? active.file.name.slice(0, dot) + suffix + '.dxf' : active.file.name + suffix + '.dxf';
    onModified(new File([text], name, { type: 'application/dxf', lastModified: Date.now() }));
    setStatus('Ändringarna sparades i en ny DXF-fil. Välj ”Spara till Connect” för uppladdning.');
  };
  const layers = [...new Set(entities.map((entity) => String(entity.layer || '0')))].sort();
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const onWheel = (event: WheelEvent) => { event.preventDefault(); setZoom((value) => Math.min(20, Math.max(.1, value * (event.deltaY < 0 ? 1.12 : .89)))); };
    canvas.addEventListener('wheel', onWheel, { passive: false }); return () => canvas.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || active?.kind !== 'DXF') return;
      const tag = (event.target as HTMLElement | null)?.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (event.key.toLowerCase() === 'z' && event.shiftKey) { event.preventDefault(); redo(); }
      else if (event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
      else if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
      else if (event.key === 'Delete' && selectedHandle) { event.preventDefault(); pushHistory(); setRemovedHandles((items) => new Set(items).add(selectedHandle)); setSelectedHandle(null); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  return <div className={'viewport-stage ' + (active?.kind === 'DXF' && drawn ? 'drawing-mode' : '')}>
    <div className="viewport-grid"/><canvas ref={canvasRef} className="drawing-canvas" aria-label="DXF-ritning" onContextMenu={(event) => event.preventDefault()} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}/>
    {(!active || (active.kind === 'IFC' && !active.file) || (active.kind === 'Punktmoln' && !active.file)) && <svg className="model-art" viewBox="0 0 900 600" role="img" aria-label="Modellförhandsvisning"><defs><linearGradient id="facade" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#d9e2ca"/><stop offset="1" stopColor="#929d8c"/></linearGradient><linearGradient id="roof" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#777f71"/><stop offset="1" stopColor="#4c554c"/></linearGradient></defs><ellipse cx="454" cy="496" rx="330" ry="53" fill="#0a0d0b" opacity=".42"/><path d="M180 270 487 132 732 218 425 355Z" fill="url(#roof)" stroke="#edf2db" strokeOpacity=".34"/><path d="M180 270 425 355 425 472 180 386Z" fill="#52655c" stroke="#d5dec9" strokeOpacity=".52"/><path d="M425 355 732 218 732 334 425 472Z" fill="url(#facade)" stroke="#f3f5e9" strokeOpacity=".66"/><path d="M218 267 270 244 270 414 218 396ZM295 234 350 210 350 441 295 422ZM489 350 541 327 541 419 489 443ZM568 315 622 290 622 385 568 408ZM649 279 698 257 698 352 649 375Z" fill="#1d3030" stroke="#adbaa7" strokeWidth="2" opacity=".92"/><path d="M425 355 732 218M180 270 487 132M425 355V472M180 270V386M732 218V334" stroke="#f1f5e8" strokeOpacity=".3"/><path d="M162 487h551M199 505h450" stroke="#d6f36a" strokeOpacity=".24" strokeDasharray="5 7"/><path d="m172 484 62-26m-30 42 62-26m474-242 42-19m-40 87 42-19" stroke="#d6f36a" strokeWidth="1.2" opacity=".58"/></svg>}
    {!drawn && <div className="stage-watermark"><span className="watermark-icon"><Cuboid size={20}/></span><span>{active?.name || 'Modellvy'}</span><i/>{status}</div>}
    {active?.kind === 'DXF' && drawn && <div className="drawing-edit-tools"><span>{selectedHandle ? 'VALD · ' + selectedHandle : status}</span><button className={editMode === 'select' ? 'drawing-tool-active' : ''} onClick={() => { setEditMode('select'); setDraftPoint(null); }}>Markera</button><button className={editMode === 'line' ? 'drawing-tool-active' : ''} onClick={() => { setEditMode('line'); setDraftPoint(null); }}>Linje</button><button className={editMode === 'circle' ? 'drawing-tool-active' : ''} onClick={() => { setEditMode('circle'); setDraftPoint(null); }}>Cirkel</button><button className={snapEnabled ? 'drawing-tool-active' : ''} onClick={() => setSnapEnabled((value) => !value)}>Snäpp 0,1</button><button disabled={!selectedHandle} onClick={() => { if (!selectedHandle) return; pushHistory(); setObjectTransforms((items) => { const next = new Map(items), previous = next.get(selectedHandle) || { rotation: 0, scale: 1 }; next.set(selectedHandle, { ...previous, rotation: previous.rotation + 90 }); return next; }); }}>Rotera 90°</button><button disabled={!selectedHandle} onClick={() => { if (!selectedHandle) return; pushHistory(); setObjectTransforms((items) => { const next = new Map(items), previous = next.get(selectedHandle) || { rotation: 0, scale: 1 }; next.set(selectedHandle, { ...previous, scale: previous.scale * 1.1 }); return next; }); }}>Skala ×1,1</button><button onClick={undo} disabled={!historyRef.current.length}>Ångra</button><button onClick={redo} disabled={!redoRef.current.length}>Gör om</button><button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Zoom {zoom.toFixed(1)}×</button>{(translations.size > 0 || objectTransforms.size > 0 || removedHandles.size > 0 || additions.length > 0) && <button onClick={saveDrawing}><Check size={13}/> Spara DXF-kopia</button>}</div>}
    {active?.kind === 'DXF' && drawn && layers.length > 0 && <div className="drawing-layers"><b>LAGER</b>{layers.map((layer) => <label key={layer}><input type="checkbox" checked={!hiddenLayers.has(layer)} onChange={() => setHiddenLayers((items) => { const next = new Set(items); if (next.has(layer)) next.delete(layer); else next.add(layer); return next; })}/>{layer}</label>)}</div>}
    <button className="fit-button" aria-label="Anpassa vy" onClick={onFit}><Maximize2 size={15}/></button><div className="axis-widget"><span>Z</span><div/><span>X</span></div>
  </div>;
}

export default function App() {
  const [route, setRoute] = useState(location.hash === '#/editor' ? 'editor' : location.hash === '#/trimble' ? 'trimble' : 'home');
  const [models, setModels] = useState<LocalModel[]>([]);
  const [active, setActive] = useState<LocalModel | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showSketchfab, setShowSketchfab] = useState(false);
  const [showProperties, setShowProperties] = useState(true);
  const [tool, setTool] = useState<'select' | 'measure' | 'section'>('select');
  const [ifcStore, setIfcStore] = useState<IfcDataStore | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedIfcIds, setSelectedIfcIds] = useState<Set<number>>(new Set());
  const [selectedProperties, setSelectedProperties] = useState<Array<{ name: string; value: string }>>([]);
  const [pendingEditFile, setPendingEditFile] = useState<File | null>(null);
  const [moveDistance, setMoveDistance] = useState({ x: '0.10', y: '0', z: '0' });
  const [ifcMoves, setIfcMoves] = useState<Map<number, [number, number, number]>>(new Map());
  const ifcUndoRef = useRef<Array<Map<number, [number, number, number]>>>([]);
  const ifcRedoRef = useRef<Array<Map<number, [number, number, number]>>>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set());
  const [isolatedIds, setIsolatedIds] = useState<Set<number> | null>(null);
  const [sectionOn, setSectionOn] = useState(false);
  const [sectionPosition, setSectionPosition] = useState(0.5);
  const [measurePoint, setMeasurePoint] = useState<{ x: number; y: number; z: number } | null>(null);
  const [measurement, setMeasurement] = useState<number | null>(null);
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
  const rendererCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const pointCloudGeneration = useRef(0);
  const renderOptionsRef = useRef<{ hiddenIds: Set<number>; isolatedIds: Set<number> | null; selectedIds: Set<number>; sectionPlane?: { axis: 'down'; position: number; enabled: boolean } }>({ hiddenIds: new Set(), isolatedIds: null, selectedIds: new Set() });

  useEffect(() => {
    renderOptionsRef.current = { hiddenIds, isolatedIds, selectedIds: selectedIfcIds.size ? selectedIfcIds : selectedId ? new Set([selectedId]) : new Set(), ...(sectionOn ? { sectionPlane: { axis: 'down', position: sectionPosition, enabled: true } } : {}) };
  }, [hiddenIds, isolatedIds, selectedId, selectedIfcIds, sectionOn, sectionPosition]);

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
    if (rendererRef.current && rendererCanvasRef.current === canvas) return;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    if (rendererRef.current) rendererRef.current.destroy();
    rendererRef.current = null;
    const renderer = new Renderer(canvas);
    const geometry = new GeometryProcessor();
    await Promise.all([renderer.init(), geometry.init()]);
    rendererRef.current = renderer; rendererCanvasRef.current = canvas; geometryRef.current = geometry; parserRef.current = new IfcParser();
    const loop = () => { renderer.render(renderOptionsRef.current); animationRef.current = requestAnimationFrame(loop); };
    loop();
  }, []);

  useEffect(() => {
    if (route === 'editor' || !rendererRef.current) return;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    rendererRef.current.destroy(); rendererRef.current = null; rendererCanvasRef.current = null;
  }, [route]);

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
        setIfcStore(store); setHiddenIds(new Set()); setIsolatedIds(null); setSelectedId(null); setSelectedProperties([]);
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
    if (!kind) { setNotice('Välj IFC, DXF, glTF/GLB/ZIP eller en punktmolnsfil.'); return; }
    const item: LocalModel = { name: file.name, size: formatBytes(file.size), kind, file };
    setModels((current) => [item, ...current.filter((m) => m.name !== item.name)]);
    setActive(item); setSelectedId(null); setSelectedIfcIds(new Set()); setSelectedProperties([]); setPendingEditFile(null); setIfcMoves(new Map()); ifcUndoRef.current = []; ifcRedoRef.current = []; setMeasurePoint(null); setMeasurement(null); setHiddenIds(new Set()); setIsolatedIds(null); setShowImport(false); setRoute('editor'); location.hash = '/editor';
    if (kind === 'Punktmoln') setNotice('Punktmolnsfilen har lagts till.');
  };

  const openModel = (model: LocalModel) => {
    setActive(model); setEntityTotal(model.entities ?? null); setSelectedId(null); setSelectedIfcIds(new Set()); setSelectedProperties([]); setPendingEditFile(null); setIfcMoves(new Map()); ifcUndoRef.current = []; ifcRedoRef.current = []; setMeasurePoint(null); setMeasurement(null); setHiddenIds(new Set()); setIsolatedIds(null); setShowFiles(false); setRoute('editor');
    location.hash = '/editor';
    if (model.kind === 'Punktmoln' && !model.file) setNotice('Välj en lokal punktmolnsfil för att börja.');
    if (model.kind === 'IFC' && !model.file) setNotice('Exempelfilen finns i modellistan. Importera en lokal IFC för att visa geometrin.');
    if (model.kind === 'DXF' && !model.file) setNotice('Importera en lokal DXF-fil för att visa ritningsgeometrin.');
  };

  const selectViewport = async (event: MouseEvent<HTMLCanvasElement>) => {
    if (active?.kind !== 'IFC' || !rendererRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const picked = await rendererRef.current.pick(event.clientX - rect.left, event.clientY - rect.top, { hiddenIds, isolatedIds });
    if (tool === 'measure') {
      if (!picked?.worldXYZ) { setNotice('Klicka på en synlig IFC-yta för att mäta.'); return; }
      const point = picked.worldXYZ;
      if (!measurePoint) { setMeasurePoint(point); setMeasurement(null); setNotice('Första mätpunkten vald. Välj nästa punkt.'); }
      else {
        const distance = Math.hypot(point.x - measurePoint.x, point.y - measurePoint.y, point.z - measurePoint.z) * (ifcStore?.lengthUnitScale ?? 1);
        setMeasurement(distance); setMeasurePoint(null); setNotice(`Avstånd: ${distance.toFixed(3)} m`);
      }
      return;
    }
    const id = picked?.expressId ?? null;
    if (event.shiftKey && id) {
      setSelectedIfcIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    } else setSelectedIfcIds(id ? new Set([id]) : new Set());
    setSelectedId(id);
    if (!id || !ifcStore) { setSelectedProperties([]); setNotice('Inget IFC-objekt valt.'); return; }
    const entity = ifcStore.entityIndex.byId.get(id);
    const attrs = extractEntityAttributesOnDemand(ifcStore, id);
    const rows = [
      { name: 'IFC-klass', value: entity?.type || 'IFC-objekt' },
      { name: 'Express ID', value: `#${id}` },
      ...(attrs.globalId ? [{ name: 'GlobalId', value: attrs.globalId }] : []),
      ...(attrs.name ? [{ name: 'Namn', value: attrs.name }] : []),
      ...(attrs.objectType ? [{ name: 'Objekttyp', value: attrs.objectType }] : []),
      ...extractPropertiesOnDemand(ifcStore, id).flatMap((set) => set.properties.map((property) => ({ name: `${set.name} · ${property.name}`, value: String(property.value ?? property.values?.join(', ') ?? '—') }))),
      ...extractQuantitiesOnDemand(ifcStore, id).flatMap((set) => set.quantities.map((quantity) => ({ name: `${set.name} · ${quantity.name}`, value: String(quantity.value) }))),
    ];
    setSelectedProperties(rows.slice(0, 18)); setNotice(`${entity?.type || 'IFC-objekt'} · #${id} markerad`);
  };

  const hideSelected = () => {
    if (!selectedId) { setNotice('Markera ett IFC-objekt först.'); return; }
    const ids = selectedIfcIds.size ? selectedIfcIds : new Set([selectedId]);
    setHiddenIds((current) => new Set([...current, ...ids])); setSelectedId(null); setSelectedIfcIds(new Set()); setSelectedProperties([]); setNotice(`${ids.size} IFC-objekt dolda.`);
  };
  const isolateSelected = () => {
    if (!selectedId) { setNotice('Markera ett IFC-objekt först.'); return; }
    setIsolatedIds(selectedIfcIds.size ? new Set(selectedIfcIds) : new Set([selectedId])); setNotice(`${selectedIfcIds.size || 1} IFC-objekt isolerade.`);
  };
  const resetVisibility = () => { setHiddenIds(new Set()); setIsolatedIds(null); setNotice('Alla IFC-objekt visas igen.'); };

  const moveIfcSelection = () => {
    if (active?.kind !== 'IFC' || !active.file || !ifcStore || !selectedId || !rendererRef.current) { setNotice('Markera ett IFC-element som går att flytta.'); return; }
    const scale = ifcStore.lengthUnitScale || 1;
    const meters: [number, number, number] = [Number(moveDistance.x), Number(moveDistance.y), Number(moveDistance.z)];
    if (meters.some((value) => !Number.isFinite(value)) || meters.every((value) => value === 0)) { setNotice('Ange en förflyttning i meter.'); return; }
    const rendererDelta: [number, number, number] = [meters[0] / scale, meters[1] / scale, meters[2] / scale];
    const ids = selectedIfcIds.size ? [...selectedIfcIds] : [selectedId];
    const nextMoves = new Map(ifcMoves);
    ids.forEach((id) => { const previous = nextMoves.get(id) || [0, 0, 0] as [number, number, number]; nextMoves.set(id, [previous[0] + meters[0], previous[1] + meters[1], previous[2] + meters[2]]); });
    try {
      const editedFile = createTranslatedIfcFile(active.file, ifcStore, nextMoves);
      const movedIds: number[] = [];
      for (const id of ids) {
        const moved = rendererRef.current.getScene().translateMeshesForEntity(id, rendererDelta);
        if (!moved) { movedIds.forEach((movedId) => rendererRef.current?.getScene().translateMeshesForEntity(movedId, [-rendererDelta[0], -rendererDelta[1], -rendererDelta[2]])); throw new Error(`IFC-element #${id} ligger i delad geometri och kan inte flyttas separat.`); }
        movedIds.push(id);
      }
      ifcUndoRef.current.push(new Map(ifcMoves)); ifcRedoRef.current = [];
      setIfcMoves(nextMoves); setPendingEditFile(editedFile); setNotice(`${ids.length} IFC-element flyttade ${meters.map((value) => value.toFixed(2)).join(', ')} m. En redigerad kopia är klar för Connect.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'IFC-ändringen kunde inte sparas.'); }
  };

  const duplicateIfcSelection = () => {
    if (!active?.file || !ifcStore || !selectedId) { setNotice('Markera ett IFC-objekt först.'); return; }
    try {
      const duplicate = createIfcDuplicate(active.file, ifcStore, selectedId);
      acceptFile(duplicate);
      setNotice(`Kopia av IFC-element #${selectedId} skapad med 1 m förskjutning. Kontrollera modellen innan uppladdning.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'IFC-objektet kunde inte dupliceras.'); }
  };

  const deleteIfcSelection = () => {
    if (!active?.file || !ifcStore || !selectedId) { setNotice('Markera ett IFC-objekt först.'); return; }
    try {
      const deleted = createIfcDeletedCopy(active.file, ifcStore, selectedId);
      acceptFile(deleted);
      setNotice(`IFC-element #${selectedId} borttaget i en ny kopia. Övriga projektfiler påverkas inte.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'IFC-objektet kunde inte tas bort säkert.'); }
  };

  const restoreIfcHistory = (direction: 'undo' | 'redo') => {
    const stack = direction === 'undo' ? ifcUndoRef.current : ifcRedoRef.current;
    const target = stack.pop();
    if (!target || !active?.file || !ifcStore || !rendererRef.current) return;
    const other = direction === 'undo' ? ifcRedoRef.current : ifcUndoRef.current;
    other.push(new Map(ifcMoves));
    const ids = new Set([...ifcMoves.keys(), ...target.keys()]);
    ids.forEach((id) => {
      const before = ifcMoves.get(id) || [0, 0, 0], after = target.get(id) || [0, 0, 0];
      const scale = ifcStore.lengthUnitScale || 1;
      const delta: [number, number, number] = [(after[0] - before[0]) / scale, (after[1] - before[1]) / scale, (after[2] - before[2]) / scale];
      if (delta.some((value) => Math.abs(value) > 1e-9)) rendererRef.current?.getScene().translateMeshesForEntity(id, delta);
    });
    setIfcMoves(target);
    const hasMoves = [...target.values()].some((move) => move.some((value) => Math.abs(value) > 1e-9));
    setPendingEditFile(hasMoves ? createTranslatedIfcFile(active.file, ifcStore, target) : null);
    setNotice(direction === 'undo' ? 'IFC-flytten ångrades.' : 'IFC-flytten görs om.');
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || route !== 'editor' || active?.kind !== 'IFC') return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (event.key.toLowerCase() === 'z' && event.shiftKey) { event.preventDefault(); restoreIfcHistory('redo'); }
      else if (event.key.toLowerCase() === 'z') { event.preventDefault(); restoreIfcHistory('undo'); }
      else if (event.key.toLowerCase() === 'y') { event.preventDefault(); restoreIfcHistory('redo'); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [route, active, ifcMoves, ifcStore]);

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
      <div className="launch-visual"><div className="visual-top"><span className="live-dot" /> MODELLSTUDIO <span className="visual-project">ARBETSFLÖDE · IFC + DXF</span></div><div className="launch-blueprint"><div className="blueprint-grid"/><svg viewBox="0 0 540 330"><path d="m84 174 196-96 170 61-198 98z" fill="#27312a" stroke="#d6f36a" strokeWidth="1.2"/><path d="m84 174 168 63v69L84 242z" fill="#202c27" stroke="#738176"/><path d="m252 237 198-98v69l-198 98z" fill="#45554d" stroke="#c6d1bb"/><path d="m112 173 49-24v75l-49-19zm74-35 47-23v88l-47-18zm108 94 42-21v58l-42 21zm70-35 42-20v58l-42 20z" fill="#182220" stroke="#a4b39f"/><path d="m84 255 168 64 198-98" fill="none" stroke="#d6f36a" strokeDasharray="4 5" opacity=".6"/><circle cx="444" cy="95" r="3" fill="#ff875d"/><path d="M444 95v35" stroke="#ff875d" strokeDasharray="2 3"/></svg><div className="floating-label label-ifc"><Cuboid size={14}/> IFC-modell <b>IFC</b></div><div className="floating-label label-dxf"><FileImage size={14}/> Ritning <b>DXF</b></div><div className="visual-scale">IFC · DXF · PUNKTMOLN</div></div><div className="visual-bottom"><span>ARBETSFLÖDE</span><span className="workflow">Connect <ArrowRight size={13}/> Studio <ArrowRight size={13}/> Tillbaka till projektet</span></div></div>
      <div className="launch-lower"><div><span className="section-kicker">ARBETSFLÖDE</span><p className="empty-recent">Importerade filer visas i arbetslistan när du öppnar editorn.</p></div><div className="open-files-card"><span className="file-plus"><FilePlus2 size={19}/></span><span><b>Börja med en lokal fil</b><small>IFC · DXF · punktmoln</small></span><button onClick={() => inputRef.current?.click()}><Plus size={16}/></button></div></div>
    </main><footer className="launch-footer"><span>TC CODEX <span className="footer-sep">/</span> EXTERN MODELLSTUDIO</span><span>Utvecklas för projektarbete i Trimble Connect</span><button onClick={() => setShowConnect(true)}><CircleHelp size={14}/> Om kopplingen</button></footer>
    <input ref={inputRef} hidden type="file" accept=".ifc,.dxf,.glb,.gltf,.zip,.las,.laz,.ply,.e57,.copc,.pcd,.pts,.xyz" onChange={(e) => e.target.files?.[0] && acceptFile(e.target.files[0])}/>
    {showConnect && <ConnectDialog close={() => setShowConnect(false)} />}{showImport && <ImportDialog close={() => setShowImport(false)} pickFile={() => inputRef.current?.click()} />}
  </div>;

  return <div className="studio-shell">
    <header className="studio-top"><button className="brand compact" onClick={goHome}><span className="brand-mark">T<span /></span><span className="brand-name">TC <b>Codex</b></span></button><span className="top-divider"/><button className="project-select" onClick={() => setShowFiles(true)}><span className="project-glyph">N</span><span><b>{connectProject?.name || 'NSV · DP1, DP2 & DP3'}</b><small>{connectToken ? 'Trimble Connect-session aktiv' : 'Trimble Connect-projekt'}</small></span><ChevronDown size={14}/></button><div className="top-spacer"/><span className="save-state"><span className="live-dot"/> {active?.file ? 'Sparad lokalt' : 'Ingen ändringar'}</span><button className="icon-button" title="Dela" onClick={() => setNotice('Delning aktiveras när en Trimble Connect-session är ansluten.')}><Share2 size={16}/></button><button className="avatar">VF</button></header>
    <nav className="studio-tools"><div className="tool-group"><button className="tool-button" onClick={goHome}><ArrowLeft size={16}/><span>Tillbaka</span></button><span className="tool-separator"/><button className={`tool-button ${tool === 'select' ? 'selected' : ''}`} onClick={() => { setTool('select'); setMeasurePoint(null); }}><MousePointer2 size={16}/><span>Markera</span></button><button className={`tool-button ${tool === 'measure' ? 'selected' : ''}`} onClick={() => { setTool('measure'); setMeasurePoint(null); setMeasurement(null); setNotice('Klicka två punkter i IFC-modellen för att mäta.'); }}><Ruler size={16}/><span>Mät</span></button><button className={`tool-button ${tool === 'section' ? 'selected' : ''}`} onClick={() => { setTool('section'); setSectionOn((value) => !value); setNotice(sectionOn ? 'Snittplanet avstängt.' : 'Snittplanet aktivt. Justera läget i modellvyn.'); }}><Scissors size={16}/><span>Snitt</span></button></div><div className="tool-group"><button className="tool-button" onClick={() => setShowProperties((s) => !s)}><PanelRightClose size={16}/><span>Egenskaper</span></button><span className="tool-separator"/><button className="tool-button" onClick={() => active?.file ? setShowFiles(true) : setShowImport(true)}><Upload size={16}/><span>Spara till Connect</span></button><button className="tool-button more" title="Hämta från Sketchfab" onClick={() => setShowSketchfab(true)}><Cuboid size={17}/></button></div></nav>
    <div className="studio-layout">
      <aside className="left-rail"><button className="rail-active" title="Modeller"><Box size={17}/></button><button title="Trimble Connect-filer" onClick={() => setShowFiles(true)}><Folder size={17}/></button><button title="Lager" onClick={() => setNotice('Lager kopplas till modellen när IFC-filen är inläst.')}><Layers3 size={17}/></button><div className="rail-bottom"><button title="Inställningar" onClick={() => setNotice('Inställningar kommer snart.')}><Settings2 size={17}/></button><button title="Hjälp"><CircleHelp size={17}/></button></div></aside>
      <aside className="model-panel"><div className="panel-heading"><div><span className="panel-eyebrow">ARBETSPLATS</span><h2>Modellfiler</h2></div><button className="mini-icon" title="Lägg till fil" onClick={() => inputRef.current?.click()}><Plus size={16}/></button></div><button className="connect-folder" onClick={() => setShowFiles(true)}><span className="folder-square"><Cloud size={16}/></span><span><b>Trimble Connect</b><small>{connectProject?.name || 'NSV · DP1, DP2 & DP3'}</small></span><ChevronRight size={15}/></button><div className="search-box"><Search size={14}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Sök modell eller ritning"/><kbd>⌘ K</kbd></div><div className="list-heading"><span>ARBETSFILER <b>{visibleModels.length}</b></span><button onClick={() => setShowConnect(true)}><ListFilter size={14}/></button></div><div className="model-list">{visibleModels.map((model, i) => <button key={model.name} onClick={() => openModel(model)} className={`model-row ${active?.name === model.name ? 'model-active' : ''}`}><span className={`file-chip ${model.kind === 'IFC' ? 'ifc-chip' : model.kind === 'DXF' ? 'dxf-chip' : 'cloud-chip'}`}>{model.kind === 'Punktmoln' ? 'LAS' : model.kind}</span><span className="model-info"><b>{model.name}</b><small>{model.size} <i>·</i> {model.entities ? `${model.entities.toLocaleString('sv-SE')} objekt` : 'Connect-fil'}</small></span><span className="row-more"><MoreHorizontal size={15}/></span></button>)}</div><button className="add-model-button" onClick={() => inputRef.current?.click()}><Plus size={15}/> Lägg till lokal fil</button><button className="library-button" onClick={() => setShowSketchfab(true)}><Cuboid size={14}/> Sök Sketchfab</button><button className="library-button" onClick={() => { window.open('https://3dwarehouse.sketchup.com/', '_blank', 'noopener,noreferrer'); setNotice('3D Warehouse öppnades i en ny flik. Ladda ned en kompatibel IFC- eller glTF-modell för import.'); }}><ExternalLink size={14}/> Öppna 3D Warehouse</button><div className="panel-footer"><span className="storage-icon"><HardDrive size={14}/></span><span><b>Lokala filer</b><small>Bara dina öppna filer</small></span><button onClick={() => setShowFiles(true)}><Link2 size={14}/></button></div></aside>
      <main className="editor-main"><div className="editor-header"><div className="breadcrumb"><span>NSV · DP1, DP2 & DP3</span><ChevronRight size={13}/><b>{active?.name || 'Modellvy'}</b></div><div className="editor-header-actions"><span className="format-pill"><span className={active?.kind === 'DXF' ? 'format-orange' : ''}/>{active?.kind || '3D'}</span><button className="mini-icon" onClick={() => setNotice('Versioner hämtas från Trimble Connect när anslutningen är aktiv.')} title="Versionshistorik"><Command size={15}/></button><button className="mini-icon" onClick={() => setNotice('Fler vyer kommer snart.')} title="Vyinställningar"><Grid2X2 size={15}/></button></div></div><div className="editor-tabs"><button className={activeTab === 'modell' ? 'tab-active' : ''} onClick={() => setActiveTab('modell')}>Modell <span>01</span></button><button className={activeTab === 'projekt' ? 'tab-active' : ''} onClick={() => { setActiveTab('projekt'); setShowFiles(true); }}>Connect <span><Cloud size={12}/></span></button><button className="tab-add" onClick={() => setShowImport(true)}><Plus size={14}/></button></div>
        <div className="viewport-wrap" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files[0]) acceptFile(e.dataTransfer.files[0]); }}>
          {active?.kind === 'GLTF' && active.file ? <GltfViewport file={active.file} onStatus={setNotice}/> : (active?.kind === 'IFC' || active?.kind === 'Punktmoln') && active.file ? <canvas ref={canvasRef} onClick={(event) => void selectViewport(event)} className={`ifc-canvas ${tool === 'measure' ? 'measure-cursor' : ''}`} aria-label={active.kind === 'IFC' ? 'IFC 3D-modell' : 'Punktmoln'} /> : <EditableDrawing active={active} onModified={(file) => { setPendingEditFile(file); setNotice(`${file.name} klar att ladda upp till Trimble Connect.`); }} onFit={() => { if (active?.kind === 'IFC' || active?.kind === 'Punktmoln') rendererRef.current?.fitToView(); else if (canvasRef.current) renderFrame(canvasRef.current); setNotice('Vyn anpassad efter modellen.'); }}/ >}
          {active?.kind !== 'DXF' && (!active?.file || (active.kind === 'Punktmoln' && !active.file)) && <div className="scene-model" aria-hidden="true"><svg viewBox="0 0 900 500"><defs><linearGradient id="sfa" x2="1" y2="1"><stop stopColor="#cfdbc5"/><stop offset="1" stopColor="#9aa897"/></linearGradient></defs><ellipse cx="456" cy="407" rx="282" ry="37" fill="#000" opacity=".36"/><path d="m205 213 267-125 221 79-267 125z" fill="#59665d" stroke="#bac9b4"/><path d="m205 213 221 79v93l-221-80z" fill="#314139" stroke="#a8b7a5"/><path d="m426 292 267-125v94L426 385z" fill="url(#sfa)" stroke="#e3ead7"/><path d="m244 210 45-21v100l-45-16zm70-33 45-21v127l-45-16zm158 121 42-20v62l-42 20zm66-31 43-20v62l-43 20zm67-32 42-20v62l-42 20z" fill="#192624" stroke="#89998c"/><path d="m426 292 267-125M205 213l267-125" stroke="#f0f4e5" opacity=".56"/></svg></div>}
          <div className="viewport-hud"><span className="hud-live"><i/>{active?.file ? 'LOKAL MODELL' : 'FÖRHANDSVISNING'}</span><span className="hud-coords">{selectedId ? `IFC #${selectedId}` : 'X 0,00  ·  Y 0,00  ·  Z 0,00 m'}</span></div><div className="view-controls"><button className="viewcube">TOP</button><button onClick={() => setNotice('Perspektivvy aktiv.')}><Cuboid size={15}/></button><button title="Återställ synlighet" onClick={resetVisibility}><Eye size={15}/></button></div>
          {active?.kind === 'IFC' && active.file && (tool === 'section' || measurement !== null) && <div className="model-tool-popover">{tool === 'section' && <><div><Scissors size={14}/> <b>Snittplan</b><button onClick={() => setSectionOn((value) => !value)}>{sectionOn ? 'Av' : 'På'}</button></div><input aria-label="Snittplanets position" type="range" min="0" max="100" value={Math.round(sectionPosition * 100)} onChange={(e) => setSectionPosition(Number(e.target.value) / 100)}/><small>Vertikalt snitt · {Math.round(sectionPosition * 100)}%</small></>}{measurement !== null && <div><Ruler size={14}/> <b>{measurement.toFixed(3)} m</b><button onClick={() => { setMeasurement(null); setTool('measure'); }}>Ny mätning</button></div>}</div>}
          {busy && <div className="loading-banner"><span className="spinner"/>{notice || 'Laddar modell…'}</div>}
        </div><div className="statusbar"><span><span className="status-dot"/>{notice || (active?.file ? 'Modellen finns på din enhet' : 'Anslut Trimble Connect för att öppna projektfiler')}</span><span>{entityTotal ? `${entityTotal.toLocaleString('sv-SE')} entiteter` : 'METER'} <i/> ORTHO <i/> 1:100</span></div>
      </main>
      {showProperties && <aside className="properties-panel"><div className="properties-heading"><div><span className="panel-eyebrow">INSPEKTÖR</span><h2>Detaljer</h2></div><button className="mini-icon" onClick={() => setShowProperties(false)}><PanelRightClose size={16}/></button></div><div className="properties-tabs"><button className="property-active">Egenskaper</button><button onClick={() => setNotice(measurement === null ? 'Välj Mät och klicka två punkter i IFC-modellen.' : `Senaste mätning: ${measurement.toFixed(3)} m`)}>Mätningar</button></div>{active ? <><div className="selected-object"><div className="object-icon"><Cuboid size={18}/></div><div><b>{selectedId ? `#${selectedId} · ${ifcStore?.entityIndex.byId.get(selectedId)?.type || 'IFC-objekt'}` : active.name}</b><small>{active.kind === 'IFC' ? 'IFC Building Model' : active.kind === 'DXF' ? 'CAD-ritning' : active.kind === 'GLTF' ? 'glTF / Sketchfab' : 'Punktmoln'}</small></div></div><div className="property-section"><button className="property-section-title"><ChevronDown size={14}/> ÖVERSIKT</button><div className="property-row"><span>Format</span><b>{active.kind}</b></div><div className="property-row"><span>Storlek</span><b>{active.size}</b></div><div className="property-row"><span>Objekt</span><b>{entityTotal?.toLocaleString('sv-SE') || active.entities?.toLocaleString('sv-SE') || '—'}</b></div><div className="property-row"><span>Koordinatsystem</span><b className="unknown-value">{ifcStore?.lengthUnitScale ? `IFC · ${ifcStore.lengthUnitScale} m/enhet` : 'Ej inläst'}</b></div></div>{active.kind === 'IFC' && <><div className="object-actions"><button onClick={hideSelected} disabled={!selectedId}><EyeOff size={14}/> Dölj</button><button onClick={isolateSelected} disabled={!selectedId}><Eye size={14}/> Isolera</button><button onClick={resetVisibility}><Maximize2 size={14}/> Visa alla</button></div><div className="ifc-move-controls"><b>Flytta markerat element</b><small>Förflyttning i modellens X, Y och Z, meter</small><div>{(['x','y','z'] as const).map((axis) => <label key={axis}>{axis.toUpperCase()}<input type="number" step="0.1" value={moveDistance[axis]} onChange={(event) => setMoveDistance((current) => ({ ...current, [axis]: event.target.value }))}/></label>)}</div><button disabled={!selectedId} onClick={moveIfcSelection}><Move3D size={14}/> Flytta {selectedIfcIds.size > 1 ? 'valda element' : 'element'}</button><button disabled={!selectedId} onClick={duplicateIfcSelection}><Copy size={14}/> Duplicera element</button><button disabled={!selectedId || selectedIfcIds.size > 1} onClick={deleteIfcSelection}><X size={14}/> Ta bort element</button></div><div className="property-section"><button className="property-section-title"><ChevronDown size={14}/> IFC-EGENSKAPER {selectedId ? `· #${selectedId}` : ''}</button>{selectedProperties.length ? selectedProperties.map((property, index) => <div className="property-row ifc-property-row" key={`${property.name}-${index}`}><span title={property.name}>{property.name}</span><b title={property.value}>{property.value}</b></div>) : <small className="ifc-empty-properties">Markera ett element i modellen för att läsa dess IFC-egenskaper och mängder.</small>}</div></>}</> : <div className="empty-inspector"><span><Cuboid size={21}/></span><b>Välj ett objekt</b><small>Markera ett objekt i vyn för att se dess egenskaper.</small></div>}<div className="inspector-bottom"><span className="inspector-help"><Sparkles size={14}/><span><b>Modellassistent</b><small>Fråga om modellen när den är ansluten.</small></span></span><button onClick={() => setNotice('Assistenten aktiveras efter att IFC-modellen är inläst.')}><ArrowRight size={15}/></button></div></aside>}
    </div>
    <input ref={inputRef} hidden type="file" accept=".ifc,.dxf,.glb,.gltf,.zip,.las,.laz,.ply,.e57,.copc,.pcd,.pts,.xyz" onChange={(e) => e.target.files?.[0] && acceptFile(e.target.files[0])}/>
    {showConnect && <ConnectDialog close={() => setShowConnect(false)} />}{showFiles && <FilesDialog close={() => setShowFiles(false)} models={models} open={openModel} projectId={connectProject?.id} projectName={connectProject?.name} projectRegion={connectProject?.region} token={connectToken} activeFile={pendingEditFile || active?.file} onImport={acceptFile} onNotice={setNotice} />}{showImport && <ImportDialog close={() => setShowImport(false)} pickFile={() => inputRef.current?.click()} />}{showSketchfab && <SketchfabDialog close={() => setShowSketchfab(false)} onImport={acceptFile} onNotice={setNotice} />}
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
      const eventToken = typeof args === 'string' ? args : args?.data;
      if (event === 'extension.accessToken' && isAccessToken(eventToken)) {
        tokenRef.current = eventToken; setStatus('Projekt och användarsession anslutna.');
        childRef.current?.postMessage({ type: 'tc-codex:session', project: projectRef.current, accessToken: eventToken }, location.origin);
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
        const connection = await WorkspaceAPI.connect(window.parent, onEvent, 30000);
        if (!alive) return;
        setApi(connection);
        const current = await connection.project.getProject();
        if (!alive) return;
        const rawProject = current as any;
        const projectInfo = {
          id: rawProject?.id ?? rawProject?.projectId,
          name: rawProject?.name ?? rawProject?.projectName,
          region: rawProject?.location ?? rawProject?.region,
        };
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
      const token = await api.extension.requestPermission('accesstoken');
      if (isAccessToken(token)) {
        tokenRef.current = token;
        child.postMessage({ type: 'tc-codex:session', project: projectRef.current, accessToken: token }, location.origin);
        setStatus('Editorn öppnas med projektets session.');
      } else if (token === 'denied') setStatus('Åtkomst nekades. Ändra tillståndet i extensionens inställningar.');
      else setStatus('Väntar på att Trimble Connect ska godkänna åtkomsten.');
    } catch {
      setStatus('Editorn öppnas. Connect-sessionen kunde inte hämtas.');
    }
  };
  return <main className="trimble-launcher"><div className="trimble-card"><div className="trimble-brand"><span className="brand-mark">T<span/></span><span>TC <b>Codex</b></span><span className="trimble-tag">MODELLSTUDIO</span></div><span className="panel-eyebrow">EXTERN 3D-EDITOR</span><h1>Modellen vidare.<br/><em>Arbetet samlat.</em></h1><p>Öppna IFC, DXF och punktmoln i en fristående arbetsyta. Hämta och spara filer i projektets Connect-mappar.</p><div className="trimble-project"><span className="project-glyph">N</span><span><small>AKTIVT PROJEKT</small><b>{project?.name || 'Trimble Connect-projekt'}</b></span><span className="connect-state"><i/>{status}</span></div><button className="primary-button full-button" onClick={() => void launch()}>Öppna extern editor <ArrowRight size={16}/></button><button className="trimble-local" onClick={onOpenLocal}><Upload size={14}/> Öppna en lokal modell <span>IFC · DXF · PUNKTMOLN</span></button><div className="trimble-footer"><span><Check size={13}/> IFC</span><span><Check size={13}/> DXF</span><span>Punktmoln</span></div></div><div className="trimble-side"><span className="live-dot"/> Trimble Connect <span>/</span> Modellstudio</div></main>;
}

function isAccessToken(value: unknown): value is string {
  return typeof value === 'string' && value.split('.').length === 3;
}

function ConnectDialog({ close }: { close: () => void }) {
  return <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}><section className="connect-modal"><button className="modal-close" onClick={close}><X size={17}/></button><span className="modal-mark"><Cloud size={21}/></span><span className="panel-eyebrow">TRIMBLE CONNECT</span><h2>Hämta filer från projektet</h2><p>Starta Modellstudio från din Connect-projektvy för att läsa in projekt och mappar med din användarsession.</p><div className="connect-steps"><div><span>01</span><b>Öppna i Connect</b><small>Starta TC Codex från projektets Apps & Capabilities.</small></div><ArrowRight size={15}/><div><span>02</span><b>Välj mapp</b><small>Välj en Connect-fil för att hämta den till 3D-editorn.</small></div></div><div className="modal-note"><span className="live-dot"/> Ingen Connect-session hittades i den här fliken ännu.</div><button className="primary-button full-button" onClick={close}>Tillbaka till arbetsplatsen <ArrowRight size={16}/></button><small className="modal-footnote">När projektets session är ansluten finns mapphämtning och uppladdning i editorns Connect-panel.</small></section></div>;
}

function FilesDialog({ close, models, open, projectId, projectName, projectRegion, token, activeFile, onImport, onNotice }: {
  close: () => void; models: LocalModel[]; open: (model: LocalModel) => void;
  projectId?: string; projectName?: string; projectRegion?: string; token: string | null; activeFile?: File;
  onImport: (file: File) => void; onNotice: (message: string) => void;
}) {
  const [client, setClient] = useState<ConnectFiles | null>(null);
  const [path, setPath] = useState<ConnectFolder[]>([]);
  const [entries, setEntries] = useState<ConnectEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!projectId || !token) return;
    let alive = true;
    setLoading(true);
    void ConnectFiles.open(projectId, token, projectRegion).then((connection) => {
      if (alive) { setClient(connection); setError(''); }
    }).catch((reason) => {
      if (alive) setError(reason instanceof Error ? reason.message : 'Kunde inte ansluta till Trimble Connect Core API.');
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, projectRegion, token]);

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
