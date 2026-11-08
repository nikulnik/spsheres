import * as THREE from 'three';

export const BALL_CONFIG = Object.freeze({
  radius: 0.44,
  speed: 7.4,
  maxCount: 64,
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

export function createBallSystem(scene, { frameWidth, courtDepth, environment }) {
  const { radius, speed, maxCount, splitAngle, splitCooldown } = BALL_CONFIG;
  const xLimit = frameWidth / 2 - 0.26 - radius;
  const zLimit = courtDepth / 2 - 0.26 - radius;
  const balls = [];
  const impacts = [];
  const sphereGeometry = new THREE.SphereGeometry(radius, 48, 32);
  const sphereMaterial = new THREE.MeshPhysicalMaterial({
    color: '#42bffc',
    metalness: 0.18,
    roughness: 0.16,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    iridescence: 0.85,
    iridescenceIOR: 1.35,
    iridescenceThicknessMinimum: 120,
    iridescenceThicknessMaximum: 420,
    emissive: '#062c46',
    emissiveIntensity: 0.22,
    envMap: environment ?? null,
    envMapIntensity: 1.3,
  });
  const impactGeometry = new THREE.RingGeometry(radius * 0.85, radius * 0.97, 48);
  const rollingAxis = new THREE.Vector3();
  let accumulator = 0;

  function createBall(x, z, velocityX, velocityZ, isNewborn = false) {
    const mesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
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

    if (position.x >= xLimit) {
      position.x = xLimit;
      if (ball.velocity.x > 0) normalX = -1;
    } else if (position.x <= -xLimit) {
      position.x = -xLimit;
      if (ball.velocity.x < 0) normalX = 1;
    }

    if (position.z >= zLimit) {
      position.z = zLimit;
      if (ball.velocity.y > 0) normalZ = -1;
    } else if (position.z <= -zLimit) {
      position.z = -zLimit;
      if (ball.velocity.y < 0) normalZ = 1;
    }

    if (normalX === 0 && normalZ === 0) return null;

    const normalLength = Math.hypot(normalX, normalZ);
    normalX /= normalLength;
    normalZ /= normalLength;
    const dot = ball.velocity.x * normalX + ball.velocity.y * normalZ;

    return {
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

  function splitBall(ball, collision) {
    const { normalX, normalZ, velocityX, velocityZ } = collision;
    const baseAngle = Math.atan2(velocityZ, velocityX);
    const tangentX = -normalZ;
    const tangentZ = normalX;
    const children = [];

    for (const direction of [-1, 1]) {
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

      const offset = direction * radius * 0.16;
      const x = THREE.MathUtils.clamp(
        ball.mesh.position.x + tangentX * offset + normalX * radius * 0.08,
        -xLimit,
        xLimit,
      );
      const z = THREE.MathUtils.clamp(
        ball.mesh.position.z + tangentZ * offset + normalZ * radius * 0.08,
        -zLimit,
        zLimit,
      );
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

      const activeCount = balls.length - splitCount + newBalls.length;
      if (ball.splitCooldown === 0 && activeCount < maxCount) {
        ball.splitting = true;
        splitCount += 1;
        newBalls.push(...splitBall(ball, collision));
      } else {
        ball.velocity.set(collision.velocityX, collision.velocityZ);
      }
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

    updateImpacts(delta);
  }

  balls.push(createBall(-0.9, 1.4, Math.cos(0.61) * speed, Math.sin(0.61) * speed));

  return {
    balls,
    update(delta) {
      accumulator += Math.min(delta, MAX_FRAME_DELTA);
      while (accumulator >= FIXED_STEP) {
        simulate(FIXED_STEP);
        accumulator -= FIXED_STEP;
      }
    },
  };
}
