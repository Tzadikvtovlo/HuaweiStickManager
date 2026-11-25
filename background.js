const GITHUB_REPO = 'Tzadikvtovlo/HuaweiStickManager';

// -------------------------------------------------------------------------
// הגנה 1: קטיעה אוטומטית (Anti-Hang) - מונע מהתוסף להיתקע אם הסטיק איטי
// -------------------------------------------------------------------------
async function fetchWithTimeout(resource, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, { credentials: 'include', ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// --- כלי עזר ל-XML ופענוח ---
function getXmlTagSimple(xml, tag) {
  if (!xml) return null;
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = regex.exec(xml);
  return match ? match[1].trim() : null;
}

function getNodesSimple(xml, tag) {
  if (!xml) return [];
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let matches = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

function isHuaweiAuthError(xml) {
  if (!xml) return true;
  return xml.includes('100003') || xml.includes('125001') || xml.includes('125002');
}

function parseBatteryPercentFromXml(statusXml) {
  const pctStr = getXmlTagSimple(statusXml, 'BatteryPercent');
  if (pctStr !== null && pctStr !== '') {
    const p = parseInt(pctStr, 10);
    if (!isNaN(p) && p >= 0 && p <= 100) return p;
  }
  const lvlStr = getXmlTagSimple(statusXml, 'BatteryLevel');
  if (lvlStr !== null && lvlStr !== '') {
    const lvl = parseInt(lvlStr, 10);
    if (!isNaN(lvl) && lvl >= 0) {
      // ברוב סטיקי Huawei, BatteryLevel הוא סקאלה של 0-4 פסים ולא אחוזים
      return lvl <= 4 ? Math.min(100, lvl * 25) : Math.min(100, lvl);
    }
  }
  return -1;
}

async function hexSha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

class MinimalHuaweiClient {
  constructor(ip, user, pass) {
    this.ip = (ip || '192.168.8.1').trim();
    this.user = (user || 'admin').trim().toLowerCase();
    this.pass = pass || '';
    this.session = '';
    this.token = '';
    this.isLoggedIn = false;
  }

  async syncChromeCookie(rawSession) {
    if (!rawSession || !chrome.cookies) return;
    const cleanSession = rawSession.replace(/^SessionID=/i, '');
    try {
      await chrome.cookies.set({
        url: `http://${this.ip}/`,
        name: 'SessionID',
        value: cleanSession
      });
    } catch (e) {}
  }

  updateTokenFromHeaders(res) {
    const newToken = res.headers.get('__RequestVerificationToken') ||
                     res.headers.get('__requestverificationtokenone') ||
                     res.headers.get('__requestverificationtokentwo');
    if (newToken) this.token = newToken;
  }

  async refreshTok() {
    try {
      const res = await fetchWithTimeout(`http://${this.ip}/api/webserver/SesTokInfo`, {
        cache: 'no-store',
        credentials: 'include'
      });
      if (res.ok) {
        const txt = await res.text();
        const ses = getXmlTagSimple(txt, 'SessionInfo') || getXmlTagSimple(txt, 'SesInfo');
        const tok = getXmlTagSimple(txt, 'TokInfo') || getXmlTagSimple(txt, 'token');
        if (ses) {
          this.session = ses.startsWith('SessionID=') ? ses : `SessionID=${ses}`;
          await this.syncChromeCookie(ses);
        }
        if (tok) this.token = tok;
        return !!this.token;
      }
    } catch (e) {}
    return false;
  }

  async checkLoginState() {
    try {
      const headers = this.token ? { '__RequestVerificationToken': this.token } : {};
      const res = await fetchWithTimeout(`http://${this.ip}/api/user/state-login`, {
        headers,
        cache: 'no-store',
        credentials: 'include'
      });
      this.updateTokenFromHeaders(res);
      if (res.ok) {
        const txt = await res.text();
        const state = getXmlTagSimple(txt, 'State');
        this.isLoggedIn = (state === '0');
        const deviceUser = getXmlTagSimple(txt, 'username') || getXmlTagSimple(txt, 'Username');
        if (deviceUser) this.user = deviceUser.toLowerCase();
        return this.isLoggedIn;
      }
    } catch (e) {}
    this.isLoggedIn = false;
    return false;
  }

  async sendLoginXml(userToTry, pwdHash, type) {
    const loginXml = `<?xml version="1.0" encoding="UTF-8"?><request><Username>${userToTry}</Username><Password>${pwdHash}</Password><password_type>${type}</password_type></request>`;
    try {
      const res = await fetchWithTimeout(`http://${this.ip}/api/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml', '__RequestVerificationToken': this.token },
        body: loginXml,
        credentials: 'include'
      });
      this.updateTokenFromHeaders(res);
      const txt = await res.text();
      if (txt.includes('OK') || txt.includes('108003')) {
        this.isLoggedIn = true;
        await this.refreshTok();
        return true;
      }
    } catch (e) {}
    return false;
  }

  async executeLogin(userToTry) {
    await this.refreshTok();
    const firstHash = btoa(await hexSha256(this.pass));
    const finalHash = btoa(await hexSha256(userToTry + firstHash + this.token));
    if (await this.sendLoginXml(userToTry, finalHash, 4)) return true;
    if (await this.sendLoginXml(userToTry, btoa(this.pass), 0)) return true;
    return false;
  }

  async login() {
    await this.refreshTok();
    if (!this.pass) return false;
    if (await this.checkLoginState()) return true;
    if (await this.executeLogin(this.user)) return true;
    if (this.user !== '' && await this.executeLogin('')) return true;
    return false;
  }

  async getXml(endpoint) {
    if (!this.token) {
      await this.refreshTok();
    }
    const doReq = async () => {
      const headers = this.token ? { '__RequestVerificationToken': this.token } : {};
      const res = await fetchWithTimeout(`http://${this.ip}/${endpoint}`, {
        headers,
        cache: 'no-store',
        credentials: 'include'
      });
      this.updateTokenFromHeaders(res);
      if (!res.ok) return '';
      return await res.text();
    };

    let xml = await doReq();
    if (isHuaweiAuthError(xml)) {
      // ראשית מרעננים SesTokInfo (עובד גם ללא סיסמה עבור status בסיסי!)
      await this.refreshTok();
      xml = await doReq();
      if (isHuaweiAuthError(xml) && this.pass) {
        const logged = await this.login();
        if (logged) {
          xml = await doReq();
        }
      }
    }
    return xml;
  }
}

// פעולות החירום באנר בדף + צליל
function injectCriticalAlertInPage(batteryPercent, critLevel, shouldPlaySound, shouldShowBanner) {
  if (shouldPlaySound) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const playBeep = (freq, start, duration, vol) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(vol, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + duration);
      };
      for(let i = 0; i < 3; i++) {
         playBeep(880, i * 0.8, 0.2, 0.1);
         playBeep(1046.5, i * 0.8 + 0.2, 0.4, 0.1);
      }
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

// התראת פוש (עם תמיכה בהתראות מתמשכות לסוללה נמוכה/קריטית כדי שלא ייעלמו תוך 15 שניות)
function firePushNotification(notifId, title, message, priority = 1, persistent = false) {
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: title,
    message: message,
    priority: Math.min(priority, 1),
    requireInteraction: false
  }, (createdId) => {
    if (chrome.runtime.lastError) return;
    if (createdId) {
      chrome.alarms.create('clear_notif::' + createdId, { delayInMinutes: 5 });
    }
  });
}

