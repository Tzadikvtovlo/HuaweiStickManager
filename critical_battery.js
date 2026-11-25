document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  let pct = urlParams.get('pct');
  let thresh = urlParams.get('thresh');

  const s = await chrome.storage.local.get({
    batteryCriticalLevel: 5,
    critAlertSound: true,
    lastBatteryPercent: 0
  });

  if (!pct || pct === 'undefined' || pct === 'null') {
    pct = s.lastBatteryPercent || 0;
  }
  if (!thresh || thresh === 'undefined' || thresh === 'null') {
    thresh = s.batteryCriticalLevel || 5;
  }

  const descEl = document.getElementById('batteryDesc');
  if (descEl) {
    descEl.innerHTML = `רמת הסוללה בסטיק ירדה ל-<strong>${pct}%</strong> (סף החירום שהגדרת: <strong>${thresh}%</strong>).<br>החיבור עומד להיסגר בתוך דקות ספורות.<br><strong>נא לחבר את הסטיק לטעינה מיד.</strong>`;
  }

  document.getElementById('closeBtn')?.addEventListener('click', () => {
    window.close();
  });

  // השמעת צליל אזהרה אם הוגדר
  if (s.critAlertSound) {
    playAlertTone();
  }
});

function playAlertTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const playBeep = (freq, start, duration, vol) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(vol, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + duration);
    };

    for (let i = 0; i < 3; i++) {
      playBeep(880, i * 0.8, 0.2, 0.1);
      playBeep(1046.5, i * 0.8 + 0.2, 0.4, 0.1);
    }
  } catch (e) {}
}
