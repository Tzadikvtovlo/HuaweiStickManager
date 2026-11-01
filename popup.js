// ========================================================
// זיהוי הקשר התצוגה (פופ-אפ / פאנל צד / כרטיסייה מלאה)
// ========================================================
const urlParams = new URLSearchParams(window.location.search);
const currentMode = urlParams.get('mode');

if (currentMode === 'tab' || window.innerWidth > 500) {
  document.body.classList.add('mode-tab');
} else if (currentMode === 'sidepanel' || (window.innerHeight > 520 && window.innerWidth <= 480)) {
  document.body.classList.add('mode-sidepanel');
} else {
  document.body.classList.add('mode-popup');
}

// ========================================================
// הודעת טוסט פנימית
// ========================================================
function showInternalToast(message, duration = 3000) {
  const toast = document.getElementById('internalToast');
  if (!toast) return;
  toast.innerText = message;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, duration);
}

// ========================================================
// הגדרות קבועות
// ========================================================
const GITHUB_REPO = 'Tzadikvtovlo/HuaweiStickManager';

// ========================================================
// כלי עזר לפענוח XML
// ========================================================
function parseXmlDoc(xmlStr) {
  try {
    return new DOMParser().parseFromString(xmlStr, "text/xml");
  } catch (e) {
    return null;
  }
}

function getVal(docOrNode, tagName) {
  if (!docOrNode) return null;
  const els = docOrNode.getElementsByTagName('*');
  for (let i = 0; i < els.length; i++) {
    if (els[i].tagName.toLowerCase() === tagName.toLowerCase()) {
      return els[i].textContent.trim();
    }
  }
  return null;
}

function getNodes(doc, tagName) {
  if (!doc) return [];
  const els = doc.getElementsByTagName('*');
  return Array.from(els).filter(e => e.tagName.toLowerCase() === tagName.toLowerCase());
}

async function hexSha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// פורמט זמנים קומפקטי עם הקפדה מוחלטת על עברית ו-RTL
function formatDuration(secondsNum) {
  const s = parseInt(secondsNum, 10) || 0;
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);

  if (days > 0) return `${days}\u00A0ימ', ${hours}\u00A0שע'`;
  if (hours > 0) return `${hours}\u00A0שע', ${minutes}\u00A0דק'`;
  return `${minutes}\u00A0דק'`;
}

