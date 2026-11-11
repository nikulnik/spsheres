import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const EXPLOSION_DELAY = 0.6;
const FRAGMENTS_PER_RING = 12;
const GRAVITY = 24;

function createFractureSites(bounds, random) {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const sites = [];
  for (const height of [0.1, 0.46, 0.83]) {
    for (let index = 0; index < FRAGMENTS_PER_RING; index += 1) {
      const angle = (index + random()) * 2 * Math.PI / FRAGMENTS_PER_RING;
      const radius = 0.24 + random() * 0.16;
      sites.push(new THREE.Vector3(
        center.x + Math.cos(angle) * radius * size.x,
        bounds.min.y + (height + (random() - 0.5) * 0.17) * size.y,
        center.z + Math.sin(angle) * radius * size.z,
      ));
    }
  }
  // Include the middle of the saucer and lid so they break along with the walls.
  sites.push(center.clone().setY(bounds.min.y + size.y * 0.06));
  sites.push(center.clone().setY(bounds.min.y + size.y * 0.86));
  return sites;
}

function addFragments(geometry, material, sites, fragments) {
  const triangles = sites.map(() => []);
  const { position } = geometry.attributes;
  const centroid = new THREE.Vector3();
  const corner = new THREE.Vector3();
  for (let vertex = 0; vertex < position.count; vertex += 3) {
    centroid.fromBufferAttribute(position, vertex)
      .add(corner.fromBufferAttribute(position, vertex + 1))
      .add(corner.fromBufferAttribute(position, vertex + 2))
      .multiplyScalar(1 / 3);
    let nearest = 0;
    let nearestDistance = Infinity;
    for (let index = 0; index < sites.length; index += 1) {
      const distance = centroid.distanceToSquared(sites[index]);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    }
    triangles[nearest].push(vertex);
  }

  for (const [index, faces] of triangles.entries()) {
    if (faces.length === 0) continue;
    const fragmentGeometry = new THREE.BufferGeometry();
    // Copy every attribute to keep the cup's baked textures and vertex colors.
    for (const [name, { array, itemSize, normalized }] of Object.entries(geometry.attributes)) {
      const fragmentArray = new array.constructor(faces.length * 3 * itemSize);
      for (const [faceIndex, vertex] of faces.entries()) {
        const start = vertex * itemSize;
        fragmentArray.set(array.subarray(start, start + 3 * itemSize), faceIndex * 3 * itemSize);
      }
      fragmentGeometry.setAttribute(name, new THREE.BufferAttribute(fragmentArray, itemSize, normalized));
    }
    const mesh = new THREE.Mesh(fragmentGeometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    fragments[index].add(mesh);
  }
}

export function createCupExplosion(backdrop, model, onCollision) {
  model.updateWorldMatrix(true, true);
  const worldToBackdrop = backdrop.matrixWorld.clone().invert();
  const localMatrix = new THREE.Matrix4();
  const bounds = new THREE.Box3();
  const materialGeometries = new Map();

  model.traverse((object) => {
    if (!object.isMesh) return;
    const { geometry: source, material } = object;
    const geometry = source.index ? source.toNonIndexed() : source.clone();
    geometry.applyMatrix4(localMatrix.multiplyMatrices(worldToBackdrop, object.matrixWorld));
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox);
    if (!materialGeometries.has(material)) materialGeometries.set(material, []);
    materialGeometries.get(material).push(geometry);
  });

  let seed = 157;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  const sites = createFractureSites(bounds, random);
  const fragments = sites.map(() => new THREE.Group());
  for (const [material, parts] of materialGeometries) {
    const merged = mergeGeometries(parts);
    for (const geometry of merged ? [merged] : parts) {
      addFragments(geometry, material, sites, fragments);
    }
  }

  const debris = new THREE.Group();
  debris.name = 'Cup fragments';
  const center = bounds.getCenter(new THREE.Vector3());
  const height = bounds.max.y - bounds.min.y;
  const shards = [];
  const fragmentBounds = new THREE.Box3();
  for (const fragment of fragments) {
    if (fragment.children.length === 0) continue;
    fragmentBounds.setFromObject(fragment).getCenter(fragment.position);
    for (const mesh of fragment.children) {
      mesh.geometry.translate(-fragment.position.x, -fragment.position.y, -fragment.position.z);
    }
    const heading = Math.atan2(fragment.position.z - center.z, fragment.position.x - center.x)
      + (random() - 0.5) * 0.8;
    const speed = height * (0.66 + random() * 0.65);
    const velocity = new THREE.Vector3(Math.cos(heading) * speed, height * (0.38 + random() * 0.55),
      Math.sin(heading) * speed);
    const spinAxis = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
    const radius = fragmentBounds.getSize(new THREE.Vector3()).length() / 2;
    shards.push({ fragment, velocity, spinAxis, radius, spinSpeed: 2.8 + random() * 5, resting: false });
    debris.add(fragment);
  }

  const rotation = new THREE.Quaternion();
  const up = new THREE.Vector3();
  let movingShards = shards.length;
  let shattered = false;
  let timeAfterSplash = 0;

  return {
    update(delta) {
      if (movingShards === 0) return;
      if (!shattered) {
        timeAfterSplash += delta;
        if (timeAfterSplash < EXPLOSION_DELAY) return;
        shattered = true;
        backdrop.remove(model);
        backdrop.add(debris);
        const { x, z } = backdrop.localToWorld(center);
        onCollision?.({ type: 'cupExplosion', intensity: 1, x, z });
        return;
      }

      const airRetention = Math.exp(-0.78 * delta);
      const groundRetention = Math.exp(-8 * delta);
      for (const shard of shards) {
        if (shard.resting) continue;
        const { fragment, velocity, spinAxis, radius } = shard;
        velocity.multiplyScalar(airRetention);
        velocity.y -= GRAVITY * delta;
        fragment.position.addScaledVector(velocity, delta);
        fragment.quaternion.premultiply(rotation.setFromAxisAngle(spinAxis, shard.spinSpeed * delta));
        if (fragment.position.y > radius) continue;

        // Find the lowest rotated vertex in the backdrop's ground plane.
        up.set(0, 1, 0).applyQuaternion(rotation.copy(fragment.quaternion).invert());
        let lowest = Infinity;
        for (const mesh of fragment.children) {
          const { array } = mesh.geometry.attributes.position;
          for (let i = 0; i < array.length; i += 3) {
            lowest = Math.min(lowest, up.x * array[i] + up.y * array[i + 1] + up.z * array[i + 2]);
          }
        }
        if (fragment.position.y + lowest > 0) continue;
        fragment.position.y = -lowest;
        velocity.y = Math.max(velocity.y, -velocity.y * 0.24);
        if (velocity.y < 0.55) velocity.y = 0;
        velocity.x *= groundRetention;
        velocity.z *= groundRetention;
        shard.spinSpeed *= groundRetention;
        if (velocity.lengthSq() < 0.045 && shard.spinSpeed < 0.16) {
          shard.resting = true;
          movingShards -= 1;
        }
      }
    },
  };
}
