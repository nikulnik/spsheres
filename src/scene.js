import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OBB } from 'three/addons/math/OBB.js';
import { createBallSystem } from './balls.js';

export const SCENE_CONFIG = Object.freeze({
  frameWidth: 9,
  frameHeight: 16,
  courtHeightInFrame: 14,
  cameraElevation: 75,
});

const RAIL_THICKNESS = 0.26;
const PLANK_HEIGHT = 0.2;
const PLANK_GAP = 0.03;
const PLANK_COUNT = 3;
const RAIL_HEIGHT = PLANK_HEIGHT * PLANK_COUNT + PLANK_GAP * (PLANK_COUNT - 1);

function seededRandom(initialSeed = 47) {
  let seed = initialSeed;

  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function createWoodMaterials(renderer) {
  const manager = new THREE.LoadingManager();
  const ready = new Promise((resolve, reject) => {
    manager.onLoad = resolve;
    manager.onError = (url) => reject(new Error(`Texture loading failed: ${url}`));
  });
  const loader = new THREE.TextureLoader(manager);
  const baseTextures = {
    map: loader.load('/textures/wood/color.jpg'),
    normalMap: loader.load('/textures/wood/normal.jpg'),
    roughnessMap: loader.load('/textures/wood/roughness.jpg'),
  };
  baseTextures.map.colorSpace = THREE.SRGBColorSpace;

  for (const texture of Object.values(baseTextures)) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  const materials = ['#e7c39d', '#dbb38a', '#f0ceb0'].map((color, level) => {
    const textures = Object.fromEntries(
      Object.entries(baseTextures).map(([key, texture]) => {
        const clone = texture.clone();
        clone.offset.set(level * 0.19, level * 0.31);
        clone.needsUpdate = true;
        return [key, clone];
      }),
    );

    return new THREE.MeshPhysicalMaterial({
      ...textures,
      color,
      roughness: 1,
      normalScale: new THREE.Vector2(0.85, 0.85),
      clearcoat: 0.03,
      clearcoatRoughness: 0.9,
    });
  });

  return { materials, ready };
}

function applyWoodUVs(geometry, longAxis, length, lengthRepeats) {
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uv = geometry.attributes.uv;

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const nx = Math.abs(normals.getX(index));
    const ny = Math.abs(normals.getY(index));
    const nz = Math.abs(normals.getZ(index));
    const isEnd = longAxis === 'x' ? nx > ny && nx > nz : nz > nx && nz > ny;
    let u;
    let v;

    if (isEnd) {
      const cross = longAxis === 'x' ? z : x;
      u = cross / RAIL_THICKNESS + 0.5;
      v = y / PLANK_HEIGHT + 0.5;
    } else {
      const long = longAxis === 'x' ? x : z;
      const isTop = ny > nx && ny > nz;
      const cross = isTop ? (longAxis === 'x' ? z : x) : y;
      const crossSize = isTop ? RAIL_THICKNESS : PLANK_HEIGHT;
      u = (cross / crossSize + 0.5) * 0.38;
      v = (long / length + 0.5) * lengthRepeats;
    }

    uv.setXY(index, u, v);
  }

  uv.needsUpdate = true;
  return geometry;
}

function createNoiseGrid(size, random) {
  const values = new Float32Array(size * size);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = random();
  }
  return { size, values };
}

function sampleNoise(grid, u, v) {
  const x = u * grid.size;
  const y = v * grid.size;
  const x0 = Math.floor(x) % grid.size;
  const y0 = Math.floor(y) % grid.size;
  const x1 = (x0 + 1) % grid.size;
  const y1 = (y0 + 1) % grid.size;
  const tx = x - Math.floor(x);
  const ty = y - Math.floor(y);
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const top = THREE.MathUtils.lerp(grid.values[y0 * grid.size + x0], grid.values[y0 * grid.size + x1], sx);
  const bottom = THREE.MathUtils.lerp(grid.values[y1 * grid.size + x0], grid.values[y1 * grid.size + x1], sx);
  return THREE.MathUtils.lerp(top, bottom, sy);
}

