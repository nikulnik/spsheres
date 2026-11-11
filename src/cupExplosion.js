import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const EXPLOSION_DELAY = 0.6;
const FRAGMENTS_PER_RING = 12;
const GRAVITY = 9.81;
const GROUND_RESTITUTION = 0.24;
const GROUND_FRICTION = 0.48;
const MIN_BOUNCE_SPEED = 1.6;
const GROUND_ROLL_RESISTANCE = 6.5;
const SLEEP_SPEED = 0.4;
const SLEEP_SPIN = 0.14;
const FRAME_LOOK_AHEAD = 0.45;

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
  const launchSpeed = Math.sqrt(GRAVITY * height);
  // Direct the burst into the backdrop and past the smaller cups.
  const backDrift = Math.sign(center.x) * launchSpeed * 1.05;
  const forwardDrift = launchSpeed * 0.55;
  const shards = [];
  const fragmentBounds = new THREE.Box3();
  const fragmentSize = new THREE.Vector3();
  for (const fragment of fragments) {
    if (fragment.children.length === 0) continue;
    fragmentBounds.setFromObject(fragment).getCenter(fragment.position);
    for (const mesh of fragment.children) {
      mesh.geometry.translate(-fragment.position.x, -fragment.position.y, -fragment.position.z);
    }
    const heading = Math.atan2(fragment.position.z - center.z, fragment.position.x - center.x)
      + (random() - 0.5) * 0.8;
    const radius = fragmentBounds.getSize(fragmentSize).length() / 2;
    const relativeSize = Math.min(radius / (height * 0.29), 1);
    // Smaller pieces launch and spin faster, with more air resistance.
    const speed = launchSpeed * (1.5 + random() * 1.08) * (1.15 - relativeSize * 0.34);
    const lift = launchSpeed * (0.28 + random() ** 1.4 * 0.83) * (1.04 - relativeSize * 0.3);
    const velocity = new THREE.Vector3(
      Math.cos(heading) * speed * 0.7 + backDrift,
      lift,
      Math.sin(heading) * speed + forwardDrift,
    );
    const spin = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
    spin.multiplyScalar((3.4 + random() * 5.2) * (1.35 - relativeSize * 0.64));
    shards.push({
      fragment,
      velocity,
      spin,
      radius,
      drag: 0.25 + (1 - relativeSize) * 0.39,
      inverseInertia: 2.5 / Math.max(radius ** 2, 1e-6),
      resting: false,
    });
    debris.add(fragment);
  }

  const rotation = new THREE.Quaternion();
  const groundNormal = new THREE.Vector3(0, 1, 0);
  const localUp = new THREE.Vector3();
  const spinAxis = new THREE.Vector3();
  const contact = new THREE.Vector3();
  const contactVelocity = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const torque = new THREE.Vector3();
  const frameCorner = new THREE.Vector3();
  let movingShards = shards.length;
  let shattered = false;
  let timeAfterSplash = 0;

  // Use impulses and rotational inertia per unit mass for each shard.
  function applyImpulse(shard, direction, speedChange, limit = Infinity) {
    torque.crossVectors(contact, direction);
    const inverseContactMass = 1 + torque.lengthSq() * shard.inverseInertia;
    const impulse = Math.min(speedChange / inverseContactMass, limit);
    shard.velocity.addScaledVector(direction, impulse);
    shard.spin.addScaledVector(torque, impulse * shard.inverseInertia);
    return impulse;
  }

  function resolveGroundContact(shard, delta) {
    const { fragment, velocity, spin, radius } = shard;
    if (fragment.position.y > radius) return;

    // The lowest vertex of the rotated shard gives the actual point of impact.
    localUp.copy(groundNormal).applyQuaternion(rotation.copy(fragment.quaternion).invert());
    let lowest = Infinity;
    for (const mesh of fragment.children) {
      const { array } = mesh.geometry.attributes.position;
      for (let index = 0; index < array.length; index += 3) {
        const x = array[index];
        const y = array[index + 1];
        const z = array[index + 2];
        const projection = localUp.x * x + localUp.y * y + localUp.z * z;
        if (projection >= lowest) continue;
        lowest = projection;
        contact.set(x, y, z);
      }
    }
    if (fragment.position.y + lowest > 0) return;

    fragment.position.y = -lowest;
    contact.applyQuaternion(fragment.quaternion);
    contactVelocity.crossVectors(spin, contact).add(velocity);
    const normalSpeed = contactVelocity.y;
    if (normalSpeed < 0) {
      const bounce = normalSpeed < -MIN_BOUNCE_SPEED ? GROUND_RESTITUTION : 0;
      const impulse = applyImpulse(shard, groundNormal, -(1 + bounce) * normalSpeed);
      contactVelocity.crossVectors(spin, contact).add(velocity);
      tangent.set(-contactVelocity.x, 0, -contactVelocity.z);
      const slipSpeed = tangent.length();
      if (slipSpeed > 1e-6) {
        tangent.multiplyScalar(1 / slipSpeed);
        applyImpulse(shard, tangent, slipSpeed, GROUND_FRICTION * impulse);
      }
    }

    if (velocity.y > MIN_BOUNCE_SPEED) return;
    const rollRetention = Math.exp(-GROUND_ROLL_RESISTANCE * delta);
    velocity.x *= rollRetention;
    velocity.z *= rollRetention;
    spin.multiplyScalar(rollRetention);
    const spinSpeedSq = spin.lengthSq();
    const slowSpin = spinSpeedSq < SLEEP_SPIN ** 2 || spinSpeedSq * radius ** 2 < SLEEP_SPEED ** 2;
    if (velocity.lengthSq() < SLEEP_SPEED ** 2 && slowSpin) {
      velocity.set(0, 0, 0);
      spin.set(0, 0, 0);
      shard.resting = true;
      movingShards -= 1;
    }
  }

  return {
    getBounds(target) {
      target.copy(bounds);
      const reveal = THREE.MathUtils.smoothstep(timeAfterSplash, 0, EXPLOSION_DELAY);
      if (reveal > 0) {
        for (const { fragment, velocity, radius } of shards) {
          const { x, y, z } = fragment.position;
          const dx = velocity.x * FRAME_LOOK_AHEAD;
          const dz = velocity.z * FRAME_LOOK_AHEAD;
          const riseTime = THREE.MathUtils.clamp(velocity.y / GRAVITY, 0, FRAME_LOOK_AHEAD);
          const apex = y + (velocity.y - GRAVITY * riseTime / 2) * riseTime;
          target.expandByPoint(frameCorner.set(
            x + Math.min(0, dx) - radius, 0, z + Math.min(0, dz) - radius,
          ));
          target.expandByPoint(frameCorner.set(
            x + Math.max(0, dx) + radius, apex + radius, z + Math.max(0, dz) + radius,
          ));
        }
        target.min.lerp(bounds.min, 1 - reveal);
        target.max.lerp(bounds.max, 1 - reveal);
      }
      backdrop.updateWorldMatrix(true, false);
      return target.applyMatrix4(backdrop.matrixWorld);
    },
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

      for (const shard of shards) {
        if (shard.resting) continue;
        const { fragment, velocity, spin, drag } = shard;
        velocity.multiplyScalar(Math.exp(-drag * delta));
        velocity.y -= GRAVITY * delta;
        fragment.position.addScaledVector(velocity, delta);
        spin.multiplyScalar(Math.exp(-drag * 0.35 * delta));
        const angularSpeed = spin.length();
        if (angularSpeed > 1e-8) {
          spinAxis.copy(spin).multiplyScalar(1 / angularSpeed);
          fragment.quaternion.premultiply(rotation.setFromAxisAngle(spinAxis, angularSpeed * delta));
        }
        resolveGroundContact(shard, delta);
      }
    },
  };
}