// ========================================================
// לקוח ה-API של הוואווי
// ========================================================
class HuaweiClient {
  constructor(ip, username = 'admin', password = '') {
    this.ip = ip;
    this.username = (username || 'admin').trim().toLowerCase();
    this.password = password;
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

  async refreshTokens() {
    try {
      const res = await fetch(`http://${this.ip}/api/webserver/SesTokInfo`, { credentials: 'include' });
      if (res.ok) {
        const doc = parseXmlDoc(await res.text());
        const s = getVal(doc, 'SessionInfo') || getVal(doc, 'SesInfo');
        const t = getVal(doc, 'TokInfo') || getVal(doc, 'token');
        if (s) {
          this.session = s.startsWith('SessionID=') ? s : `SessionID=${s}`;
          await this.syncChromeCookie(s);
        }
        if (t) this.token = t;
        return !!this.token;
      }
    } catch (e) {}
    return false;
  }

  updateTokenFromHeaders(res) {
    const newToken = res.headers.get('__RequestVerificationToken') || 
                     res.headers.get('__requestverificationtokenone') ||
                     res.headers.get('__requestverificationtokentwo');
    if (newToken) this.token = newToken;
  }

  async checkLoginState() {
    try {
      const res = await this.get('api/user/state-login', false);
      if (res.ok) {
        const doc = parseXmlDoc(await res.text());
        const state = getVal(doc, 'State');
        this.isLoggedIn = (state === '0');
        const deviceUser = getVal(doc, 'username') || getVal(doc, 'Username');
        if (deviceUser) this.username = deviceUser.toLowerCase();
        return this.isLoggedIn;
      }
    } catch (e) {}
    this.isLoggedIn = false;
    return false;
  }

  async login() {
    await this.refreshTokens();
    if (!this.password) return { success: false, reason: 'no_password' };
    if (await this.checkLoginState()) return { success: true };

    let res = await this.executeLogin(this.username);
    if (res.success) return res;

    if (this.username !== '') {
      res = await this.executeLogin('');
      if (res.success) return res;
    }
    return res;
  }

  async executeLogin(userToTry) {
    await this.refreshTokens();
    const firstHash = btoa(await hexSha256(this.password));
    const finalHash = btoa(await hexSha256(userToTry + firstHash + this.token));

    let res = await this.sendLoginXml(userToTry, finalHash, 4);
    if (res.success) return res;

    res = await this.sendLoginXml(userToTry, btoa(this.password), 0);
    return res;
  }

  async sendLoginXml(user, pwdHash, type) {
    const loginXml = `<?xml version="1.0" encoding="UTF-8"?><request><Username>${user}</Username><Password>${pwdHash}</Password><password_type>${type}</password_type></request>`;
    try {
      const headers = { 'Content-Type': 'text/xml', '__RequestVerificationToken': this.token };
      const res = await fetch(`http://${this.ip}/api/user/login`, {
        method: 'POST',
        headers,
        body: loginXml,
        credentials: 'include'
      });

      this.updateTokenFromHeaders(res);
      const text = await res.text();
      const doc = parseXmlDoc(text);
      const errCode = getVal(doc, 'code');

      if (text.includes('<response>OK</response>') || errCode === '108003') {
        this.isLoggedIn = true;
        await this.refreshTokens();
        return { success: true };
      }
      return { success: false, code: errCode || 'unknown', text };
    } catch (e) {
      return { success: false, code: 'network_error' };
    }
  }

  async get(endpoint, retry = true) {
    const headers = {};
    if (this.token) headers['__RequestVerificationToken'] = this.token;

    let res = await fetch(`http://${this.ip}/${endpoint}`, { headers, credentials: 'include' });
    this.updateTokenFromHeaders(res);

    if (retry && res.status === 200) {
      const cloneText = await res.clone().text();
      if (cloneText.includes('100003') || cloneText.includes('125001') || cloneText.includes('125002')) {
        const loginRes = await this.login();
        if (loginRes.success) {
          headers['__RequestVerificationToken'] = this.token;
          res = await fetch(`http://${this.ip}/${endpoint}`, { headers, credentials: 'include' });
          this.updateTokenFromHeaders(res);
        }
      }
    }
    return res;
  }

  async post(endpoint, bodyXml, retry = true) {
    if (!this.token) await this.refreshTokens();
    const headers = { 'Content-Type': 'text/xml', '__RequestVerificationToken': this.token };

    let res = await fetch(`http://${this.ip}/${endpoint}`, {
      method: 'POST',
      headers,
      body: bodyXml,
      credentials: 'include'
    });

    this.updateTokenFromHeaders(res);

    if (retry && res.status === 200) {
      const cloneText = await res.clone().text();
      if (cloneText.includes('100003') || cloneText.includes('125001') || cloneText.includes('125002')) {
        const loginRes = await this.login();
        if (loginRes.success) {
          headers['__RequestVerificationToken'] = this.token;
          res = await fetch(`http://${this.ip}/${endpoint}`, {
            method: 'POST',
            headers,
            body: bodyXml,
            credentials: 'include'
          });
          this.updateTokenFromHeaders(res);
        }
      }
    }
    await this.refreshTokens();
    return res;
  }
}

let client = null;

// ========================================================
// ניווט טאבים (UI) - 4 טאבים מאוחדים בלבד
// ========================================================
const navBtns = ['navMain', 'navSms', 'navDevices', 'navOptions'];
const sections = ['sectionMain', 'sectionSms', 'sectionDevices', 'sectionOptions'];

function switchTab(btnId, targetSectionId) {
  navBtns.forEach(id => document.getElementById(id)?.classList.remove('btn-active'));
  sections.forEach(id => {
    const sec = document.getElementById(id);
    if (sec) sec.style.display = 'none';
  });
  document.getElementById(btnId)?.classList.add('btn-active');
  const sec = document.getElementById(targetSectionId);
  if (sec) sec.style.display = 'block';
}

navBtns.forEach((btnId, idx) => {
  const btn = document.getElementById(btnId);
  if (btn) btn.addEventListener('click', () => switchTab(btnId, sections[idx]));
});

function goToSettingsPassword() {
  switchTab('navOptions', 'sectionOptions');
  const pwdInput = document.getElementById('passwordInput');
  if (pwdInput) {
    pwdInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    pwdInput.focus();
  }
}

// ========================================================
// עדכון אייקון סטטוס החיבור העליון
// ========================================================
function updateConnectionStatusUI(state, tooltipText) {
  const btn = document.getElementById('connectionStatusBtn');
  if (!btn) return;

  btn.className = 'ctrl-btn status-icon-btn';
  btn.title = tooltipText;

  let svgContent = '';
  if (state === 'full') {
    btn.classList.add('status-full');
    svgContent = `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 12 11 14 15 10"></polyline>`;
  } else if (state === 'partial') {
    btn.classList.add('status-partial');
    svgContent = `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>`;
  } else {
    btn.classList.add('status-none');
    svgContent = `<circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>`;
  }

  const svgEl = document.getElementById('statusIconSvg');
  if (svgEl) svgEl.innerHTML = svgContent;
}

// ========================================================
// SVG דינמיים קוויים אלגנטיים
// ========================================================
function renderDynamicSignalSVG(levelNum) {
  const level = parseInt(levelNum, 10) || 0;
  const color = level < 2 ? 'var(--status-alert)' : 'var(--accent)';
  const bars = [
    { x: 2, y: 17, h: 5 }, { x: 6, y: 14, h: 8 },
    { x: 10, y: 11, h: 11 }, { x: 14, y: 8, h: 14 },
    { x: 18, y: 5, h: 17 }
  ];
  let svg = `<svg viewBox="0 0 24 24" width="24" height="24">`;
  bars.forEach((b, idx) => {
    const isFilled = idx < level;
    svg += `<rect x="${b.x}" y="${b.y}" width="3" height="${b.h}" rx="1" fill="${isFilled ? color : 'var(--border)'}" />`;
  });
  svg += `</svg>`;
  const el = document.getElementById('dynamicSignalIcon');
  if (el) el.innerHTML = svg;
}

function renderDynamicBatterySVG(percent, isCharging) {
  const pct = parseInt(percent, 10) || 0;
  const color = pct <= 20 && !isCharging ? 'var(--status-alert)' : 'var(--accent)';
  let svg = `<svg viewBox="0 0 24 24" width="24" height="24" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"><rect x="2" y="7" width="17" height="10" rx="2" ry="2"/><line x1="22" y1="11" x2="22" y2="13"/>`;
  if (isCharging) {
    svg += `<polyline points="11 6 8 13 13 13 10 18" fill="none" stroke="${color}" stroke-width="1.75"/>`;
  } else {
    const segments = [{ x: 4, y: 9, w: 3, h: 6 }, { x: 8, y: 9, w: 3, h: 6 }, { x: 12, y: 9, w: 3, h: 6 }, { x: 16, y: 9, w: 2, h: 6 }];
    let fillLevel = Math.ceil((pct / 100) * 4);
    if (pct > 0 && fillLevel === 0) fillLevel = 1;
    for (let i = 0; i < fillLevel; i++) {
      svg += `<rect x="${segments[i].x}" y="${segments[i].y}" width="${segments[i].w}" height="${segments[i].h}" fill="${color}" stroke="none"/>`;
    }
  }
  svg += `</svg>`;
  const el = document.getElementById('dynamicBatteryIcon');
  if (el) el.innerHTML = svg;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb > 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(2) + ' MB';
}

function getNetworkGeneration(typeNum) {
  const num = parseInt(typeNum, 10);
  if ([1, 2, 3].includes(num)) return 'דור 2 (2G)';
  if ([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 41, 42, 43, 44, 45, 46].includes(num)) return 'דור 3 (3G)';
  if (num === 19) return 'דור 4 (LTE)';
  if (num === 101) return 'דור 4+ (LTE-A)';
  if ([20, 111, 112, 113, 114].includes(num)) return 'דור 5 (5G)';
  if (num === 0) return 'אין קליטה';
  return 'מחובר';
}

function renderPasswordRequiredCard(targetElementId, featureName) {
  const el = document.getElementById(targetElementId);
  if (!el) return;
  el.innerHTML = `
    <div class="auth-lock-card">
      <div class="lock-icon-circle">
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="var(--primary)" stroke-width="1.75" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
      </div>
      <h4>נדרשת סיסמת סטיק</h4>
      <p>הגישה ל-${featureName} חסומה על ידי הסטיק עד להזנת סיסמה תקינה בהגדרות התוסף.</p>
      <button class="btn-primary auth-redirect-btn" style="padding: 5px 12px; font-size: 11px; margin: 0 auto;">
        הגדר סיסמה כעת
      </button>
    </div>
  `;
  el.querySelector('.auth-redirect-btn')?.addEventListener('click', goToSettingsPassword);
}

function calculateBillingCycleProgress(resetDay) {
  const now = new Date();
  const day = Math.min(Math.max(parseInt(resetDay, 10) || 1, 1), 31);

  let cycleStart = new Date(now.getFullYear(), now.getMonth(), day, 0, 0, 0);
  let cycleEnd;

  if (now >= cycleStart) {
    cycleEnd = new Date(now.getFullYear(), now.getMonth() + 1, day, 0, 0, 0);
  } else {
    cycleStart = new Date(now.getFullYear(), now.getMonth() - 1, day, 0, 0, 0);
    cycleEnd = new Date(now.getFullYear(), now.getMonth(), day, 0, 0, 0);
  }

  const totalCycleMs = cycleEnd - cycleStart;
  const elapsedCycleMs = now - cycleStart;

  const totalDays = Math.max(1, Math.round(totalCycleMs / (1000 * 60 * 60 * 24)));
  const daysPassed = Math.max(0.5, elapsedCycleMs / (1000 * 60 * 60 * 24));
  const timeProgressRatio = Math.min(Math.max(elapsedCycleMs / totalCycleMs, 0), 1);

  return { totalDays, daysPassed, timeProgressRatio };
}

// ========================================================
// טעינת הנתונים מהסטיק
// ========================================================
async function loadData() {
  const statusBtn = document.getElementById('connectionStatusBtn');
  const refreshBtn = document.getElementById('refreshDataBtn');
  statusBtn?.classList.add('loading');
  refreshBtn?.classList.add('loading');

  const settings = await chrome.storage.local.get({
    routerIp: '192.168.8.1',
    routerUsername: 'admin',
    routerPassword: '',
    dataLimitGB: 50,
    dataResetDay: 1,
    dataThreshold: 90,
    deviceHistory: {}
  });

  client = new HuaweiClient(settings.routerIp, settings.routerUsername, settings.routerPassword);

  const isAlive = await client.refreshTokens();
  if (!isAlive) {
    updateConnectionStatusUI('none', 'לא מחובר לסטיק (בדוק Wi-Fi / IP)');
    document.getElementById('batteryVal').innerText = 'שגיאת חיבור';
    renderDynamicSignalSVG(0);
    renderDynamicBatterySVG(0, false);
    statusBtn?.classList.remove('loading');
    refreshBtn?.classList.remove('loading');
    return;
  }

  let hasFullAuth = false;
  if (settings.routerPassword) {
    const loginRes = await client.login();
    if (loginRes.success) {
      hasFullAuth = true;
      updateConnectionStatusUI('full', 'מחובר (הרשאות מלאות)');
    } else {
      const msg = (loginRes.code === '108002' || loginRes.code === '108006') 
        ? 'מחובר (סיסמה שגויה)' 
        : `מחובר (ללא אימות - קוד ${loginRes.code || ''})`;
      updateConnectionStatusUI('partial', msg);
    }
  } else {
    updateConnectionStatusUI('partial', 'מחובר (מצב אורח - ללא סיסמה)');
  }

  try {
    // 1. קליטה, רשת וסוללה
    const statusRes = await client.get('api/monitoring/status');
    const statusDoc = parseXmlDoc(await statusRes.text());

    const signalIcon = getVal(statusDoc, 'SignalIcon') || '0';
    const netType = getVal(statusDoc, 'CurrentNetworkTypeEx') || getVal(statusDoc, 'CurrentNetworkType');
    const netGen = getNetworkGeneration(netType);

    let providerName = '';
    try {
      const plmnRes = await client.get('api/net/current-plmn');
      if (plmnRes.ok) providerName = getVal(parseXmlDoc(await plmnRes.text()), 'FullName') || '';
    } catch (e) {}

    document.getElementById('networkVal').innerText = `${netGen}${providerName ? ` (${providerName})` : ''}`;
    renderDynamicSignalSVG(signalIcon);

    const battery = getVal(statusDoc, 'BatteryPercent') || getVal(statusDoc, 'BatteryLevel');
    const batStatus = getVal(statusDoc, 'BatteryStatus');
    document.getElementById('batteryVal').innerText = battery ? `${battery}%${batStatus === '1' ? ' (בטעינה)' : ''}` : 'מחובר לחשמל';
    renderDynamicBatterySVG(battery || 100, batStatus === '1');

    if (battery) {
      await chrome.storage.local.set({ lastBatteryPercent: parseInt(battery, 10) });
    }

    // 2. תעבורה וסרגלים
    let monthDown = '0', monthUp = '0';
    try {
      const monthRes = await client.get('api/monitoring/month_statistics');
      if (monthRes.ok) {
        const monthDoc = parseXmlDoc(await monthRes.text());
        monthDown = getVal(monthDoc, 'CurrentMonthDownload') || '0';
        monthUp = getVal(monthDoc, 'CurrentMonthUpload') || '0';
      }
    } catch (e) {}

    const trafficRes = await client.get('api/monitoring/traffic-statistics');
    const trafficDoc = parseXmlDoc(await trafficRes.text());
    if (parseInt(monthDown, 10) === 0) {
      monthDown = getVal(trafficDoc, 'CurrentMonthDownload') || '0';
      monthUp = getVal(trafficDoc, 'CurrentMonthUpload') || '0';
    }

    const totalMonthGB = parseFloat(((parseInt(monthDown, 10) + parseInt(monthUp, 10)) / (1024 ** 3)).toFixed(2));
    const limitGB = parseFloat(settings.dataLimitGB) || 50;
    const resetDay = parseInt(settings.dataResetDay, 10) || 1;

    document.getElementById('resetDayBadge').innerText = `מתחדש ב-${resetDay} לחודש`;
    document.getElementById('dataVal').innerText = `${totalMonthGB.toFixed(2)}GB / ${limitGB}GB`;

    const volumePercent = Math.min((totalMonthGB / limitGB) * 100, 100) || 0;
    const dataFill = document.getElementById('dataFill');
    dataFill.style.setProperty('--val', `${volumePercent}%`);
    dataFill.style.background = volumePercent >= settings.dataThreshold ? 'var(--status-alert)' : 'var(--accent)';

    const { totalDays, daysPassed, timeProgressRatio } = calculateBillingCycleProgress(resetDay);
    const expectedUsedGB = limitGB * timeProgressRatio; 
    const paceRatio = expectedUsedGB > 0 ? (totalMonthGB / expectedUsedGB) : 0;
    const paceBarPercent = Math.min(Math.round(paceRatio * 100), 100);

    const paceFill = document.getElementById('paceFill');
    const pacePercentText = document.getElementById('pacePercentText');
    const paceSubText = document.getElementById('paceSubText');

    paceFill.style.setProperty('--val', `${paceBarPercent}%`);
    pacePercentText.innerText = `${Math.round(paceRatio * 100)}% מהקצב המומלץ`;

    const diffGB = totalMonthGB - expectedUsedGB;
    const daysPassedRounded = Math.round(daysPassed);

    if (diffGB > 0.3) {
      paceFill.style.background = 'var(--status-alert)';
      pacePercentText.style.color = 'var(--status-alert)';
      paceSubText.innerHTML = `חריגה של <strong>${diffGB.toFixed(2)}GB</strong> מעבר לקצב המומלץ ליום ה-${daysPassedRounded} (מתוך ${totalDays})`;
    } else {
      paceFill.style.background = 'var(--accent)';
      pacePercentText.style.color = 'var(--accent)';
      const savedGB = Math.abs(diffGB).toFixed(2);
      paceSubText.innerHTML = `בקצב מצוין. נותרו לך עוד <strong>${savedGB}GB</strong> רזרבה ליום ה-${daysPassedRounded} (מתוך ${totalDays})`;
    }

    // נתוני סשן וזמנים
    const currentDown = parseInt(getVal(trafficDoc, 'CurrentDownload') || '0', 10);
    const currentUp = parseInt(getVal(trafficDoc, 'CurrentUpload') || '0', 10);
    const currentConnectTime = getVal(trafficDoc, 'CurrentConnectTime') || '0';
    const totalConnectTime = getVal(trafficDoc, 'TotalConnectTime') || '0';

    document.getElementById('currentSessionVal').innerText = formatBytes(currentDown + currentUp);
    
    // מילוי 3 תיבות חודשיות
    document.getElementById('monthDownVal').innerText = formatBytes(parseInt(monthDown, 10));
    document.getElementById('monthUpVal').innerText = formatBytes(parseInt(monthUp, 10));
    document.getElementById('monthTimeVal').innerText = formatDuration(totalConnectTime);

    // מילוי 3 תיבות סשן נוכחי
    document.getElementById('sessionDownVal').innerText = formatBytes(currentDown);
    document.getElementById('sessionUpVal').innerText = formatBytes(currentUp);
    document.getElementById('sessionTimeVal').innerText = formatDuration(currentConnectTime);

    // 3. הצגת הודעות SMS
    if (!hasFullAuth) {
      renderPasswordRequiredCard('smsList', 'קריאת הודעות SMS');
      document.getElementById('smsBadge').style.display = 'none';
    } else {
      await renderSmsSection();
    }

    // 4. התקנים מחוברים
    let deviceHistory = settings.deviceHistory || {};
    if (!hasFullAuth) {
      renderPasswordRequiredCard('currentDevicesList', 'צפייה בהתקנים מחוברים');
      document.getElementById('devicesCountVal').innerText = '-';
    } else {
      let hostRes = await client.get('api/wlan/host-list');
      let hostDoc = parseXmlDoc(await hostRes.text());
      let hostNodes = getNodes(hostDoc, 'Host');

      if (hostNodes.length === 0) {
        hostRes = await client.get('api/lan/HostList');
        if (hostRes.ok) {
          hostDoc = parseXmlDoc(await hostRes.text());
          hostNodes = getNodes(hostDoc, 'Host');
        }
      }

      document.getElementById('devicesCountVal').innerText = hostNodes.length;
      const currentListEl = document.getElementById('currentDevicesList');
      currentListEl.innerHTML = '';
      const currentlyConnectedMacs = new Set();
      const nowStr = new Date().toLocaleString('he-IL');

      const editIconSvg = `<svg class="svg-icon-small" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;

      hostNodes.forEach(node => {
        const mac = getVal(node, 'MacAddress');
        if (mac) {
          currentlyConnectedMacs.add(mac);
          if (!deviceHistory[mac]) {
            deviceHistory[mac] = { name: getVal(node, 'HostName') || 'לא ידוע', customName: '', lastSeen: nowStr };
          } else {
            deviceHistory[mac].lastSeen = nowStr;
            deviceHistory[mac].name = getVal(node, 'HostName') || deviceHistory[mac].name;
          }

          const displayName = deviceHistory[mac].customName || deviceHistory[mac].name;
          const div = document.createElement('div');
          div.className = 'device-item';
          div.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px;">
              <button class="ctrl-btn edit-btn" data-mac="${mac}" title="ערוך שם">${editIconSvg}</button>
              <strong>${displayName}</strong>
            </div>
            <div class="device-mac">${mac}</div>
          `;
          currentListEl.appendChild(div);
        }
      });

