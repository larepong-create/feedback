/**
 * ระบบความคิดเห็นลูกค้า (Customer Feedback) — Apps Script backend
 * โรงพยาบาลสัตว์เมืองเอก · แยกจากระบบรายงานอุบัติการณ์
 *
 * ติดตั้ง:
 *   1) สร้าง Google Sheets ไฟล์ใหม่ > ส่วนขยาย > Apps Script แล้ววางไฟล์นี้ทั้งไฟล์
 *   2) เลือกฟังก์ชัน setup แล้วกด "เรียกใช้" (อนุญาตสิทธิ์ครั้งแรก)
 *   3) การทำให้ใช้งานได้ > การทำให้ใช้งานได้รายการใหม่ > เว็บแอป
 *        เรียกใช้ในฐานะ: ฉัน · ผู้ที่มีสิทธิ์เข้าถึง: ทุกคน
 *   4) นำ URL ที่ลงท้าย /exec ไปใส่ใน config.js ของหน้าเว็บ
 */

var CFG = {
  TZ: 'Asia/Bangkok',
  SHEET_RES: 'FB_Responses',
  SHEET_USERS: 'FB_Users',
  SHEET_SETTINGS: 'FB_Settings',
  SESSION_SECONDS: 21600
};

var RES_COLS = ['id', 'createdAt', 'branch', 'score', 'aspects', 'nps', 'comment', 'wantCall', 'name', 'phone', 'pet',
  'follow', 'followNote', 'followBy', 'followAt', 'updatedAt', 'deleted'];
var RES_HEAD = ['เลขที่', 'วันที่ส่ง', 'สาขา', 'คะแนน (ดาว)', 'ด้านที่พูดถึง', 'คะแนนแนะนำ (0-10)', 'ความคิดเห็น', 'ขอให้ติดต่อกลับ', 'ชื่อ', 'เบอร์โทร', 'ชื่อสัตว์',
  'การติดตาม', 'บันทึกการติดตาม', 'ผู้ติดตาม', 'ติดตามเมื่อ', 'แก้ไขล่าสุด', 'ลบ'];
var USER_COLS = ['username', 'name', 'role', 'branch', 'passHash', 'salt', 'active', 'createdAt'];
var FOLLOW = { WAIT: 'รอติดต่อ', DONE: 'ติดต่อแล้ว' };
var ROLES = { admin: 'ผู้ดูแลระบบ', manager: 'ผู้บริหาร / QA', branch: 'หัวหน้าสาขา' };
var STAR_LABEL = ['ไม่พอใจมาก', 'ไม่พอใจ', 'เฉย ๆ', 'พอใจ', 'พอใจมาก'];
var DEFAULTS = {
  orgName: 'โรงพยาบาลสัตว์เมืองเอก',
  branches: [{ code: 'MA', name: 'เมืองเอก' }, { code: 'K3', name: 'คลองสาม' }, { code: 'K4', name: 'คลองสี่' }],
  aspects: ['การต้อนรับ', 'คุณหมอ', 'พยาบาล / ผู้ช่วย', 'ระยะเวลารอ', 'ความสะอาด', 'การแจ้งค่าใช้จ่าย', 'อาบน้ำตัดขน', 'ห้องยา'],
  askNps: true,
  followMaxScore: 2,      // คะแนนเท่านี้หรือต่ำกว่า ต้องติดตาม
  notifyMaxScore: 2,      // แจ้ง LINE เมื่อคะแนนเท่านี้หรือต่ำกว่า (0 = ไม่แจ้งตามคะแนน)
  notifyCallback: true,   // แจ้ง LINE เมื่อลูกค้าขอให้ติดต่อกลับ
  lineTo: '',
  lineGroups: [],
  appUrl: ''
};

/* ======================================================================
 *  HTTP
 * ==================================================================== */
function doGet() { return json_({ ok: { service: 'Customer Feedback API', at: now_() } }); }

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'คำขอไม่ถูกต้อง' }); }
  if (body && Object.prototype.toString.call(body.events) === '[object Array]') {
    try { lineWebhook_(body.events); } catch (err) { console.warn('line webhook', err); }
    return ContentService.createTextOutput('OK');
  }
  if (body.fn === 'batch') return json_({ ok: (body.args[0] || []).map(function (c) { return run_(c[0], c[1]); }) });
  return json_(run_(body.fn, body.args || []));
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

