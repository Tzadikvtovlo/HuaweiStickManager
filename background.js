const GITHUB_REPO = 'Tzadikvtovlo/HuaweiStickManager';

function getXmlTagSimple(xml, tag) {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = regex.exec(xml);
  return match ? match[1].trim() : null;
}

async function hexSha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function syncChromeCookieBg(ip, rawSession) {
  if (!rawSession || !chrome.cookies) return;
  const cleanSession = rawSession.replace(/^SessionID=/i, '');
  try {
    await chrome.cookies.set({
      url: `http://${ip}/`,
      name: 'SessionID',
      value: cleanSession
    });
  } catch (e) {}
}

async function getHuaweiAuthBg(ip) {
  try {
    const authRes = await fetch(`http://${ip}/api/webserver/SesTokInfo`, { credentials: 'include' });
    if (authRes.ok) {
      const authXml = await authRes.text();
      let s = getXmlTagSimple(authXml, 'SessionInfo') || getXmlTagSimple(authXml, 'SesInfo');
      let t = getXmlTagSimple(authXml, 'TokInfo') || getXmlTagSimple(authXml, 'token');
      if (s) await syncChromeCookieBg(ip, s);
      return { session: s || '', token: t || '' };
    }
  } catch (e) {}
  return { session: '', token: '' };
}

