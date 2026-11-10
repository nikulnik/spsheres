import './style.css';
import { createCollisionAudio } from './audio.js';
import { createArenaScene, SCENE_CONFIG } from './scene.js';

const RECORD_WIDTH = 1080;
const RECORD_HEIGHT = 1920;
const RECORD_FPS = 30;

const canvas = document.querySelector('#scene');
const frame = document.querySelector('#frame');
const recordButton = document.querySelector('#record');
const recordLabel = document.querySelector('#record-label');
const status = document.querySelector('#status');
const timer = document.querySelector('#timer');

const collisionAudio = createCollisionAudio({
  panRange: SCENE_CONFIG.frameWidth / 2,
  initialZoom: SCENE_CONFIG.cameraZoom,
});
const arena = createArenaScene(canvas, {
  onCollision: collisionAudio.play,
  onCameraZoom: collisionAudio.setCameraZoom,
  onBreakout: (position) => collisionAudio.play({ type: 'breakout', intensity: 1, x: position.x }),
});
const unlockAudio = () => collisionAudio.unlock();
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio);

let capturing = false;
let recorder;
let stream;
let chunks = [];
let startedAt = 0;
let timerInterval;
let recordingFailed = false;

function resizeDisplay() {
  if (capturing) return;
  const { width, height } = frame.getBoundingClientRect();
  arena.resize(
    Math.max(1, Math.round(width)),
    Math.max(1, Math.round(height)),
    Math.min(window.devicePixelRatio || 1, 2),
  );
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateTimer() {
  timer.value = formatDuration(performance.now() - startedAt);
}

function resetCapture() {
  clearInterval(timerInterval);
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  recorder = undefined;
  capturing = false;
  recordButton.disabled = false;
  recordButton.classList.remove('is-recording');
  recordLabel.textContent = 'Записать 1080 × 1920';
  resizeDisplay();
}

function saveRecording() {
  const type = recorder?.mimeType || 'video/webm';
  const blob = new Blob(chunks, { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const date = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  link.href = url;
  link.download = `arena-1080x1920-${date}.webm`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function stopRecording() {
  if (recorder?.state !== 'recording') return;
  clearInterval(timerInterval);
  recordButton.disabled = true;
  recordLabel.textContent = 'Сохранение…';
  status.textContent = 'Подготовка видео';
  recorder.stop();
}

function startRecording() {
  recordingFailed = false;
  chunks = [];

  try {
    capturing = true;
    arena.resize(RECORD_WIDTH, RECORD_HEIGHT, 1);
    collisionAudio.unlock();
    stream = canvas.captureStream(RECORD_FPS);
    collisionAudio.addToStream(stream);

    const mimeTypes = stream.getAudioTracks().length > 0
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
    const options = { videoBitsPerSecond: 12_000_000 };
    if (mimeType) options.mimeType = mimeType;

    recorder = new MediaRecorder(stream, options);
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('error', () => {
      recordingFailed = true;
    });
    recorder.addEventListener('stop', () => {
      if (!recordingFailed && chunks.length > 0) {
        saveRecording();
        status.textContent = 'Видео сохранено · 1080 × 1920';
      } else {
        status.textContent = 'Не удалось сохранить видео';
      }
      resetCapture();
    }, { once: true });

    recorder.start(250);
    startedAt = performance.now();
    timer.value = '00:00';
    timerInterval = setInterval(updateTimer, 250);
    recordButton.classList.add('is-recording');
    recordLabel.textContent = 'Остановить запись';
    status.textContent = 'Идёт запись';
  } catch (error) {
    console.error('Recording failed:', error);
    status.textContent = 'Запись недоступна в этом браузере';
    resetCapture();
  }
}

const canRecord = 'MediaRecorder' in window && 'captureStream' in HTMLCanvasElement.prototype;
if (!canRecord) {
  recordButton.disabled = true;
  status.textContent = 'Запись не поддерживается браузером';
}

recordButton.addEventListener('click', () => {
  if (recorder?.state === 'recording') {
    stopRecording();
  } else if (!recordButton.disabled) {
    startRecording();
  }
});

recordButton.disabled = true;
status.textContent = 'Загрузка текстур…';
new ResizeObserver(resizeDisplay).observe(frame);
window.addEventListener('resize', resizeDisplay);
resizeDisplay();
arena.start();

try {
  await arena.ready;
  recordButton.disabled = !canRecord;
  status.textContent = canRecord ? 'Готово к записи' : 'Запись не поддерживается браузером';
} catch (error) {
  console.error('Texture loading failed:', error);
  status.textContent = 'Не удалось загрузить текстуры';
}
