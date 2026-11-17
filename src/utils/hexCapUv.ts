import * as THREE from 'three';

/** CylinderGeometry's cap UV generation inscribes the (correctly
 * proportioned) hex inside a UNIT SQUARE using one shared radius for both
 * axes: U spans the full [0,1] range (matches the vertex-to-vertex
 * diameter), but V only spans roughly [0.067, 0.933] (matches the SHORTER
 * flat-edge-to-flat-edge diameter, 2/sqrt(3) narrower than the U extent).
 * Any hex-cap artwork that's cropped tight to its own hex's true bounding
 * box — touching all 4 canvas edges, as ours all are — never gets that
 * ~6.7% margin on each side of V sampled at all, silently cropping away
 * the outermost strip of the art (borders/bevels/glows are usually drawn
 * right at that edge) along the flat-edge sides. Rescaling V around its
 * center by 2/sqrt(3) makes the sampled region reach the full image on
 * both axes, matching how the art is actually cropped, so the rendered
 * hex shows the complete design instead of a cropped/distorted one.
 *
 * Only the top/bottom cap vertices (materialIndex 1 and 2 in the geometry's
 * groups) are touched — a plain CylinderGeometry's side wall uses its own,
 * unrelated UV parametrization and is left alone.
 *
 * `zoom` (default 1, i.e. no effect) additionally scales both U and V
 * around center for artwork whose hex silhouette has rounded corners that
 * fall short of a true hex vertex — without it, the cap's sharp corners
 * would show a transparent notch where the art's rounding recedes.
 * Zooming in samples further inside the source image at every corner and
 * edge, past where the rounding cuts in, so the cap reads as a fully-filled
 * hex. Calibrate per-art: the smallest value (closest to 1) that still
 * samples opaque pixels at all 6 corners and along every edge. */
export function fixHexCapUvAspectRatio(geometry: THREE.CylinderGeometry, zoom = 1): void {
  const V_SCALE = 2 / Math.sqrt(3);
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const index = geometry.getIndex();
  if (!index) return;
  const adjusted = new Set<number>();
  for (const group of geometry.groups) {
    if (group.materialIndex === 0) continue; // side wall — its own UVs are unaffected
    for (let i = group.start; i < group.start + group.count; i++) {
      const vi = index.getX(i);
      if (adjusted.has(vi)) continue;
      adjusted.add(vi);
      uv.setX(vi, 0.5 + (uv.getX(vi) - 0.5) * zoom);
      uv.setY(vi, 0.5 + (uv.getY(vi) - 0.5) * V_SCALE * zoom);
    }
  }
  uv.needsUpdate = true;
}
