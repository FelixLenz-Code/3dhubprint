// Downloads the model for the AI bed check (DINOv2-small, Apache-2.0) to models/ and checks its hash.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const URL_ = 'https://huggingface.co/onnx-community/dinov2-small/resolve/8b1f705a3a7f6f062f6bdd21986c1583d3ef105d/onnx/model.onnx';
const SHA256 = 'f22797eabf810a75e41de68d378541ebea372122b25c4ce3ef25ff618250c20a';
const target = path.resolve(process.argv[2] ?? 'models/dinov2-small.onnx');

const hash = (buf) => createHash('sha256').update(buf).digest('hex');
if (fs.existsSync(target) && hash(fs.readFileSync(target)) === SHA256) {
  console.log(`${target} ist aktuell`);
  process.exit(0);
}
const res = await fetch(URL_);
if (!res.ok) throw new Error(`Download fehlgeschlagen: ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (hash(buf) !== SHA256) throw new Error('Prüfsumme des Modells stimmt nicht');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(`${target}.tmp`, buf);
fs.renameSync(`${target}.tmp`, target);
console.log(`${target} gespeichert (${(buf.length / 1e6).toFixed(0)} MB)`);
