// Wczytywanie modeli STL/3MF: wymiary + podgląd 3D.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const ACCENT = 0xfa6831;

// Zwraca obiekt three.js w układzie drukarki (Z do góry, milimetry).
export function parseModel(buffer, extension) {
  if (extension === 'stl') {
    const geometry = new STLLoader().parse(buffer);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.6, side: THREE.DoubleSide }));
  }
  const group = new ThreeMFLoader().parse(buffer);
  group.traverse((node) => {
    if (!node.isMesh) return;
    if (!node.geometry.attributes.normal) node.geometry.computeVertexNormals();
    node.material = new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.6, side: THREE.DoubleSide });
  });
  return group;
}

export function measure(object) {
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  return [size.x, size.y, size.z];
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.replaceChildren(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 2, 1.5);
    this.scene.add(sun);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: hgt } = this.container;
    if (!w || !hgt) return;
    this.renderer.setSize(w, hgt);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  // volume: [x, y, z] pola roboczego drukarki albo null.
  show(object, volume) {
    if (this.root) this.scene.remove(this.root);
    this.root = new THREE.Group();
    this.root.rotation.x = -Math.PI / 2; // Z drukarki -> góra ekranu

    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    object.position.sub(new THREE.Vector3(center.x, center.y, box.min.z)); // na środek stołu
    this.root.add(object);
    this.object = object;
    this.scene.add(this.root);
    this.setVolume(volume);

    const size = box.getSize(new THREE.Vector3());
    const reach = Math.max(size.x, size.y, size.z, 40, volume ? Math.max(volume[0], volume[1]) * 0.85 : 0);
    this.controls.target.set(0, size.z / 2, 0);
    this.camera.position.set(reach * 1.3, size.z / 2 + reach * 1.0, reach * 1.6);
    this.camera.near = reach / 100;
    this.camera.far = reach * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }

  setVolume(volume) {
    if (!this.root) return;
    if (this.bed) this.root.remove(this.bed);
    this.bed = null;
    if (volume) {
      const [x, y, z] = volume;
      this.bed = new THREE.Group();
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(x, y),
        new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.25, side: THREE.DoubleSide }),
      );
      plate.position.z = -0.05;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(x, y, z)),
        new THREE.LineBasicMaterial({ color: 0x888888 }),
      );
      edges.position.z = z / 2;
      this.bed.add(plate, edges);
      this.root.add(this.bed);
    }
    this.render();
  }
}
