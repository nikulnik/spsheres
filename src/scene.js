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

function latticeNoise(x, y, z) {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
}

function sampleNoise3D(x, y, z) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const ty = y - y0;
  const tz = z - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const sz = tz * tz * (3 - 2 * tz);
  const bottomFront = THREE.MathUtils.lerp(
    latticeNoise(x0, y0, z0),
    latticeNoise(x0 + 1, y0, z0),
    sx,
  );
  const topFront = THREE.MathUtils.lerp(
    latticeNoise(x0, y0 + 1, z0),
    latticeNoise(x0 + 1, y0 + 1, z0),
    sx,
  );
  const bottomBack = THREE.MathUtils.lerp(
    latticeNoise(x0, y0, z0 + 1),
    latticeNoise(x0 + 1, y0, z0 + 1),
    sx,
  );
  const topBack = THREE.MathUtils.lerp(
    latticeNoise(x0, y0 + 1, z0 + 1),
    latticeNoise(x0 + 1, y0 + 1, z0 + 1),
    sx,
  );

  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(bottomFront, topFront, sy),
    THREE.MathUtils.lerp(bottomBack, topBack, sy),
    sz,
  );
}

function createRockGeometry(radius) {
  const geometry = new THREE.SphereGeometry(radius, 96, 64);
  const positions = geometry.attributes.position;
  const direction = new THREE.Vector3();

  for (let index = 0; index < positions.count; index += 1) {
    direction.fromBufferAttribute(positions, index).normalize();
    const broad = sampleNoise3D(
      direction.x * 1.45 + 9.2,
      direction.y * 1.45 + 3.7,
      direction.z * 1.45 + 5.1,
    );
    const middle = sampleNoise3D(
      direction.x * 4.2 + 2.4,
      direction.y * 4.2 + 8.8,
      direction.z * 4.2 + 1.6,
    );
    const fine = sampleNoise3D(
      direction.x * 11.5 + 6.1,
      direction.y * 11.5 + 4.3,
      direction.z * 11.5 + 7.9,
    );
    const radialScale = 0.97 + (broad - 0.5) * 0.22 + (middle - 0.5) * 0.07 + (fine - 0.5) * 0.025;
    const surfaceRadius = radius * radialScale;
    positions.setXYZ(
      index,
      direction.x * surfaceRadius * 1.03,
      direction.y * surfaceRadius * 0.9,
      direction.z * surfaceRadius * 0.98,
    );
  }

  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function createRockTextures(renderer) {
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
  const random = seededRandom(191);
  const noise = [5, 13, 32, 96, 224].map((resolution) => createNoiseGrid(resolution, random));

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const u = x / size;
      const v = y / size;
      const broad = sampleNoise(noise[0], u, v) * 0.58 + sampleNoise(noise[1], u, v) * 0.42;
      const middle = sampleNoise(noise[2], u, v);
      const fine = sampleNoise(noise[3], u, v);
      const micro = sampleNoise(noise[4], u, v);
      const grain = random() - 0.5;
      const mineral = random();
      const darkMineral = mineral > 0.972 ? (mineral - 0.972) / 0.028 : 0;
      const lightMineral = mineral < 0.022 ? (0.022 - mineral) / 0.022 : 0;
      const shade = (broad - 0.5) * 58
        + (middle - 0.5) * 32
        + (fine - 0.5) * 18
        + (micro - 0.5) * 9
        + grain * 9
        - darkMineral * 42
        + lightMineral * 48;

      colorImage.data[index] = 116 + shade + (middle - 0.5) * 5;
      colorImage.data[index + 1] = 114 + shade;
      colorImage.data[index + 2] = 108 + shade - (broad - 0.5) * 5;
      colorImage.data[index + 3] = 255;

      const roughness = 224 + (middle - 0.5) * 24 + (fine - 0.5) * 18 + grain * 8 - lightMineral * 18;
      roughnessImage.data[index] = roughness;
      roughnessImage.data[index + 1] = roughness;
      roughnessImage.data[index + 2] = roughness;
      roughnessImage.data[index + 3] = 255;

      const height = 128
        + (broad - 0.5) * 25
        + (middle - 0.5) * 35
        + (fine - 0.5) * 38
        + (micro - 0.5) * 20
        + grain * 10
        - darkMineral * 12;
      heightImage.data[index] = height;
      heightImage.data[index + 1] = height;
      heightImage.data[index + 2] = height;
      heightImage.data[index + 3] = 255;
    }
  }

  colorContext.putImageData(colorImage, 0, 0);
  roughnessContext.putImageData(roughnessImage, 0, 0);
  heightContext.putImageData(heightImage, 0, 0);

  const heights = heightContext.getImageData(0, 0, size, size).data;
  const normalImage = normalContext.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const left = heights[(y * size + (x + size - 1) % size) * 4];
      const right = heights[(y * size + (x + 1) % size) * 4];
      const top = heights[(((y + size - 1) % size) * size + x) * 4];
      const bottom = heights[(((y + 1) % size) * size + x) * 4];
      const nx = ((left - right) / 255) * 3.4;
      const ny = ((top - bottom) / 255) * 3.4;
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
  const ROCK_RESTITUTION = 0.34;
  const ROCK_FRICTION = 0.42;
  const BOARD_RELEASE_SPEED = 32;
  const BOARD_RELEASE_LIFT = 8.8;
  const BOARD_GRAVITY = 9.81;
  const BOARD_PHYSICS_STEP = 1 / 120;
  const GROUND_RESTITUTION = 0.18;
  const GROUND_FRICTION = 0.58;
  const GROUND_CONTACT_ITERATIONS = 6;
  const GROUND_SLEEP_SPEED = 0.12;
  const GROUND_SLEEP_SPIN = 0.1;
  const GROUND_SLEEP_DELAY = 0.35;
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
  const rockBounds = new THREE.Box3();
  const boardCollider = new OBB();
  const closestPoint = new THREE.Vector3();
  const contactNormal = new THREE.Vector3();
  const contactOffset = new THREE.Vector3();
  const contactVelocity = new THREE.Vector3();
  const tangentDirection = new THREE.Vector3();
  const contactImpulse = new THREE.Vector3();
  const inverseBoardRotation = new THREE.Quaternion();
  const localContact = new THREE.Vector3();
  const localOffset = new THREE.Vector3();
  const localDirection = new THREE.Vector3();
  const localTorque = new THREE.Vector3();
  const worldAngularChange = new THREE.Vector3();
  const rotationStep = new THREE.Quaternion();
  const spinAxis = new THREE.Vector3();
  const groundNormal = new THREE.Vector3(0, 1, 0);
  const groundContacts = Array.from({ length: 8 }, () => new THREE.Vector3());
  const sunlightOffset = sunlight.position.clone();
  const rockGeometry = createRockGeometry(ROCK_RADIUS);
  const rockMaterial = new THREE.MeshStandardMaterial({
    ...createRockTextures(renderer),
    color: '#ffffff',
    roughness: 1,
    normalScale: new THREE.Vector2(0.85, 0.85),
    envMapIntensity: 0.45,
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
    rock.position.y = 0;
    rock.rotation.set(0.18, 0.45, -0.08);
    rock.updateMatrixWorld(true);
    rockBounds.setFromObject(rock);
    rock.position.y = ground.position.y - rockBounds.min.y;
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);

    const velocity = direction.clone().multiplyScalar(BOARD_RELEASE_SPEED);
    velocity.y = BOARD_RELEASE_LIFT;
    const spin = side === 'east' || side === 'west'
      ? new THREE.Vector3(0.45, 0.65, 1.4)
      : new THREE.Vector3(2.2, 0.65, 0.35);
    const boardSize = board.geometry.boundingBox.getSize(new THREE.Vector3());
    const boardMass = 1.4;
    const inverseInertia = new THREE.Vector3(
      12 / (boardMass * (boardSize.y ** 2 + boardSize.z ** 2)),
      12 / (boardMass * (boardSize.x ** 2 + boardSize.z ** 2)),
      12 / (boardMass * (boardSize.x ** 2 + boardSize.y ** 2)),
    );
    breakout = {
      board,
      rock,
      velocity,
      spin,
      inverseMass: 1 / boardMass,
      inverseInertia,
      hitRock: false,
      groundRestTime: 0,
      sleeping: false,
    };
  }

  function getContactImpulseDenominator(direction, offset) {
    const { board, inverseMass, inverseInertia } = breakout;
    inverseBoardRotation.copy(board.quaternion).invert();
    localOffset.copy(offset).applyQuaternion(inverseBoardRotation);
    localDirection.copy(direction).applyQuaternion(inverseBoardRotation);
    localTorque.crossVectors(localOffset, localDirection).multiply(inverseInertia);
    worldAngularChange.copy(localTorque).applyQuaternion(board.quaternion).cross(offset);
    return inverseMass + worldAngularChange.dot(direction);
  }

  function applyContactImpulse(impulse, offset) {
    const { board, velocity, spin, inverseMass, inverseInertia } = breakout;
    velocity.addScaledVector(impulse, inverseMass);
    inverseBoardRotation.copy(board.quaternion).invert();
    localOffset.copy(offset).applyQuaternion(inverseBoardRotation);
    localDirection.copy(impulse).applyQuaternion(inverseBoardRotation);
    localTorque.crossVectors(localOffset, localDirection).multiply(inverseInertia);
    worldAngularChange.copy(localTorque).applyQuaternion(board.quaternion);
    spin.add(worldAngularChange);
  }

  function applyContactResponse(normal, offset, restitution, friction, minimumBounceSpeed) {
    const { velocity, spin } = breakout;
    contactVelocity.copy(spin).cross(offset).add(velocity);
    const normalSpeed = contactVelocity.dot(normal);
    if (normalSpeed >= 0) return false;

    const bounce = normalSpeed < -minimumBounceSpeed ? restitution : 0;
    const normalDenominator = getContactImpulseDenominator(normal, offset);
    const normalImpulseSize = -(1 + bounce) * normalSpeed / normalDenominator;
    contactImpulse.copy(normal).multiplyScalar(normalImpulseSize);
    applyContactImpulse(contactImpulse, offset);

    contactVelocity.copy(spin).cross(offset).add(velocity);
    tangentDirection.copy(contactVelocity).addScaledVector(normal, -contactVelocity.dot(normal));
    const tangentSpeed = tangentDirection.length();
    if (tangentSpeed > 1e-6) {
      tangentDirection.multiplyScalar(1 / tangentSpeed);
      const tangentDenominator = getContactImpulseDenominator(tangentDirection, offset);
      const tangentImpulseSize = THREE.MathUtils.clamp(
        -tangentSpeed / tangentDenominator,
        -friction * normalImpulseSize,
        friction * normalImpulseSize,
      );
      contactImpulse.copy(tangentDirection).multiplyScalar(tangentImpulseSize);
      applyContactImpulse(contactImpulse, offset);
    }

    return true;
  }

  function resolveRockCollision() {
    const { board, rock } = breakout;
    board.updateMatrixWorld(true);
    boardCollider.fromBox3(board.geometry.boundingBox).applyMatrix4(board.matrixWorld);
    boardCollider.clampPoint(rock.position, closestPoint);
    let distance = closestPoint.distanceTo(rock.position);
    if (distance >= ROCK_RADIUS) return;

    if (boardCollider.containsPoint(rock.position)) {
      localContact.copy(rock.position);
      board.worldToLocal(localContact);
      localOffset.copy(localContact);
      const { min, max } = board.geometry.boundingBox;
      distance = Infinity;

      for (const axis of ['x', 'y', 'z']) {
        const negativeDistance = localContact[axis] - min[axis];
        const positiveDistance = max[axis] - localContact[axis];
        const faceDistance = Math.min(negativeDistance, positiveDistance);
        if (faceDistance >= distance) continue;
        const faceSign = negativeDistance < positiveDistance ? -1 : 1;
        distance = faceDistance;
        localOffset[axis] = faceSign < 0 ? min[axis] : max[axis];
        contactNormal.set(0, 0, 0);
        contactNormal[axis] = faceSign;
      }

      closestPoint.copy(localOffset).applyMatrix4(board.matrixWorld);
      contactNormal.applyQuaternion(board.quaternion);
    } else {
      contactNormal.subVectors(closestPoint, rock.position).normalize();
    }

    contactOffset.subVectors(closestPoint, board.position);
    board.position.addScaledVector(contactNormal, ROCK_RADIUS - distance + 1e-4);
    if (applyContactResponse(contactNormal, contactOffset, ROCK_RESTITUTION, ROCK_FRICTION, 0.8)) {
      breakout.hitRock = true;
    }
  }

  function resolveGroundCollision() {
    const { board } = breakout;
    boardBounds.setFromObject(board);
    const penetration = ground.position.y - boardBounds.min.y;
    if (penetration <= 0) return false;

    board.position.y += penetration + 1e-4;
    board.updateMatrixWorld(true);
    const { min, max } = board.geometry.boundingBox;
    let contactCount = 0;

    for (let corner = 0; corner < 8; corner += 1) {
      localContact.set(
        corner & 1 ? max.x : min.x,
        corner & 2 ? max.y : min.y,
        corner & 4 ? max.z : min.z,
      );
      closestPoint.copy(localContact).applyMatrix4(board.matrixWorld);
      if (closestPoint.y > ground.position.y + 0.02) continue;
      groundContacts[contactCount].subVectors(closestPoint, board.position);
      contactCount += 1;
    }

    for (let iteration = 0; iteration < GROUND_CONTACT_ITERATIONS; iteration += 1) {
      for (let index = 0; index < contactCount; index += 1) {
        applyContactResponse(
          groundNormal,
          groundContacts[index],
          iteration === 0 ? GROUND_RESTITUTION : 0,
          GROUND_FRICTION,
          1.1,
        );
      }
    }

    return contactCount > 0;
  }

  function simulateBreakoutStep(delta) {
    const { board, velocity, spin } = breakout;
    if (breakout.sleeping) return;

    velocity.y -= BOARD_GRAVITY * delta;
    board.position.addScaledVector(velocity, delta);
    const angularSpeed = spin.length();
    if (angularSpeed > 1e-8) {
      spinAxis.copy(spin).multiplyScalar(1 / angularSpeed);
      rotationStep.setFromAxisAngle(spinAxis, angularSpeed * delta);
      board.quaternion.premultiply(rotationStep);
    }
    resolveRockCollision();
    const grounded = resolveGroundCollision();
    const nearlyStill = velocity.lengthSq() < GROUND_SLEEP_SPEED ** 2
      && spin.lengthSq() < GROUND_SLEEP_SPIN ** 2;

    if (grounded && nearlyStill) {
      breakout.groundRestTime += delta;
      if (breakout.groundRestTime >= GROUND_SLEEP_DELAY) {
        velocity.set(0, 0, 0);
        spin.set(0, 0, 0);
        breakout.sleeping = true;
      }
    } else {
      breakout.groundRestTime = 0;
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
    const { board, rock, hitRock } = breakout;
    const rockDistance = board.position.distanceTo(rock.position);
    const rockFocusWeight = hitRock ? 0.5 : THREE.MathUtils.clamp((16 - rockDistance) / 16, 0, 0.5);
    const horizontalDistance = Math.abs(board.position.x - rock.position.x);
    const verticalDistance = Math.abs(board.position.z - rock.position.z);
    const followZoom = hitRock
      ? Math.min(0.42, frameWidth / (horizontalDistance + 14), frameHeight / (verticalDistance + 14))
      : 0.42;
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
      camera.zoom = THREE.MathUtils.lerp(1, followZoom, eased);
      camera.updateProjectionMatrix();
      if (progress === 1) cameraTrackingBoard = true;
    } else {
      cameraTarget.copy(cameraFocus);
      activeCameraOffset.copy(flightCameraOffset);
      camera.zoom = followZoom;
      camera.updateProjectionMatrix();
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
