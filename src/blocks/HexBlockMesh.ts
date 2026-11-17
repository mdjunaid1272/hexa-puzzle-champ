import * as THREE from 'three';
import { BLOCK_HEIGHT, COLORS, HEX_SIZE } from '../utils/config';

// Every tile, of every color, at every layer, shares this ONE geometry
// object: a flat-top hexagonal prism with softly rounded vertical corners and
// a smooth rounded bevel on its top and bottom edges. TILE_APOTHEM is the
// distance from the tile's center to the middle of a flat side (a sharp hex of
// circumradius HEX_SIZE * 0.9 has this apothem), so tiles still sit flush
// against their neighbours along every flat edge.
const TILE_APOTHEM = HEX_SIZE * 0.9 * Math.cos(Math.PI / 6);
const CORNER_RADIUS = 0.16; // vertical-corner rounding of the outer wall
const BEVEL = 0.035; // radius of the rounded top/bottom edge
const CORNER_SEGMENTS = 8; // arc smoothness per rounded corner
const BEVEL_SEGMENTS = 6; // arc smoothness per bevel

// Every tile's top face uses a hand-supplied glossy-hex image instead of a
// flat material color — one per color, in the SAME order as COLORS in
// config.ts (index-for-index, not matched by name/hex).
const TILE_TEXTURE_URLS = [
  // File names are inconsistent; matched by each image's actual color:
  // Y-1 = yellow, yello-1 = orange, P-1 = pink, Purp-1 = purple, Cyn-1 = cyan.
  new URL('../../img/color blocks/Y-1.png', import.meta.url).href, // sunflower
  new URL('../../img/color blocks/Blue-1.png', import.meta.url).href, // sky
  new URL('../../img/color blocks/Red-1.png', import.meta.url).href, // cherry
  new URL('../../img/color blocks/P-1.png', import.meta.url).href, // punch
  new URL('../../img/color blocks/Green-1.png', import.meta.url).href, // leaf
  new URL('../../img/color blocks/yello-1.png', import.meta.url).href, // tangerine
  new URL('../../img/color blocks/Purp-1.png', import.meta.url).href, // violet
  new URL('../../img/color blocks/Cyn-1.png', import.meta.url).href // aqua
];

export interface BlockGeometries {
  tile: THREE.BufferGeometry;
}

interface OutlinePoint {
  x: number;
  z: number;
  nx: number; // outward unit normal of the outline at this point (in the xz plane)
  nz: number;
}

/** Closed outline of a flat-top hexagon (vertices on +/-X) with the given
 * apothem and rounded corners of the given radius. Normals are exact and
 * continuous (flat edges and arcs share the same normal where they meet), so
 * the wall shades smoothly around the whole tile. */
function roundedHexOutline(apothem: number, cornerRadius: number): OutlinePoint[] {
  const circumradius = apothem / Math.cos(Math.PI / 6);
  const c = Math.max(cornerRadius, 0.0005);
  const centerDist = circumradius - c / Math.sin(Math.PI / 3); // corner-arc center, along the vertex direction
  const pts: OutlinePoint[] = [];
  for (let k = 0; k < 6; k++) {
    const theta = (k * Math.PI) / 3;
    const cx = Math.cos(theta) * centerDist;
    const cz = Math.sin(theta) * centerDist;
    for (let s = 0; s <= CORNER_SEGMENTS; s++) {
      const a = theta - Math.PI / 6 + (s / CORNER_SEGMENTS) * (Math.PI / 3);
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      pts.push({ x: cx + nx * c, z: cz + nz * c, nx, nz });
    }
  }
  return pts;
}

// Art mapping for the top-face texture. The glossy-glass art (1772x1602, all
// 8 colors identical in layout) fills its image: opaque from x 16..1748 and
// y 20..1576, centered at pixel (882, 798), with rounded corners. The hex is
// a little taller than a regular one, so the u and v radii are fitted
// separately (vertex-to-vertex 1732px wide, flat edges 1556px apart).
const ART_W = 1772;
const ART_H = 1602;
// The art paints its own rim and corner highlight around the edge of the hex.
// The 3D bevel now provides the rim, so the cap samples only the flat inner
// face of the art (INNER_FACE of its full size) — no double frame, no baked
// highlight blob in one corner.
const INNER_FACE = 0.8;
const ART_RU = (866 / ART_W) * INNER_FACE; // half the sampled hex width, in uv units
const ART_RV = (778 / 0.8660254 / ART_H) * INNER_FACE; // vertical radius equivalent to the circumradius, in uv units
const ART_U0 = 882 / ART_W;
const ART_V0 = 1 - 798 / ART_H; // three.js v runs bottom-up