async function loginHuaweiBg(ip, username, password) {
  let auth = await getHuaweiAuthBg(ip);
  if (!auth.token) return auth;

  const user = (username || 'admin').trim().toLowerCase();

  try {
    const stateRes = await fetch(`http://${ip}/api/user/state-login`, { credentials: 'include' });
    const stateXml = await stateRes.text();
    if (getXmlTagSimple(stateXml, 'State') === '0') return auth;
  } catch (e) {}

  if (!password) return auth;

  async function attemptLogin(u, type, pwdHash) {
    const loginXml = `<?xml version="1.0" encoding="UTF-8"?><request><Username>${u}</Username><Password>${pwdHash}</Password><password_type>${type}</password_type></request>`;
    try {
      const res = await fetch(`http://${ip}/api/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml', '__RequestVerificationToken': auth.token },
        body: loginXml,
        credentials: 'include'
      });
      const text = await res.text();
      return text.includes('OK') || text.includes('108003');
    } catch (e) { return false; }
  }

  const firstHash = btoa(await hexSha256(password));
  const finalHash = btoa(await hexSha256(user + firstHash + auth.token));

  let success = await attemptLogin(user, 4, finalHash);
  if (!success) success = await attemptLogin(user, 0, btoa(password));
  if (!success) await attemptLogin('', 4, btoa(await hexSha256('' + firstHash + auth.token)));

  return await getHuaweiAuthBg(ip);
}

// בדיקת עדכונים יומית (כל 24 שעות)
async function checkUpdatesDaily() {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.tag_name) {
      const latestVersion = data.tag_name.replace(/[vV]/g, '').trim();
      if (parseFloat(latestVersion) > parseFloat(currentVersion)) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'HuaweiStickManager - עדכון חדש',
          message: `גרסה חדשה (${latestVersion}) זמינה להורדה.`
        });
      }
    }
  } catch (e) {}
}

async function checkDeviceStatus() {
  const settings = await chrome.storage.local.get({
    routerIp: '192.168.8.1', routerUsername: 'admin', routerPassword: '',
    batteryThreshold: 20, batteryAlertPush: true, batteryAlertIcon: true,
    dataLimitGB: 50, dataThreshold: 90, dataAlertPush: true, dataAlertIcon: true,
    lastBatteryAlert: 0, lastDataAlert: 0
  });

  const ip = settings.routerIp;
  let isAlertIconActive = false;
  let alertText = "";

  try {
    const auth = await loginHuaweiBg(ip, settings.routerUsername, settings.routerPassword);
    const headers = new Headers();
    if (auth.token) headers.append('__RequestVerificationToken', auth.token);
    const fetchOptions = { headers: headers, credentials: 'include' };

    // 1. סוללה
    const statusRes = await fetch(`http://${ip}/api/monitoring/status`, fetchOptions);
    const statusXml = await statusRes.text();
    let batStr = getXmlTagSimple(statusXml, 'BatteryPercent') || getXmlTagSimple(statusXml, 'BatteryLevel');
    let isCharging = getXmlTagSimple(statusXml, 'BatteryStatus') === '1';
    const batteryPercent = parseInt(batStr || '0', 10);
    const now = Date.now();

    if (batteryPercent > 0 && batteryPercent <= settings.batteryThreshold && !isCharging) {
      if (settings.batteryAlertIcon) { isAlertIconActive = true; alertText = "BAT"; }
      if (settings.batteryAlertPush && (now - settings.lastBatteryAlert > 2700000)) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'סוללה נמוכה בסטיק',
          message: `רמת הסוללה ירדה ל-${batteryPercent}%. כדאי לחבר לטעינה.`
        });
        await chrome.storage.local.set({ lastBatteryAlert: now });
      }
    }

    // 2. תעבורת נתונים
    let monthDown = '0', monthUp = '0';
    try {
      const monthRes = await fetch(`http://${ip}/api/monitoring/month_statistics`, fetchOptions);
      if (monthRes.ok) {
        const monthXml = await monthRes.text();
        monthDown = getXmlTagSimple(monthXml, 'CurrentMonthDownload') || '0';
        monthUp = getXmlTagSimple(monthXml, 'CurrentMonthUpload') || '0';
      }
    } catch(e) {}

    if (parseInt(monthDown, 10) === 0) {
      const trafficRes = await fetch(`http://${ip}/api/monitoring/traffic-statistics`, fetchOptions);
      if (trafficRes.ok) {
        const trafficXml = await trafficRes.text();
        monthDown = getXmlTagSimple(trafficXml, 'CurrentMonthDownload') || '0';
        monthUp = getXmlTagSimple(trafficXml, 'CurrentMonthUpload') || '0';
      }
    }

    const totalUsedGB = (parseInt(monthDown, 10) + parseInt(monthUp, 10)) / (1024 ** 3);
    if (settings.dataLimitGB > 0) {
      const usedPercentage = (totalUsedGB / settings.dataLimitGB) * 100;
      if (usedPercentage >= settings.dataThreshold) {
        if (settings.dataAlertIcon) { isAlertIconActive = true; alertText = "DATA"; }
        if (settings.dataAlertPush && (now - settings.lastDataAlert > 86400000)) {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'חבילת הגלישה עומדת להסתיים',
            message: `ניצלת ${usedPercentage.toFixed(1)}% מחבילת הגלישה (${totalUsedGB.toFixed(2)}GB מתוך ${settings.dataLimitGB}GB).`
          });
          await chrome.storage.local.set({ lastDataAlert: now });
        }
      }
    }

    // 3. תג SMS (מבוסס סקאלת הוורוד-אודם)
    try {
      const smsRes = await fetch(`http://${ip}/api/sms/sms-count`, fetchOptions);
      const smsXml = await smsRes.text();
      const unreadSMS = parseInt(getXmlTagSimple(smsXml, 'LocalUnread') || getXmlTagSimple(smsXml, 'UnreadMessage') || '0', 10);
      if (unreadSMS > 0 && !isAlertIconActive) {
        chrome.action.setBadgeText({ text: unreadSMS.toString() });
        chrome.action.setBadgeBackgroundColor({ color: "#be123c" });
      } else if (!isAlertIconActive) {
        chrome.action.setBadgeText({ text: "" });
      }
    } catch (e) {}

    if (isAlertIconActive) {
      chrome.action.setIcon({ path: { "16": "icons/alert16.png", "48": "icons/alert48.png", "128": "icons/alert128.png" } }).catch(() => {});
      chrome.action.setBadgeText({ text: alertText });
      chrome.action.setBadgeBackgroundColor({ color: "#881337" });
    } else {
      chrome.action.setIcon({ path: { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" } }).catch(() => {});
    }
  } catch (error) {}
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  const s = await chrome.storage.local.get({ pollingInterval: '5' });
  chrome.alarms.create('checkStick', { periodInMinutes: parseInt(s.pollingInterval, 10) });
  
  // אזעקה לבדיקת עדכונים יומית (כל 24 שעות = 1440 דקות)
  chrome.alarms.create('checkUpdatesDaily', { periodInMinutes: 1440 });

  checkDeviceStatus();
  checkUpdatesDaily();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkStick') checkDeviceStatus();
  if (alarm.name === 'checkUpdatesDaily') checkUpdatesDaily();
});