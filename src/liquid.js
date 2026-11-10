import * as THREE from 'three';
import { OBB } from 'three/addons/math/OBB.js';

const DROPLET_COUNT = 220;
const SECONDARY_DROPLET_COUNT = 48;
const POP_DURATION = 0.12;
const PHYSICS_STEP = 1 / 120;
const SHEET_SEGMENTS = 96;
const SHEET_RINGS = 10;
const SHEET_DURATION = 0.68;
const PUDDLE_RINGS = 8;
const GROUND_FILM_Y = 0.028;
const RIM_DRAG = 0.75;
const DOMINO_RESTITUTION = 0.04;
const DOMINO_TANGENT_RETENTION = 0.68;
const SPLASH_EXTENT = 5.15;
const SPLASH_HEIGHT = 2.55;
const TAU = 2 * Math.PI;
const { clamp, lerp, smoothstep } = THREE.MathUtils;

function seededRandom(initialSeed = 811) {
  let seed = initialSeed;

  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function createRadialGeometry(segments, rings) {
  const count = (rings + 1) * segments;
  const indices = [];

  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const inner = ring * segments + segment;
      const next = ring * segments + (segment + 1) % segments;
      indices.push(inner, next, inner + segments, next, next + segments, inner + segments);
    }
  }

  const geometry = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['color', 4]]) {
    const attribute = new THREE.BufferAttribute(new Float32Array(count * size), size);
    geometry.setAttribute(name, attribute.setUsage(THREE.DynamicDrawUsage));
  }
  geometry.setIndex(indices);
  return geometry;
}

function createSplatGeometry() {
  const segments = 16;
  const geometry = createRadialGeometry(segments, 3);
  const { position, normal, color } = geometry.attributes;
  const distances = [0, 0.52, 0.78, 1];
  const opacity = [0.72, 0.62, 0.31, 0];
  for (let ring = 0; ring <= 3; ring += 1) {
    for (let index = 0; index < segments; index += 1) {
      const angle = index / segments * TAU;
      const edge = distances[ring] * (1 + 0.12 * Math.sin(angle * 3 + 0.6) + 0.06 * Math.cos(angle * 5));
      const vertex = ring * segments + index;
      position.setXYZ(vertex, Math.cos(angle) * edge, 0, Math.sin(angle) * edge);
      normal.setXYZ(vertex, 0, 1, 0);
      color.setXYZW(vertex, 0.93, 0.86, 0.91, opacity[ring]);
    }
  }
  return geometry;
}