var PUBLIC = { config: 1, submit: 1, login: 1, logout: 1 };
function run_(fn, args) {
  try {
    if (!Object.prototype.hasOwnProperty.call(API, fn)) throw new Error('ไม่พบคำสั่ง ' + fn);
    if (!PUBLIC[fn]) { var user = auth_(args[0]); return { ok: API[fn].apply(null, [user].concat(args.slice(1))) }; }
    return { ok: API[fn].apply(null, args) };
  } catch (err) {
    return { error: String((err && err.message) || err).replace(/^(Exception|Error):\s*/, '') };
  }
}

/* ======================================================================
 *  API
 * ==================================================================== */
var API = {
  /** ตัวเลือกสำหรับหน้าลูกค้า */
  config: function (branch) {
    var s = settings_(), b = (s.branches || []).filter(function (x) { return x.code === String(branch || '').toUpperCase(); })[0];
    return { orgName: s.orgName, branches: s.branches, branch: b || null, aspects: s.aspects, askNps: s.askNps !== false };
  },

  /** ลูกค้าส่งความคิดเห็น (ไม่ต้องเข้าสู่ระบบ) */
  submit: function (d) {
    d = d || {};
    if (d.website) return { id: 'ok' }; // ช่องกันบอท ต้องว่าง
    var s = settings_();
    var branch = String(d.branch || '').toUpperCase();
    if (!(s.branches || []).some(function (b) { return b.code === branch; })) throw new Error('กรุณาเลือกสาขาที่ใช้บริการ');
    var score = parseInt(d.score, 10);
    if (!(score >= 1 && score <= 5)) throw new Error('กรุณาแตะดาวเพื่อให้คะแนน');
    var nps = d.nps === '' || d.nps == null ? '' : Math.max(0, Math.min(10, parseInt(d.nps, 10) || 0));
    var wantCall = !!d.wantCall;
    if (wantCall && !clean_(d.phone, 40)) throw new Error('กรุณากรอกเบอร์โทรเพื่อให้เราติดต่อกลับ');
    if (!throttle_(d.client)) throw new Error('ส่งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่');
    var rec;
    var lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      var created = now_();
      rec = {
        id: nextId_(created), createdAt: created, branch: branch, score: score,
        aspects: (d.aspects || []).slice(0, 12).map(function (a) { return clean_(a, 40); }).join(', '),
        nps: nps, comment: clean_(d.comment, 1500), wantCall: wantCall ? 'TRUE' : 'FALSE',
        name: wantCall ? clean_(d.name, 80) : '', phone: wantCall ? clean_(d.phone, 40) : '', pet: clean_(d.pet, 80),
        follow: (wantCall || score <= (parseInt(s.followMaxScore, 10) || 0)) ? FOLLOW.WAIT : '',
        followNote: '', followBy: '', followAt: '', updatedAt: created, deleted: ''
      };
      sheet_(CFG.SHEET_RES).appendRow(rowOf_(rec));
    } finally { lock.releaseLock(); }
    try { notify_(rec, s); } catch (err) { console.warn('notify', err); }
    return { id: rec.id };
  },

  login: function (username, password) {
    username = String(username || '').trim().toLowerCase();
    var u = findUser_(username);
    if (!u || String(u.active) === 'FALSE' || hash_(password, u.salt) !== u.passHash) { Utilities.sleep(600); throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'); }
    var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    CacheService.getScriptCache().put('s_' + token, username, CFG.SESSION_SECONDS);
    return { token: token, user: publicUser_(u) };
  },
  logout: function (token) { if (token) CacheService.getScriptCache().remove('s_' + token); return true; },

  bootstrap: function (user) {
    var s = settings_();
    return { user: publicUser_(user), roles: ROLES, config: { orgName: s.orgName, branches: s.branches, aspects: s.aspects, askNps: s.askNps !== false, appUrl: s.appUrl } };
  },

  /** ความคิดเห็นทั้งหมดที่ผู้ใช้มีสิทธิ์เห็น */
  list: function (user) {
    return readRes_().filter(function (r) { return !r.deleted && canSee_(user, r); }).map(view_);
  },

  /** บันทึกการติดตาม (โทรกลับแล้ว / ยังติดต่อไม่ได้) */
  follow: function (user, id, status, note) {
    if ([FOLLOW.WAIT, FOLLOW.DONE, ''].indexOf(status) < 0) throw new Error('สถานะไม่ถูกต้อง');
    return withRow_(user, id, function (r) {
      r.follow = status;
      var n = clean_(note, 1500);
      if (n) r.followNote = (r.followNote ? r.followNote + '\n' : '') + '[' + now_().slice(0, 16) + ' ' + user.name + '] ' + n;
      r.followBy = user.name; r.followAt = now_();
      return r;
    });
  },

  remove: function (user, id) { needRole_(user, 'admin'); withRow_(user, id, function (r) { r.deleted = 'TRUE'; return r; }); return true; },

  changePassword: function (user, oldPw, newPw) {
    if (String(newPw || '').length < 6) throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
    if (hash_(oldPw, user.salt) !== user.passHash) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
    setPassword_(user.username, newPw);
    return true;
  },

  listUsers: function (user) { needRole_(user, 'admin'); return readUsers_().map(publicUser_); },
  saveUser: function (user, u) {
    needRole_(user, 'admin');
    var username = String(u.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,30}$/.test(username)) throw new Error('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - (2-30 ตัว)');
    if (!ROLES[u.role]) throw new Error('บทบาทไม่ถูกต้อง');
    if (u.role === 'branch' && !u.branch) throw new Error('หัวหน้าสาขาต้องระบุสาขา');
    var sh = sheet_(CFG.SHEET_USERS), rows = sh.getDataRange().getDisplayValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).toLowerCase() === username) {
        sh.getRange(i + 1, 2, 1, 3).setValues([[clean_(u.name, 80), u.role, u.role === 'branch' ? u.branch : '']]);
        sh.getRange(i + 1, 7).setValue(u.active === false ? 'FALSE' : 'TRUE');
        if (u.password) setPassword_(username, u.password);
        return true;
      }
    }
    if (String(u.password || '').length < 6) throw new Error('ผู้ใช้ใหม่ต้องตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร');
    var salt = Utilities.getUuid();
    sh.appendRow([username, clean_(u.name, 80), u.role, u.role === 'branch' ? u.branch : '', hash_(u.password, salt), salt, 'TRUE', now_()]);
    return true;
  },

  getSettings: function (user) {
    needRole_(user, 'admin');
    var s = settings_();
    s.lineTokenSet = !!PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
    s.webAppUrl = ScriptApp.getService().getUrl() || '';
    return s;
  },
  saveSettings: function (user, s) {
    needRole_(user, 'admin');
    var cur = settings_();
    ['orgName', 'branches', 'aspects', 'askNps', 'followMaxScore', 'notifyMaxScore', 'notifyCallback', 'lineTo', 'appUrl'].forEach(function (k) { if (s[k] != null) cur[k] = s[k]; });
    writeSettings_(cur);
    if (s.lineToken) PropertiesService.getScriptProperties().setProperty('LINE_TOKEN', String(s.lineToken).trim());
    return true;
  },
  testNotify: function (user) {
    needRole_(user, 'admin');
    var r = pushLine_('ทดสอบการแจ้งเตือนจากระบบความคิดเห็นลูกค้า ✅');
    if (r !== true) throw new Error(r);
    return true;
  }
};

