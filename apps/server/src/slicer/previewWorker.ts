// Worker thread: renders plate previews so the web server stays responsive.
import { parentPort, workerData } from 'node:worker_threads';
import { renderPlatePreview, type PlateGeometry } from './gcodePreview.js';

const { gcodePath, plate, sizes } = workerData as { gcodePath: string; plate: PlateGeometry; sizes: number[] };
renderPlatePreview(gcodePath, plate, sizes)
  .then((p) => parentPort!.postMessage({ ok: true, top: p.top, iso: p.iso, thumbnails: [...p.thumbnails], segments: p.segments, paths: p.paths }))
  .catch((err: Error) => parentPort!.postMessage({ ok: false, error: err.message }));
