const GITHUB_REPO = 'Tzadikvtovlo/HuaweiStickManager';

// פונקציות עזר לבסיס הקוד של הרקע
function getXmlTagSimple(xml, tag) {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = regex.exec(xml);
  return match ? match[1].trim() : null;
}
async function hexSha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ----------------------------------------------------
// קליינט מינימלי למקרה הצורך באימות ברקע (עבור SMS)
// ----------------------------------------------------
class MinimalHuaweiClient {
  constructor(ip, user, pass) {
    this.ip = ip;
    this.user = user || 'admin';
    this.pass = pass;
    this.token = '';
  }
  async refreshTok() {
    try {
      const res = await fetch(`http://${this.ip}/api/webserver/SesTokInfo`, { cache: 'no-store' });
      if (res.ok) {
        const txt = await res.text();
        this.token = getXmlTagSimple(txt, 'TokInfo') || getXmlTagSimple(txt, 'token');
      }
    } catch(e) {}
  }
  async login() {
    if (!this.pass) return;
    await this.refreshTok();
    const firstHash = btoa(await hexSha256(this.pass));
    const finalHash = btoa(await hexSha256(this.user + firstHash + this.token));
    const loginXml = `<?xml version="1.0" encoding="UTF-8"?><request><Username>${this.user}</Username><Password>${finalHash}</Password><password_type>4</password_type></request>`;
    try {
      await fetch(`http://${this.ip}/api/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml', '__RequestVerificationToken': this.token },
        body: loginXml
      });
    } catch(e) {}
  }
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
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + duration);
      };
      playBeep(784, 0, 0.15); playBeep(784, 0.2, 0.15); playBeep(987.77, 0.4, 0.35);
    } catch(e) {}
  }
  if (shouldShowBanner) {
    let banner = document.getElementById('huawei-critical-battery-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'huawei-critical-battery-banner';
      banner.style.cssText = `
        position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important;
        z-index: 2147483647 !important; background: #0f2331 !important; color: #edf3f7 !important;
        border-bottom: 3px solid #0284c7 !important; padding: 10px 18px !important; direction: rtl !important;
        display: flex !important; align-items: center !important; justify-content: space-between !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-size: 13px !important; box-shadow: 0 4px 25px rgba(0,0,0,0.4) !important;
      `;
      document.body.appendChild(banner);
    }
    banner.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="background:#0284c7; color:#fff; padding:2px 7px; border-radius:4px; font-size:11px; font-weight:700;">חירום</span>
        <span>סוללת הסטיק עומדת להתרוקן! ירדה ל-<strong>${batteryPercent}%</strong> (סף שהוגדר: ${critLevel}%). חבר לטעינה מיד.</span>
      </div>
      <button id="huaweiCloseBannerBtn" style="background:#0284c7; color:#fff; border:none; padding:4px 12px; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer;">הבנתי, סגור</button>
    `;
    document.getElementById('huaweiCloseBannerBtn')?.addEventListener('click', () => banner.remove());
  }
}

// ----------------------------------------------------
// ניהול תצוגת הסמלון (Badge) מבוסס עדיפויות
// ----------------------------------------------------
async function evaluateBadge() {
  const s = await chrome.storage.local.get({
    smsCount: 0,
    lastBatteryPercent: 100,
    isCharging: false,
    batteryThreshold: 20,
    dataUsagePct: 0,
    dataThreshold: 90
  });

  // עדיפות 1: הודעות SMS חדשות (כחול כהה)
  if (s.smsCount > 0) {
    chrome.action.setBadgeText({ text: s.smsCount.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#0f2331' });
    return;
  }
  // עדיפות 2: סוללה נמוכה וגם לא בטעינה (אפור כחלחל)
  if (s.lastBatteryPercent >= 0 && s.lastBatteryPercent <= s.batteryThreshold && !s.isCharging) {
    chrome.action.setBadgeText({ text: `${s.lastBatteryPercent}%` });
    chrome.action.setBadgeBackgroundColor({ color: '#476175' });
    return;
  }
  // עדיפות 3: התראת חבילת גלישה (כתום-אדום)
  if (s.dataUsagePct >= s.dataThreshold) {
    chrome.action.setBadgeText({ text: `${s.dataUsagePct}%` });
    chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
    return;
  }
  // שום בעיה
  chrome.action.setBadgeText({ text: '' });
}

// ----------------------------------------------------
// בדיקת סוללה תקופתית
// ----------------------------------------------------
async function checkBatteryStatus() {
  const s = await chrome.storage.local.get({
    routerIp: '192.168.8.1',
    batteryThreshold: 20,
    batteryCriticalLevel: 5,
    critAlertTab: true,
    critAlertWindow: false,
    critAlertSound: true,
    critAlertBanner: false,
    lastCriticalAlert: 0
  });
  try {
    const res = await fetch(`http://${s.routerIp}/api/monitoring/status`, { cache: 'no-store' });
    if (!res.ok) return evaluateBadge();
    const statusXml = await res.text();
    const batStr = getXmlTagSimple(statusXml, 'BatteryPercent') || getXmlTagSimple(statusXml, 'BatteryLevel');
    const isCharging = getXmlTagSimple(statusXml, 'BatteryStatus') === '1';
    const batteryPercent = parseInt(batStr || '-1', 10);
    const now = Date.now();

    if (batteryPercent >= 0) {
      await chrome.storage.local.set({ lastBatteryPercent: batteryPercent, isCharging: isCharging });
    }

    // התראת חירום קופצת - רק אם לא בטעינה!
    const critLevel = s.batteryCriticalLevel || 5;
    if (batteryPercent >= 0 && batteryPercent <= critLevel && !isCharging) {
      if (now - (s.lastCriticalAlert || 0) > 300000) {
        await chrome.storage.local.set({ lastCriticalAlert: now });
        if (s.critAlertTab !== false) {
          chrome.tabs.create({ url: chrome.runtime.getURL(`critical_battery.html?mode=tab&pct=${batteryPercent}&thresh=${critLevel}`) });
        }
        if (s.critAlertWindow === true) {
          chrome.windows.create({
            url: chrome.runtime.getURL(`critical_battery.html?mode=window&pct=${batteryPercent}&thresh=${critLevel}`),
            type: 'popup', width: 480, height: 340
          });
        }
        if (s.critAlertBanner || (s.critAlertSound && !s.critAlertTab && !s.critAlertWindow)) {
          chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
            if (tabs && tabs[0] && tabs[0].id && tabs[0].url && !tabs[0].url.startsWith('chrome://')) {
              chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                func: injectCriticalAlertInPage,
                args: [batteryPercent, critLevel, s.critAlertSound, s.critAlertBanner]
              }).catch(() => {});
            }
          });
        }
      }
    }
    evaluateBadge();
  } catch (err) { evaluateBadge(); }
}

