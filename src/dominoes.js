import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { OBB } from 'three/addons/math/OBB.js';

export const DOMINO_CONFIG = Object.freeze({
  count: 12,
  scaleFactor: 1.5,
  width: 0.34,
  height: 0.62,
  depth: 0.14,
  spacingRatio: 0.78,
});

const GRAVITY = 9.81;
const FALLEN_ANGLE = Math.PI / 2;
const INITIAL_TIP_SPEED = 4;
const BOARD_CONTACT_OVERLAP = 0.03;
const COLLISION_ITERATIONS = 8;
const RESTITUTION = 0.06;
const GROUND_FRICTION = 0.45;
const POSITION_CORRECTION = 0.8;
const PENETRATION_SLOP = 1e-5;
const DOMINO_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#6366f1',
  '#f43f5e',
];

function updateRectangle(domino) {
  const cosine = Math.cos(domino.angle);
  const sine = Math.sin(domino.angle);
  domino.axisY.y = cosine;
  domino.axisY.z = sine;
  domino.axisZ.y = -sine;
  domino.axisZ.z = cosine;
  domino.center.y = domino.height / 2 * cosine + domino.depth / 2 * sine;
  domino.center.z = domino.pivotZ + domino.height / 2 * sine - domino.depth / 2 * cosine;

  for (let index = 0; index < 4; index += 1) {
    const verticalSign = index & 1 ? 1 : -1;
    const depthSign = index & 2 ? 1 : -1;
    const verticalOffset = verticalSign * domino.height / 2;
    const depthOffset = depthSign * domino.depth / 2;
    const corner = domino.corners[index];
    corner.y = domino.center.y
      + verticalOffset * domino.axisY.y + depthOffset * domino.axisZ.y;
    corner.z = domino.center.z
      + verticalOffset * domino.axisY.z + depthOffset * domino.axisZ.z;
  }
}

function projectRadius(domino, axis) {
  return domino.height / 2 * Math.abs(
    domino.axisY.y * axis.y + domino.axisY.z * axis.z,
  ) + domino.depth / 2 * Math.abs(
    domino.axisZ.y * axis.y + domino.axisZ.z * axis.z,
  );
}

function findContact(first, second, contact) {
  const differenceY = second.center.y - first.center.y;
  const differenceZ = second.center.z - first.center.z;
  let minimumOverlap = Infinity;
  let normalY = 0;
  let normalZ = 1;

  for (const axis of [first.axisY, first.axisZ, second.axisY, second.axisZ]) {
    const projection = differenceY * axis.y + differenceZ * axis.z;
    const overlap = projectRadius(first, axis) + projectRadius(second, axis) - Math.abs(projection);
    if (overlap < 0) return false;
    if (overlap < minimumOverlap) {
      minimumOverlap = overlap;
      const sign = projection < 0 ? -1 : 1;
      normalY = axis.y * sign;
      normalZ = axis.z * sign;
    }
  }

  const supportEpsilon = Math.max(first.height, second.height) * 1e-7;
  let firstBest = -Infinity;
  let secondBest = Infinity;
  let firstSupportY = 0;
  let firstSupportZ = 0;
  let secondSupportY = 0;
  let secondSupportZ = 0;
  let firstSupportCount = 0;
  let secondSupportCount = 0;

  for (const corner of first.corners) {
    const projection = corner.y * normalY + corner.z * normalZ;
    if (projection > firstBest + supportEpsilon) {
      firstBest = projection;
      firstSupportY = corner.y;
      firstSupportZ = corner.z;
      firstSupportCount = 1;
    } else if (Math.abs(projection - firstBest) <= supportEpsilon) {
      firstSupportY += corner.y;
      firstSupportZ += corner.z;
      firstSupportCount += 1;
    }
  }

  for (const corner of second.corners) {
    const projection = corner.y * normalY + corner.z * normalZ;
    if (projection < secondBest - supportEpsilon) {
      secondBest = projection;
      secondSupportY = corner.y;
      secondSupportZ = corner.z;
      secondSupportCount = 1;
    } else if (Math.abs(projection - secondBest) <= supportEpsilon) {
      secondSupportY += corner.y;
      secondSupportZ += corner.z;
      secondSupportCount += 1;
    }
  }

  contact.normalY = normalY;
  contact.normalZ = normalZ;
  contact.penetration = minimumOverlap;
  contact.y = (firstSupportY / firstSupportCount + secondSupportY / secondSupportCount) / 2;
  contact.z = (firstSupportZ / firstSupportCount + secondSupportZ / secondSupportCount) / 2;
  return true;
}