      if (hostNodes.length === 0) {
        currentListEl.innerHTML = '<div class="empty" style="padding:12px;">אין התקנים מחוברים כעת</div>';
      }
      await chrome.storage.local.set({ deviceHistory });
    }

    const historyListEl = document.getElementById('historyDevicesList');
    historyListEl.innerHTML = '';
    let historyCount = 0;
    const currentMacSet = new Set(Array.from(document.querySelectorAll('#currentDevicesList .edit-btn')).map(b => b.getAttribute('data-mac')));
    const editIconSvg = `<svg class="svg-icon-small" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;

    for (const [mac, data] of Object.entries(deviceHistory)) {
      if (!currentMacSet.has(mac)) {
        historyCount++;
        const div = document.createElement('div');
        div.className = 'device-item';
        div.innerHTML = `
          <div style="display:flex; align-items:center; gap:6px;">
            <button class="ctrl-btn edit-btn" data-mac="${mac}" title="ערוך שם">${editIconSvg}</button> 
            <strong>${data.customName || data.name}</strong>
          </div>
          <div class="device-mac">${mac}<br><span style="font-size:9px; color:var(--text-muted);">נראה: ${data.lastSeen}</span></div>
        `;
        historyListEl.appendChild(div);
      }
    }
    if (historyCount === 0) historyListEl.innerHTML = '<div class="empty" style="padding:12px;">אין היסטוריה קודמת</div>';

  } catch (err) {}

  statusBtn?.classList.remove('loading');
  refreshBtn?.classList.remove('loading');
}

// ========================================================
// שליפה וניהול הודעות SMS
// ========================================================
async function renderSmsSection() {
  const smsListEl = document.getElementById('smsList');
  try {
    const smsCountRes = await client.get('api/sms/sms-count');
    const smsCountDoc = parseXmlDoc(await smsCountRes.text());
    const unreadSMS = parseInt(getVal(smsCountDoc, 'LocalUnread') || getVal(smsCountDoc, 'UnreadMessage') || '0', 10);
    const smsBadge = document.getElementById('smsBadge');
    if (unreadSMS > 0) {
      smsBadge.innerText = unreadSMS;
      smsBadge.style.display = 'flex';
    } else {
      smsBadge.style.display = 'none';
    }

    const smsReq = `<?xml version="1.0" encoding="UTF-8"?><request><PageIndex>1</PageIndex><ReadCount>7</ReadCount><BoxType>1</BoxType><SortType>0</SortType><Ascending>0</Ascending><UnreadPreferred>0</UnreadPreferred></request>`;
    const smsListRes = await client.post('api/sms/sms-list', smsReq);
    const smsListDoc = parseXmlDoc(await smsListRes.text());
    let smsNodes = getNodes(smsListDoc, 'Message');
    smsNodes = smsNodes.slice(0, 7);

    smsListEl.innerHTML = '';

    if (smsNodes.length === 0) {
      smsListEl.innerHTML = '<div class="empty">אין הודעות בתיבת הדואר הנכנס</div>';
      return;
    }

    smsNodes.forEach(msg => {
      const idx = getVal(msg, 'Index');
      const isUnread = getVal(msg, 'Smstat') === '0';
      const phone = getVal(msg, 'Phone') || '';
      const date = getVal(msg, 'Date') || '';
      const content = getVal(msg, 'Content') || '';

      const card = document.createElement('div');
      card.className = `sms-card-item ${isUnread ? 'unread' : ''}`;
      card.innerHTML = `
        <div class="sms-meta-row">
          <strong dir="ltr" style="color:var(--primary); font-size:12px;">${phone}</strong>
          <div style="display:flex; align-items:center; gap:6px;">
            <span class="sms-status-pill ${isUnread ? 'unread' : 'read'}">${isUnread ? 'חדשה' : 'נקראה'}</span>
            <span dir="ltr" style="font-size:10px; color:var(--text-muted);">${date}</span>
          </div>
        </div>
        <div class="sms-body-text">${content}</div>
        <div class="sms-actions-row">
          ${isUnread ? `
            <button class="sms-act-btn mark-read-btn" data-index="${idx}">
              <svg class="svg-icon-small" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
              סמן כנקרא
            </button>
          ` : ''}
          <button class="sms-act-btn delete-btn delete-sms-btn" data-index="${idx}">
            <svg class="svg-icon-small" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            מחק
          </button>
        </div>
      `;
      smsListEl.appendChild(card);
    });

    smsListEl.querySelectorAll('.mark-read-btn').forEach(b => {
      b.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-index');
        b.innerText = 'מעדכן...';
        await client.post('api/sms/set-read', `<?xml version="1.0" encoding="UTF-8"?><request><Index>${id}</Index></request>`);
        showInternalToast('ההודעה סומנה כנקראה');
        await renderSmsSection();
      });
    });

    smsListEl.querySelectorAll('.delete-sms-btn').forEach(b => {
      b.addEventListener('click', async (e) => {
        if (!confirm('האם למחוק הודעה זו מהסטיק לצמיתות?')) return;
        const id = e.currentTarget.getAttribute('data-index');
        b.innerText = 'מוחק...';
        await client.post('api/sms/delete-sms', `<?xml version="1.0" encoding="UTF-8"?><request><Index>${id}</Index></request>`);
        showInternalToast('ההודעה נמחקה בהצלחה');
        await renderSmsSection();
      });
    });

  } catch (e) {
    smsListEl.innerHTML = `<div class="empty">שגיאה בטעינת הודעות</div>`;
  }
}

// ========================================================
// בדיקת עדכוני גרסה מול GitHub
// ========================================================
async function checkForUpdates(isManual = false) {
  const alertBox = document.getElementById('updateAlertBox');
  const currentVersion = chrome.runtime.getManifest().version;

  if (isManual) {
    showInternalToast('בודק עדכונים מול GitHub...');
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data && data.tag_name) {
      const latestVersion = data.tag_name.replace(/[vV]/g, '').trim();
      const isNewer = parseFloat(latestVersion) > parseFloat(currentVersion);

      if (isNewer) {
        if (alertBox) {
          document.getElementById('updateAlertText').innerText = `גרסה חדשה זמינה (${latestVersion})`;
          document.getElementById('updateAlertLink').href = data.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`;
          alertBox.style.display = 'block';
        }
        if (isManual) {
          showInternalToast(`זמין עדכון חדש: ${latestVersion}`);
        }
      } else {
        if (isManual) {
          showInternalToast('הגרסה שברשותך היא העדכנית ביותר');
        }
      }
    }
  } catch (e) {
    if (isManual) {
      showInternalToast('שגיאה בבדיקת עדכונים מול השרת');
    }
  }
}

