import * as THREE from 'three';
import { BOARD_RADIUS, HEX_SIZE } from '../utils/config';

export class SceneManager {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  private shadowMapSize = 1024;

  constructor(canvas: HTMLCanvasElement) {
    this.scene = new THREE.Scene();
    // Background is painted by the CSS sky gradient behind the canvas — the
    // renderer stays transparent so that bright, cheerful gradient shows through.
    this.scene.background = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    // Phones and tablets (coarse pointer) get a lower pixel ratio and a smaller
    // shadow map: the extra sharpness is invisible on a small screen but costs
    // a lot of fill-rate and battery.
    const touchDevice = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, touchDevice ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = touchDevice ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.shadowMapSize = touchDevice ? 512 : 1024;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.setupLighting();
  }

  private setupLighting(): void {
    // Bright, soft sky/ground fill: lifts the rounded side walls (lit
    // Lambert) so they read as the same saturated color as the glossy tops
    // instead of a muddy shade of it.
    const hemi = new THREE.HemisphereLight(0xffffff, 0xcfeaff, 2.6);
    this.scene.add(hemi);

    const boardSpan = BOARD_RADIUS * HEX_SIZE * 1.8;
    const dir = new THREE.DirectionalLight(0xfff4e0, 1.7); // warm key light from above-front
    dir.position.set(4, 13, 6);
    dir.castShadow = true;
    dir.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
    dir.shadow.camera.left = -boardSpan;
    dir.shadow.camera.right = boardSpan;
    dir.shadow.camera.top = boardSpan;
    dir.shadow.camera.bottom = -boardSpan;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 30;
    dir.shadow.bias = -0.0025;
    this.scene.add(dir);

    const fill = new THREE.DirectionalLight(0xdbeaff, 0.7); // cool fill from the opposite side
    fill.position.set(-7, 5, -5);
    this.scene.add(fill);
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }

  setShadowQuality(mapSize: number): void {
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.DirectionalLight && obj.castShadow) {
        obj.shadow.mapSize.set(mapSize, mapSize);
        obj.shadow.map?.dispose();
        obj.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      }
    });
  }
}
