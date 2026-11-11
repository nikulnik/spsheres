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
  domino: [
    'impactPlank_medium_000.ogg',
    'impactPlank_medium_001.ogg',
    'impactPlank_medium_002.ogg',
    'impactPlank_medium_003.ogg',
    'impactPlank_medium_004.ogg',
  ],
  breakout: ['plank-break.ogg'],
  rock: ['plank-rock.ogg'],
  whoosh: ['plank-whoosh.ogg'],
  splash: ['liquid-burst.ogg'],
  cupExplosion: ['cup-explosion.ogg'],
});

const PLAY_INTERVAL = Object.freeze({ ball: 0.045, wall: 0.07 });
const SOUND_VOLUME = Object.freeze({
  ball: 0.24, wall: 0.32, domino: 0.85, breakout: 0.9, rock: 0.9, whoosh: 0.62, splash: 0.95,
  cupExplosion: 1,
});
const GLOBAL_PLAY_INTERVAL = 0.02;
const MAX_VOICES = 12;
const MASTER_VOLUME = 0.7;
const SILENT_CAMERA_ZOOM = 0.08;
const CAMERA_VOLUME_RAMP = 0.12;
const WHOOSH_FADE = 0.12;
const DOMINO_IMPACT_COUNT = 11;
const DOMINO_FIRST_PLAYBACK_RATE = 1.08;
const DOMINO_LAST_PLAYBACK_RATE = 0.54;
const DOMINO_FIRST_VOLUME = 0.5;
const DOMINO_LAST_VOLUME = 1.25;

export function createCollisionAudio({ panRange = 4.5, initialZoom = 0.78 } = {}) {
  const kinds = Object.keys(SOUND_FILES);
  const buffers = {};
  const nextVariant = Object.fromEntries(kinds.map((kind) => [kind, 0]));
  const lastKindTime = Object.fromEntries(kinds.map((kind) => [kind, -Infinity]));
  let context;
  let master;
  let dominoMaster;
  let recordingDestination;
  let whooshVoice;
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
      dominoMaster = context.createGain();
      dominoMaster.gain.value = MASTER_VOLUME;
      dominoMaster.connect(compressor);
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

  function getPan(x) {
    return Math.max(-0.75, Math.min(0.75, (x / panRange) * 0.75));
  }

  function createSampleVoice(buffer, x, output) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    panner.pan.value = getPan(x);
    source.connect(gain);
    gain.connect(panner);
    panner.connect(output);
    activeVoices += 1;
    source.onended = () => {
      activeVoices -= 1;
      source.disconnect();
      gain.disconnect();
      panner.disconnect();
    };
    return { source, gain, panner };
  }

  function setBoardFlight(x) {
    if (x === null) {
      if (!whooshVoice) return;
      const { source, gain } = whooshVoice;
      whooshVoice = undefined;
      const now = context.currentTime;
      const volume = gain.gain.value;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.linearRampToValueAtTime(0, now + WHOOSH_FADE);
      source.stop(now + WHOOSH_FADE);
      return;
    }

    const sample = buffers.whoosh?.[0];
    if (!sample || context?.state !== 'running') return;
    if (whooshVoice) {
      whooshVoice.panner.pan.value = getPan(x);
      return;
    }

    whooshVoice = createSampleVoice(sample, x, master);
    const { source, gain } = whooshVoice;
    const now = context.currentTime;
    source.loop = true;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(SOUND_VOLUME.whoosh, now + WHOOSH_FADE);
    source.start(now);
  }

  function play({ type, intensity, index = 0, x = 0 }) {
    const samples = buffers[type];
    const isBoardImpact = type === 'breakout' || type === 'rock';
    const isDomino = type === 'domino';
    const isFinaleEffect = type === 'splash' || type === 'cupExplosion';
    const useDominoMaster = isDomino || isFinaleEffect;
    const bypassesLimits = isBoardImpact || useDominoMaster;
    if (
      (!useDominoMaster && distanceLevel === 0)
      || !context
      || context.state !== 'running'
      || !samples?.length
      || (!bypassesLimits && activeVoices >= MAX_VOICES)
    ) return;

    const now = context.currentTime;
    if (
      !bypassesLimits
      && (now - lastPlayTime < GLOBAL_PLAY_INTERVAL || now - lastKindTime[type] < PLAY_INTERVAL[type])
    ) return;

    const strength = Math.min(1, Math.max(0, intensity));
    const dominoProgress = isDomino
      ? Math.min(1, Math.max(0, (index - 1) / (DOMINO_IMPACT_COUNT - 1)))
      : 0;
    const sampleIndex = nextVariant[type] % samples.length;
    nextVariant[type] += 1;
    lastPlayTime = now;
    lastKindTime[type] = now;

    const { source, gain } = createSampleVoice(
      samples[sampleIndex], x, useDominoMaster ? dominoMaster : master,
    );
    if (isDomino) {
      source.playbackRate.value = DOMINO_FIRST_PLAYBACK_RATE
        * (DOMINO_LAST_PLAYBACK_RATE / DOMINO_FIRST_PLAYBACK_RATE) ** dominoProgress;
    } else {
      source.playbackRate.value = isBoardImpact || isFinaleEffect ? 1 : 0.96 + strength * 0.08;
    }

    const volumeScale = isDomino
      ? DOMINO_FIRST_VOLUME + (DOMINO_LAST_VOLUME - DOMINO_FIRST_VOLUME) * dominoProgress
      : 0.3 + strength * 0.7;
    gain.gain.value = SOUND_VOLUME[type] * volumeScale;
    source.start();
  }

  function addToStream(stream) {
    if (!recordingDestination) return;
    for (const track of recordingDestination.stream.getAudioTracks()) {
      stream.addTrack(track.clone());
    }
  }

  return { play, unlock, setCameraZoom, setBoardFlight, addToStream };
}
