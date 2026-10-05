import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Bed } from '../../lib/plate';

export interface SceneObject {
  /** Stable per item + copy. */
  key: string;
  item: number;
  copy: number;
  /** Shared by all copies of an item; rebuilt when the orientation changes. */
  geometry: THREE.BufferGeometry;
  x: number;
  y: number;
  selected: boolean;
  invalid: boolean;
}

export type PointerMode = 'move' | 'face' | 'none';

interface Handlers {
  onSelect: (item: number | null) => void;
  onMove: (item: number, copy: number, x: number, y: number) => void;
  onFacePick: (item: number, normal: [number, number, number]) => void;
}

const BASE = new THREE.Color(0x2aa198);
/** Axis colors, also used for the rotate buttons. */
export const AXIS_COLORS = { x: '#e5484d', y: '#30a46c', z: '#3e63dd' } as const;

/** Arrows for X/Y/Z with letter labels; drawn on top so they stay visible inside parts. */
function axesGizmo(length: number): THREE.Group {
  const g = new THREE.Group();
  const dirs = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  for (const [axis, dir] of Object.entries(dirs) as ['x' | 'y' | 'z', THREE.Vector3][]) {
    // Solid shaft + cone (line-based arrows are 1 px thin and hard to see).
    const mat = new THREE.MeshBasicMaterial({ color: AXIS_COLORS[axis], depthTest: false, transparent: true });
    const r = Math.max(0.8, length * 0.035);
    const head = Math.max(4, length * 0.22);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, length - head, 12), mat);
    shaft.position.y = (length - head) / 2;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 2.6, head, 16), mat);
    cone.position.y = length - head / 2;
    const arrow = new THREE.Group();
    arrow.add(shaft, cone);
    // Cylinders point along +Y; turn them onto the axis.
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    arrow.traverse((o) => (o.renderOrder = 10));
    g.add(arrow);
    const label = textSprite(axis.toUpperCase(), AXIS_COLORS[axis]);
    label.position.copy(dir.clone().multiplyScalar(length + Math.max(4, length * 0.12)));
    label.scale.setScalar(Math.max(9, length * 0.3));
    g.add(label);
  }
  return g;
}

function textSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeText(text, 32, 34);
  ctx.fillStyle = color;
  ctx.fillText(text, 32, 34);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sprite.renderOrder = 11;
  return sprite;
}
const OVERHANG = new THREE.Color(0xe5484d);