// ----------------------------------------------------
// בדיקת נתונים כללית (SMS וגלישה)
// ----------------------------------------------------
async function checkGeneralStatus() {
  const s = await chrome.storage.local.get({
    routerIp: '192.168.8.1',
    routerUsername: 'admin',
    routerPassword: '',
    dataLimitGB: 50,
    dataThreshold: 90
  });

  const doFetch = async () => {
    let unreadSMS = 0;
    try {
      const smsRes = await fetch(`http://${s.routerIp}/api/sms/sms-count`, { cache: 'no-store' });
      if (smsRes.ok) {
        const smsXml = await smsRes.text();
        if (smsXml.includes('100003') || smsXml.includes('125001') || smsXml.includes('125002')) return false; 
        unreadSMS = parseInt(getXmlTagSimple(smsXml, 'LocalUnread') || getXmlTagSimple(smsXml, 'UnreadMessage') || '0', 10);
      }
    } catch (e) {}

    let dataUsagePct = 0;
    try {
      let monthDown = '0', monthUp = '0';
      const mRes = await fetch(`http://${s.routerIp}/api/monitoring/month_statistics`, { cache: 'no-store' });
      if (mRes.ok) {
        const mXml = await mRes.text();
        monthDown = getXmlTagSimple(mXml, 'CurrentMonthDownload') || '0';
        monthUp = getXmlTagSimple(mXml, 'CurrentMonthUpload') || '0';
      }
      if (parseInt(monthDown, 10) === 0) {
        const tRes = await fetch(`http://${s.routerIp}/api/monitoring/traffic-statistics`, { cache: 'no-store' });
        if (tRes.ok) {
          const tXml = await tRes.text();
          monthDown = getXmlTagSimple(tXml, 'CurrentMonthDownload') || '0';
          monthUp = getXmlTagSimple(tXml, 'CurrentMonthUpload') || '0';
        }
      }
      const totalGB = ((parseInt(monthDown, 10) + parseInt(monthUp, 10)) / (1024 ** 3));
      const limitGB = parseFloat(s.dataLimitGB) || 50;
      dataUsagePct = Math.round(Math.min((totalGB / limitGB) * 100, 100));
    } catch (e) {}

    await chrome.storage.local.set({ smsCount: unreadSMS, dataUsagePct: dataUsagePct });
    evaluateBadge();
    return true; 
  };

  // ניסיון משיכה פשוט, אם נכשל מבקש התחברות שקטה
  const success = await doFetch();
  if (!success && s.routerPassword) {
    const minClient = new MinimalHuaweiClient(s.routerIp, s.routerUsername, s.routerPassword);
    await minClient.login();
    await doFetch();
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

// ניהול אזעקות חכם מבוסס הגדרות משתמש
async function setupAlarms() {
  const s = await chrome.storage.local.get({
    batteryCheckInterval: 3,
    generalCheckInterval: 5
  });
  
  chrome.alarms.clearAll();
  
  if (s.batteryCheckInterval > 0) {
    chrome.alarms.create('batteryCheck', { periodInMinutes: s.batteryCheckInterval });
  }
  if (s.generalCheckInterval > 0) {
    chrome.alarms.create('generalCheck', { periodInMinutes: s.generalCheckInterval });
  }
  chrome.alarms.create('checkUpdates12Hours', { periodInMinutes: 720 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  setupAlarms();
  checkBatteryStatus();
  checkGeneralStatus();
  checkUpdates12Hours();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'batteryCheck') checkBatteryStatus();
  if (alarm.name === 'generalCheck') checkGeneralStatus();
  if (alarm.name === 'checkUpdates12Hours') checkUpdates12Hours();
});

// האזנה להודעות מהפופ-אפ לעדכון מידי
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'updateAlarms') {
    setupAlarms();
  } else if (msg.action === 'forceCheck') {
    // הפעלת חישוב לתווית מיד עם פתיחת הפופאפ
    evaluateBadge();
  }
});