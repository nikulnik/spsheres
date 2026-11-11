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
});

const PLAY_INTERVAL = Object.freeze({ ball: 0.045, wall: 0.07 });
const SOUND_VOLUME = Object.freeze({
  ball: 0.24, wall: 0.32, domino: 0.85, breakout: 0.9, rock: 0.9, whoosh: 0.62, splash: 0.95,
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

  function playFinalDomino(x) {
    if (!context || context.state !== 'running') return;

    const now = context.currentTime;

    function routeVoice(source, ...nodes) {
      const panner = context.createStereoPanner();
      panner.pan.value = getPan(x);
      let previous = source;
      for (const node of nodes) {
        previous.connect(node);
        previous = node;
      }
      previous.connect(panner);
      panner.connect(dominoMaster);
      activeVoices += 1;
      source.onended = () => {
        activeVoices -= 1;
        source.disconnect();
        for (const node of nodes) node.disconnect();
        panner.disconnect();
      };
    }

    for (const tone of [
      { start: 120, end: 34, sweep: 0.85, volume: 1.3, attack: 0.01, duration: 2.2 },
      { start: 60, end: 24, sweep: 1.3, volume: 0.95, attack: 0.035, duration: 2.8 },
    ]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(tone.start, now);
      oscillator.frequency.exponentialRampToValueAtTime(tone.end, now + tone.sweep);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(tone.volume, now + tone.attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.duration);
      routeVoice(oscillator, gain);
      oscillator.start(now);
      oscillator.stop(now + tone.duration);
    }

    const noiseDuration = 0.85;
    const noiseBuffer = context.createBuffer(1, Math.ceil(context.sampleRate * noiseDuration), context.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    let seed = 0x6d2b79f5;
    for (let index = 0; index < noiseData.length; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noiseData[index] = seed / 2147483648 - 1;
    }
    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    noise.buffer = noiseBuffer;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1600, now);
    filter.frequency.exponentialRampToValueAtTime(110, now + 0.65);
    filter.Q.value = 0.8;
    noiseGain.gain.setValueAtTime(0.0001, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.7, now + 0.004);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + noiseDuration);
    routeVoice(noise, filter, noiseGain);
    noise.start(now);
    noise.stop(now + noiseDuration);
  }

  function play({ type, intensity, index = 0, x = 0 }) {
    if (type === 'finalDomino') {
      playFinalDomino(x);
      return;
    }

    const samples = buffers[type];
    const isBoardImpact = type === 'breakout' || type === 'rock';
    const isDomino = type === 'domino';
    const isSplash = type === 'splash';
    const useDominoMaster = isDomino || isSplash;
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
      source.playbackRate.value = isBoardImpact || isSplash ? 1 : 0.96 + strength * 0.08;
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