async function evaluateBadge() {
  const s = await chrome.storage.local.get({
    smsCount: 0, lastBatteryPercent: 100, isCharging: false,
    batteryThreshold: 20, dataUsagePct: 0, dataThreshold: 90
  });

  if (s.smsCount > 0) {
    chrome.action.setBadgeText({ text: s.smsCount.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#0f2331' });
    return;
  }
  if (s.lastBatteryPercent >= 0 && s.lastBatteryPercent <= s.batteryThreshold && !s.isCharging) {
    chrome.action.setBadgeText({ text: `${s.lastBatteryPercent}%` });
    chrome.action.setBadgeBackgroundColor({ color: '#476175' });
    return;
  }
  if (s.dataUsagePct >= s.dataThreshold) {
    chrome.action.setBadgeText({ text: `${s.dataUsagePct}%` });
    chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
    return;
  }
  chrome.action.setBadgeText({ text: '' });
}

// לוגיקה חכמה להתראות סוללה
async function evaluateBatteryAlertsLogic(batteryPercent, isCharging, forceTest = false) {
  const s = await chrome.storage.local.get({
    batteryThreshold: 20, batteryCriticalLevel: 5,
    critAlertTab: true, critAlertWindow: false, critAlertSound: true, critAlertBanner: false,
    lastCriticalAlert: 0, lastLowAlert: 0, isCharging: false
  });

  const critNum = Number(s.batteryCriticalLevel);
  const lowNum = Number(s.batteryThreshold);
  const critLevel = Number.isFinite(critNum) ? critNum : 5;
  const lowLevel = Number.isFinite(lowNum) ? lowNum : 20;
  const now = Date.now();
  let triggeredAny = false;

  // זיהוי ניתוק מהמטען - איפוס שעונים כדי להתריע מיד!
  const justUnplugged = (s.isCharging === true && isCharging === false);
  if (justUnplugged && !forceTest) {
    s.lastCriticalAlert = 0;
    s.lastLowAlert = 0;
  }

  await chrome.storage.local.set({ isCharging: isCharging });

  if (isCharging && forceTest) {
     firePushNotification('huawei_test_charging', 'בדיקת התראות - סוללה בטעינה', `הסטיק מחובר לחשמל כעת (${batteryPercent}%). ההתראות לא יופעלו בזמן טעינה.`, 1, false);
     evaluateBadge();
     return;
  }

  if (isCharging && !forceTest) {
    await chrome.storage.local.set({ lastCriticalAlert: 0, lastLowAlert: 0 });
  } else if (batteryPercent >= 0) {
    if (batteryPercent <= critLevel) {
      if (forceTest || (now - (s.lastCriticalAlert || 0) > 300000) || justUnplugged) {
        triggeredAny = true;
        if (!forceTest) await chrome.storage.local.set({ lastCriticalAlert: now });

        if (s.critAlertTab !== false) {
          const existingTabs = await chrome.tabs.query({ url: chrome.runtime.getURL('critical_battery.html*') }).catch(() => []);
          const tabUrl = chrome.runtime.getURL(`critical_battery.html?mode=tab&pct=${batteryPercent}&thresh=${critLevel}`);
          if (existingTabs && existingTabs.length > 0) {
            chrome.tabs.update(existingTabs[0].id, { url: tabUrl, active: true }).catch(() => {});
          } else {
            chrome.tabs.create({ url: tabUrl });
          }
        }
        if (s.critAlertWindow === true) {
          chrome.windows.create({
            url: chrome.runtime.getURL(`critical_battery.html?mode=window&pct=${batteryPercent}&thresh=${critLevel}`),
            type: 'popup', width: 500, height: 380, focused: true
          });
        }
        if (s.critAlertBanner || (s.critAlertSound && !s.critAlertTab && !s.critAlertWindow)) {
          chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
            if (tabs && tabs[0] && tabs[0].id && tabs[0].url && !tabs[0].url.startsWith('chrome://') && !tabs[0].url.startsWith('chrome-extension://')) {
              chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: injectCriticalAlertInPage, args: [batteryPercent, critLevel, s.critAlertSound, s.critAlertBanner] }).catch(() => {});
            }
          });
        }
        // תמיד שולח גם התראת פוש קופצת במצב קריטי (כדי שיתריע גם כשהדפדפן ממוזער)
        const critTitle = forceTest ? 'בדיקת התראות - מצב קריטי' : 'HuaweiStickManager - סוללה קריטית!';
        const critMsg = forceTest
          ? `הסוללה ברמה קריטית (${batteryPercent}%). פעולות החירום הופעלו.`
          : `סוללת הסטיק ירדה ל-${batteryPercent}% (סף חירום: ${critLevel}%). נא לחבר לטעינה מיד!`;
        firePushNotification('huawei_crit_battery_' + now, critTitle, critMsg, 1, false);
      }
    }
    else if (batteryPercent <= lowLevel) {
      if (forceTest || (now - (s.lastLowAlert || 0) > 1800000) || justUnplugged) {
        triggeredAny = true;
        if (!forceTest) await chrome.storage.local.set({ lastLowAlert: now });
        const title = forceTest ? 'התראת ניסיון - פוש סוללה' : 'HuaweiStickManager - אזהרת סוללה';
        firePushNotification('huawei_low_battery_' + now, title, `רמת הסוללה ירדה ל-${batteryPercent}%. נא לשקול חיבור לחשמל.`, 1, false);
      }
    }
    else {
       if (!forceTest) await chrome.storage.local.set({ lastLowAlert: 0, lastCriticalAlert: 0 });
    }

    if (forceTest && !triggeredAny) {
       firePushNotification('huawei_test_ok', 'בדיקת התראות - אין התראות', `הסוללה תקינה כרגע (${batteryPercent}%). ההתראות יקפצו רק כשהסוללה תרד מתחת לספים שהוגדרו.`, 1, false);
    }
  }
  evaluateBadge();
}

