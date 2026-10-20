// Recordings sheet: the saved recordings with playback, download and delete.

import { formatDb, formatDuration } from './dsp.js';
import { deleteRecording, listRecordings, recordingFile } from './recorder.js';

const $ = (id) => document.getElementById(id);
const DATE = new Intl.DateTimeFormat('de-AT', {
  weekday: 'short',
  day: 'numeric',
  month: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const ICONS = {
  play: '<path d="M7 4.5v15l12-7.5Z"/>',
  save: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  delete: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
};
const icon = (name) => `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// On phones the share sheet is the way to "Save to Files"; desktops download.
const shareFiles = () => matchMedia('(pointer: coarse)').matches && navigator.canShare;

export function createRecordingsView({ onPlay, onPlayEnd, onCount }) {
  const list = $('rec-list');
  const empty = $('rec-empty');
  const usage = $('rec-usage');
  let player = null;

  function stopPlayer() {
    if (!player) return;
    player.audio.pause();
    URL.revokeObjectURL(player.audio.src);
    player.audio.remove();
    player.item.classList.remove('playing');
    player = null;
    onPlayEnd();
  }

  async function play(row, item) {
    const same = player?.item === item;
    stopPlayer();
    if (same) return;
    const file = await recordingFile(row);
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = URL.createObjectURL(file);
    item.append(audio);
    item.classList.add('playing');
    player = { audio, item };
    onPlay();
    audio.addEventListener('ended', stopPlayer);
    audio.play().catch(() => {});
  }

  async function save(row) {
    const file = await recordingFile(row);
    if (shareFiles() && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name });
        return;
      } catch (error) {
        if (error.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  function confirmDelete(button, row, item) {
    if (!button.classList.contains('confirm')) {
      button.classList.add('confirm');
      button.setAttribute('aria-label', 'Wirklich löschen?');
      setTimeout(() => button.classList.remove('confirm'), 3000);
      return;
    }
    if (player?.item === item) stopPlayer();
    deleteRecording(row.id).then(refresh);
  }

  function render(rows) {
    stopPlayer();
    list.replaceChildren();
    empty.hidden = rows.length > 0;
    for (const row of rows) {
      const item = document.createElement('li');
      item.className = 'rec';
      const stats =
        row.leq === undefined
          ? 'unvollständig'
          : `Ø ${formatDb(row.leq)} · max ${formatDb(row.max)} ${row.unit ?? 'dB'}`;
      item.innerHTML = `
        <div class="rec-info">
          <span class="rec-date">${DATE.format(row.created)}</span>
          <span class="rec-meta">${formatDuration(row.samples / row.sampleRate)} · ${stats}</span>
        </div>
        <button class="icon-btn" type="button" data-act="play" aria-label="Abspielen">${icon('play')}</button>
        <button class="icon-btn" type="button" data-act="save" aria-label="Herunterladen">${icon('save')}</button>
        <button class="icon-btn danger" type="button" data-act="delete" aria-label="Löschen">${icon('delete')}</button>`;
      item.addEventListener('click', (e) => {
        const button = e.target.closest('button');
        if (!button) return;
        if (button.dataset.act === 'play') play(row, item);
        else if (button.dataset.act === 'save') save(row);
        else confirmDelete(button, row, item);
      });
      list.append(item);
    }
    const bytes = rows.reduce((sum, r) => sum + r.samples * 2, 0);
    onCount(rows.length);
    const count = rows.length === 1 ? '1 Aufnahme' : `${rows.length} Aufnahmen`;
    usage.textContent = rows.length ? `${count} · ${(bytes / 1e6).toFixed(1).replace('.', ',')} MB` : '';
  }

  async function refresh() {
    try {
      render(await listRecordings());
    } catch (error) {
      console.error(error);
      empty.hidden = false;
      empty.textContent = 'Der Speicher des Browsers ist nicht verfügbar.';
    }
  }

  return { refresh, stopPlayer };
}