/** Hand-built rounded-hex prism with smooth normals, carrying the SAME 3
 * material groups CylinderGeometry itself would (0 = side wall incl. bevels,
 * 1 = top cap, 2 = bottom cap), so every other file that consumes
 * `BlockGeometries` (materialsFor, buildBlockGroup, setBlockColor,
 * AnimationManager, BlockManager) needs zero changes — from their side this
 * is still just "one geometry, one mesh, 3 material slots."
 *
 * The wall is a stack of identical outlines: a top bevel (quarter circle,
 * normal swinging from up to sideways), the straight wall, and a mirrored
 * bottom bevel. The top cap's outline is the first (innermost) bevel ring, and
 * its uvs are a planar projection of the cap's own x/z, scaled so the art's
 * outline lands exactly on the cap's outline. */
export function createBlockGeometries(): BlockGeometries {
  const halfHeight = BLOCK_HEIGHT / 2;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const groups: { start: number; count: number; materialIndex: number }[] = [];

  // Profile rings, top to bottom. phi = 90deg at the flat cap, 0 on the wall.
  interface Ring {
    inset: number;
    y: number;
    cosPhi: number; // horizontal share of the surface normal
    sinPhi: number; // vertical share (positive = up, negative = down)
    brightness: number; // baked soft top-to-bottom shading multiplier
  }
  const rings: Ring[] = [];
  for (let s = 0; s <= BEVEL_SEGMENTS; s++) {
    const phi = (Math.PI / 2) * (1 - s / BEVEL_SEGMENTS);
    rings.push({ inset: BEVEL * (1 - Math.cos(phi)), y: halfHeight - BEVEL + BEVEL * Math.sin(phi), cosPhi: Math.cos(phi), sinPhi: Math.sin(phi), brightness: 1 });
  }
  for (let s = 0; s <= BEVEL_SEGMENTS; s++) {
    const phi = (Math.PI / 2) * (s / BEVEL_SEGMENTS);
    rings.push({ inset: BEVEL * (1 - Math.cos(phi)), y: -(halfHeight - BEVEL + BEVEL * Math.sin(phi)), cosPhi: Math.cos(phi), sinPhi: -Math.sin(phi), brightness: 0.78 });
  }
  // Gentle gradient down the wall so the sides read as lit from above even
  // before scene lighting: brightest at the top bevel, softly darker below.
  rings.forEach((ring) => {
    const t = (halfHeight - ring.y) / BLOCK_HEIGHT; // 0 at top, 1 at bottom
    ring.brightness = 1 - 0.28 * t; // each thin layer shows a light rim fading to a darker lower edge
  });

  const ringIndices: number[][] = rings.map((ring) => {
    const outline = roundedHexOutline(TILE_APOTHEM - ring.inset, Math.max(CORNER_RADIUS - ring.inset, 0.0005));
    const row: number[] = [];
    for (const p of outline) {
      positions.push(p.x, ring.y, p.z);
      normals.push(p.nx * ring.cosPhi, ring.sinPhi, p.nz * ring.cosPhi);
      uvs.push(0, 0);
      colors.push(ring.brightness, ring.brightness, ring.brightness);
      row.push(positions.length / 3 - 1);
    }
    return row;
  });

  const ringLength = ringIndices[0].length;

  const sideStart = indices.length;
  for (let r = 0; r < rings.length - 1; r++) {
    const top = ringIndices[r];
    const bottom = ringIndices[r + 1];
    for (let j = 0; j < ringLength; j++) {
      const j2 = (j + 1) % ringLength;
      const a = top[j];
      const b = bottom[j];
      const c = bottom[j2];
      const d = top[j2];
      indices.push(a, d, b, b, d, c);
    }
  }
  groups.push({ start: sideStart, count: indices.length - sideStart, materialIndex: 0 });

  // Cap outline = the ring at the flat end of each bevel (top: first ring,
  // bottom: last ring).
  const capCircumradiusRef = (TILE_APOTHEM - BEVEL) / Math.cos(Math.PI / 6); // sharp-hex radius the art's outline is fitted to
  function buildCap(sign: 1 | -1, materialIndex: number): void {
    const start = indices.length;
    const ring = rings[sign === 1 ? 0 : rings.length - 1];
    const outline = roundedHexOutline(TILE_APOTHEM - ring.inset, Math.max(CORNER_RADIUS - ring.inset, 0.0005));
    const uvOf = (x: number, z: number): [number, number] => [ART_U0 + (x / capCircumradiusRef) * ART_RU, ART_V0 - sign * (z / capCircumradiusRef) * ART_RV];

    const centerIndex = positions.length / 3;
    positions.push(0, sign * halfHeight, 0);
    normals.push(0, sign, 0);
    uvs.push(ART_U0, ART_V0);
    colors.push(1, 1, 1);

    const ringStart = positions.length / 3;
    for (const p of outline) {
      positions.push(p.x, sign * halfHeight, p.z);
      normals.push(0, sign, 0);
      const [u, v] = uvOf(p.x, p.z);
      uvs.push(u, v);
      colors.push(1, 1, 1);
    }
    for (let j = 0; j < outline.length; j++) {
      const i = ringStart + j;
      const i2 = ringStart + ((j + 1) % outline.length);
      if (sign === 1) indices.push(centerIndex, i2, i);
      else indices.push(centerIndex, i, i2);
    }
    groups.push({ start, count: indices.length - start, materialIndex });
  }

  buildCap(1, 1);
  buildCap(-1, 2);

  const tile = new THREE.BufferGeometry();
  tile.setIndex(indices);
  tile.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  tile.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  tile.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  tile.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  for (const g of groups) tile.addGroup(g.start, g.count, g.materialIndex);

  return { tile };
}

