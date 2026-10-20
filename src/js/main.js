// Wiring: start/pause, settings, recording, the render loop.

import { errorText, loadDsp, startAudio } from './audio.js';
import { formatDb, formatDuration, REPORT_SECONDS } from './dsp.js';
import { createLevelView } from './level-view.js';
import { startRecording } from './recorder.js';
import { createRecordingsView } from './recordings-view.js';
import { DEFAULT_OFFSET, loadSettings, saveSettings } from './settings.js';
import { createSpectrumView } from './spectrum-view.js';
import { LevelStats, WEIGHTINGS } from './stats.js';

const $ = (id) => document.getElementById(id);
const settings = loadSettings();
const level = createLevelView();
const spectrum = createSpectrumView();
const recordings = createRecordingsView({
  onPlay: pauseForPlayback,
  onPlayEnd: resumeAfterPlayback,
  onCount: (count) => {
    $('rec-count').hidden = !count;
    $('rec-count').textContent = String(count);
  },
});

let stats = new LevelStats({ reportSeconds: REPORT_SECONDS });
let audio = null;
let state = 'idle'; // idle | starting | running | paused | waiting
let userPaused = false;
let resumeAfterPlay = false;
let levelDirty = true;
let measured = false;
let recording = null;
let wakeLock = null;

// --- State and status ---

function setState(next, message = '') {
  state = next;
  document.body.dataset.state = next;
  const overlay = ['idle', 'starting', 'waiting'].includes(next);
  $('start').hidden = !overlay;
  $('start-btn').disabled = next === 'starting';
  if (next === 'running') measured = true;
  $('start-btn').textContent =
    next === 'starting' ? 'Startet …' : next === 'waiting' && measured ? 'Weiter messen' : 'Messung starten';
  $('start-error').hidden = !message;
  $('start-error').textContent = message;
  $('toggle').setAttribute('aria-label', next === 'paused' ? 'Fortsetzen' : 'Pause');
  $('record').disabled = !audio;
  keepAwake(next === 'running');
  status();
}

function status(now = performance.now()) {
  const el = $('status');
  if (recording) {
    el.textContent = `Aufnahme ${formatDuration(recording.writer.seconds)}`;
    el.className = 'status rec';
  } else {
    el.textContent = state === 'running' ? 'Misst' : state === 'paused' ? 'Pausiert' : '';
    el.className = `status ${state}`;
  }
  status.at = now;
}

async function keepAwake(on) {
  if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch {
      // Not allowed (battery saver, iframe): the screen may dim.
    }
  } else if (!on && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// --- Audio ---

// `auto`: started without a tap (microphone already allowed). If that fails,
// e.g. because the screen was off, the start button just waits for a tap.
async function start(auto = false) {
  if (audio) {
    // Suspended by the system (autoplay rule, phone call): a tap resumes it.
    userPaused = false;
    await audio.ctx.resume().catch(() => {});
    return;
  }
  if (state === 'starting') return;
  setState('starting');
  try {
    audio = await startAudio({
      mode: settings.averaging,
      onLevel,
      onSpectrum: (live, avg) => {
        spectrum.onSpectrum(live, avg);
        requestFrame();
      },
      onAverage: (db, current) => spectrum.onAverage(db, current),
      onPcm: (pcm) => recording?.writer.write(pcm).catch(recordingFailed),
      onRecordEnd: finishRecording,
      onEnded: () => stop('Das Mikrofon wurde getrennt.'),
    });
  } catch (error) {
    if (!auto) console.error(error);
    setState('idle', auto ? '' : errorText(error));
    return;
  }
  stats = new LevelStats({ reportSeconds: REPORT_SECONDS });
  userPaused = false;
  spectrum.attach(audio, settings);
  audio.ctx.onstatechange = () => {
    if (!audio) return;
    if (audio.ctx.state === 'running') setState('running');
    else if (audio.ctx.state !== 'closed') setState(userPaused ? 'paused' : 'waiting');
  };
  setState(audio.ctx.state === 'running' ? 'running' : 'waiting');
}

function stop(message) {
  if (recording) finishRecording();
  audio?.stop();
  audio = null;
  spectrum.detach();
  setState('idle', message);
}

function togglePause() {
  if (!audio) return;
  if (state === 'paused') {
    userPaused = false;
    audio.ctx.resume();
  } else {
    userPaused = true;
    audio.ctx.suspend();
  }
}

function pauseForPlayback() {
  if (state !== 'running') return;
  // Otherwise the speaker would end up in the average and the maximum. A
  // running recording just has a gap.
  resumeAfterPlay = true;
  togglePause();
}

function resumeAfterPlayback() {
  if (!resumeAfterPlay) return;
  resumeAfterPlay = false;
  if (state === 'paused') togglePause();
}

function onLevel(report) {
  stats.add(report);
  recording?.stats.add(report);
  levelDirty = true;
  requestFrame();
}

function reset() {
  stats.reset();
  audio?.send({ type: 'reset' });
  spectrum.reset();
  refreshLevel();
}

// --- Recording ---

async function toggleRecording() {
  if (!audio) return;
  if (recording) {
    if (recording.stopping) return;
    recording.stopping = true;
    audio.send({ type: 'record', on: false });
    return;
  }
  try {
    const writer = await startRecording({ sampleRate: audio.sampleRate, offset: settings.offset });
    recording = { writer, stats: new LevelStats({ reportSeconds: REPORT_SECONDS, settleSeconds: 0 }) };
    document.body.classList.add('recording');
    audio.send({ type: 'record', on: true });
    status();
  } catch (error) {
    recordingFailed(error);
  }
}

function finishRecording() {
  if (!recording) return;
  const { writer, stats: s } = recording;
  const w = settings.weighting;
  recording = null;
  document.body.classList.remove('recording');
  writer
    .finish({
      leq: s.leq(w) + settings.offset,
      max: s.max(w, settings.time) + settings.offset,
      unit: `dB(${WEIGHTINGS[w]})`,
    })
    .then(() => recordings.refresh())
    .catch(recordingFailed);
  status();
}

function recordingFailed(error) {
  console.error(error);
  if (recording) {
    audio?.send({ type: 'record', on: false });
    recording = null;
    document.body.classList.remove('recording');
  }
  alert(
    error?.name === 'QuotaExceededError'
      ? 'Der Speicher ist voll. Alte Aufnahmen löschen und noch einmal versuchen.'
      : `Aufnahme fehlgeschlagen: ${error?.message ?? error}`,
  );
  status();
}

// --- Views ---

function refreshLevel() {
  level.labels(settings);
  level.frame(stats, settings, performance.now(), true);
  level.draw(stats, settings);
}

function changed() {
  saveSettings(settings);
  refreshLevel();
  spectrum.redraw(settings);
  calibration();
}

// Frames only when new data has come in (levels 20/s, spectra 47/s): an
// endless animation loop would keep the phone rendering 60 frames a second.
let framePending = false;

function requestFrame() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(loop);
}

