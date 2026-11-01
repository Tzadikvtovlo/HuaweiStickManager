const GITHUB_REPO = 'Tzadikvtovlo/HuaweiStickManager';

function getXmlTagSimple(xml, tag) {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = regex.exec(xml);
  return match ? match[1].trim() : null;
}

// פונקציית הזרקה לדף פעיל (צליל אזהרה + באנר חירום עליון)
function injectCriticalAlertInPage(batteryPercent, critLevel, shouldPlaySound, shouldShowBanner) {
  if (shouldPlaySound) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const playBeep = (freq, start, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(0.25, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + duration);
      };
      playBeep(784, 0, 0.15);
      playBeep(784, 0.2, 0.15);
      playBeep(987.77, 0.4, 0.35);
    } catch(e) {}
  }

  if (shouldShowBanner) {
    let banner = document.getElementById('huawei-critical-battery-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'huawei-critical-battery-banner';
      banner.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        z-index: 2147483647 !important;
        background: #0f2331 !important;
        color: #edf3f7 !important;
        border-bottom: 3px solid #0284c7 !important;
        padding: 10px 18px !important;
        direction: rtl !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-size: 13px !important;
        box-shadow: 0 4px 25px rgba(0,0,0,0.4) !important;
      `;
      document.body.appendChild(banner);
    }

    banner.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="background:#0284c7; color:#fff; padding:2px 7px; border-radius:4px; font-size:11px; font-weight:700;">חירום</span>
        <span>סוללת הסטיק עומדת להתרוקן! ירדה ל-<strong>${batteryPercent}%</strong> (סף שהוגדר: ${critLevel}%). חבר לטעינה מיד.</span>
      </div>
      <button id="huaweiCloseBannerBtn" style="background:#0284c7; color:#fff; border:none; padding:4px 12px; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer; font-family:inherit;">הבנתי, סגור</button>
    `;

    document.getElementById('huaweiCloseBannerBtn')?.addEventListener('click', () => {
      banner.remove();
    });
  }
}

// בדיקת סטטוס קלה ברקע כל דקה
async function checkDeviceStatusLight() {
  const settings = await chrome.storage.local.get({
    routerIp: '192.168.8.1',
    batteryThreshold: 20,
    batteryCriticalLevel: 5,
    critAlertTab: true,
    critAlertWindow: false,
    critAlertSound: true,
    critAlertBanner: false,
    lastCriticalAlert: 0
  });

  const ip = settings.routerIp;

  try {
    const res = await fetch(`http://${ip}/api/monitoring/status`, { cache: 'no-store' });
    if (!res.ok) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    const statusXml = await res.text();

    let batStr = getXmlTagSimple(statusXml, 'BatteryPercent') || getXmlTagSimple(statusXml, 'BatteryLevel');
    let isCharging = getXmlTagSimple(statusXml, 'BatteryStatus') === '1';
    const batteryPercent = parseInt(batStr || '-1', 10);
    const now = Date.now();

    if (batteryPercent >= 0) {
      await chrome.storage.local.set({ lastBatteryPercent: batteryPercent });
    }

    // טיפול בהתראות חירום סוללה קריטית
    const critLevel = settings.batteryCriticalLevel || 5;
    if (batteryPercent >= 0 && batteryPercent <= critLevel && !isCharging) {
      if (now - (settings.lastCriticalAlert || 0) > 300000) {
        await chrome.storage.local.set({ lastCriticalAlert: now });

        if (settings.critAlertTab !== false) {
          chrome.tabs.create({ url: chrome.runtime.getURL(`critical_battery.html?mode=tab&pct=${batteryPercent}&thresh=${critLevel}`) });
        }

        if (settings.critAlertWindow === true) {
          chrome.windows.create({
            url: chrome.runtime.getURL(`critical_battery.html?mode=window&pct=${batteryPercent}&thresh=${critLevel}`),
            type: 'popup',
            width: 480,
            height: 340
          });
        }

        if (settings.critAlertBanner || (settings.critAlertSound && !settings.critAlertTab && !settings.critAlertWindow)) {
          chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
            if (tabs && tabs[0] && tabs[0].id && tabs[0].url && !tabs[0].url.startsWith('chrome://')) {
              chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                func: injectCriticalAlertInPage,
                args: [batteryPercent, critLevel, settings.critAlertSound, settings.critAlertBanner]
              }).catch(() => {});
            }
          });
        }
      }
    }

    // עדכון סמלון לפי הודעות SMS
    try {
      const smsRes = await fetch(`http://${ip}/api/sms/sms-count`, { cache: 'no-store' });
      if (smsRes.ok) {
        const smsXml = await smsRes.text();
        const unreadSMS = parseInt(getXmlTagSimple(smsXml, 'LocalUnread') || getXmlTagSimple(smsXml, 'UnreadMessage') || '0', 10);
        if (unreadSMS > 0) {
          chrome.action.setBadgeText({ text: unreadSMS.toString() });
          chrome.action.setBadgeBackgroundColor({ color: '#0f2331' });
          return;
        }
      }
    } catch (e) {}

    // אם אין SMS וסוללה נמוכה
    if (batteryPercent >= 0 && batteryPercent <= settings.batteryThreshold && !isCharging) {
      chrome.action.setBadgeText({ text: `${batteryPercent}%` });
      chrome.action.setBadgeBackgroundColor({ color: '#476175' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }

  } catch (err) {
    chrome.action.setBadgeText({ text: '' });
  }
}

// בדיקת עדכונים כל 12 שעות בדיוק
async function checkUpdates12Hours() {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.tag_name) {
      const latestVersion = data.tag_name.replace(/[vV]/g, '').trim();
      if (parseFloat(latestVersion) > parseFloat(currentVersion)) {
        chrome.storage.local.set({ updateAvailable: latestVersion });
      }
    }
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  
  // בדיקת סוללה ו-SMS כל דקה
  chrome.alarms.create('checkStickEveryMinute', { periodInMinutes: 1 });
  
  // בדיקת עדכונים כל 12 שעות (720 דקות)
  chrome.alarms.create('checkUpdates12Hours', { periodInMinutes: 720 });

  checkDeviceStatusLight();
  checkUpdates12Hours();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkStickEveryMinute') checkDeviceStatusLight();
  if (alarm.name === 'checkUpdates12Hours') checkUpdates12Hours();
});