function resolveContact(first, second, contact) {
  const firstOffsetY = contact.y;
  const firstOffsetZ = contact.z - first.pivotZ;
  const secondOffsetY = contact.y;
  const secondOffsetZ = contact.z - second.pivotZ;
  const firstLeverage = firstOffsetY * contact.normalZ - firstOffsetZ * contact.normalY;
  const secondLeverage = secondOffsetY * contact.normalZ - secondOffsetZ * contact.normalY;
  const firstFactor = firstLeverage * first.inverseInertia;
  const secondFactor = secondLeverage * second.inverseInertia;
  const normalSpeedSquared = contact.normalZ ** 2;
  const denominator = (first.inverseMass + second.inverseMass) * normalSpeedSquared
    + firstLeverage * firstFactor + secondLeverage * secondFactor;
  if (denominator < 1e-12) return 0;

  let impactImpulse = 0;
  const relativeNormalSpeed = (second.pivotVelocity - first.pivotVelocity) * contact.normalZ
    + second.angularVelocity * secondLeverage - first.angularVelocity * firstLeverage;
  if (relativeNormalSpeed < 0) {
    const impulse = -(1 + RESTITUTION) * relativeNormalSpeed / denominator;
    first.pivotVelocity -= impulse * contact.normalZ * first.inverseMass;
    second.pivotVelocity += impulse * contact.normalZ * second.inverseMass;
    first.angularVelocity -= impulse * firstFactor;
    second.angularVelocity += impulse * secondFactor;
    impactImpulse = impulse;
  }

  const correction = Math.max(contact.penetration - PENETRATION_SLOP, 0)
    * POSITION_CORRECTION / denominator;
  if (correction > 0) {
    first.pivotZ -= correction * contact.normalZ * first.inverseMass;
    second.pivotZ += correction * contact.normalZ * second.inverseMass;
    first.angle = THREE.MathUtils.clamp(first.angle - correction * firstFactor, 0, FALLEN_ANGLE);
    second.angle = THREE.MathUtils.clamp(second.angle + correction * secondFactor, 0, FALLEN_ANGLE);
    updateRectangle(first);
    updateRectangle(second);
  }
  return impactImpulse;
}