export function createLiquidBall(parent, { domino, dominoes = [domino], environment }) {
  const radius = domino.height * 0.15;
  const center = new THREE.Vector3(0, radius + 0.025, domino.pivotZ + domino.height * 0.68);
  const gravity = radius * 5;
  const collisionSkin = radius * 0.0015;
  const visual = new THREE.Group();
  visual.position.copy(center);
  parent.add(visual);

  const shellMaterial = new THREE.MeshPhysicalMaterial({
    color: '#ff8dc5',
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.4,
    transmission: 0.28,
    thickness: radius * 0.16,
    ior: 1.34,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    depthWrite: false,
  });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), shellMaterial);
  shell.renderOrder = 2;
  visual.add(shell);

  const liquidMaterial = new THREE.MeshPhysicalMaterial({
    color: '#ff3b9d',
    roughness: 0.16,
    metalness: 0,
    transparent: true,
    opacity: 0.96,
    clearcoat: 0.85,
    clearcoatRoughness: 0.1,
  });
  const liquid = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.88, 40, 28), liquidMaterial);
  liquid.scale.y = 0.94;
  liquid.position.y = -radius * 0.045;
  liquid.castShadow = true;
  liquid.receiveShadow = true;
  visual.add(liquid);

  const fluidMaterial = new THREE.MeshPhysicalMaterial({
    color: '#ff458d',
    roughness: 0.18,
    ior: 1.33,
    clearcoat: 0.72,
    clearcoatRoughness: 0.1,
    envMap: environment ?? null,
    envMapIntensity: 0.38,
  });
  const filmMaterial = fluidMaterial.clone();
  filmMaterial.setValues({
    color: '#d12f63',
    roughness: 0.24,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const puddle = new THREE.Mesh(createRadialGeometry(SHEET_SEGMENTS, PUDDLE_RINGS), filmMaterial);
  puddle.visible = false;
  puddle.receiveShadow = true;
  puddle.frustumCulled = false;
  parent.add(puddle);

  const sheetMaterial = fluidMaterial.clone();
  sheetMaterial.setValues({
    vertexColors: true,
    transparent: true,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    depthWrite: false,
  });
  const sheet = new THREE.Mesh(createRadialGeometry(SHEET_SEGMENTS, SHEET_RINGS), sheetMaterial);
  sheet.visible = false;
  sheet.frustumCulled = false;
  sheet.receiveShadow = true;
  sheet.renderOrder = 1;
  parent.add(sheet);

  const capacity = DROPLET_COUNT + SECONDARY_DROPLET_COUNT;
  const dropletMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 10, 8),
    fluidMaterial,
    capacity,
  );
  dropletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dropletMesh.frustumCulled = false;
  dropletMesh.castShadow = true;
  dropletMesh.receiveShadow = true;
  dropletMesh.visible = false;
  parent.add(dropletMesh);

  const splatMesh = new THREE.InstancedMesh(createSplatGeometry(), filmMaterial, capacity);
  splatMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  splatMesh.frustumCulled = false;
  splatMesh.receiveShadow = true;
  splatMesh.visible = false;
  parent.add(splatMesh);

  const random = seededRandom();
  const particles = Array.from({ length: capacity }, () => ({
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    flow: null,
    releaseTime: 0,
    radius: 0,
    drag: 0,
    active: false,
    onWood: false,
  }));
  const splats = [];
  const flows = [];
  const jets = [];
  const splashOrigin = center.clone().setY(GROUND_FILM_Y);
  const impactVelocity = new THREE.Vector3();
  const relativeVelocity = new THREE.Vector3();
  const transform = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3();
  const closestPoint = new THREE.Vector3();
  const localMatrix = new THREE.Matrix4();
  const inverseParent = new THREE.Matrix4();
  const colliders = dominoes.map((part) => {
    const box = new OBB();
    box.axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    box.domino = part;
    return box;
  });
  const lastCollider = colliders[dominoes.indexOf(domino)];
  const nearbyColliders = [];
  const sheetPoint = new THREE.Vector3();
  const sheetRim = new THREE.Vector3();
  const stepEnd = new THREE.Vector3();
  const sweepDelta = new THREE.Vector3();
  const sweepRelative = new THREE.Vector3();
  const sweepClosest = new THREE.Vector3();
  const sweepOffset = new THREE.Vector3();
  const contactNormal = new THREE.Vector3();
  const contact = {
    time: 0,
    position: new THREE.Vector3(),
    normal: new THREE.Vector3(),
  };
  const bestContact = {
    box: null,
    position: new THREE.Vector3(),
    normal: new THREE.Vector3(),
  };
  const ballBounds = new THREE.Box3(
    new THREE.Vector3(center.x - radius * 1.1, 0, center.z - radius * 1.1),
    new THREE.Vector3(center.x + radius * 1.1, radius * 2.1, center.z + radius * 1.1),
  );
  const splashBounds = new THREE.Box3(
    new THREE.Vector3(center.x - radius * SPLASH_EXTENT, 0, center.z - radius * SPLASH_EXTENT),
    new THREE.Vector3(
      center.x + radius * SPLASH_EXTENT,
      radius * SPLASH_HEIGHT,
      center.z + radius * SPLASH_EXTENT,
    ),
  );
  let burst = false;
  let settled = false;
  let elapsed = 0;
  let accumulator = 0;
  let particleCount = DROPLET_COUNT;
  let impulse = 1;
  let fallDirection = 1;
  let lastSplatTime = 0;
  let depositedVolume = 0;
  let totalDropletVolume = 1;
  let activeDropletCount = 0;
  let dominoImpactCount = 0;
  let puddleRadius = 0;

  function updateCollider(box) {
    const { mesh } = box.domino;
    mesh.updateWorldMatrix(true, false);
    localMatrix.multiplyMatrices(inverseParent, mesh.matrixWorld);
    box.fromBox3(mesh.geometry.boundingBox).applyMatrix4(localMatrix);
    box.rotation.extractBasis(...box.axes);
  }

  function updateColliders() {
    parent.updateWorldMatrix(true, false);
    inverseParent.copy(parent.matrixWorld).invert();
    nearbyColliders.length = 0;
    for (const box of colliders) {
      if (!burst && box !== lastCollider) continue;
      updateCollider(box);
      const reach = box.halfSize.y + box.halfSize.z;
      if (box.center.z + reach >= splashBounds.min.z && box.center.z - reach <= splashBounds.max.z) {
        nearbyColliders.push(box);
      }
    }
  }

  function getImpactVelocity(part, point, target) {
    return target.set(0, -part.angularVelocity * (point.z - part.pivotZ),
      part.pivotVelocity + part.angularVelocity * point.y);
  }

  function createFlow(angle) {
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    const forward = (1 + z * fallDirection) / 2;
    const sideways = x ** 2;
    let crest = 0;
    for (const jet of jets) {
      const offset = Math.atan2(Math.sin(angle - jet.angle), Math.cos(angle - jet.angle));
      crest = Math.max(crest, jet.strength * Math.exp(-0.5 * (offset / jet.width) ** 2));
    }
    const wave = Math.sin(angle * 5 + 0.9) * 0.65 + Math.cos(angle * 9) * 0.35;
    const exposure = Math.max(forward, Math.abs(x) * 0.86);
    return {
      x,
      z,
      crest,
      wave,
      exposure,
      radialSpeed: radius * impulse * (1.15 + 1.63 * sideways + 1.6 * forward + 1.45 * crest),
      liftSpeed: radius * impulse * (0.68 + 0.78 * sideways + 0.5 * forward + 1.6 * crest),
      baseHeight: radius * (0.26 + 0.21 * exposure + 0.13 * crest),
      puddleShape: 0.74 + 0.21 * forward + 0.18 * sideways + 0.12 * crest + 0.07 * wave,
    };
  }

  function sampleRim(flow, time, target, velocityTarget) {
    const drag = Math.exp(-RIM_DRAG * time);
    const squeeze = 0.27 * radius * flow.exposure;
    const squeezeDecay = Math.exp(-12 * time);
    const distance = radius * 0.68 + squeeze * (1 - squeezeDecay)
      + flow.radialSpeed * (1 - drag) / RIM_DRAG;
    target.set(
      splashOrigin.x + flow.x * distance,
      GROUND_FILM_Y + Math.max(0, flow.baseHeight + flow.liftSpeed * time - gravity * time ** 2 / 2),
      splashOrigin.z + flow.z * distance,
    );
    if (velocityTarget) {
      const radialSpeed = flow.radialSpeed * drag + squeeze * 12 * squeezeDecay;
      velocityTarget.set(flow.x * radialSpeed, flow.liftSpeed - gravity * time, flow.z * radialSpeed);
    }
    return distance;
  }

  function pushPointOutside(point, clearance, box) {
    box.clampPoint(point, sweepClosest);
    sweepOffset.subVectors(point, sweepClosest);
    const distanceSquared = sweepOffset.lengthSq();
    if (distanceSquared > 1e-12) {
      if (distanceSquared >= clearance * clearance) return false;
      point.copy(sweepClosest).addScaledVector(sweepOffset, clearance / Math.sqrt(distanceSquared));
      return true;
    }

    sweepRelative.subVectors(point, box.center);
    let smallestDepth = Infinity;
    contactNormal.set(0, 1, 0);
    for (let axisIndex = 0; axisIndex < 3; axisIndex += 1) {
      const axis = box.axes[axisIndex];
      const projection = sweepRelative.dot(axis);
      const depth = box.halfSize.getComponent(axisIndex) - Math.abs(projection);
      if (depth < smallestDepth) {
        smallestDepth = depth;
        contactNormal.copy(axis).multiplyScalar(projection < 0 ? -1 : 1);
      }
    }
    point.addScaledVector(contactNormal, Math.max(0, smallestDepth) + clearance);
    return true;
  }

  function sweepSphere(start, end, particleRadius, box, hit) {
    sweepDelta.subVectors(end, start);
    sweepRelative.subVectors(start, box.center);
    let enter = 0;
    let leave = 1;
    let startsInside = true;
    let hasNormal = false;

    for (let axisIndex = 0; axisIndex < 3; axisIndex += 1) {
      const axis = box.axes[axisIndex];
      const startProjection = sweepRelative.dot(axis);
      const movement = sweepDelta.dot(axis);
      const extent = box.halfSize.getComponent(axisIndex) + particleRadius;
      if (Math.abs(startProjection) > extent) startsInside = false;

      if (Math.abs(movement) < 1e-10) {
        if (Math.abs(startProjection) > extent) return false;
        continue;
      }

      const entryExtent = movement > 0 ? -extent : extent;
      const exitExtent = -entryExtent;
      const entryTime = (entryExtent - startProjection) / movement;
      const exitTime = (exitExtent - startProjection) / movement;
      if (entryTime > enter) {
        enter = entryTime;
        hit.normal.copy(axis).multiplyScalar(movement > 0 ? -1 : 1);
        hasNormal = true;
      }
      leave = Math.min(leave, exitTime);
      if (enter > leave) return false;
    }

    if (enter > 1 || leave < 0) return false;
    if (startsInside || !hasNormal) {
      box.clampPoint(start, sweepClosest);
      sweepOffset.subVectors(start, sweepClosest);
      const distanceSquared = sweepOffset.lengthSq();
      if (distanceSquared > 1e-12) {
        const distance = Math.sqrt(distanceSquared);
        if (distance > particleRadius + collisionSkin) return false;
        hit.normal.copy(sweepOffset).multiplyScalar(1 / distance);
        if (sweepDelta.dot(hit.normal) >= 0) return false;
        hit.position.copy(sweepClosest).addScaledVector(hit.normal, particleRadius + collisionSkin);
      } else {
        hit.position.copy(start);
        pushPointOutside(hit.position, particleRadius + collisionSkin, box);
        hit.normal.subVectors(hit.position, start);
        if (hit.normal.lengthSq() < 1e-12) return false;
        hit.normal.normalize();
      }
      hit.time = 0;
      return true;
    }

    hit.time = enter;
    hit.position.lerpVectors(start, end, enter).addScaledVector(hit.normal, collisionSkin);
    return true;
  }

  function depositParticle(particle, canSpray) {
    particle.active = false;
    particle.position.y = GROUND_FILM_Y;
    const distance = particle.position.distanceTo(splashOrigin) / radius;
    const speed = Math.hypot(particle.velocity.x, particle.velocity.z);
    const impact = Math.max(0, -particle.velocity.y);
    const angle = Math.atan2(particle.velocity.z, particle.velocity.x);
    depositedVolume += particle.radius ** 3 * (1 - smoothstep(distance, 1.1, 2.45));

    // Distant drops leave their own marks instead of dragging out the edge of the pool.
    if (distance > 1.15) {
      splats.push({
        position: particle.position,
        angle,
        time: elapsed,
        size: particle.radius * (1.36 + 0.56 * clamp(impact / (radius * 2.5), 0, 1)),
        stretch: 1 + 0.57 * clamp(speed / (radius * 2), 0, 1),
      });
      lastSplatTime = elapsed;
    }

    if (!canSpray || particle.radius < radius * 0.043 || impact < radius * 1.6) return;
    for (let index = 0; index < 2 && particleCount < capacity; index += 1) {
      const spray = particles[particleCount++];
      const heading = angle + (index === 0 ? -1 : 1) * (0.48 + random() * 0.7);
      const ejection = (speed * 0.26 + impact * 0.18) * (0.74 + random() * 0.5);
      spray.radius = particle.radius * (0.22 + random() * 0.17);
      spray.position.copy(particle.position).addScaledVector(up, spray.radius * 0.82);
      spray.velocity.set(Math.cos(heading) * ejection, impact * (0.19 + random() * 0.14),
        Math.sin(heading) * ejection);
      spray.releaseTime = elapsed;
      spray.drag = 2.6;
      spray.active = true;
    }
  }

  function resolveDominoImpact(particle, { box, normal }) {
    const part = box.domino;
    getImpactVelocity(part, particle.position, impactVelocity);
    relativeVelocity.subVectors(particle.velocity, impactVelocity);
    const normalSpeed = relativeVelocity.dot(normal);
    if (normalSpeed >= 0) return;
    dominoImpactCount += 1;
    if (normal.y > 0.95 && impactVelocity.lengthSq() < (radius * 0.012) ** 2) {
      particle.active = false;
      particle.onWood = true;
      particle.velocity.copy(normal);
      particle.position.addScaledVector(normal, -particle.radius * 0.75);
      return;
    }
    particle.velocity.copy(relativeVelocity).addScaledVector(normal, -normalSpeed)
      .multiplyScalar(DOMINO_TANGENT_RETENTION).add(impactVelocity)
      .addScaledVector(normal, -DOMINO_RESTITUTION * normalSpeed);
  }

  function moveParticle(particle, delta, canSpray) {
    const speed = particle.velocity.length() / radius;
    const drag = Math.exp(-(particle.drag + speed * 0.32) * delta);
    particle.velocity.y -= gravity * delta;
    particle.velocity.multiplyScalar(drag);
    let remaining = delta;

    for (let iteration = 0; iteration < 4 && remaining > 1e-7; iteration += 1) {
      stepEnd.copy(particle.position).addScaledVector(particle.velocity, remaining);
      const groundHeight = GROUND_FILM_Y + particle.radius * 0.67;
      let earliest = Infinity;
      let groundContact = false;
      if (stepEnd.y <= groundHeight && particle.velocity.y <= 0) {
        earliest = clamp(
          (groundHeight - particle.position.y) / (stepEnd.y - particle.position.y || -1),
          0,
          1,
        );
        groundContact = true;
      }

      bestContact.box = null;
      for (const box of nearbyColliders) {
        if (!sweepSphere(particle.position, stepEnd, particle.radius, box, contact)) continue;
        if (contact.time >= earliest) continue;
        earliest = contact.time;
        bestContact.box = box;
        bestContact.position.copy(contact.position);
        bestContact.normal.copy(contact.normal);
        groundContact = false;
      }

      if (earliest === Infinity) {
        particle.position.copy(stepEnd);
        return;
      }
      if (groundContact) {
        particle.position.lerp(stepEnd, earliest);
        depositParticle(particle, canSpray);
        return;
      }
      particle.position.copy(bestContact.position);
      resolveDominoImpact(particle, bestContact);
      if (!particle.active) return;
      remaining *= 1 - earliest;
    }
  }

  function pop(point) {
    burst = true;
    puddle.visible = true;
    sheet.visible = true;
    totalDropletVolume = 0;
    getImpactVelocity(domino, point, impactVelocity);
    impulse = clamp(0.82 - impactVelocity.y / radius * 0.085, 0.8, 1.2);
    fallDirection = Math.sign(impactVelocity.z) || 1;
    splashOrigin.z = lerp(center.z, point.z, 0.3);

    const jetCount = 9;
    for (let index = 0; index < jetCount; index += 1) {
      const angle = (index + (random() - 0.5) * 0.78) / jetCount * TAU;
      const forward = (1 + Math.sin(angle) * fallDirection) / 2;
      const exposure = Math.max(forward, 0.88 * Math.abs(Math.cos(angle)));
      jets.push({
        angle,
        width: 0.085 + random() * 0.13,
        strength: (0.76 + random() * 0.32) * (0.35 + 0.65 * exposure) + 0.18 * forward,
      });
    }
    for (let index = 0; index < SHEET_SEGMENTS; index += 1) {
      flows.push(createFlow(index / SHEET_SEGMENTS * TAU));
    }
    for (let index = 0; index < DROPLET_COUNT; index += 1) {
      const particle = particles[index];
      const jet = jets[index % jetCount];
      const freeSpray = index % 4 === 0;
      const angle = freeSpray ? random() * TAU : jet.angle + (random() - random()) * jet.width * 2.2;
      particle.flow = createFlow(angle);
      const size = 0.012 + random() ** 1.7 * (freeSpray ? 0.042 : 0.074);
      particle.radius = radius * size;
      particle.drag = lerp(2.7, 0.66, smoothstep(size, 0.01, 0.076));
      particle.releaseTime = freeSpray ? 0.02 + random() * 0.13
        : 0.085 + 0.105 * particle.flow.crest + random() ** 1.3 * 0.19;
      particle.speedFactor = 0.68 + random() * 0.67;
      particle.kick = (random() - 0.43) * radius * 0.95;
      particle.tangent = (random() - 0.5) * radius * 0.62;
      totalDropletVolume += particle.radius ** 3;
    }
  }

  function simulateStep(delta) {
    const stepStart = elapsed;
    elapsed += delta;
    activeDropletCount = 0;
    const count = particleCount;
    for (let index = 0; index < count; index += 1) {
      const particle = particles[index];
      let travelTime = delta;
      if (particle.flow) {
        if (elapsed < particle.releaseTime) continue;
        const flow = particle.flow;
        sampleRim(flow, particle.releaseTime, particle.position, particle.velocity);
        particle.velocity.multiplyScalar(particle.speedFactor);
        particle.velocity.x -= flow.z * particle.tangent;
        particle.velocity.z += flow.x * particle.tangent;
        particle.velocity.y += particle.kick;
        particle.flow = null;
        particle.active = true;
        travelTime = elapsed - Math.max(stepStart, particle.releaseTime);
        for (const box of nearbyColliders) {
          pushPointOutside(particle.position, particle.radius + collisionSkin, box);
        }
      }
      if (!particle.active) continue;
      moveParticle(particle, travelTime, index < DROPLET_COUNT);
      if (particle.active) activeDropletCount += 1;
    }
    activeDropletCount += particleCount - count;
  }

  function updatePuddleGeometry() {
    const { position, color } = puddle.geometry.attributes;
    const fill = Math.sqrt(clamp(depositedVolume / totalDropletVolume, 0, 1));
    const spreadProgress = 1 - (1 - clamp(elapsed / 1.55, 0, 1)) ** 2.65;
    const spread = radius * (0.47 + 2.14 * spreadProgress + 0.25 * fill);
    const centerZ = splashOrigin.z + fallDirection * radius * 0.65 * smoothstep(elapsed, 0.05, 0.95);
    const waveFade = 1 - smoothstep(elapsed, 0.18, 1.65);
    puddleRadius = 0;
    for (let segment = 0; segment < SHEET_SEGMENTS; segment += 1) {
      const { x, z, puddleShape, wave } = flows[segment];
      const edge = spread * puddleShape;
      puddleRadius = Math.max(puddleRadius, edge);
      for (let ring = 0; ring <= PUDDLE_RINGS; ring += 1) {
        const fraction = ring / PUDDLE_RINGS;
        const distance = edge * fraction;
        const phase = distance / radius - elapsed * 2.15;
        const ripple = Math.sin(18 * phase + 0.3 * wave) * Math.exp(-5 * phase ** 2) * waveFade;
        const thickness = (0.012 + ripple * 0.009) * (1 - fraction ** 2);
        const feather = 1 - smoothstep(fraction, 0.68, 1);
        const vertex = ring * SHEET_SEGMENTS + segment;
        position.setXYZ(vertex, splashOrigin.x + x * distance, GROUND_FILM_Y + radius * thickness,
          centerZ + z * distance);
        color.setXYZW(vertex, 0.96, 0.76 + 0.17 * feather, 0.85 + 0.12 * feather,
          feather * (0.74 + 0.045 * ripple));
      }
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    puddle.geometry.computeVertexNormals();
  }

  function updateSheetGeometry() {
    const { position, color } = sheet.geometry.attributes;
    const reveal = 0.4 + 0.6 * smoothstep(elapsed, 0, 0.075);
    for (let segment = 0; segment < SHEET_SEGMENTS; segment += 1) {
      const flow = flows[segment];
      const rimDistance = sampleRim(flow, elapsed, sheetRim);
      const innerRadius = Math.min(puddleRadius * 0.69, rimDistance * 0.57);
      const sheetFade = smoothstep(elapsed, 0.09 + flow.crest * 0.11, 0.25 + flow.crest * 0.17);
      const rimFade = smoothstep(elapsed, 0.19 + flow.crest * 0.16, 0.35 + flow.crest * 0.29);
      for (let ring = 0; ring <= SHEET_RINGS; ring += 1) {
        const fraction = ring / SHEET_RINGS;
        const lip = smoothstep(fraction, 0.68, 1);
        const radialDistance = lerp(innerRadius, rimDistance, fraction);
        const ripple = Math.sin(fraction * 13 - elapsed * 21 + flow.wave * 1.5);
        const height = (sheetRim.y - GROUND_FILM_Y) * fraction ** 2.3
          * (1 + ripple * 0.12 * (1 - lip));
        sheetPoint.set(
          splashOrigin.x + flow.x * radialDistance,
          GROUND_FILM_Y + height,
          splashOrigin.z + flow.z * radialDistance,
        );
        let opacity = reveal * flow.exposure * lerp(1 - sheetFade, 1 - rimFade, lip)
          * smoothstep(fraction, 0.02, 0.28) * (0.65 + 0.27 * lip);
        for (const box of nearbyColliders) {
          box.clampPoint(sheetPoint, closestPoint);
          opacity *= smoothstep(sheetPoint.distanceToSquared(closestPoint), 0, (radius * 0.095) ** 2);
        }
        const vertex = ring * SHEET_SEGMENTS + segment;
        position.setXYZ(vertex, sheetPoint.x, sheetPoint.y, sheetPoint.z);
        color.setXYZW(vertex, 0.99, 0.67 + 0.33 * lip, 0.81 + 0.19 * lip, opacity);
      }
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    sheet.geometry.computeVertexNormals();
  }

  function updateDropletGeometry() {
    let visibleCount = 0;
    for (let index = 0; index < particleCount; index += 1) {
      const particle = particles[index];
      if (!particle.active && !particle.onWood) continue;
      transform.position.copy(particle.position);
      direction.copy(particle.velocity).normalize();
      if (direction.lengthSq() === 0) direction.copy(up);
      transform.quaternion.setFromUnitVectors(up, direction);
      if (particle.onWood) {
        transform.scale.set(particle.radius * 1.36, particle.radius * 0.27, particle.radius * 1.25);
      } else {
        const strand = 1 - smoothstep(elapsed - particle.releaseTime, 0.015, 0.19);
        const stretch = 1 + strand * (0.68 + particle.radius / radius * 17)
          + 0.32 * clamp(particle.velocity.length() / (radius * 3.5), 0, 1);
        const width = particle.radius / Math.sqrt(stretch);
        transform.scale.set(width, particle.radius * stretch, width);
      }
      transform.updateMatrix();
      dropletMesh.setMatrixAt(visibleCount++, transform.matrix);
    }
    dropletMesh.count = visibleCount;
    dropletMesh.visible = visibleCount > 0;
    if (dropletMesh.visible) dropletMesh.instanceMatrix.needsUpdate = true;
  }

  function updateSplatGeometry() {
    for (let index = 0; index < splats.length; index += 1) {
      const { position, angle, time, size, stretch } = splats[index];
      const spread = size * (0.52 + 0.48 * smoothstep(elapsed - time, 0, 0.22));
      transform.position.copy(position);
      transform.quaternion.setFromAxisAngle(up, -angle);
      transform.scale.set(spread * stretch, 1, spread);
      transform.updateMatrix();
      splatMesh.setMatrixAt(index, transform.matrix);
    }
    splatMesh.count = splats.length;
    splatMesh.visible = splats.length > 0;
    if (splatMesh.visible) splatMesh.instanceMatrix.needsUpdate = true;
  }

  return {
    get burst() {
      return burst;
    },
    get settled() {
      return settled;
    },
    get activeDropletCount() {
      return activeDropletCount;
    },
    get dominoImpactCount() {
      return dominoImpactCount;
    },
    get puddleRadius() {
      return puddleRadius;
    },
    getBounds(target) {
      parent.updateWorldMatrix(true, false);
      const reveal = burst ? 1 : smoothstep(domino.angle, 0.36, 1.05);
      target.min.lerpVectors(ballBounds.min, splashBounds.min, reveal);
      target.max.lerpVectors(ballBounds.max, splashBounds.max, reveal);
      return target.applyMatrix4(parent.matrixWorld);
    },
    update(delta) {
      if (settled || (!burst && domino.angle <= 0)) return;
      updateColliders();

      if (!burst) {
        lastCollider.clampPoint(center, closestPoint);
        if (closestPoint.distanceToSquared(center) > radius ** 2) return;
        pop(closestPoint);
      }

      accumulator += delta;
      while (accumulator >= PHYSICS_STEP) {
        simulateStep(PHYSICS_STEP);
        accumulator -= PHYSICS_STEP;
      }

      const popProgress = smoothstep(elapsed, 0, POP_DURATION);
      visual.scale.set(1 + popProgress * 0.15, 1 - popProgress * 0.74, 1 + popProgress * 0.15);
      visual.position.y = center.y - radius * popProgress * 0.74;
      shellMaterial.opacity = (1 - smoothstep(elapsed, 0, POP_DURATION * 0.65)) * 0.4;
      liquidMaterial.opacity = (1 - popProgress) * 0.96;
      if (popProgress === 1) visual.visible = false;

      sheet.visible = elapsed < SHEET_DURATION;
      updatePuddleGeometry();
      if (sheet.visible) updateSheetGeometry();
      updateDropletGeometry();
      updateSplatGeometry();
      if (activeDropletCount === 0 && elapsed >= Math.max(1.65, lastSplatTime + 0.22)) settled = true;
    },
  };
}
