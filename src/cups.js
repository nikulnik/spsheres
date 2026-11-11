import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCupExplosion } from './cupExplosion.js';

const CUP_LAYOUT = [
  { name: 'tea_cup', anchor: 2, along: 0.25, behind: 11.2, height: 1.8, yaw: -0.65 },
  { name: 'ribbed_cup', anchor: 0, along: -4.8, behind: 15, height: 3.15, yaw: 0.7 },
  { name: 'strawberry_cup', anchor: 8, along: 4.2, behind: 31, height: 8.5, yaw: 0.95 },
  { name: 'rose_cup', anchor: 10, along: 11.5, behind: 51, height: 15, yaw: 1.1 },
];

export async function loadDominoCups(environment) {
  const loader = new GLTFLoader();
  const results = await Promise.allSettled(CUP_LAYOUT.map(async (placement) => {
    const { scene: model } = await loader.loadAsync(`/models/domino-cups/${placement.name}.glb`);
    model.name = placement.name;
    model.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      object.material.envMap = environment;
      object.material.envMapIntensity = 0.45;
    });
    return { ...placement, model };
  }));
  const cups = [];
  for (const result of results) {
    if (result.status === 'fulfilled') cups.push(result.value);
    else console.warn('Domino backdrop model failed to load:', result.reason);
  }
  return cups;
}

export function addDominoCups(chain, cups, farSide, onCollision) {
  if (cups.length === 0) return;
  const backdrop = new THREE.Group();
  backdrop.name = 'Domino cup backdrop';
  const bounds = new THREE.Box3();
  const center = new THREE.Vector3();
  let largest = cups[0];

  for (const cup of cups) {
    const { model, anchor, along, behind, height, yaw } = cup;
    const { pivotZ, depth } = chain.dominoes[anchor];
    model.rotation.y = yaw + (farSide < 0 ? Math.PI : 0);
    bounds.setFromObject(model);
    model.scale.setScalar(height / (bounds.max.y - bounds.min.y));
    bounds.setFromObject(model).getCenter(center);
    model.position.set(farSide * behind - center.x, -bounds.min.y,
      pivotZ - depth / 2 + along - center.z);
    backdrop.add(model);
    if (height > largest.height) largest = cup;
  }
  chain.group.add(backdrop);
  return createCupExplosion(backdrop, largest.model, onCollision);
}