/* ======================================================================
 *  ติดตั้ง
 * ==================================================================== */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, CFG.SHEET_RES, RES_HEAD);
  ensureSheet_(ss, CFG.SHEET_USERS, ['ชื่อผู้ใช้', 'ชื่อ', 'บทบาท', 'สาขา', 'passHash', 'salt', 'ใช้งาน', 'สร้างเมื่อ']);
  ensureSheet_(ss, CFG.SHEET_SETTINGS, ['key', 'value']);
  writeSettings_(settings_());
  if (!findUser_('admin')) {
    var salt = Utilities.getUuid();
    sheet_(CFG.SHEET_USERS).appendRow(['admin', 'ผู้ดูแลระบบ', 'admin', '', hash_('admin1234', salt), salt, 'TRUE', now_()]);
  }
  console.log('ติดตั้งเรียบร้อย · ผู้ใช้เริ่มต้น admin / admin1234 (เปลี่ยนรหัสผ่านทันทีหลังเข้าระบบ)');
}

/* ======================================================================
 *  ข้อมูล
 * ==================================================================== */
function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('ยังไม่ได้ติดตั้งระบบ (ไม่พบชีต ' + name + ') กรุณาเรียกใช้ฟังก์ชัน setup ใน Apps Script');
  return sh;
}
function ensureSheet_(ss, name, head) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#ffe3ec');
    sh.setFrozenRows(1);
    sh.getRange('A:Q').setNumberFormat('@');
  }
  return sh;
}
function readRes_() {
  var v = sheet_(CFG.SHEET_RES).getDataRange().getDisplayValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    if (!v[i][0]) continue;
    var r = {}; RES_COLS.forEach(function (k, j) { r[k] = v[i][j] == null ? '' : v[i][j]; });
    r._row = i + 1; out.push(r);
  }
  return out;
}
function rowOf_(r) { return RES_COLS.map(function (k) { var x = r[k] == null ? '' : String(r[k]); return /^[=+\-@]/.test(x) ? "'" + x : x; }); }
function withRow_(user, id, fn) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var r = readRes_().filter(function (x) { return x.id === id && !x.deleted; })[0];
    if (!r || !canSee_(user, r)) throw new Error('ไม่พบความคิดเห็น ' + id);
    r = fn(r); r.updatedAt = now_();
    sheet_(CFG.SHEET_RES).getRange(r._row, 1, 1, RES_COLS.length).setValues([rowOf_(r)]);
    return view_(r);
  } finally { lock.releaseLock(); }
}
function view_(r) {
  return {
    id: r.id, createdAt: r.createdAt, branch: r.branch, score: parseInt(r.score, 10) || 0,
    aspects: String(r.aspects || '').split(/\s*,\s*/).filter(String), nps: r.nps === '' ? null : parseInt(r.nps, 10),
    comment: r.comment, wantCall: String(r.wantCall) === 'TRUE', name: r.name, phone: r.phone, pet: r.pet,
    follow: r.follow, followNote: r.followNote, followBy: r.followBy, followAt: r.followAt
  };
}
function nextId_(created) {
  var y = (parseInt(created.slice(0, 4), 10) + 543) % 100, prefix = 'FB' + (y < 10 ? '0' : '') + y + created.slice(5, 7) + '-', max = 0;
  readRes_().forEach(function (r) { if (r.id.indexOf(prefix) === 0) max = Math.max(max, parseInt(r.id.slice(prefix.length), 10) || 0); });
  var n = max + 1;
  return prefix + (n < 10 ? '000' : n < 100 ? '00' : n < 1000 ? '0' : '') + n;
}
/** กันการกดส่งซ้ำรัว ๆ จากเครื่องเดียว: 1 ครั้งต่อ 20 วินาที */
function throttle_(client) {
  client = String(client || '').replace(/[^\w-]/g, '').slice(0, 40);
  if (!client) return true;
  var c = CacheService.getScriptCache(), k = 't_' + client;
  if (c.get(k)) return false;
  c.put(k, '1', 20);
  return true;
}