// -------------------------------------------------------------------------
// פונקציות הבדיקה (עם ניהול SessionID + Token מלא בדומה ל-popup.js)
// -------------------------------------------------------------------------
let stickTaskQueue = Promise.resolve();
function enqueueStickTask(fn) {
  const next = stickTaskQueue.then(fn, fn);
  stickTaskQueue = next.catch(() => {});
  return next;
}

async function checkBatteryStatus() {
  return enqueueStickTask(async () => {
    await chrome.storage.local.set({ lastBatteryCheckTime: Date.now() });
    const s = await chrome.storage.local.get({ routerIp: '192.168.8.1', routerUsername: 'admin', routerPassword: '' });
    try {
      const client = new MinimalHuaweiClient(s.routerIp, s.routerUsername, s.routerPassword);
      const statusXml = await client.getXml('api/monitoring/status');
      if (!statusXml || isHuaweiAuthError(statusXml)) {
        evaluateBadge();
        return;
      }

      const isCharging = getXmlTagSimple(statusXml, 'BatteryStatus') === '1';
      const batteryPercent = parseBatteryPercentFromXml(statusXml);

      if (!isNaN(batteryPercent) && batteryPercent >= 0) {
        await chrome.storage.local.set({ lastBatteryPercent: batteryPercent });
        await evaluateBatteryAlertsLogic(batteryPercent, isCharging, false);
      } else {
        evaluateBadge();
      }
    } catch (err) {
      evaluateBadge();
    }
  });
}

