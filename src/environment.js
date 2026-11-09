import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

function seededRandom(initialSeed) {
  let seed = initialSeed;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function organicRadius(angle, phase) {
  return 1 + Math.sin(angle * 3 + phase) * 0.07 + Math.sin(angle * 5 - phase * 0.6) * 0.035;
}

function createOrganicGeometry(phase) {
  const points = [];
  for (let index = 0; index < 48; index += 1) {
    const angle = (index / 48) * Math.PI * 2;
    const radius = organicRadius(angle, phase);
    points.push(new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius));
  }
  return new THREE.ShapeGeometry(new THREE.Shape(points));
}

function createGrassGeometry() {
  const positions = [];
  for (let blade = 0; blade < 5; blade += 1) {
    const angle = (blade / 5) * Math.PI * 2;
    const directionX = Math.cos(angle);
    const directionZ = Math.sin(angle);
    const sideX = -directionZ;
    const sideZ = directionX;
    const rootX = directionX * 0.055;
    const rootZ = directionZ * 0.055;
    const height = 0.42 + (blade % 3) * 0.09;
    const middleX = rootX + directionX * 0.055;
    const middleZ = rootZ + directionZ * 0.055;
    const tipX = rootX + directionX * 0.16;
    const tipZ = rootZ + directionZ * 0.16;
    const width = 0.045;
    const rootLeft = [rootX + sideX * width, 0, rootZ + sideZ * width];
    const rootRight = [rootX - sideX * width, 0, rootZ - sideZ * width];
    const middleLeft = [middleX + sideX * width * 0.55, height * 0.62, middleZ + sideZ * width * 0.55];
    const middleRight = [middleX - sideX * width * 0.55, height * 0.62, middleZ - sideZ * width * 0.55];
    const tip = [tipX, height, tipZ];
    positions.push(
      ...rootLeft, ...rootRight, ...middleRight,
      ...rootLeft, ...middleRight, ...middleLeft,
      ...middleLeft, ...middleRight, ...tip,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function createGardenEnvironment(scene, {
  frameWidth,
  courtDepth,
  groundY,
  environment,
}) {
  const garden = new THREE.Group();
  garden.name = 'Garden environment';
  scene.add(garden);

  const random = seededRandom(7301);
  const transform = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3();
  const foliageInstances = [];
  const barkInstances = [];
  const stoneInstances = [];
  const pathInstances = [];
  const grassInstances = [];
  const stemInstances = [];
  const petalInstances = [];
  const flowerCenterInstances = [];

  const foliageMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.9,
    flatShading: true,
  });
  const barkMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 });
  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.96,
    flatShading: true,
  });
  const grassMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 1,
    side: THREE.DoubleSide,
  });
  const stemMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 });
  const petalMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.72,
    flatShading: true,
  });
  const flowerCenterMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 });

  const foliageGeometry = new THREE.IcosahedronGeometry(1, 2);
  const barkGeometry = new THREE.CylinderGeometry(0.72, 1, 1, 7);
  const stoneGeometry = new THREE.IcosahedronGeometry(1, 1);
  const pathGeometry = new THREE.CylinderGeometry(1, 1.07, 0.12, 7);
  const grassGeometry = createGrassGeometry();
  const stemGeometry = new THREE.CylinderGeometry(1, 1, 1, 5);
  const petalGeometry = new THREE.SphereGeometry(1, 7, 5);
  const flowerCenterGeometry = new THREE.SphereGeometry(1, 8, 6);

  function addInstance(instances, x, y, z, scaleX, scaleY, scaleZ, rotation, color) {
    transform.position.set(x, y, z);
    transform.rotation.set(0, rotation, 0);
    transform.scale.set(scaleX, scaleY, scaleZ);
    transform.updateMatrix();
    instances.push({ matrix: transform.matrix.clone(), color: new THREE.Color(color) });
  }

  function addBarkSegment(instances, start, end, radius, color) {
    direction.subVectors(end, start);
    const length = direction.length();
    transform.position.copy(start).add(end).multiplyScalar(0.5);
    transform.quaternion.setFromUnitVectors(up, direction.normalize());
    transform.scale.set(radius, length, radius);
    transform.updateMatrix();
    instances.push({ matrix: transform.matrix.clone(), color: new THREE.Color(color) });
  }

  function buildInstances(geometry, material, instances, castShadow = true) {
    const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
    for (let index = 0; index < instances.length; index += 1) {
      mesh.setMatrixAt(index, instances[index].matrix);
      mesh.setColorAt(index, instances[index].color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    garden.add(mesh);
    return mesh;
  }

  const patchMaterials = ['#9eaa83', '#adb58e', '#b8b99a'].map((color) => (
    new THREE.MeshStandardMaterial({ color, roughness: 1 })
  ));
  const patchGeometries = [0.4, 1.8, 3.1].map(createOrganicGeometry);

  function addPatch(x, z, scaleX, scaleZ, variant = 0) {
    const patch = new THREE.Mesh(
      patchGeometries[variant % patchGeometries.length],
      patchMaterials[variant % patchMaterials.length],
    );
    patch.rotation.x = -Math.PI / 2;
    patch.rotation.z = variant * 0.7;
    patch.position.set(x, groundY + 0.006 + (variant % 3) * 0.001, z);
    patch.scale.set(scaleX, scaleZ, 1);
    patch.receiveShadow = true;
    garden.add(patch);
  }

  [
    [-7.8, -6.4, 3.1, 3.8],
    [-8.3, 6.3, 3.5, 3.4],
    [6.7, 8.8, 3.6, 2.8],
    [-1.5, 9.3, 5.5, 2.1],
    [1.2, -9.1, 5.8, 2.2],
    [12, -9.4, 4.8, 3.1],
    [25, 11.3, 5.3, 3.4],
    [36, -10.6, 5.5, 3.1],
    [49, 12.2, 5.2, 3.5],
    [58, -9, 4.5, 3.2],
    [-12, 9.4, 4.8, 3.1],
    [-25, -11.3, 5.3, 3.4],
    [-36, 10.6, 5.5, 3.1],
    [-49, -12.2, 5.2, 3.5],
    [-58, 9, 4.5, 3.2],
    [-10, -24, 4.6, 4],
    [10, -24, 4.6, 4],
    [-12, 24, 4.6, 4],
    [12, 24, 4.6, 4],
    [-9, -45, 5.2, 4.5],
    [11, -45, 5.2, 4.5],
    [-11, 45, 5.2, 4.5],
    [10, 45, 5.2, 4.5],
  ].forEach(([x, z, scaleX, scaleZ], index) => addPatch(x, z, scaleX, scaleZ, index));

  const greenPalette = ['#426b50', '#557d58', '#6b9163', '#85a570'];
  const blossomPalette = ['#aa6c7d', '#c78896', '#dea6aa', '#edc2bb'];
  const barkPalette = ['#66503d', '#775c43', '#85674b'];

  function addTree(x, z, scale, palette) {
    addBarkSegment(
      barkInstances,
      new THREE.Vector3(x, groundY, z),
      new THREE.Vector3(x + 0.08 * scale, groundY + 2.85 * scale, z),
      0.25 * scale,
      barkPalette[Math.floor(random() * barkPalette.length)],
    );

    const clusters = [
      [0, 3.65, 0, 1.15],
      [-0.85, 3.3, 0.1, 0.95],
      [0.85, 3.35, 0.18, 0.98],
      [0.12, 3.35, -0.85, 0.9],
      [-0.1, 3.25, 0.9, 0.92],
      [-0.62, 4.05, -0.42, 0.82],
      [0.62, 4.08, -0.25, 0.85],
      [0.12, 4.42, 0.18, 0.78],
    ];

    for (let index = 0; index < 4; index += 1) {
      const angle = index * Math.PI * 0.5 + 0.35;
      addBarkSegment(
        barkInstances,
        new THREE.Vector3(x, groundY + (1.8 + index * 0.12) * scale, z),
        new THREE.Vector3(
          x + Math.cos(angle) * 0.95 * scale,
          groundY + 3.3 * scale,
          z + Math.sin(angle) * 0.95 * scale,
        ),
        0.105 * scale,
        barkPalette[index % barkPalette.length],
      );
    }

    for (const [offsetX, offsetY, offsetZ, radius] of clusters) {
      const size = radius * scale * (0.9 + random() * 0.16);
      addInstance(
        foliageInstances,
        x + offsetX * scale,
        groundY + offsetY * scale,
        z + offsetZ * scale,
        size,
        size * (0.78 + random() * 0.12),
        size,
        random() * Math.PI,
        palette[Math.floor(random() * palette.length)],
      );
    }
  }

  [
    [-7.8, -6.8, 1.05, greenPalette],
    [-8.6, 6.4, 1.18, blossomPalette],
    [6.9, 9.3, 0.98, greenPalette],
    [-4.7, 11.2, 0.88, greenPalette],
    [11.5, -9.8, 1.12, greenPalette],
    [25.2, 12.3, 1.14, blossomPalette],
    [35.5, -10.8, 1.08, greenPalette],
    [48.5, 12.5, 1.2, greenPalette],
    [58, -9, 1.08, blossomPalette],
    [-11.5, 9.8, 1.12, greenPalette],
    [-25.2, -12.3, 1.14, blossomPalette],
    [-35.5, 10.8, 1.08, greenPalette],
    [-48.5, -12.5, 1.2, greenPalette],
    [-58, 9, 1.08, blossomPalette],
    [-10, -24, 1.08, blossomPalette],
    [10, -24, 1.12, greenPalette],
    [-12, 24, 1.15, greenPalette],
    [12, 24, 1.05, blossomPalette],
    [-9, -45, 1.35, greenPalette],
    [11, -45, 1.3, blossomPalette],
    [-11, 45, 1.3, blossomPalette],
    [10, 45, 1.35, greenPalette],
  ].forEach(([x, z, scale, palette]) => addTree(x, z, scale, palette));

  const distantPalette = ['#5f7968', '#718874', '#82977c', '#93a388'];
  for (const centerX of [-46, 46]) {
    for (let index = 0; index < 20; index += 1) {
      const angle = (index / 20) * Math.PI * 2;
      const radius = 39 + (index % 3) * 2.2;
      const x = centerX + Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (Math.abs(x) < 10 && Math.abs(z) < 12) continue;
      addPatch(x, z, 4.5, 4, index);
      addTree(x, z, 1.35 + random() * 0.5, distantPalette);
    }

    for (let index = 0; index < 12; index += 1) {
      const angle = (index / 12) * Math.PI * 2 + 0.18;
      const offsetX = Math.cos(angle) * 63;
      if (Math.sign(centerX) * offsetX < 0) continue;
      const x = centerX + offsetX;
      const z = Math.sin(angle) * 63;
      addInstance(
        foliageInstances,
        x,
        groundY - 0.8,
        z,
        10 + random() * 5,
        3.2 + random() * 2.2,
        8 + random() * 4,
        random() * Math.PI,
        ['#91a088', '#9da991', '#aab39b'][index % 3],
      );
    }
  }

  for (const z of [-68, 68]) {
    for (const x of [-18, 0, 18]) {
      addInstance(
        foliageInstances,
        x,
        groundY - 0.8,
        z,
        11 + random() * 4,
        3.5 + random() * 1.8,
        9 + random() * 3,
        random() * Math.PI,
        '#9da991',
      );
    }
  }

  const shrubCenters = [
    [-5.8, -3.8], [-6.1, 3.4], [5.9, -8], [3.2, 8.7], [-2.4, -8.8],
    [9.5, 8.1], [12.5, -7.8], [23, -8.7], [30.5, 9.2], [40, -8.8],
    [48, 8.6], [56, 7.9], [-9.5, -8.1], [-12.5, 7.8], [-23, 8.7],
    [-30.5, -9.2], [-40, 8.8], [-48, -8.6], [-56, -7.9],
    [8, -22], [-8, -22], [8, 22], [-8, 22], [9, -40], [-9, 40],
  ];
  for (const [x, z] of shrubCenters) {
    for (let cluster = 0; cluster < 3; cluster += 1) {
      const angle = cluster * Math.PI * 2 / 3 + random() * 0.4;
      const size = 0.5 + random() * 0.24;
      addInstance(
        foliageInstances,
        x + Math.cos(angle) * 0.48,
        groundY + size * 0.62,
        z + Math.sin(angle) * 0.48,
        size,
        size * 0.78,
        size,
        random() * Math.PI,
        greenPalette[1 + Math.floor(random() * (greenPalette.length - 1))],
      );
    }
  }

  const pondX = 18;
  const pondZ = 10;
  const pondRadiusX = 3.25;
  const pondRadiusZ = 2.2;
  const pondPhase = 1.7;
  const pondGeometry = createOrganicGeometry(pondPhase);
  const pondObjectStart = garden.children.length;
  const pondBank = new THREE.Mesh(
    pondGeometry,
    new THREE.MeshStandardMaterial({ color: '#a79f80', roughness: 1 }),
  );
  pondBank.rotation.x = -Math.PI / 2;
  pondBank.position.set(pondX, groundY + 0.012, pondZ);
  pondBank.scale.set(pondRadiusX * 1.12, pondRadiusZ * 1.16, 1);
  pondBank.receiveShadow = true;
  garden.add(pondBank);

  const water = new THREE.Mesh(
    pondGeometry,
    new THREE.MeshPhysicalMaterial({
      color: '#5d9994',
      roughness: 0.18,
      metalness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      transparent: true,
      opacity: 0.9,
      envMap: environment ?? null,
      envMapIntensity: 0.85,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(pondX, groundY + 0.026, pondZ);
  water.scale.set(pondRadiusX, pondRadiusZ, 1);
  water.receiveShadow = true;
  garden.add(water);

  for (let index = 0; index < 28; index += 1) {
    const angle = (index / 28) * Math.PI * 2;
    const radius = organicRadius(angle, pondPhase);
    const size = 0.24 + random() * 0.18;
    const offsetX = Math.cos(angle) * pondRadiusX * radius * 1.06;
    const offsetZ = Math.sin(angle) * pondRadiusZ * radius * 1.08;
    const rotation = random() * Math.PI;
    const color = ['#8b8c7d', '#a4a18c', '#b7ae94'][index % 3];
    for (const side of [-1, 1]) {
      addInstance(
        stoneInstances,
        side * (pondX + offsetX),
        groundY + size * 0.32,
        side * (pondZ + offsetZ),
        size * 1.3,
        size * 0.65,
        size,
        rotation,
        color,
      );
    }
  }

  const lilyMaterial = new THREE.MeshStandardMaterial({
    color: '#527c55',
    roughness: 0.82,
    side: THREE.DoubleSide,
  });
  const lilyGeometry = new THREE.CircleGeometry(1, 24, 0.25, Math.PI * 2 - 0.48);
  const lilyPositions = [
    [-1.65, -0.65, 0.33], [-1.05, 0.82, 0.27], [1.45, 0.65, 0.36],
    [1.9, -0.45, 0.25], [0.45, -1.15, 0.29],
  ];
  for (const [offsetX, offsetZ, size] of lilyPositions) {
    const lily = new THREE.Mesh(lilyGeometry, lilyMaterial);
    lily.rotation.set(-Math.PI / 2, 0, random() * Math.PI * 2);
    lily.position.set(pondX + offsetX, groundY + 0.045, pondZ + offsetZ);
    lily.scale.setScalar(size);
    lily.receiveShadow = true;
    garden.add(lily);
  }

  function addBloom(x, y, z, size, color) {
    for (let petal = 0; petal < 5; petal += 1) {
      const angle = (petal / 5) * Math.PI * 2;
      addInstance(
        petalInstances,
        x + Math.cos(angle) * size * 0.48,
        y,
        z + Math.sin(angle) * size * 0.48,
        size * 0.43,
        size * 0.17,
        size * 0.76,
        Math.PI / 2 - angle,
        color,
      );
    }
    addInstance(
      flowerCenterInstances,
      x,
      y + size * 0.1,
      z,
      size * 0.27,
      size * 0.2,
      size * 0.27,
      0,
      '#e6b85c',
    );
  }

  addBloom(pondX - 1.65, groundY + 0.11, pondZ - 0.65, 0.27, '#f0c1c8');
  addBloom(pondX + 1.45, groundY + 0.11, pondZ + 0.65, 0.25, '#f4ddd0');
  addBloom(-pondX + 1.65, groundY + 0.11, -pondZ + 0.65, 0.27, '#f0c1c8');
  addBloom(-pondX - 1.45, groundY + 0.11, -pondZ - 0.65, 0.25, '#f4ddd0');

  const bridge = new THREE.Group();
  bridge.position.set(pondX, groundY, pondZ);
  const bridgeWood = new THREE.MeshStandardMaterial({ color: '#956346', roughness: 0.82 });
  const bridgeDarkWood = new THREE.MeshStandardMaterial({ color: '#684c3b', roughness: 0.9 });
  const plankGeometry = new RoundedBoxGeometry(0.52, 0.12, 1.34, 2, 0.025);
  const deckPoints = [];

  function addBridgeBeam(start, end, radius, material) {
    const beam = new THREE.Mesh(barkGeometry, material);
    direction.subVectors(end, start);
    beam.position.copy(start).add(end).multiplyScalar(0.5);
    beam.quaternion.setFromUnitVectors(up, direction.clone().normalize());
    beam.scale.set(radius, direction.length(), radius);
    beam.castShadow = true;
    beam.receiveShadow = true;
    bridge.add(beam);
  }

  for (let index = 0; index < 9; index += 1) {
    const x = (index - 4) * 0.5;
    const y = 0.25 + 0.52 * (1 - (x / 2.15) ** 2);
    const plank = new THREE.Mesh(plankGeometry, bridgeWood);
    plank.position.set(x, y, 0);
    plank.rotation.z = Math.atan(-x / (2.15 ** 2) * 0.52);
    plank.castShadow = true;
    plank.receiveShadow = true;
    bridge.add(plank);
    deckPoints.push(new THREE.Vector3(x, y, 0));
  }

  for (const side of [-1, 1]) {
    for (let index = 0; index < deckPoints.length; index += 1) {
      const point = deckPoints[index];
      if (index % 2 === 0) {
        addBridgeBeam(
          new THREE.Vector3(point.x, point.y, side * 0.7),
          new THREE.Vector3(point.x, point.y + 0.64, side * 0.7),
          0.055,
          bridgeDarkWood,
        );
      }
      if (index < deckPoints.length - 1) {
        const next = deckPoints[index + 1];
        addBridgeBeam(
          new THREE.Vector3(point.x, point.y + 0.58, side * 0.7),
          new THREE.Vector3(next.x, next.y + 0.58, side * 0.7),
          0.05,
          bridgeDarkWood,
        );
      }
    }
  }
  garden.add(bridge);

  const westPond = new THREE.Group();
  westPond.rotation.y = Math.PI;
  for (const object of garden.children.slice(pondObjectStart)) {
    westPond.add(object.clone());
  }
  garden.add(westPond);

  for (let index = 0; index < 14; index += 1) {
    const z = -10.5 + index * 1.58;
    const x = -6.55 + Math.sin(index * 0.63) * 0.45;
    const size = 0.42 + random() * 0.14;
    addInstance(
      pathInstances,
      x,
      groundY + 0.065,
      z,
      size * 1.2,
      1,
      size,
      random() * Math.PI,
      ['#b7b39e', '#c6c0aa', '#a8a893'][index % 3],
    );
  }
  for (let index = 0; index < 9; index += 1) {
    const x = -4.4 + index * 1.08;
    const z = 8.65 + Math.sin(index * 0.7) * 0.38;
    const size = 0.4 + random() * 0.12;
    addInstance(
      pathInstances,
      x,
      groundY + 0.065,
      z,
      size * 1.15,
      1,
      size,
      random() * Math.PI,
      ['#b7b39e', '#c6c0aa', '#a8a893'][index % 3],
    );
  }

  const boulderClusters = [
    [-6.4, -8.4], [-10.2, 2.4], [7.2, 10.5], [9.4, -8.4],
    [28.5, -9.8], [38.5, 10.8], [53.5, -8.2],
    [-9.4, 8.4], [-28.5, 9.8], [-38.5, -10.8], [-53.5, 8.2],
    [8, -27], [-8, 27], [9, 43], [-9, -43],
  ];
  for (const [x, z] of boulderClusters) {
    for (let index = 0; index < 4; index += 1) {
      const size = 0.22 + random() * 0.45;
      addInstance(
        stoneInstances,
        x + (random() - 0.5) * 1.25,
        groundY + size * 0.42,
        z + (random() - 0.5) * 1.05,
        size * 1.25,
        size * 0.82,
        size,
        random() * Math.PI,
        ['#85897b', '#9b9b88', '#b0aa94'][index % 3],
      );
    }
  }

  const lanternStone = new THREE.MeshStandardMaterial({ color: '#8d9184', roughness: 0.96 });
  const lanternRoof = new THREE.MeshStandardMaterial({ color: '#656e65', roughness: 0.92 });
  const lanternGlow = new THREE.MeshStandardMaterial({
    color: '#ffd596',
    emissive: '#ffae55',
    emissiveIntensity: 1.4,
    roughness: 0.6,
  });
  const lanternBaseGeometry = new THREE.CylinderGeometry(0.44, 0.53, 0.16, 8);
  const lanternPostGeometry = new THREE.CylinderGeometry(0.18, 0.25, 0.72, 8);
  const lanternPlatformGeometry = new THREE.CylinderGeometry(0.45, 0.35, 0.16, 8);
  const lanternChamberGeometry = new RoundedBoxGeometry(0.5, 0.43, 0.5, 2, 0.035);
  const lanternRoofGeometry = new THREE.ConeGeometry(0.65, 0.34, 4);
  const lanternCapGeometry = new THREE.SphereGeometry(0.1, 10, 7);
  const lanternWindowGeometry = new THREE.BoxGeometry(0.28, 0.25, 0.018);

  function addLantern(x, z, scale = 1) {
    const lantern = new THREE.Group();
    lantern.position.set(x, groundY, z);
    lantern.scale.setScalar(scale);
    lantern.rotation.y = random() * 0.3 - 0.15;

    function part(geometry, material, y) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = y;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      lantern.add(mesh);
      return mesh;
    }

    part(lanternBaseGeometry, lanternStone, 0.08);
    part(lanternPostGeometry, lanternStone, 0.52);
    part(lanternPlatformGeometry, lanternStone, 0.94);
    part(lanternChamberGeometry, lanternStone, 1.23);
    const roof = part(lanternRoofGeometry, lanternRoof, 1.61);
    roof.rotation.y = Math.PI / 4;
    part(lanternCapGeometry, lanternRoof, 1.83);

    for (let side = 0; side < 4; side += 1) {
      const angle = side * Math.PI / 2;
      const window = new THREE.Mesh(lanternWindowGeometry, lanternGlow);
      window.position.set(Math.sin(angle) * 0.255, 1.24, Math.cos(angle) * 0.255);
      window.rotation.y = angle;
      lantern.add(window);
    }
    garden.add(lantern);
  }

  [
    [-5.55, -5.85, 0.88], [-5.65, 5.75, 0.9], [5.75, -6.15, 0.9],
    [5.85, 6.25, 0.92], [13.2, 7.1, 1], [33.5, -8.1, 1.05], [49.5, 8.2, 1],
    [-13.2, -7.1, 1], [-33.5, 8.1, 1.05], [-49.5, -8.2, 1],
    [7, -23, 1], [-7, 23, 1], [8, -42, 1.05], [-8, 42, 1.05],
  ].forEach(([x, z, scale]) => addLantern(x, z, scale));

  const flowerPatches = [
    [-5.25, -4.25, '#d78e9e'], [-5.35, 3.55, '#a99ac8'],
    [5.3, -7.6, '#f0cf9d'], [5.45, 7.7, '#d78e9e'],
    [-2.1, 8.15, '#f0d8c4'], [1.8, -8.35, '#a99ac8'],
    [10.2, 6.8, '#d78e9e'], [10.5, -6.9, '#f0cf9d'],
    [26.5, -7.5, '#a99ac8'], [41, 7.6, '#f0d8c4'],
    [-10.2, -6.8, '#d78e9e'], [-10.5, 6.9, '#f0cf9d'],
    [-26.5, 7.5, '#a99ac8'], [-41, -7.6, '#f0d8c4'],
    [6.5, -20, '#d78e9e'], [-6.5, 20, '#a99ac8'],
    [7, 40, '#f0cf9d'], [-7, -40, '#f0d8c4'],
  ];
  for (const [centerX, centerZ, color] of flowerPatches) {
    for (let index = 0; index < 10; index += 1) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * 0.85;
      const x = centerX + Math.cos(angle) * radius;
      const z = centerZ + Math.sin(angle) * radius;
      const height = 0.25 + random() * 0.28;
      addInstance(stemInstances, x, groundY + height / 2, z, 0.016, height, 0.016, 0, '#52734c');
      addBloom(x, groundY + height, z, 0.13 + random() * 0.045, color);
    }
  }

  let attempts = 0;
  while (grassInstances.length < 1400 && attempts < 10000) {
    attempts += 1;
    const x = -65 + random() * 130;
    const z = -52 + random() * 104;
    const insideArena = Math.abs(x) < frameWidth / 2 + 0.65 && Math.abs(z) < courtDepth / 2 + 0.65;
    const insideFlightPath = (Math.abs(x) > frameWidth / 2 && Math.abs(z) < 5.7)
      || (Math.abs(z) > courtDepth / 2 && Math.abs(x) < 5.7);
    const insidePond = ((Math.abs(x) - pondX) / (pondRadiusX + 0.8)) ** 2
      + ((Math.abs(z) - pondZ) / (pondRadiusZ + 0.8)) ** 2 < 1;
    if (insideArena || insideFlightPath || insidePond) continue;
    const scale = 0.65 + random() * 0.85;
    addInstance(
      grassInstances,
      x,
      groundY + 0.01,
      z,
      scale,
      scale,
      scale,
      random() * Math.PI * 2,
      ['#6e855b', '#829666', '#93a273'][Math.floor(random() * 3)],
    );
  }

  buildInstances(foliageGeometry, foliageMaterial, foliageInstances);
  buildInstances(barkGeometry, barkMaterial, barkInstances);
  buildInstances(stoneGeometry, stoneMaterial, stoneInstances);
  buildInstances(pathGeometry, stoneMaterial, pathInstances);
  buildInstances(grassGeometry, grassMaterial, grassInstances, false);
  buildInstances(stemGeometry, stemMaterial, stemInstances, false);
  buildInstances(petalGeometry, petalMaterial, petalInstances, false);
  buildInstances(flowerCenterGeometry, flowerCenterMaterial, flowerCenterInstances, false);

  return garden;
}