function settings_() {
  var s = JSON.parse(JSON.stringify(DEFAULTS));
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.SHEET_SETTINGS);
  if (!sh) return s;
  sh.getDataRange().getValues().slice(1).forEach(function (r) {
    if (!r[0]) return;
    try { s[r[0]] = JSON.parse(r[1]); } catch (e) { s[r[0]] = r[1]; }
  });
  return s;
}
function writeSettings_(s) {
  var sh = sheet_(CFG.SHEET_SETTINGS);
  var rows = Object.keys(s).filter(function (k) { return k !== 'lineTokenSet' && k !== 'webAppUrl'; }).map(function (k) { return [k, JSON.stringify(s[k])]; });
  sh.getRange(2, 1, Math.max(sh.getLastRow(), 2), 2).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 2).setValues(rows);
}

/* ---------- ผู้ใช้ ---------- */
function readUsers_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.SHEET_USERS);
  if (!sh) return [];
  return sh.getDataRange().getDisplayValues().slice(1).filter(function (r) { return r[0]; }).map(function (r) {
    var u = {}; USER_COLS.forEach(function (k, j) { u[k] = r[j]; }); return u;
  });
}
function findUser_(username) { return readUsers_().filter(function (u) { return String(u.username).toLowerCase() === username; })[0] || null; }
function publicUser_(u) { return { username: u.username, name: u.name, role: u.role, branch: u.branch, active: String(u.active) !== 'FALSE' }; }
function setPassword_(username, pw) {
  var sh = sheet_(CFG.SHEET_USERS), rows = sh.getDataRange().getDisplayValues();
  for (var i = 1; i < rows.length; i++) if (String(rows[i][0]).toLowerCase() === username) {
    var salt = Utilities.getUuid();
    sh.getRange(i + 1, 5, 1, 2).setValues([[hash_(pw, salt), salt]]);
    return;
  }
}
function hash_(pw, salt) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + '|' + String(pw), Utilities.Charset.UTF_8);
  return b.map(function (x) { return ((x + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}
function auth_(token) {
  if (!token) throw new Error('SESSION_EXPIRED');
  var c = CacheService.getScriptCache(), username = c.get('s_' + token);
  if (!username) throw new Error('SESSION_EXPIRED');
  var u = findUser_(username);
  if (!u || String(u.active) === 'FALSE') throw new Error('SESSION_EXPIRED');
  c.put('s_' + token, username, CFG.SESSION_SECONDS);
  return u;
}
function needRole_(user, role) { if (user.role !== role) throw new Error('เฉพาะ' + ROLES[role] + 'เท่านั้น'); }
function canSee_(user, r) { return user.role !== 'branch' || r.branch === user.branch; }

/* ======================================================================
 *  LINE
 * ==================================================================== */
function notify_(r, s) {
  if (!s.lineTo) return;
  var low = (parseInt(s.notifyMaxScore, 10) || 0) >= r.score;
  var call = s.notifyCallback !== false && String(r.wantCall) === 'TRUE';
  if (!low && !call) return;
  var br = (s.branches.filter(function (b) { return b.code === r.branch; })[0] || {}).name || r.branch;
  pushLine_((r.score <= 2 ? '⚠️' : '⭐') + ' ความคิดเห็นลูกค้า\n' +
    'สาขา' + br + '\n' +
    r.score + ' ดาว · ' + STAR_LABEL[r.score - 1] + '\n' +
    (call ? 'ขอให้ติดต่อกลับ' : (r.aspects || 'ไม่ได้ระบุด้าน')));
}
function pushLine_(text) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN'), to = settings_().lineTo;
  if (!token || !to) return 'ยังไม่ได้ตั้งค่า Channel access token หรือกลุ่มที่รับแจ้งเตือน';
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text.slice(0, 4900) }] })
  });
  return res.getResponseCode() === 200 ? true : 'LINE ตอบกลับ ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200);
}
/** ใช้เมื่อสร้าง LINE Official Account แยกสำหรับระบบนี้: เชิญเข้ากลุ่ม หรือพิมพ์ "ตั้งกลุ่มความคิดเห็น" ในกลุ่ม */
function lineWebhook_(events) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  if (!token) return;
  events.forEach(function (ev) {
    var src = ev.source || {}, gid = src.groupId || src.roomId;
    if (!gid) return;
    var text = ev.type === 'message' && ev.message && ev.message.type === 'text' ? String(ev.message.text || '').trim() : '';
    if (ev.type !== 'join' && !/^(ตั้งกลุ่มความคิดเห็น|#feedback)$/i.test(text)) return;
    var name = 'ห้องแชต';
    if (src.groupId) {
      var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/group/' + encodeURIComponent(gid) + '/summary', { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } });
      if (res.getResponseCode() !== 200) return;
      try { name = JSON.parse(res.getContentText()).groupName || 'กลุ่ม LINE'; } catch (e) { name = 'กลุ่ม LINE'; }
    }
    var s = settings_(), msg;
    s.lineGroups = (s.lineGroups || []).filter(function (g) { return g.id !== gid; });
    s.lineGroups.push({ id: gid, name: name, at: now_() });
    if (!s.lineTo || s.lineTo === gid) { s.lineTo = gid; msg = '✅ เชื่อมกลุ่มนี้กับระบบความคิดเห็นลูกค้าแล้ว'; }
    else msg = 'บันทึกกลุ่มนี้แล้ว ผู้ดูแลระบบเลือกให้ส่งแจ้งเตือนเข้ากลุ่มนี้ได้ที่หน้าตั้งค่า';
    writeSettings_(s);
    if (ev.replyToken) UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: 'text', text: msg }] })
    });
  });
}

/* ======================================================================
 *  helpers
 * ==================================================================== */
function now_() {
  var t = new Date(Date.now() + 7 * 3600000);
  return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate()) + ' ' + pad2_(t.getUTCHours()) + ':' + pad2_(t.getUTCMinutes()) + ':' + pad2_(t.getUTCSeconds());
}
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function clean_(v, max) { return String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max || 500); }