// בדיקת התקנים מחוברים ללא שגיאת Flip-Flop
async function checkDevicesConnected(client) {
  const s = await chrome.storage.local.get({ currentConnectedMacs: null, deviceHistory: {} });
  try {
    let hostXml = await client.getXml('api/wlan/host-list');
    if (!hostXml || hostXml.includes('error>') || isHuaweiAuthError(hostXml)) {
      hostXml = await client.getXml('api/lan/HostList');
    }
    if (!hostXml || hostXml.includes('error>') || isHuaweiAuthError(hostXml)) return;

    const hostNodes = getNodesSimple(hostXml, 'Host');
    const newMacs = [];
    const newDevicesInfo = {};

    for (const node of hostNodes) {
      const mac = getXmlTagSimple(node, 'MacAddress');
      if (mac) {
        newMacs.push(mac);
        newDevicesInfo[mac] = getXmlTagSimple(node, 'HostName') || 'מכשיר לא ידוע';
      }
    }

    // הפעלה ראשונה מעולם: לימוד שקט ללא התראות פוש
    if (s.currentConnectedMacs === null) {
      await chrome.storage.local.set({ currentConnectedMacs: newMacs });
      return;
    }

    const currentMacsSet = new Set(s.currentConnectedMacs);
    const newMacsSet = new Set(newMacs);

    for (const mac of newMacs) {
      if (!currentMacsSet.has(mac)) {
        let deviceName = newDevicesInfo[mac];
        if (s.deviceHistory && s.deviceHistory[mac]) {
          deviceName = s.deviceHistory[mac].customName || s.deviceHistory[mac].name || deviceName;
        }
        firePushNotification(`dev_conn_${mac}_${Date.now()}`, 'התקן חדש מחובר לסטיק', `התקן: ${deviceName}\nMAC: ${mac}`);
      }
    }

    for (const oldMac of s.currentConnectedMacs) {
      if (!newMacsSet.has(oldMac)) {
        let deviceName = 'מכשיר לא ידוע';
        if (s.deviceHistory && s.deviceHistory[oldMac]) {
          deviceName = s.deviceHistory[oldMac].customName || s.deviceHistory[oldMac].name || deviceName;
        }
        firePushNotification(`dev_disconn_${oldMac}_${Date.now()}`, 'התקן התנתק מהסטיק', `התקן: ${deviceName}\nMAC: ${oldMac}`);
      }
    }
    await chrome.storage.local.set({ currentConnectedMacs: newMacs });
  } catch (e) {
    // התעלמות בשגיאות רשת כדי למנוע מחיקת זיכרון
  }
}