// ========================================================
// כפתורים ומאזיני אירועים
// ========================================================
document.getElementById('connectionStatusBtn').addEventListener('click', loadData);
document.getElementById('refreshDataBtn').addEventListener('click', loadData);

// הפעלת WPS
let wpsCountdownInterval = null;
function startWpsVisualAnimation(durationSeconds = 120) {
  const btn = document.getElementById('wpsBtn');
  const textEl = document.getElementById('wpsBtnText');
  if (!btn || !textEl) return;

  clearInterval(wpsCountdownInterval);
  btn.classList.add('btn-wps-active');
  btn.title = "צימוד WPS פעיל כעת בסטיק";

  let remaining = durationSeconds;
  textEl.innerText = `WPS פעיל (${remaining})`;

  wpsCountdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(wpsCountdownInterval);
      btn.classList.remove('btn-wps-active');
      textEl.innerText = 'הפעל WPS';
      btn.title = 'הפעלת צימוד WPS בסטיק למשך 2 דקות';
      showInternalToast('הסתיים זמן צימוד WPS');
    } else {
      textEl.innerText = `WPS פעיל (${remaining})`;
    }
  }, 1000);
}

document.getElementById('wpsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('wpsBtn');
  if (btn.classList.contains('btn-wps-active')) return;

  const settings = await chrome.storage.local.get({ routerIp: '192.168.8.1', routerUsername: 'admin', routerPassword: '' });
  const wpsClient = new HuaweiClient(settings.routerIp, settings.routerUsername, settings.routerPassword);
  await wpsClient.login();

  try {
    let res = await wpsClient.post('api/wlan/wps-pbc', `<?xml version="1.0" encoding="UTF-8"?><request><WPSMode>1</WPSMode><ssidindex>0</ssidindex></request>`);
    let text = await res.text();

    if (!text.includes('OK') && !text.includes('1')) {
      res = await wpsClient.post('api/wlan/wps', `<?xml version="1.0" encoding="UTF-8"?><request><WPSPin></WPSPin><ssidindex>0</ssidindex></request>`);
      text = await res.text();
    }

    if (text.includes('OK') || text.includes('1')) {
      startWpsVisualAnimation(120);
      showInternalToast('מצב WPS הופעל למשך 2 דקות');
    }
  } catch (e) {
    showInternalToast('שגיאה בהפעלת WPS');
  }
});