export function createDominoChain(scene, { origin, direction, groundY, material, onCollision }) {
  const { count, scaleFactor, width, height, depth, spacingRatio } = DOMINO_CONFIG;
  const group = new THREE.Group();
  const chainDirection = direction.clone().setY(0).normalize();
  group.position.copy(origin);
  group.position.y = groundY;
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), chainDirection);
  scene.add(group);

  const geometry = new RoundedBoxGeometry(width, height, depth, 2, 0.018);
  geometry.computeBoundingBox();
  const dominoes = [];
  const impactedDominoes = new Uint8Array(count);
  const boardCollider = new OBB();
  const firstCollider = new OBB();
  const contact = {};
  const collisionPosition = new THREE.Vector3();
  let centerDistance = 0;
  let previousHeight = 0;
  let started = false;
  let complete = false;
  let cameraExtent = 2;

  for (let index = 0; index < count; index += 1) {
    const scale = scaleFactor ** index;
    if (index > 0) centerDistance += previousHeight * spacingRatio;
    const scaledHeight = height * scale;
    const scaledDepth = depth * scale;
    const pivot = new THREE.Group();
    pivot.position.z = centerDistance + scaledDepth / 2;
    pivot.scale.setScalar(scale);

    const dominoMaterial = material.clone();
    dominoMaterial.color.set(DOMINO_COLORS[index % DOMINO_COLORS.length]);
    const mesh = new THREE.Mesh(geometry, dominoMaterial);
    mesh.position.set(0, height / 2, -depth / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pivot.add(mesh);
    group.add(pivot);

    const mass = scale ** 1.25;
    const domino = {
      pivot,
      mesh,
      scale,
      height: scaledHeight,
      depth: scaledDepth,
      pivotZ: pivot.position.z,
      inverseMass: 0.15 / mass,
      inverseInertia: 3 / (mass * (scaledHeight ** 2 + scaledDepth ** 2)),
      angle: 0,
      angularVelocity: 0,
      pivotVelocity: 0,
      center: { y: 0, z: 0 },
      axisY: { y: 1, z: 0 },
      axisZ: { y: 0, z: 1 },
      corners: Array.from({ length: 4 }, () => ({ y: 0, z: 0 })),
    };
    updateRectangle(domino);
    dominoes.push(domino);
    previousHeight = scaledHeight;
  }

  group.updateMatrixWorld(true);
  const last = dominoes[count - 1];
  const finalLocalBounds = new THREE.Box3(
    new THREE.Vector3(-width * last.scale / 2, 0, -depth / 2),
    new THREE.Vector3(
      width * last.scale / 2,
      last.height,
      centerDistance + last.depth / 2 + last.height,
    ),
  );

  function updateCollider(domino, target) {
    domino.mesh.updateWorldMatrix(true, false);
    target.fromBox3(geometry.boundingBox).applyMatrix4(domino.mesh.matrixWorld);
  }

  const cameraBounds = new THREE.Box3();

  return {
    group,
    dominoes,
    get started() {
      return started;
    },
    get lastStarted() {
      return last.angle > 0;
    },
    get complete() {
      return complete;
    },
    getFinalBounds(target) {
      group.updateWorldMatrix(true, false);
      return target.copy(finalLocalBounds).applyMatrix4(group.matrixWorld);
    },
    getCameraBounds(target) {
      const lastIndex = Math.min(count - 1, Math.floor(cameraExtent));
      target.setFromObject(dominoes[0].mesh);
      for (let index = 1; index <= lastIndex; index += 1) {
        target.union(cameraBounds.setFromObject(dominoes[index].mesh));
      }
      if (lastIndex < count - 1) {
        // Reveal the next domino gradually instead of adding its whole bounds at once.
        cameraBounds.setFromObject(dominoes[lastIndex + 1].mesh).union(target);
        const fraction = cameraExtent - lastIndex;
        target.min.lerp(cameraBounds.min, fraction);
        target.max.lerp(cameraBounds.max, fraction);
      }
      return target;
    },
    update(delta, board) {
      group.updateMatrixWorld(true);

      if (!started) {
        if (!board) return;
        board.updateMatrixWorld(true);
        boardCollider.fromBox3(board.geometry.boundingBox).applyMatrix4(board.matrixWorld);
        updateCollider(dominoes[0], firstCollider);
        if (!boardCollider.intersectsOBB(firstCollider)) return;
        started = true;
        dominoes[0].angularVelocity = INITIAL_TIP_SPEED;
      }

      for (const domino of dominoes) {
        if (domino.angle === 0 && domino.angularVelocity === 0 && domino.pivotVelocity === 0) continue;
        const frictionDelta = GROUND_FRICTION * GRAVITY * delta;
        domino.pivotVelocity = Math.sign(domino.pivotVelocity)
          * Math.max(0, Math.abs(domino.pivotVelocity) - frictionDelta);
        domino.pivotZ += domino.pivotVelocity * delta;
        const gravityTorque = domino.height * Math.sin(domino.angle)
          - domino.depth * Math.cos(domino.angle);
        const angularAcceleration = 3 * GRAVITY * gravityTorque
          / (2 * (domino.height ** 2 + domino.depth ** 2));
        domino.angularVelocity += angularAcceleration * delta;
        domino.angle += domino.angularVelocity * delta;

        if (domino.angle >= FALLEN_ANGLE) {
          domino.angle = FALLEN_ANGLE;
          if (domino.angularVelocity > 0) domino.angularVelocity = 0;
        } else if (domino.angle <= 0) {
          domino.angle = 0;
          if (domino.angularVelocity < 0) domino.angularVelocity = 0;
        }
        updateRectangle(domino);
      }

      for (let iteration = 0; iteration < COLLISION_ITERATIONS; iteration += 1) {
        for (let firstIndex = 0; firstIndex < count - 1; firstIndex += 1) {
          for (let secondIndex = firstIndex + 1; secondIndex < count; secondIndex += 1) {
            const first = dominoes[firstIndex];
            const second = dominoes[secondIndex];
            if (!findContact(first, second, contact)) continue;
            const impact = resolveContact(first, second, contact);
            if (impact > 0 && !impactedDominoes[secondIndex]) {
              impactedDominoes[secondIndex] = 1;
              collisionPosition.set(0, contact.y, contact.z).applyMatrix4(group.matrixWorld);
              onCollision?.({
                type: 'domino',
                index: secondIndex,
                intensity: 1,
                x: collisionPosition.x,
                z: collisionPosition.z,
              });
            }
          }
        }
      }

      for (const domino of dominoes) {
        domino.pivot.position.z = domino.pivotZ;
        domino.pivot.rotation.x = domino.angle;
      }
      let activeIndex = 0;
      for (let index = 1; index < count; index += 1) {
        if (dominoes[index].angle > 0) activeIndex = index;
      }
      cameraExtent = THREE.MathUtils.damp(
        cameraExtent,
        Math.min(count - 1, activeIndex + 2),
        3,
        delta,
      );
      group.updateMatrixWorld(true);
      if (last.angle >= FALLEN_ANGLE) complete = true;
    },
  };
}

export function getFirstDominoOrigin(board, direction, groundY) {
  board.updateMatrixWorld(true);
  const { min, max } = board.geometry.boundingBox;
  const corner = new THREE.Vector3();
  const worldCorner = new THREE.Vector3();
  const relativeCorner = new THREE.Vector3();
  const contact = new THREE.Vector3();
  let lowestY = Infinity;

  for (let index = 0; index < 8; index += 1) {
    corner.set(
      index & 1 ? max.x : min.x,
      index & 2 ? max.y : min.y,
      index & 4 ? max.z : min.z,
    );
    worldCorner.copy(corner).applyMatrix4(board.matrixWorld);
    relativeCorner.subVectors(worldCorner, board.position);
    if (relativeCorner.dot(direction) < -1e-5 || worldCorner.y >= lowestY) continue;
    lowestY = worldCorner.y;
    contact.copy(worldCorner);
  }

  contact.y = groundY;
  return contact.addScaledVector(direction, DOMINO_CONFIG.depth / 2 - BOARD_CONTACT_OVERLAP);
}