async function checkGeneralStatus() {
  return enqueueStickTask(async () => {
    await chrome.storage.local.set({ lastGeneralCheckTime: Date.now() });
    const s = await chrome.storage.local.get({ routerIp: '192.168.8.1', routerUsername: 'admin', routerPassword: '', dataLimitGB: 50, dataThreshold: 90, smsCount: 0, dataUsagePct: 0 });
    try {
      const client = new MinimalHuaweiClient(s.routerIp, s.routerUsername, s.routerPassword);
      let unreadSMS = s.smsCount || 0;
      try {
        const smsXml = await client.getXml('api/sms/sms-count');
        if (smsXml && !isHuaweiAuthError(smsXml)) {
          unreadSMS = parseInt(getXmlTagSimple(smsXml, 'LocalUnread') || getXmlTagSimple(smsXml, 'UnreadMessage') || '0', 10);
        }
      } catch (e) {}

      let dataUsagePct = s.dataUsagePct || 0;
      try {
        let monthDown = '0', monthUp = '0';
        const mXml = await client.getXml('api/monitoring/month_statistics');
        if (mXml && !isHuaweiAuthError(mXml)) {
          monthDown = getXmlTagSimple(mXml, 'CurrentMonthDownload') || '0';
          monthUp = getXmlTagSimple(mXml, 'CurrentMonthUpload') || '0';
        }
        if (parseInt(monthDown, 10) === 0) {
          const tXml = await client.getXml('api/monitoring/traffic-statistics');
          if (tXml && !isHuaweiAuthError(tXml)) {
            monthDown = getXmlTagSimple(tXml, 'CurrentMonthDownload') || '0';
            monthUp = getXmlTagSimple(tXml, 'CurrentMonthUpload') || '0';
          }
        }
        if ((parseInt(monthDown, 10) + parseInt(monthUp, 10)) > 0) {
          const totalGB = ((parseInt(monthDown, 10) + parseInt(monthUp, 10)) / (1024 ** 3));
          const limitGB = parseFloat(s.dataLimitGB) || 50;
          dataUsagePct = Math.round(Math.min((totalGB / limitGB) * 100, 100));
        }
      } catch (e) {}

      await chrome.storage.local.set({ smsCount: unreadSMS, dataUsagePct: dataUsagePct });
      evaluateBadge();
      await checkDevicesConnected(client);
    } catch (e) {
      evaluateBadge();
    }
  });
}

async function checkUpdates12Hours() {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const res = await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { credentials: 'omit' }, 10000);
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

// -------------------------------------------------------------------------
// הגנה 2: ניהול Alarms נקי + וידוא שהשעונים תמיד קיימים
// -------------------------------------------------------------------------
async function setupAlarms() {
  const s = await chrome.storage.local.get({ batteryCheckInterval: 3, generalCheckInterval: 5 });
  await chrome.alarms.clear('check_battery');
  await chrome.alarms.clear('check_general');
  await chrome.alarms.clear('check_updates');

  const batInt = parseInt(s.batteryCheckInterval, 10);
  if (batInt > 0) chrome.alarms.create('check_battery', { periodInMinutes: batInt });

  const genInt = parseInt(s.generalCheckInterval, 10);
  if (genInt > 0) chrome.alarms.create('check_general', { periodInMinutes: genInt });

  chrome.alarms.create('check_updates', { periodInMinutes: 720 });
}