function createFloorTextures(renderer) {
  const size = 1024;
  const colorCanvas = document.createElement('canvas');
  const roughnessCanvas = document.createElement('canvas');
  const heightCanvas = document.createElement('canvas');
  const normalCanvas = document.createElement('canvas');

  for (const canvas of [colorCanvas, roughnessCanvas, heightCanvas, normalCanvas]) {
    canvas.width = size;
    canvas.height = size;
  }

  const colorContext = colorCanvas.getContext('2d');
  const roughnessContext = roughnessCanvas.getContext('2d');
  const heightContext = heightCanvas.getContext('2d');
  const normalContext = normalCanvas.getContext('2d');
  const colorImage = colorContext.createImageData(size, size);
  const roughnessImage = roughnessContext.createImageData(size, size);
  const heightImage = heightContext.createImageData(size, size);
  const random = seededRandom(83);
  const noise = [8, 24, 64, 160].map((resolution) => createNoiseGrid(resolution, random));

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const u = x / size;
      const v = y / size;
      const broad = sampleNoise(noise[0], u, v) * 0.65 + sampleNoise(noise[1], u, v) * 0.35;
      const middle = sampleNoise(noise[2], u, v);
      const fine = sampleNoise(noise[3], u, v);
      const grain = random() - 0.5;
      const pore = random() > 0.992 ? -(0.25 + random() * 0.75) : 0;
      const shade = (broad - 0.5) * 24 + (middle - 0.5) * 13 + (fine - 0.5) * 5 + grain * 5 + pore * 9;

      colorImage.data[index] = 216 + shade + (middle - 0.5) * 2;
      colorImage.data[index + 1] = 220 + shade;
      colorImage.data[index + 2] = 210 + shade - (broad - 0.5) * 3;
      colorImage.data[index + 3] = 255;

      const roughness = 215 + (broad - 0.5) * 27 + (middle - 0.5) * 15 + grain * 10;
      roughnessImage.data[index] = roughness;
      roughnessImage.data[index + 1] = roughness;
      roughnessImage.data[index + 2] = roughness;
      roughnessImage.data[index + 3] = 255;

      const height = 128 + (middle - 0.5) * 28 + (fine - 0.5) * 20 + grain * 12 + pore * 32;
      heightImage.data[index] = height;
      heightImage.data[index + 1] = height;
      heightImage.data[index + 2] = height;
      heightImage.data[index + 3] = 255;
    }
  }

  colorContext.putImageData(colorImage, 0, 0);
  roughnessContext.putImageData(roughnessImage, 0, 0);
  heightContext.putImageData(heightImage, 0, 0);

  const scuffs = Array.from({ length: 64 }, () => {
    const length = 18 + random() * 105;
    const angle = random() * Math.PI * 2;
    const bend = (random() - 0.5) * length * 0.32;
    return {
      x: random() * size,
      y: random() * size,
      dx: Math.cos(angle) * length,
      dy: Math.sin(angle) * length,
      cx: -Math.sin(angle) * bend,
      cy: Math.cos(angle) * bend,
      width: 0.45 + random() * 1.55,
      alpha: 0.04 + random() * 0.08,
      light: random() > 0.38,
    };
  });

  for (const [context, type] of [
    [colorContext, 'color'],
    [roughnessContext, 'roughness'],
    [heightContext, 'height'],
  ]) {
    context.lineCap = 'round';
    for (const scuff of scuffs) {
      context.lineWidth = scuff.width;
      if (type === 'color') {
        context.strokeStyle = scuff.light
          ? `rgba(249, 244, 224, ${scuff.alpha})`
          : `rgba(67, 80, 58, ${scuff.alpha * 0.55})`;
      } else if (type === 'roughness') {
        context.strokeStyle = `rgba(245, 245, 245, ${scuff.alpha * 1.8})`;
      } else {
        context.strokeStyle = `rgba(70, 70, 70, ${scuff.alpha * 1.5})`;
      }

      for (const offsetY of [-size, 0, size]) {
        for (const offsetX of [-size, 0, size]) {
          context.beginPath();
          context.moveTo(scuff.x + offsetX, scuff.y + offsetY);
          context.quadraticCurveTo(
            scuff.x + scuff.dx * 0.5 + scuff.cx + offsetX,
            scuff.y + scuff.dy * 0.5 + scuff.cy + offsetY,
            scuff.x + scuff.dx + offsetX,
            scuff.y + scuff.dy + offsetY,
          );
          context.stroke();
        }
      }
    }
  }

  const heights = heightContext.getImageData(0, 0, size, size).data;
  const normalImage = normalContext.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const left = heights[(y * size + (x + size - 1) % size) * 4];
      const right = heights[(y * size + (x + 1) % size) * 4];
      const top = heights[(((y + size - 1) % size) * size + x) * 4];
      const bottom = heights[(((y + 1) % size) * size + x) * 4];
      const nx = ((left - right) / 255) * 2.2;
      const ny = ((top - bottom) / 255) * 2.2;
      const inverseLength = 1 / Math.hypot(nx, ny, 1);
      normalImage.data[index] = (nx * inverseLength * 0.5 + 0.5) * 255;
      normalImage.data[index + 1] = (ny * inverseLength * 0.5 + 0.5) * 255;
      normalImage.data[index + 2] = (inverseLength * 0.5 + 0.5) * 255;
      normalImage.data[index + 3] = 255;
    }
  }
  normalContext.putImageData(normalImage, 0, 0);

  const textures = {
    map: new THREE.CanvasTexture(colorCanvas),
    roughnessMap: new THREE.CanvasTexture(roughnessCanvas),
    normalMap: new THREE.CanvasTexture(normalCanvas),
  };
  textures.map.colorSpace = THREE.SRGBColorSpace;

  for (const texture of Object.values(textures)) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1.6, 2.5);
    texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  }

  return textures;
}