document.addEventListener('click', async (e) => {
  const targetBtn = e.target.closest('.edit-btn');
  if (targetBtn) {
    const mac = targetBtn.getAttribute('data-mac');
    const settings = await chrome.storage.local.get({ deviceHistory: {} });
    const currentName = settings.deviceHistory[mac]?.customName || settings.deviceHistory[mac]?.name || '';
    const newName = prompt('הזן שם מותאם אישית (השאר ריק לאיפוס):', currentName);
    if (newName !== null) {
      settings.deviceHistory[mac].customName = newName.trim();
      await chrome.storage.local.set({ deviceHistory: settings.deviceHistory });
      loadData();
    }
  }
});

// פתיחה בכרטיסייה מלאה (סוגר את הפופ-אפ)
document.getElementById('openTabBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?mode=tab') });
  window.close();
});

// פתיחה בפאנל צד (סוגר את הפופ-אפ)
document.getElementById('openSidePanelBtn').addEventListener('click', () => {
  chrome.windows.getCurrent({ populate: true }, (windowObj) => {
    chrome.sidePanel.open({ windowId: windowObj.id }).then(() => {
      window.close();
    }).catch(() => {
      window.close();
    });
  });
});

document.getElementById('refreshSmsBtn').addEventListener('click', () => renderSmsSection());

