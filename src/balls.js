import * as THREE from 'three';

export const BALL_CONFIG = Object.freeze({
  radius: 0.44,
  speed: 9.2,
  splitAngle: THREE.MathUtils.degToRad(16),
  splitCooldown: 0.16,
});

const FLOOR_TOP = 0.03;
const FIXED_STEP = 1 / 120;
const MAX_FRAME_DELTA = 0.25;
const IMPACT_DURATION = 0.48;
const COLLISION_ITERATIONS = 8;
const CONTACT_EPSILON = 1e-6;
const RESTITUTION = 1;
const MIN_INWARD_SPEED = BALL_CONFIG.speed * 0.22;
const PACKED_FILL_RATIO = 0.72;
const PRESSURE_IMPACTS_TO_BREAK = 4;
const OUTSIDE_FRICTION = 1.4;
const BALL_COLORS = [
  { color: '#42bffc', emissive: '#062c46' },
  { color: '#ff5c8a', emissive: '#461024' },
  { color: '#ffd166', emissive: '#463608' },
];

export function createBallSystem(scene, { frameWidth, courtDepth, environment, onBreakout }) {
  const { radius, speed, splitAngle, splitCooldown } = BALL_CONFIG;
  const xLimit = frameWidth / 2 - 0.26 - radius;
  const zLimit = courtDepth / 2 - 0.26 - radius;
  const balls = [];
  const impacts = [];
  const sphereGeometry = new THREE.SphereGeometry(radius, 48, 32);
  const sphereMaterials = BALL_COLORS.map(({ color, emissive }) => new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.18,
    roughness: 0.16,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    iridescence: 0.85,
    iridescenceIOR: 1.35,
    iridescenceThicknessMinimum: 120,
    iridescenceThicknessMaximum: 420,
    emissive,
    emissiveIntensity: 0.22,
    envMap: environment ?? null,
    envMapIntensity: 1.3,
  }));
  const impactGeometry = new THREE.RingGeometry(radius * 0.85, radius * 0.97, 48);
  const rollingAxis = new THREE.Vector3();
  const pressure = { north: 0, south: 0, east: 0, west: 0 };
  let accumulator = 0;
  let opening;
  let nextColorIndex = 0;

  function createBall(x, z, velocityX, velocityZ, isNewborn = false) {
    const mesh = new THREE.Mesh(sphereGeometry, sphereMaterials[nextColorIndex]);
    nextColorIndex = (nextColorIndex + 1) % sphereMaterials.length;
    mesh.position.set(x, FLOOR_TOP + radius, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    return {
      mesh,
      velocity: new THREE.Vector2(velocityX, velocityZ),
      splitCooldown: isNewborn ? splitCooldown : 0,
      splitting: false,
    };
  }

  function createImpact(x, z) {
    const material = new THREE.MeshBasicMaterial({
      color: '#a5edff',
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(impactGeometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, FLOOR_TOP + 0.012, z);
    mesh.scale.setScalar(0.45);
    scene.add(mesh);
    impacts.push({ mesh, age: 0 });
  }

  function collideWithWalls(ball) {
    const { position } = ball.mesh;
    let normalX = 0;
    let normalZ = 0;
    let side;

    if (position.x >= xLimit && opening?.side !== 'east') {
      position.x = xLimit;
      if (ball.velocity.x > 0) {
        normalX = -1;
        side = 'east';
      }
    } else if (position.x <= -xLimit && opening?.side !== 'west') {
      position.x = -xLimit;
      if (ball.velocity.x < 0) {
        normalX = 1;
        side = 'west';
      }
    }

    if (position.z >= zLimit && opening?.side !== 'south') {
      position.z = zLimit;
      if (ball.velocity.y > 0) {
        normalZ = -1;
        side = 'south';
      }
    } else if (position.z <= -zLimit && opening?.side !== 'north') {
      position.z = -zLimit;
      if (ball.velocity.y < 0) {
        normalZ = 1;
        side = 'north';
      }
    }

    if (normalX === 0 && normalZ === 0) return null;

    const normalLength = Math.hypot(normalX, normalZ);
    normalX /= normalLength;
    normalZ /= normalLength;
    const dot = ball.velocity.x * normalX + ball.velocity.y * normalZ;

    return {
      side,
      normalX,
      normalZ,
      velocityX: ball.velocity.x - 2 * dot * normalX,
      velocityZ: ball.velocity.y - 2 * dot * normalZ,
    };
  }

  function resolveBallCollisions() {
    const diameter = radius * 2;
    const diameterSquared = diameter * diameter;

    for (let iteration = 0; iteration < COLLISION_ITERATIONS; iteration += 1) {
      for (let firstIndex = 0; firstIndex < balls.length - 1; firstIndex += 1) {
        const first = balls[firstIndex];

        for (let secondIndex = firstIndex + 1; secondIndex < balls.length; secondIndex += 1) {
          const second = balls[secondIndex];
          const dx = second.mesh.position.x - first.mesh.position.x;
          const dz = second.mesh.position.z - first.mesh.position.z;
          const distanceSquared = dx * dx + dz * dz;
          if (distanceSquared > diameterSquared) continue;

          let distance = 0;
          let normalX = 1;
          let normalZ = 0;

          if (distanceSquared > 1e-12) {
            distance = Math.sqrt(distanceSquared);
            normalX = dx / distance;
            normalZ = dz / distance;
          } else {
            const relativeX = second.velocity.x - first.velocity.x;
            const relativeZ = second.velocity.y - first.velocity.y;
            const relativeLength = Math.hypot(relativeX, relativeZ);
            if (relativeLength > 0) {
              normalX = -relativeX / relativeLength;
              normalZ = -relativeZ / relativeLength;
            }
          }

          const correction = (diameter - distance + CONTACT_EPSILON) / 2;
          first.mesh.position.x -= normalX * correction;
          first.mesh.position.z -= normalZ * correction;
          second.mesh.position.x += normalX * correction;
          second.mesh.position.z += normalZ * correction;

          const relativeX = second.velocity.x - first.velocity.x;
          const relativeZ = second.velocity.y - first.velocity.y;
          const normalVelocity = relativeX * normalX + relativeZ * normalZ;
          if (normalVelocity >= 0) continue;

          const impulse = (-(1 + RESTITUTION) * normalVelocity) / 2;
          first.velocity.x -= impulse * normalX;
          first.velocity.y -= impulse * normalZ;
          second.velocity.x += impulse * normalX;
          second.velocity.y += impulse * normalZ;
        }
      }

      for (const ball of balls) {
        const collision = collideWithWalls(ball);
        if (collision) ball.velocity.set(collision.velocityX, collision.velocityZ);
      }
    }
  }

  function isOutside(ball, margin = 0) {
    if (!opening) return false;
    const { x, z } = ball.mesh.position;
    if (opening.side === 'east') return x > xLimit + margin;
    if (opening.side === 'west') return x < -xLimit - margin;
    if (opening.side === 'south') return z > zLimit + margin;
    return z < -zLimit - margin;
  }

  function applyOpeningMotion(delta) {
    if (!opening) return;
    const outwardX = opening.side === 'east' ? 1 : opening.side === 'west' ? -1 : 0;
    const outwardZ = opening.side === 'south' ? 1 : opening.side === 'north' ? -1 : 0;

    for (const ball of balls) {
      if (isOutside(ball)) {
        ball.velocity.multiplyScalar(Math.exp(-OUTSIDE_FRICTION * delta));
        if (ball.velocity.lengthSq() < 0.0025) ball.velocity.set(0, 0);
        continue;
      }

      ball.velocity.x += outwardX * speed * 3.5 * delta;
      ball.velocity.y += outwardZ * speed * 3.5 * delta;
      if (ball.velocity.lengthSq() > 1e-8) {
        ball.velocity.setLength(speed);
      } else {
        ball.velocity.set(outwardX * speed, outwardZ * speed);
      }
    }
  }

  function isSpaceFree(x, z, parent, newBalls) {
    if (Math.abs(x) > xLimit || Math.abs(z) > zLimit) return false;

    const minimumDistance = radius * 2 - CONTACT_EPSILON;
    const minimumDistanceSquared = minimumDistance * minimumDistance;
    for (const other of balls) {
      if (other === parent || other.splitting) continue;
      const dx = x - other.mesh.position.x;
      const dz = z - other.mesh.position.z;
      if (dx * dx + dz * dz < minimumDistanceSquared) return false;
    }
    for (const other of newBalls) {
      const dx = x - other.mesh.position.x;
      const dz = z - other.mesh.position.z;
      if (dx * dx + dz * dz < minimumDistanceSquared) return false;
    }
    return true;
  }

  function findSplitPlacement(ball, normalX, normalZ, newBalls) {
    const originX = ball.mesh.position.x;
    const originZ = ball.mesh.position.z;
    const centerX = originX + normalX * radius * 0.05;
    const centerZ = originZ + normalZ * radius * 0.05;
    const normalAngle = Math.atan2(normalZ, normalX);

    for (let step = 0; step < 12; step += 1) {
      const angle = normalAngle + (step * Math.PI) / 12;
      const offsetX = Math.cos(angle) * radius;
      const offsetZ = Math.sin(angle) * radius;
      const first = { x: centerX - offsetX, z: centerZ - offsetZ };
      const second = { x: centerX + offsetX, z: centerZ + offsetZ };
      if (
        isSpaceFree(first.x, first.z, ball, newBalls)
        && isSpaceFree(second.x, second.z, ball, newBalls)
      ) {
        return [first, second];
      }
    }

    if (isSpaceFree(originX, originZ, ball, newBalls)) {
      for (let step = 0; step < 24; step += 1) {
        const angle = normalAngle + (step * Math.PI) / 12;
        const second = {
          x: originX + Math.cos(angle) * radius * 2,
          z: originZ + Math.sin(angle) * radius * 2,
        };
        if (isSpaceFree(second.x, second.z, ball, newBalls)) {
          return [{ x: originX, z: originZ }, second];
        }
      }
    }

    return null;
  }

  function splitBall(ball, collision, newBalls) {
    const { normalX, normalZ, velocityX, velocityZ } = collision;
    const placement = findSplitPlacement(ball, normalX, normalZ, newBalls);
    if (!placement) return null;

    const baseAngle = Math.atan2(velocityZ, velocityX);
    const tangentX = -normalZ;
    const tangentZ = normalX;
    const children = [];

    for (let index = 0; index < 2; index += 1) {
      const direction = index === 0 ? -1 : 1;
      const angle = baseAngle + direction * splitAngle;
      let childVelocityX = Math.cos(angle) * speed;
      let childVelocityZ = Math.sin(angle) * speed;
      const inwardSpeed = childVelocityX * normalX + childVelocityZ * normalZ;

      if (inwardSpeed < MIN_INWARD_SPEED) {
        const tangentSpeed = Math.sqrt(speed * speed - MIN_INWARD_SPEED * MIN_INWARD_SPEED);
        const tangentDirection = Math.sign(childVelocityX * tangentX + childVelocityZ * tangentZ) || direction;
        childVelocityX = normalX * MIN_INWARD_SPEED + tangentX * tangentSpeed * tangentDirection;
        childVelocityZ = normalZ * MIN_INWARD_SPEED + tangentZ * tangentSpeed * tangentDirection;
      }

      const { x, z } = placement[index];
      children.push(createBall(x, z, childVelocityX, childVelocityZ, true));
    }

    createImpact(ball.mesh.position.x, ball.mesh.position.z);
    return children;
  }

  function updateImpacts(delta) {
    for (let index = impacts.length - 1; index >= 0; index -= 1) {
      const impact = impacts[index];
      impact.age += delta;
      const progress = impact.age / IMPACT_DURATION;

      if (progress >= 1) {
        scene.remove(impact.mesh);
        impact.mesh.material.dispose();
        impacts.splice(index, 1);
      } else {
        impact.mesh.scale.setScalar(0.45 + progress * 1.8);
        impact.mesh.material.opacity = (1 - progress) ** 2 * 0.8;
      }
    }
  }

  function simulate(delta) {
    const newBalls = [];
    const fillRatio = (balls.length * Math.PI * radius * radius) / (xLimit * 2 * zLimit * 2);
    let splitCount = 0;

    for (const ball of balls) {
      ball.splitCooldown = Math.max(0, ball.splitCooldown - delta);

      const dx = ball.velocity.x * delta;
      const dz = ball.velocity.y * delta;
      ball.mesh.position.x += dx;
      ball.mesh.position.z += dz;
      rollingAxis.set(dz, 0, -dx).normalize();
      ball.mesh.rotateOnWorldAxis(rollingAxis, Math.hypot(dx, dz) / radius);

      const collision = collideWithWalls(ball);
      if (!collision) continue;

      if (!opening && ball.splitCooldown === 0) {
        const children = splitBall(ball, collision, newBalls);
        if (children) {
          ball.splitting = true;
          splitCount += 1;
          newBalls.push(...children);
          continue;
        }

        if (fillRatio >= PACKED_FILL_RATIO) {
          pressure[collision.side] += 1;
          if (pressure[collision.side] >= PRESSURE_IMPACTS_TO_BREAK) {
            opening = { side: collision.side };
            onBreakout?.(collision.side);
            continue;
          }
        }
      }
      ball.velocity.set(collision.velocityX, collision.velocityZ);
    }

    if (splitCount > 0) {
      for (let index = balls.length - 1; index >= 0; index -= 1) {
        if (!balls[index].splitting) continue;
        scene.remove(balls[index].mesh);
        balls.splice(index, 1);
      }
      balls.push(...newBalls);
    }

    resolveBallCollisions();

    for (const ball of balls) {
      const collision = collideWithWalls(ball);
      if (collision) ball.velocity.set(collision.velocityX, collision.velocityZ);
    }

    applyOpeningMotion(delta);
    updateImpacts(delta);
  }

  balls.push(createBall(-0.9, 1.4, Math.cos(0.61) * speed, Math.sin(0.61) * speed));

  return {
    balls,
    get breachSide() {
      return opening?.side ?? null;
    },
    update(delta) {
      accumulator += Math.min(delta, MAX_FRAME_DELTA);
      while (accumulator >= FIXED_STEP) {
        simulate(FIXED_STEP);
        accumulator -= FIXED_STEP;
      }
    },
  };
}