async function ensureAlarmsExist() {
  const s = await chrome.storage.local.get({ batteryCheckInterval: 3, generalCheckInterval: 5 });
  const existing = await chrome.alarms.getAll();
  const names = new Set(existing.map(a => a.name));

  const batInt = parseInt(s.batteryCheckInterval, 10);
  if (batInt > 0 && !names.has('check_battery')) {
    chrome.alarms.create('check_battery', { periodInMinutes: batInt });
  }
  const genInt = parseInt(s.generalCheckInterval, 10);
  if (genInt > 0 && !names.has('check_general')) {
    chrome.alarms.create('check_general', { periodInMinutes: genInt });
  }
  if (!names.has('check_updates')) {
    chrome.alarms.create('check_updates', { periodInMinutes: 720 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('clear_notif::')) {
    chrome.notifications.clear(alarm.name.slice('clear_notif::'.length));
    return;
  }
  if (alarm.name === 'check_battery') checkBatteryStatus();
  if (alarm.name === 'check_general') checkGeneralStatus();
  if (alarm.name === 'check_updates') checkUpdates12Hours();
});

// -------------------------------------------------------------------------
// הגנה 3: השלמת פערים (Catch-up) למקרים שהמחשב היה במצב שינה
// -------------------------------------------------------------------------
let lastEventTrigger = 0;
async function catchUpIfNeeded() {
  const now = Date.now();
  if (now - lastEventTrigger < 10000) return;
  lastEventTrigger = now;

  await ensureAlarmsExist();

  const s = await chrome.storage.local.get({
    lastBatteryCheckTime: 0,
    batteryCheckInterval: 3,
    lastGeneralCheckTime: 0,
    generalCheckInterval: 5
  });

  const batInt = parseInt(s.batteryCheckInterval, 10);
  if (batInt > 0 && (now - (s.lastBatteryCheckTime || 0) > batInt * 60000)) {
    checkBatteryStatus();
  }

  const genInt = parseInt(s.generalCheckInterval, 10);
  if (genInt > 0 && (now - (s.lastGeneralCheckTime || 0) > genInt * 60000)) {
    checkGeneralStatus();
  }
}

// קשירת בדיקת ההשלמה לאירועים בהם המשתמש חוזר לדפדפן
chrome.tabs.onActivated.addListener(() => catchUpIfNeeded());
chrome.windows.onFocusChanged.addListener(() => catchUpIfNeeded());
if (chrome.idle) {
  chrome.idle.onStateChanged.addListener((state) => { if (state === 'active') catchUpIfNeeded(); });
}

// -------------------------------------------------------------------------
// אתחול וטיפול בהודעות
// -------------------------------------------------------------------------
function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "test_alerts", title: "בדוק התראות (טסט ידני)", contexts: ["action"] }, () => chrome.runtime.lastError);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove('_bgDiag').catch(() => {});
  ensureContextMenu();
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  setupAlarms();
  checkBatteryStatus();
  checkGeneralStatus();
  checkUpdates12Hours();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu();
  setupAlarms();
  checkBatteryStatus();
  checkGeneralStatus();
});

// וידוא קיום שעונים גם בהתעוררות רגילה של Service Worker
ensureAlarmsExist();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "test_alerts") {
    const s = await chrome.storage.local.get({ routerIp: '192.168.8.1', routerUsername: 'admin', routerPassword: '' });
    try {
      const client = new MinimalHuaweiClient(s.routerIp, s.routerUsername, s.routerPassword);
      const statusXml = await client.getXml('api/monitoring/status');
      if (!statusXml || isHuaweiAuthError(statusXml)) {
        firePushNotification('huawei_test_fail_auth', 'שגיאה בבדיקה', 'לא ניתן למשוך נתוני סוללה. ודא שהסטיק מחובר ושהסיסמה נכונה.', 1, false);
        return;
      }
      const isCharging = getXmlTagSimple(statusXml, 'BatteryStatus') === '1';
      const batteryPercent = parseBatteryPercentFromXml(statusXml);
      if (!isNaN(batteryPercent) && batteryPercent >= 0) {
        evaluateBatteryAlertsLogic(batteryPercent, isCharging, true);
      } else {
        firePushNotification('huawei_test_fail_auth', 'שגיאה בבדיקה', 'לא ניתן למשוך נתוני סוללה. ודא שהסטיק מחובר ושהסיסמה נכונה.', 1, false);
      }
    } catch (e) {
      firePushNotification('huawei_test_fail_net', 'שגיאת תקשורת', 'הסטיק לא מגיב לבקשה. ודא חיבור לרשת ה-Wi-Fi של הסטיק.', 1, false);
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'updateAlarms') {
    setupAlarms();
    checkBatteryStatus();
    checkGeneralStatus();
  } else if (msg.action === 'forceCheck') {
    evaluateBadge();
  } else if (msg.action === 'evaluateBatteryAlerts') {
    evaluateBatteryAlertsLogic(msg.batteryPercent, msg.isCharging, false);
  }
});