document.getElementById('togglePasswordBtn').addEventListener('click', () => {
  const pwdInput = document.getElementById('passwordInput');
  pwdInput.type = (pwdInput.type === 'password') ? 'text' : 'password';
});

// בדיקת אימות וסיסמה ידנית (עם העלמת הודעה אוטומטית)
document.getElementById('testAuthBtn').addEventListener('click', async () => {
  const ip = document.getElementById('ipInput').value.trim();
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const statusSpan = document.getElementById('authTestResult');

  statusSpan.innerText = 'בודק אימות...';
  statusSpan.style.color = 'var(--text-muted)';

  const testClient = new HuaweiClient(ip, username, password);
  const ok = await testClient.refreshTokens();
  if (!ok) {
    statusSpan.innerText = 'לא ניתן להגיע לסטיק. ודא חיבור לרשת';
    statusSpan.style.color = 'var(--status-alert)';
    setTimeout(() => { statusSpan.innerText = ''; }, 3500);
    return;
  }

  if (!password) {
    statusSpan.innerText = 'לא הוזנה סיסמה';
    statusSpan.style.color = 'var(--status-alert)';
    setTimeout(() => { statusSpan.innerText = ''; }, 3500);
    return;
  }

  const res = await testClient.login();
  if (res.success) {
    statusSpan.innerText = 'האימות הצליח! יש הרשאות מלאות';
    statusSpan.style.color = 'var(--accent)';
    showInternalToast('אימות הסטיק עבר בהצלחה');
  } else {
    let msg = `שגיאה (קוד: ${res.code})`;
    if (res.code === '108002' || res.code === '108006') msg = 'סיסמה שגויה';
    else if (res.code === '108007') msg = 'הסטיק ננעל עקב ריבוי ניסיונות';
    else if (res.code === '125001' || res.code === '125002') msg = 'בעיית Session/טוקן';
    
    statusSpan.innerText = msg;
    statusSpan.style.color = 'var(--status-alert)';
  }

  // העלמת החיווי אחרי 3.5 שניות
  setTimeout(() => { statusSpan.innerText = ''; }, 3500);
});