function addRail(group, geometry, material, x, y, z) {
  const rail = new THREE.Mesh(geometry, material);
  rail.position.set(x, y, z);
  rail.castShadow = true;
  rail.receiveShadow = true;
  group.add(rail);
  return rail;
}

export function createArenaScene(canvas) {
  const { frameWidth, frameHeight, courtHeightInFrame, cameraElevation } = SCENE_CONFIG;
  const elevation = THREE.MathUtils.degToRad(cameraElevation);
  const sinElevation = Math.sin(elevation);
  const cosElevation = Math.cos(elevation);
  const courtDepth = (courtHeightInFrame - RAIL_HEIGHT * cosElevation) / sinElevation;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#d5d1c5');

  const camera = new THREE.OrthographicCamera(
    -frameWidth / 2,
    frameWidth / 2,
    frameHeight / 2,
    -frameHeight / 2,
    0.1,
    180,
  );
  const projectedCourtCenter = (RAIL_HEIGHT * cosElevation) / 2;
  const targetZ = (1 - projectedCourtCenter) / sinElevation;
  const target = new THREE.Vector3(0, 0, targetZ);
  camera.position.set(0, 40 * sinElevation, targetZ + 40 * cosElevation);
  camera.lookAt(target);
  camera.updateProjectionMatrix();

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({ color: '#d5d1c5', roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.1;
  ground.receiveShadow = true;
  scene.add(ground);

  const floor = new THREE.Mesh(
    new RoundedBoxGeometry(frameWidth - RAIL_THICKNESS, 0.12, courtDepth - RAIL_THICKNESS, 2, 0.035),
    new THREE.MeshPhysicalMaterial({
      ...createFloorTextures(renderer),
      color: '#a9ba9e',
      roughness: 0.93,
      normalScale: new THREE.Vector2(0.32, 0.32),
      clearcoat: 0.1,
      clearcoatRoughness: 0.78,
      specularIntensity: 0.35,
      specularColor: new THREE.Color('#fff7e8'),
    }),
  );
  floor.position.y = -0.03;
  floor.receiveShadow = true;
  scene.add(floor);

  const { materials: woodMaterials, ready: woodReady } = createWoodMaterials(renderer);
  const rails = new THREE.Group();
  const boards = { north: [], south: [], east: [], west: [] };
  const horizontalGeometry = applyWoodUVs(
    new RoundedBoxGeometry(frameWidth, PLANK_HEIGHT, RAIL_THICKNESS, 3, 0.025),
    'x',
    frameWidth,
    2.6,
  );
  const sideGeometry = applyWoodUVs(
    new RoundedBoxGeometry(
      RAIL_THICKNESS,
      PLANK_HEIGHT,
      courtDepth - RAIL_THICKNESS * 2,
      3,
      0.025,
    ),
    'z',
    courtDepth - RAIL_THICKNESS * 2,
    3.8,
  );

  for (let level = 0; level < PLANK_COUNT; level += 1) {
    const y = PLANK_HEIGHT / 2 + level * (PLANK_HEIGHT + PLANK_GAP);
    const material = woodMaterials[level];
    const z = courtDepth / 2 - RAIL_THICKNESS / 2;
    const x = frameWidth / 2 - RAIL_THICKNESS / 2;

    boards.north.push(addRail(rails, horizontalGeometry, material, 0, y, -z));
    boards.south.push(addRail(rails, horizontalGeometry, material, 0, y, z));
    boards.west.push(addRail(rails, sideGeometry, material, -x, y, 0));
    boards.east.push(addRail(rails, sideGeometry, material, x, y, 0));
  }
  scene.add(rails);

  const hemisphere = new THREE.HemisphereLight('#fff8e9', '#68705f', 2.1);
  scene.add(hemisphere);

  const sunlight = new THREE.DirectionalLight('#fff0d8', 3.2);
  sunlight.position.set(-7, 15, 9);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(2048, 2048);
  sunlight.shadow.camera.left = -11;
  sunlight.shadow.camera.right = 11;
  sunlight.shadow.camera.top = 11;
  sunlight.shadow.camera.bottom = -11;
  sunlight.shadow.camera.near = 1;
  sunlight.shadow.camera.far = 45;
  sunlight.shadow.normalBias = 0.025;
  sunlight.shadow.bias = -0.00015;
  scene.add(sunlight);
  scene.add(sunlight.target);

  const fill = new THREE.DirectionalLight('#dce8ef', 0.65);
  fill.position.set(8, 7, -10);
  scene.add(fill);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const environmentScene = new RoomEnvironment();
  const environment = pmremGenerator.fromScene(environmentScene, 0.04).texture;
  environmentScene.dispose();
  pmremGenerator.dispose();

  const ROCK_RADIUS = 2.5;
  const ROCK_DISTANCE = 44;
  const BOARD_PHYSICS_STEP = 1 / 90;
  const cameraTarget = target.clone();
  const cameraFocus = new THREE.Vector3();
  const cameraOffset = camera.position.clone().sub(target);
  const flightElevation = THREE.MathUtils.degToRad(85);
  const flightCameraOffset = new THREE.Vector3(
    0,
    50 * Math.sin(flightElevation),
    50 * Math.cos(flightElevation),
  );
  const activeCameraOffset = cameraOffset.clone();
  const boardBounds = new THREE.Box3();
  const boardCollider = new OBB();
  const closestPoint = new THREE.Vector3();
  const contactNormal = new THREE.Vector3();
  const sunlightOffset = sunlight.position.clone();
  const rockGeometry = new THREE.DodecahedronGeometry(ROCK_RADIUS, 1);
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: '#77746d',
    roughness: 0.96,
    flatShading: true,
  });
  const outwardDirections = {
    north: new THREE.Vector3(0, 0, -1),
    south: new THREE.Vector3(0, 0, 1),
    east: new THREE.Vector3(1, 0, 0),
    west: new THREE.Vector3(-1, 0, 0),
  };
  let breakout;
  let cameraMove;
  let cameraTrackingBoard = false;
  let previousTime;

  function releaseBoard(side) {
    if (breakout) return;
    const board = boards[side][Math.floor(PLANK_COUNT / 2)];
    const direction = outwardDirections[side];
    scene.attach(board);
    board.geometry.computeBoundingBox();

    const rock = new THREE.Mesh(rockGeometry, rockMaterial);
    rock.position.copy(board.position).addScaledVector(direction, ROCK_DISTANCE);
    rock.position.y = ground.position.y + ROCK_RADIUS;
    rock.rotation.set(0.18, 0.45, -0.08);
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);

    const velocity = direction.clone().multiplyScalar(20);
    velocity.y = 8.2;
    const spin = side === 'east' || side === 'west'
      ? new THREE.Vector3(0.45, 0.65, 1.4)
      : new THREE.Vector3(2.2, 0.65, 0.35);
    breakout = { board, rock, velocity, spin, hitRock: false };
  }

  function resolveRockCollision(delta) {
    const { board, rock, velocity, spin } = breakout;
    board.updateMatrixWorld(true);
    boardCollider.fromBox3(board.geometry.boundingBox).applyMatrix4(board.matrixWorld);
    boardCollider.clampPoint(rock.position, closestPoint);
    const distance = closestPoint.distanceTo(rock.position);
    if (distance >= ROCK_RADIUS) return;

    contactNormal.subVectors(closestPoint, rock.position);
    if (contactNormal.lengthSq() < 1e-10) {
      contactNormal.subVectors(board.position, rock.position);
    }
    contactNormal.normalize();
    board.position.addScaledVector(contactNormal, ROCK_RADIUS - distance + 1e-4);

    const normalSpeed = velocity.dot(contactNormal);
    if (normalSpeed < 0) {
      velocity.addScaledVector(contactNormal, -normalSpeed);
    }

    if (!breakout.hitRock) {
      breakout.hitRock = true;
      velocity.multiplyScalar(0.08);
      spin.multiplyScalar(0.1);
    } else {
      const damping = Math.exp(-10 * delta);
      velocity.x *= damping;
      velocity.z *= damping;
      spin.multiplyScalar(Math.exp(-8 * delta));
    }
  }

  function simulateBreakoutStep(delta) {
    const { board, velocity, spin } = breakout;
    velocity.y -= 7.2 * delta;
    board.position.addScaledVector(velocity, delta);
    board.rotation.x += spin.x * delta;
    board.rotation.y += spin.y * delta;
    board.rotation.z += spin.z * delta;
    resolveRockCollision(delta);

    boardBounds.setFromObject(board);
    const penetration = ground.position.y - boardBounds.min.y;
    if (penetration > 0) {
      board.position.y += penetration;
      velocity.y = Math.abs(velocity.y) > 1.2 ? -velocity.y * 0.22 : 0;
      const damping = Math.exp(-1.15 * delta);
      velocity.x *= damping;
      velocity.z *= damping;
      spin.multiplyScalar(Math.exp(-1.8 * delta));
    }
  }

  function updateBreakout(delta) {
    if (!breakout) return;
    const steps = Math.max(1, Math.ceil(delta / BOARD_PHYSICS_STEP));
    const step = delta / steps;
    for (let index = 0; index < steps; index += 1) {
      simulateBreakoutStep(step);
    }

    const { board } = breakout;
    sunlight.target.position.copy(board.position);
    sunlight.position.copy(board.position).add(sunlightOffset);
    sunlight.target.updateMatrixWorld();
  }

  function updateCamera(delta) {
    if (!breakout) return;
    const { board, rock } = breakout;
    const rockDistance = board.position.distanceTo(rock.position);
    const rockFocusWeight = THREE.MathUtils.clamp((16 - rockDistance) / 16, 0, 0.5);
    cameraFocus.copy(board.position).lerp(rock.position, rockFocusWeight);

    if (!cameraTrackingBoard) {
      if (!cameraMove) {
        cameraMove = { elapsed: 0, from: cameraTarget.clone() };
      }

      cameraMove.elapsed += delta;
      const progress = Math.min(cameraMove.elapsed / 0.45, 1);
      const eased = 1 - (1 - progress) ** 3;
      cameraTarget.lerpVectors(cameraMove.from, cameraFocus, eased);
      activeCameraOffset.lerpVectors(cameraOffset, flightCameraOffset, eased);
      camera.zoom = THREE.MathUtils.lerp(1, 0.42, eased);
      camera.updateProjectionMatrix();
      if (progress === 1) cameraTrackingBoard = true;
    } else {
      cameraTarget.copy(cameraFocus);
      activeCameraOffset.copy(flightCameraOffset);
    }

    camera.position.copy(cameraTarget).add(activeCameraOffset);
    camera.lookAt(cameraTarget);
  }

  const ballSystem = createBallSystem(scene, {
    frameWidth,
    courtDepth,
    environment,
    onBreakout: releaseBoard,
  });

  return {
    camera,
    courtDepth,
    ready: woodReady,
    render: () => renderer.render(scene, camera),
    resize: (width, height, pixelRatio) => {
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
    },
    start: () => renderer.setAnimationLoop((time) => {
      const delta = previousTime === undefined ? 0 : Math.min((time - previousTime) / 1000, 0.25);
      previousTime = time;
      ballSystem.update(delta);
      updateBreakout(delta);
      updateCamera(delta);
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);
    }),
  };
}