function loop(now) {
  framePending = false;
  if (state !== 'running') return;
  // New levels come 20 times a second; between them there is nothing to do.
  if (levelDirty) {
    levelDirty = false;
    level.frame(stats, settings, now);
    level.chart(stats, settings, now);
  }
  spectrum.frame(now, settings);
  if (recording && now - status.at > 250) status(now);
}

// --- Settings sheet ---

function calibration() {
  const sign = settings.offset >= 0 ? '+' : '−';
  $('cal-value').textContent = `${sign}${formatDb(Math.abs(settings.offset))} dB`;
  $('cal-state').textContent =
    settings.offset === DEFAULT_OFFSET ? 'Nicht kalibriert (Standardwert)' : 'Kalibriert';
}

function adjust(delta) {
  settings.offset = Math.round((settings.offset + delta) * 10) / 10;
  changed();
}

function applyReference() {
  const reference = Number.parseFloat($('cal-ref').value.replace(',', '.'));
  const measured = stats.level(settings.weighting, 1);
  if (!Number.isFinite(reference) || !Number.isFinite(measured)) {
    $('cal-ref').focus();
    return;
  }
  settings.offset = Math.round((reference - measured) * 10) / 10;
  $('cal-ref').value = '';
  changed();
}

// --- Events ---

$('start-btn').addEventListener('click', () => start());
$('toggle').addEventListener('click', togglePause);
$('record').addEventListener('click', toggleRecording);
for (const button of document.querySelectorAll('.reset')) button.addEventListener('click', reset);
$('recordings-btn').addEventListener('click', () => {
  recordings.refresh();
  $('recordings').showModal();
});
$('recordings').addEventListener('close', () => recordings.stopPlayer());
$('weighting').addEventListener('click', () => {
  settings.weighting = (settings.weighting + 1) % 3;
  changed();
});
$('timing').addEventListener('click', () => {
  settings.time = (settings.time + 1) % 2;
  changed();
});
$('range').addEventListener('click', () => {
  settings.range = settings.range === 60 ? 600 : 60;
  changed();
});
$('averaging').addEventListener('click', () => {
  settings.averaging = (settings.averaging + 1) % 3;
  audio?.send({ type: 'mode', mode: settings.averaging });
  averagingLabel();
  saveSettings(settings);
});
$('settings-btn').addEventListener('click', () => {
  calibration();
  $('settings').showModal();
});
$('cal-minus').addEventListener('click', () => adjust(-0.5));
$('cal-plus').addEventListener('click', () => adjust(0.5));
$('cal-apply').addEventListener('click', applyReference);
$('cal-reset').addEventListener('click', () => {
  settings.offset = DEFAULT_OFFSET;
  changed();
});
// A tap on the dimmed backdrop closes a sheet.
for (const sheet of [$('settings'), $('recordings')]) {
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close();
  });
}

// No zooming, like a native app. iOS ignores user-scalable=no in the viewport
// tag, so pinch gestures, two-finger moves and double taps are stopped here
// as well (touch-action in the CSS covers the other browsers).
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault());
}
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches.length > 1) e.preventDefault();
  },
  { passive: false },
);
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (audio && !userPaused && audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
  if (!audio && state === 'idle') autoStart();
  keepAwake(state === 'running');
});

function averagingLabel() {
  $('averaging').textContent = ['Ø 1 s', 'Ø 10 s', 'Ø gesamt'][settings.averaging];
}

// --- Start-up ---

averagingLabel();
refreshLevel();
spectrum.show(true, settings);
recordings.refresh();
setState('idle');
loadDsp().catch((error) => setState('idle', errorText(error)));

// With the microphone already allowed, start right away; on iOS the audio
// may still wait for a tap, which the overlay then asks for.
function autoStart() {
  navigator.permissions
    ?.query({ name: 'microphone' })
    .then((p) => p.state === 'granted' && start(true))
    .catch(() => {});
}
autoStart();

if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('sw.js');
}

// Open for the browser test and the console.
window.schall = {
  settings,
  spectrum,
  get stats() {
    return stats;
  },
  get audio() {
    return audio;
  },
};