// שאיבת הגדרות חבילת גלישה
document.getElementById('syncLimitBtn').addEventListener('click', async () => {
  const ip = document.getElementById('ipInput').value.trim();
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const resultText = document.getElementById('syncResultText');

  resultText.innerText = 'מושך נתונים...';
  resultText.style.color = 'var(--text-muted)';

  const syncClient = new HuaweiClient(ip, username, password);
  await syncClient.login();

  try {
    const res = await syncClient.get('api/monitoring/start_date');
    if (res.ok) {
      const xml = await res.text();
      const doc = parseXmlDoc(xml);

      let limitGB = 0;
      let thresholdPct = 0;
      let startDay = 0;

      let rawDay = getVal(doc, 'StartDay') || getVal(doc, 'start_day');
      if (rawDay && parseInt(rawDay, 10) >= 1 && parseInt(rawDay, 10) <= 31) {
        startDay = parseInt(rawDay, 10);
      }

      const gbMatch = xml.match(/(\d+)\s*GB/i);
      const mbMatch = xml.match(/(\d+)\s*MB/i);

      if (gbMatch) {
        limitGB = parseInt(gbMatch[1], 10);
      } else if (mbMatch) {
        limitGB = Math.round(parseInt(mbMatch[1], 10) / 1024);
      }

      if (!limitGB) {
        const bigByteMatches = xml.match(/\b(\d{10,13})\b/g);
        if (bigByteMatches) {
          for (let b of bigByteMatches) {
            let calculated = Math.round(parseFloat(b) / (1024 ** 3));
            if (calculated > 0 && calculated < 10000) {
              limitGB = calculated;
              break;
            }
          }
        }
      }

      let rawThreshold = getVal(doc, 'DataMonthMonthThreshold') || 
                         getVal(doc, 'MonthThreshold') || 
                         getVal(doc, 'Threshold') || 
                         getVal(doc, 'month_threshold_percent');

      if (rawThreshold) {
        let tNum = parseInt(rawThreshold.replace(/\D/g, ''), 10);
        if (tNum >= 50 && tNum <= 99) {
          thresholdPct = tNum;
        }
      }

      if (!thresholdPct) {
        const pctMatches = xml.match(/>(\d{2})</g);
        if (pctMatches) {
          for (let m of pctMatches) {
            let val = parseInt(m.replace(/\D/g, ''), 10);
            if (val >= 50 && val <= 99 && val !== limitGB) {
              thresholdPct = val;
              break;
            }
          }
        }
      }

      if (!startDay) {
        const dayMatch = xml.match(/>([1-9]|[12][0-9]|3[01])</);
        if (dayMatch) {
          startDay = parseInt(dayMatch[1], 10);
        }
      }

      if (limitGB > 0) document.getElementById('dataLimit').value = limitGB;
      if (thresholdPct > 0) document.getElementById('dataThreshold').value = thresholdPct;
      if (startDay > 0) document.getElementById('dataResetDay').value = startDay;

      if (limitGB > 0) {
        resultText.innerText = `נמשך בהצלחה: חבילה ${limitGB}GB, יום ${document.getElementById('dataResetDay').value}, התראה ${document.getElementById('dataThreshold').value}%`;
        resultText.style.color = 'var(--accent)';
        showInternalToast('נתוני החבילה וההתראה נשאבו בהצלחה!');
        markUnsavedSettings();
      } else {
        resultText.innerText = 'לא זוהו נתונים תקינים מהסטיק.';
        resultText.style.color = 'var(--text-muted)';
      }
    } else {
      resultText.innerText = 'לא ניתן לקרוא נתונים. ודא שהסיסמה נכונה.';
      resultText.style.color = 'var(--status-alert)';
    }
  } catch (e) {
    resultText.innerText = 'שגיאה במשיכת הנתונים מהסטיק.';
    resultText.style.color = 'var(--status-alert)';
  }
});

// כיבוי הסטיק
document.getElementById('powerOffBtn').addEventListener('click', async () => {
  if (!confirm('האם אתה בטוח שברצונך לכבות את הסטיק? תצטרך להדליקו פיזית מחדש.')) return;
  const ip = document.getElementById('ipInput').value.trim();
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;

  const ctrlClient = new HuaweiClient(ip, username, password);
  const loginRes = await ctrlClient.login();
  if (!loginRes.success) return showInternalToast('שגיאת הרשאה. נדרשת סיסמה תקינה');

  try {
    const res = await ctrlClient.post('api/device/control', `<?xml version="1.0" encoding="UTF-8"?><request><Control>4</Control></request>`);
    if (res.ok) showInternalToast('פקודת כיבוי נשלחה בהצלחה');
  } catch (e) {
    showInternalToast('שגיאה בשליחת פקודת הכיבוי');
  }
});

// שינוי סיסמת Wi-Fi
document.getElementById('changeWifiPasswordBtn').addEventListener('click', async () => {
  const newPass = document.getElementById('newWifiPassword').value;
  if (newPass.length < 8) return showInternalToast('סיסמה חייבת להכיל לפחות 8 תווים');
  if (!confirm(`האם לשנות את סיסמת ה-WiFi ל- "${newPass}"? כל ההתקנים ינותקו.`)) return;

  const ip = document.getElementById('ipInput').value.trim();
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;

  const wifiClient = new HuaweiClient(ip, username, password);
  const loginRes = await wifiClient.login();
  if (!loginRes.success) return showInternalToast('שגיאת הרשאה. סיסמה שגויה');

  try {
    const resGet = await wifiClient.get('api/wlan/basic-settings');
    const currentSettingsXml = await resGet.text();
    const newXmlData = currentSettingsXml.replace(/<WifiWpapsk>.*?<\/WifiWpapsk>/g, `<WifiWpapsk>${newPass}</WifiWpapsk>`);
    
    const resPost = await wifiClient.post('api/wlan/basic-settings', newXmlData);
    if (resPost.ok) {
      showInternalToast('סיסמת ה-WiFi שונתה בהצלחה');
      document.getElementById('newWifiPassword').value = '';
    }
  } catch (e) {
    showInternalToast('שגיאה בעדכון הסיסמה');
  }
});