/** Top-face material, one per color, shared across every block instance of
 * that color. MeshBasicMaterial (unlit): the glossy art already has its
 * highlights and shading painted in, so scene lighting on top of it would
 * double-shade it and stop it matching the uploaded image. The rounded-corner
 * transparent pixels are cut by alphaTest. */
export function createTopMaterials(): THREE.MeshBasicMaterial[] {
  const loader = new THREE.TextureLoader();

  return COLORS.map((_hex, i) => {
    const texture = loader.load(TILE_TEXTURE_URLS[i]);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8; // keeps the art sharp at the board's tilted camera angle
    const material = new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5 });
    softenTexture(material, COLORS[i]);
    return material;
  });
}

/** Softer finish: pulls each sampled texel part of the way toward the
 * color's flat base tone, which tames the art's strong white highlight and
 * edge contrast while keeping its gentle gradient and rounded outline. */
const SOFTEN_AMOUNT = 0.7; // flat saturated top with only a gentle gradient
function softenTexture(material: THREE.MeshBasicMaterial, baseHex: number): void {
  const base = new THREE.Color(baseHex); // THREE converts the hex to linear working space
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSoftBase = { value: new THREE.Vector3(base.r, base.g, base.b) };
    shader.uniforms.uSoftAmount = { value: SOFTEN_AMOUNT };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSoftBase;\nuniform float uSoftAmount;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, uSoftBase, uSoftAmount);');
  };
}

/** Side-wall/bottom material: lit (Lambert) so the smooth rounded walls pick
 * up the scene's key, fill and hemisphere light and shade naturally around the
 * bevels. vertexColors carries a soft baked top-to-bottom gradient on top of
 * the lighting. */
export function createBaseMaterials(): THREE.MeshLambertMaterial[] {
  return COLORS.map((hex) => new THREE.MeshLambertMaterial({ color: new THREE.Color(hex), vertexColors: true }));
}

function materialsFor(topMaterials: THREE.Material[], baseMaterials: THREE.Material[], colorIndex: number): THREE.Material[] {
  // Matches the geometry's [side, top cap, bottom cap] group order.
  // The bottom cap shares the top-face material so a tile mid page-flip (upside
  // down) shows the same face as when upright.
  return [baseMaterials[colorIndex], topMaterials[colorIndex], topMaterials[colorIndex]];
}

export function buildBlockGroup(geometries: BlockGeometries, topMaterials: THREE.Material[], baseMaterials: THREE.Material[], colorIndex: number): THREE.Group {
  const group = new THREE.Group();

  const tile = new THREE.Mesh(geometries.tile, materialsFor(topMaterials, baseMaterials, colorIndex));
  tile.castShadow = false;
  tile.receiveShadow = true;
  tile.name = 'tile';
  group.add(tile);

  return group;
}

export function setBlockColor(group: THREE.Group, topMaterials: THREE.Material[], baseMaterials: THREE.Material[], colorIndex: number): void {
  const tile = group.getObjectByName('tile') as THREE.Mesh;
  tile.material = materialsFor(topMaterials, baseMaterials, colorIndex);
  tile.scale.set(1, 1, 1);
  const resetOpacity = (m: THREE.Material) => {
    m.transparent = false;
    (m as THREE.MeshStandardMaterial).opacity = 1;
  };
  (tile.material as THREE.Material[]).forEach(resetOpacity);
}
