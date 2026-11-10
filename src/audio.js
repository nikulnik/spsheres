const SOUND_FILES = Object.freeze({
  ball: [
    'impactGlass_light_001.ogg',
    'impactGlass_light_002.ogg',
    'impactGlass_light_003.ogg',
  ],
  wall: [
    'impactPlank_medium_000.ogg',
    'impactPlank_medium_001.ogg',
    'impactPlank_medium_002.ogg',
  ],
});

const PLAY_INTERVAL = Object.freeze({ ball: 0.045, wall: 0.07 });
const SOUND_VOLUME = Object.freeze({ ball: 0.24, wall: 0.32 });
const GLOBAL_PLAY_INTERVAL = 0.02;
const MAX_VOICES = 12;
const MASTER_VOLUME = 0.7;
const SILENT_CAMERA_ZOOM = 0.08;
const CAMERA_VOLUME_RAMP = 0.12;

export function createCollisionAudio({ panRange = 4.5, initialZoom = 0.78 } = {}) {
  const buffers = { ball: [], wall: [] };
  const nextVariant = { ball: 0, wall: 0 };
  const lastKindTime = { ball: -Infinity, wall: -Infinity };
  let context;
  let master;
  let recordingDestination;
  let activeVoices = 0;
  let lastPlayTime = -Infinity;
  let distanceLevel = 1;
  let unavailable = false;

  async function loadSounds() {
    try {
      await Promise.all(Object.entries(SOUND_FILES).map(async ([kind, files]) => {
        buffers[kind] = await Promise.all(files.map(async (file) => {
          const response = await fetch(`/audio/${file}`);
          if (!response.ok) throw new Error(`Audio request failed: ${response.status} ${file}`);
          return context.decodeAudioData(await response.arrayBuffer());
        }));
      }));
    } catch (error) {
      console.warn('Collision audio failed to load:', error);
    }
  }

  function initialize() {
    if (context || unavailable) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      unavailable = true;
      return;
    }

    try {
      context = new AudioContextClass();
      master = context.createGain();
      master.gain.value = MASTER_VOLUME * distanceLevel;

      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.knee.value = 16;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.16;
      master.connect(compressor);
      compressor.connect(context.destination);

      recordingDestination = context.createMediaStreamDestination();
      compressor.connect(recordingDestination);
      loadSounds();
    } catch (error) {
      unavailable = true;
      context = undefined;
      console.warn('Collision audio is unavailable:', error);
    }
  }

  function unlock() {
    initialize();
    if (!context) return Promise.resolve(false);
    if (context.state === 'running') return Promise.resolve(true);
    return context.resume()
      .then(() => context.state === 'running')
      .catch(() => false);
  }

  function setCameraZoom(zoom) {
    const fadeRange = initialZoom - SILENT_CAMERA_ZOOM;
    distanceLevel = fadeRange > 0
      ? Math.min(1, Math.max(0, (zoom - SILENT_CAMERA_ZOOM) / fadeRange))
      : 0;
    if (!context || !master) return;

    const now = context.currentTime;
    const currentVolume = master.gain.value;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(currentVolume, now);
    master.gain.linearRampToValueAtTime(MASTER_VOLUME * distanceLevel, now + CAMERA_VOLUME_RAMP);
  }

  function play({ type, intensity, x = 0 }) {
    const samples = buffers[type];
    if (distanceLevel === 0 || !context || context.state !== 'running' || !samples?.length || activeVoices >= MAX_VOICES) return;

    const now = context.currentTime;
    if (now - lastPlayTime < GLOBAL_PLAY_INTERVAL || now - lastKindTime[type] < PLAY_INTERVAL[type]) return;

    const strength = Math.min(1, Math.max(0, intensity));
    const sampleIndex = nextVariant[type] % samples.length;
    nextVariant[type] += 1;
    lastPlayTime = now;
    lastKindTime[type] = now;

    const source = context.createBufferSource();
    source.buffer = samples[sampleIndex];
    source.playbackRate.value = 0.96 + strength * 0.08;

    const gain = context.createGain();
    gain.gain.value = SOUND_VOLUME[type] * (0.3 + strength * 0.7);
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-0.75, Math.min(0.75, (x / panRange) * 0.75));

    source.connect(gain);
    gain.connect(panner);
    panner.connect(master);
    activeVoices += 1;
    source.onended = () => {
      activeVoices -= 1;
      source.disconnect();
      gain.disconnect();
      panner.disconnect();
    };
    source.start();
  }

  function addToStream(stream) {
    if (!recordingDestination) return;
    for (const track of recordingDestination.stream.getAudioTracks()) {
      stream.addTrack(track.clone());
    }
  }

  return { play, unlock, setCameraZoom, addToStream };
}