// איפוס היסטוריה
document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  if (confirm('האם למחוק את היסטוריית ההתקנים הקודמת?')) {
    const settings = await chrome.storage.local.get({ deviceHistory: {} });
    const currentMacs = Array.from(document.getElementById('currentDevicesList').querySelectorAll('.edit-btn')).map(btn => btn.getAttribute('data-mac'));
    const newHistory = {};
    currentMacs.forEach(mac => {
      if (settings.deviceHistory[mac]) newHistory[mac] = settings.deviceHistory[mac];
    });
    await chrome.storage.local.set({ deviceHistory: newHistory });
    showInternalToast('היסטוריית ההתקנים אופסה');
    loadData();
  }
});

// לחיצה על תיבת הגרסה בראש העמוד
document.getElementById('versionBadgeBtn').addEventListener('click', () => {
  checkForUpdates(true);
});

// ========================================================
// יצוא ויבוא הגדרות
// ========================================================
document.getElementById('exportSettingsBtn').addEventListener('click', async () => {
  const allSettings = await chrome.storage.local.get(null);
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allSettings, null, 2));
  const dlAnchor = document.createElement('a');
  dlAnchor.setAttribute("href", dataStr);
  dlAnchor.setAttribute("download", "HuaweiStick_Backup.json");
  document.body.appendChild(dlAnchor);
  dlAnchor.click();
  dlAnchor.remove();
  showInternalToast('ההגדרות יוצאו בהצלחה לקובץ');
});

document.getElementById('importSettingsBtn').addEventListener('click', () => {
  document.getElementById('importFileInput').click();
});

document.getElementById('importFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const imported = JSON.parse(evt.target.result);
      if (typeof imported === 'object') {
        await chrome.storage.local.set(imported);
        await initSettings();
        showInternalToast('ההגדרות יובאו בהצלחה!');
        loadData();
      }
    } catch(err) {
      showInternalToast('שגיאה בפענוח קובץ הגיבוי');
    }
  };
  reader.readAsText(file);
});

// העתקת מייל ללוח
const creditEmailEl = document.getElementById('creditEmail');
if (creditEmailEl) {
  creditEmailEl.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText('q9411aa@gmail.com');
      const origText = creditEmailEl.innerText;
      creditEmailEl.innerText = 'הועתק';
      creditEmailEl.classList.add('copied');
      setTimeout(() => {
        creditEmailEl.innerText = origText;
        creditEmailEl.classList.remove('copied');
      }, 3000);
    } catch (err) {}
  });
}

function markUnsavedSettings() {
  document.getElementById('saveBtn')?.classList.add('btn-unsaved-pulse');
}

['ipInput', 'usernameInput', 'passwordInput', 'dataLimit', 'dataResetDay', 'dataThreshold', 'batteryThreshold', 'batteryCriticalLevel'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', markUnsavedSettings);
});
['critAlertTab', 'critAlertWindow', 'critAlertSound', 'critAlertBanner'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', markUnsavedSettings);
});

async function initSettings() {
  const currentVersion = chrome.runtime.getManifest().version;
  const versionTextEl = document.getElementById('versionText');
  if (versionTextEl) versionTextEl.innerText = `${currentVersion}`; // בלי V

  const s = await chrome.storage.local.get({
    routerIp: '192.168.8.1', routerUsername: 'admin', routerPassword: '',
    batteryThreshold: 20, batteryCriticalLevel: 5,
    critAlertTab: true, critAlertWindow: false, critAlertSound: true, critAlertBanner: false,
    dataLimitGB: 50, dataResetDay: 1, dataThreshold: 90
  });

  document.getElementById('ipInput').value = s.routerIp;
  document.getElementById('usernameInput').value = (s.routerUsername || 'admin').toLowerCase();
  document.getElementById('passwordInput').value = s.routerPassword;
  document.getElementById('batteryThreshold').value = s.batteryThreshold;
  document.getElementById('batteryCriticalLevel').value = s.batteryCriticalLevel;
  document.getElementById('critAlertTab').checked = s.critAlertTab !== false;
  document.getElementById('critAlertWindow').checked = s.critAlertWindow === true;
  document.getElementById('critAlertSound').checked = s.critAlertSound !== false;
  document.getElementById('critAlertBanner').checked = s.critAlertBanner === true;
  document.getElementById('dataLimit').value = s.dataLimitGB;
  document.getElementById('dataResetDay').value = s.dataResetDay || 1;
  document.getElementById('dataThreshold').value = s.dataThreshold;

  document.getElementById('saveBtn')?.classList.remove('btn-unsaved-pulse');
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({
    routerIp: document.getElementById('ipInput').value.trim(),
    routerUsername: (document.getElementById('usernameInput').value.trim() || 'admin').toLowerCase(),
    routerPassword: document.getElementById('passwordInput').value,
    batteryThreshold: parseInt(document.getElementById('batteryThreshold').value, 10),
    batteryCriticalLevel: parseInt(document.getElementById('batteryCriticalLevel').value, 10) || 5,
    critAlertTab: document.getElementById('critAlertTab').checked,
    critAlertWindow: document.getElementById('critAlertWindow').checked,
    critAlertSound: document.getElementById('critAlertSound').checked,
    critAlertBanner: document.getElementById('critAlertBanner').checked,
    dataLimitGB: parseFloat(document.getElementById('dataLimit').value) || 50,
    dataResetDay: parseInt(document.getElementById('dataResetDay').value, 10) || 1,
    dataThreshold: parseInt(document.getElementById('dataThreshold').value, 10)
  });

  const btn = document.getElementById('saveBtn');
  btn.classList.remove('btn-unsaved-pulse');
  const origText = btn.innerHTML;
  btn.innerHTML = '<span>נשמר בהצלחה</span>';
  btn.style.background = 'var(--accent-hover)';
  showInternalToast('ההגדרות נשמרו בהצלחה');
  setTimeout(() => {
    btn.innerHTML = origText;
    btn.style.background = '';
  }, 2000);

  loadData();
});

// התחלה
checkForUpdates(false);
initSettings().then(loadData);