/** Builds a display geometry with per-face colors (faces flagged 2 are overhangs). */
export function buildGeometry(tris: Float32Array, faces: Uint8Array | null): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  const colors = new Float32Array(tris.length);
  for (let t = 0; t < tris.length / 9; t++) {
    const c = faces?.[t] === 2 ? OVERHANG : BASE;
    for (let v = 0; v < 3; v++) colors.set([c.r, c.g, c.b], t * 9 + v * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** The 3D plate: bed, build volume and parts; orbit with the mouse/fingers, drag parts on the bed. */
export class PlateScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 5, 20000);
  private controls: OrbitControls;
  private bedGroup = new THREE.Group();
  private partAxes: THREE.Group | null = null;
  private objects = new Map<string, { mesh: THREE.Mesh; obj: SceneObject }>();
  private raycaster = new THREE.Raycaster();
  private resize: ResizeObserver;
  private bed: Bed | null = null;
  private frame = 0;
  private sized = false;
  mode: PointerMode = 'none';
  private drag: { key: string; dx: number; dy: number } | null = null;
  private down: { x: number; y: number } | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly handlers: Handlers,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-0.5, -1, 1.5);
    this.scene.add(sun, this.bedGroup);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.pointerDown);
    el.addEventListener('pointermove', this.pointerMove);
    el.addEventListener('pointerup', this.pointerUp);
    el.addEventListener('pointercancel', this.pointerUp);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    for (const { mesh } of this.objects.values()) (mesh.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  setBed(bed: Bed, isDark: boolean) {
    const same = this.bed && JSON.stringify(this.bed) === JSON.stringify(bed);
    this.bed = bed;
    this.bedGroup.clear();
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(bed.width, bed.depth),
      new THREE.MeshStandardMaterial({ color: isDark ? 0x3a3a38 : 0xd9d7cf, roughness: 1 }),
    );
    plate.position.set(bed.x0 + bed.width / 2, bed.y0 + bed.depth / 2, -0.5);
    const lines: number[] = [];
    for (let x = Math.ceil(bed.x0 / 10) * 10; x <= bed.x0 + bed.width; x += 10) lines.push(x, bed.y0, -0.1, x, bed.y0 + bed.depth, -0.1);
    for (let y = Math.ceil(bed.y0 / 10) * 10; y <= bed.y0 + bed.depth; y += 10) lines.push(bed.x0, y, -0.1, bed.x0 + bed.width, y, -0.1);
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)),
      new THREE.LineBasicMaterial({ color: isDark ? 0x55554f : 0xa9a79e }),
    );
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(bed.width, bed.depth, bed.height)),
      new THREE.LineBasicMaterial({ color: isDark ? 0x55554f : 0xb5b3aa, transparent: true, opacity: 0.6 }),
    );
    box.position.set(bed.x0 + bed.width / 2, bed.y0 + bed.depth / 2, bed.height / 2);
    const origin = axesGizmo(Math.max(30, Math.min(bed.width, bed.depth) * 0.15));
    origin.position.set(bed.x0, bed.y0, 0);
    this.bedGroup.add(plate, grid, box, origin);
    if (!same) this.resetView();
    this.render();
  }

  setObjects(list: SceneObject[]) {
    const keep = new Set(list.map((o) => o.key));
    for (const [key, { mesh }] of this.objects) {
      if (!keep.has(key)) {
        this.scene.remove(mesh);
        (mesh.material as THREE.Material).dispose();
        this.objects.delete(key);
      }
    }
    for (const obj of list) {
      let entry = this.objects.get(obj.key);
      if (!entry) {
        const mesh = new THREE.Mesh(obj.geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 }));
        this.scene.add(mesh);
        entry = { mesh, obj };
        this.objects.set(obj.key, entry);
      }
      entry.obj = obj;
      const { mesh } = entry;
      if (mesh.geometry !== obj.geometry) mesh.geometry = obj.geometry;
      if (this.drag?.key !== obj.key) mesh.position.set(obj.x, obj.y, 0);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.set(obj.invalid ? 0xff8080 : 0xffffff);
      mat.emissive.set(obj.selected ? 0x553311 : 0x000000);
    }
    this.render();
  }

  /** Axes through the selected part's center (null hides them). */
  setPartAxes(at: { x: number; y: number; z: number; size: number } | null) {
    if (this.partAxes) {
      this.scene.remove(this.partAxes);
      this.partAxes = null;
    }
    if (at) {
      this.partAxes = axesGizmo(Math.max(15, at.size * 0.6 + 8));
      this.partAxes.position.set(at.x, at.y, at.z);
      this.scene.add(this.partAxes);
    }
    this.render();
  }

  /** Front-left view of the whole bed. */
  resetView(top = false) {
    const b = this.bed;
    if (!b) return;
    const cx = b.x0 + b.width / 2;
    const cy = b.y0 + b.depth / 2;
    // Distance at which the whole build volume (bounding sphere) fits the narrower side of the view.
    const radius = Math.hypot(b.width, b.depth, top ? 0 : b.height) / 2;
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const dist = (radius / Math.sin(fit / 2)) * 1.02;
    const tz = top ? 0 : b.height * 0.25;
    this.controls.target.set(cx, cy, tz);
    const dir = top ? new THREE.Vector3(0, -0.001, 1) : new THREE.Vector3(-0.15, -1, 0.75);
    dir.normalize().multiplyScalar(dist);
    this.camera.position.set(cx + dir.x, cy + dir.y, tz + dir.z);
    this.controls.update();
    this.render();
  }

  render() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderer.render(this.scene, this.camera));
  }

  private fit() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    const first = this.camera.aspect === 1 && !this.sized;
    this.sized = true;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (first) this.resetView();
    this.render();
  }

  private ray(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    return this.raycaster;
  }

  private hit(e: PointerEvent) {
    const meshes = [...this.objects.values()].map((o) => o.mesh);
    const hit = this.ray(e).intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const entry = [...this.objects.values()].find((o) => o.mesh === hit.object)!;
    return { entry, hit };
  }

  private onBed(e: PointerEvent): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    return this.ray(e).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), p);
  }

  private pointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
    if (this.mode !== 'move') return;
    const h = this.hit(e);
    const p = h && this.onBed(e);
    if (!h || !p) return;
    this.drag = { key: h.entry.obj.key, dx: h.entry.mesh.position.x - p.x, dy: h.entry.mesh.position.y - p.y };
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.handlers.onSelect(h.entry.obj.item);
  };

  private pointerMove = (e: PointerEvent) => {
    if (!this.drag) return;
    const p = this.onBed(e);
    const entry = this.objects.get(this.drag.key);
    if (!p || !entry) return;
    entry.mesh.position.set(p.x + this.drag.dx, p.y + this.drag.dy, 0);
    this.render();
  };

  private pointerUp = (e: PointerEvent) => {
    const click = this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5;
    this.down = null;
    if (this.drag) {
      const entry = this.objects.get(this.drag.key);
      this.drag = null;
      this.controls.enabled = true;
      if (entry && !click) {
        const r = (v: number) => Math.round(v * 10) / 10;
        this.handlers.onMove(entry.obj.item, entry.obj.copy, r(entry.mesh.position.x), r(entry.mesh.position.y));
      }
      return;
    }
    if (!click || e.type === 'pointercancel') return;
    const h = this.hit(e);
    if (h && this.mode === 'face' && h.hit.face) {
      const n = h.hit.face.normal.clone().normalize();
      this.handlers.onFacePick(h.entry.obj.item, [n.x, n.y, n.z]);
      return;
    }
    this.handlers.onSelect(h ? h.entry.obj.item : null);
  };
}
