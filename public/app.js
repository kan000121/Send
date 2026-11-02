// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const listEl = $("channels"), usersEl = $("users"), out = $("out");
const filterInput = $("filter"), userFilter = $("userFilter");
const onlySelectedCh = $("onlySelectedCh"), onlySelectedUsers = $("onlySelectedUsers");
const messageEl = $("message"), summaryEl = $("summary");
const sendBtn = $("sendBtn"), undoBtn = $("undoBtn");
const confirmModal = $("confirmModal"), undoModal = $("undoModal"), helpModal = $("helpModal");
const confirmSendBtn = $("confirmSendBtn"), confirmUndoBtn = $("confirmUndoBtn");
const modeRadios = [...document.querySelectorAll('input[name="senderMode"]')];
const userTokenRow = $("userTokenRow"), userTokenInput = $("userToken"), teamIdInput = $("teamId");
const verifyBtn = $("verifyBtn"), verifyNote = $("verifyNote");
const botTokenRow = $("botTokenRow"), botTokenInput = $("botToken");
const botVerifyBtn = $("botVerifyBtn"), botVerifyNote = $("botVerifyNote");

const MAX_TEXT_LEN = 40000;
const LS_SELECTED_CH = "selectedChannels_onlyChannelOrUsers";
const LS_PLAN = "perChannelMentions_onlyChannelOrUsers";

// ---------- state ----------
// 選択状態は DOM ではなくここで保持する（絞り込みで非表示でも選択は維持）
let allChannels = [];
let allUsers = [];
let allUsersMap = new Map();
let channelsLoading = false, usersLoading = true;
let channelsError = "", usersError = "";
let personal = { ok:false, user:null, memberChannels:[], publicChannels:[], token:"", teamId:"" };
// token が空なら、サーバーの .env に設定された Bot トークンを使っている
let botAuth = { ok:false, bot:null, token:"", fromServer:false };
let botChecking = false;
const botHeaders = () => botAuth.token ? { "x-bot-token": botAuth.token } : {};
const selectedChannels = new Set();
const selectedUsers = new Set();
// per-channel plan: Map<chId, { mode:"channel"|"user", users?:[{id,name}] }>
const perChannelMentions = new Map();
const channelMembersCache = new Map();
let lastBroadcast = null; // { id, count, labels: Map<channelId, label> }
let busy = false;

const getMode = () => modeRadios.find(r => r.checked)?.value || "user";

// API 呼び出しは必ず CSRF 対策ヘッダを付与する
const api = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), "X-Requested-With": "send" } });
const robustJsonResponse = (r) => r.text().then(raw => {
  if ((r.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    try { return JSON.parse(raw); } catch {}
  }
  return { ok:false, error:"non_json_response", status:r.status, raw };
});

// ---------- 表示用ユーティリティ ----------
const ERROR_TEXT = {
  not_in_channel: "チャンネルに参加していません",
  channel_not_found: "チャンネルが見つかりません（権限がない可能性があります）",
  is_archived: "アーカイブ済みのチャンネルです",
  restricted_action: "このチャンネルへの投稿が制限されています",
  invalid_auth: "トークンが無効です",
  not_authed: "トークンが指定されていません",
  token_revoked: "トークンが失効しています",
  account_inactive: "アカウントが無効化されています",
  missing_scope: "トークンの権限（スコープ）が不足しています",
  ratelimited: "Slack のレート制限に達しました。しばらく待って再試行してください",
  rate_limited: "短時間に操作しすぎです。1分ほど待って再試行してください",
  too_many_auth_failures: "認証失敗が多すぎます。しばらく待ってから再試行してください",
  msg_too_long: "メッセージが長すぎます",
  cannot_dm_bot: "Bot には DM を送れません",
  user_not_found: "ユーザーが見つかりません",
  user_disabled: "無効化されたユーザーです",
  token_required: "ユーザートークンを入力して「確認」してください",
  not_bot_token: "Bot トークン（xoxb-）ではありません",
  no_token: "トークンが設定されていません",
  invalid_params: "入力内容に誤りがあります",
  no_last_broadcast: "取り消せる送信がありません（サーバー再起動などで履歴が消えた可能性があります）",
  not_owner: "この送信は別のアカウントで行われたため取り消せません",
  csrf_check_failed: "不正なリクエストとして拒否されました。ページを再読み込みしてください",
  origin_not_allowed: "不正なリクエストとして拒否されました。ページを再読み込みしてください",
  https_required: "HTTPS でアクセスしてください",
  internal_error: "サーバーでエラーが発生しました",
  non_json_response: "サーバーから想定外の応答がありました",
  network_error: "サーバーに接続できませんでした",
};
const errText = (code) => code ? (ERROR_TEXT[code] || code) : "不明なエラー";

let toastTimer;
function toast(message, type = "") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  children.flat().forEach(c => c != null && node.append(c));
  return node;
}
const emptyState = (text, loading = false) =>
  el("div", { class:"empty" }, loading ? el("span", { class:"spinner", "aria-hidden":"true" }) : null, text);
// 一覧の取得失敗を、原因（Slack のエラーコード）付きで一覧内に表示する
const LOAD_ERROR_HINT = {
  no_token: "上で個人トークンまたは Bot トークンを入力して「確認」してください。",
  missing_scope: "トークン（個人トークンまたは Bot）に users:read / channels:read などのスコープを追加し、Slack アプリを再インストールしてください。",
  invalid_auth: "トークンが正しいか確認してください。",
  token_revoked: "Slack アプリを再インストールして、新しい Bot トークンを設定してください。",
};
const loadErrorState = (what, code) => el("div", { class:"empty" },
  el("div", { text:`${what}を取得できませんでした：${errText(code)}` }),
  LOAD_ERROR_HINT[code] ? el("div", { class:"muted", text:LOAD_ERROR_HINT[code] }) : null,
  el("div", { class:"muted", text:`エラーコード：${code}` }));

// ---------- persist ----------
function saveSelectedChannels() {
  try { localStorage.setItem(LS_SELECTED_CH, JSON.stringify([...selectedChannels])); } catch {}
}
function loadSelectedChannels() {
  try { JSON.parse(localStorage.getItem(LS_SELECTED_CH) || "[]").forEach(id => selectedChannels.add(id)); } catch {}
}
function savePlans() {
  try { localStorage.setItem(LS_PLAN, JSON.stringify(Object.fromEntries(perChannelMentions))); } catch {}
}
function loadPlans() {
  try {
    const obj = JSON.parse(localStorage.getItem(LS_PLAN) || "{}");
    Object.entries(obj).forEach(([k,v]) => perChannelMentions.set(k, v));
  } catch {}
}

// ---------- 宛先の算出 ----------
function currentChannelSource() { return getMode() === "user" ? (personal.ok ? personal.memberChannels : []) : allChannels; }
// 現在のモードで送信可能な選択済みチャンネル（別モードで選んだものは除外）
function effectiveChannelIds() {
  const ids = new Set(currentChannelSource().map(c => c.id));
  return [...selectedChannels].filter(id => ids.has(id));
}
const channelName = (id) => currentChannelSource().find(c => c.id === id)?.name || id;
const userName = (id) => allUsersMap.get(id) || id;

function planFor(chId) {
  if (!perChannelMentions.has(chId)) perChannelMentions.set(chId, { mode:"channel" });
  return perChannelMentions.get(chId);
}
const planIsValid = (plan) => plan.mode === "channel" || (plan.users || []).length > 0;
function summarizePlan(plan) {
  if (plan.mode === "channel") return { text:"@channel", ok:true };
  const n = (plan.users || []).length;
  if (n === 0) return { text:"メンション先を選択", ok:false };
  if (n === 1) return { text:`@${plan.users[0].name || plan.users[0].id}`, ok:true };
  return { text:`@${n}名`, ok:true };
}

function updateCounts() {
  const ch = effectiveChannelIds().length, dm = selectedUsers.size, total = ch + dm;
  $("chCount").textContent = `${ch}件選択`;
  $("chCount").classList.toggle("active", ch > 0);
  $("dmCount").textContent = `${dm}件選択`;
  $("dmCount").classList.toggle("active", dm > 0);
  const summary = $("selectionSummary");
  summary.replaceChildren(
    total ? el("strong", { text:`${total}件` }) : el("span", { class:"muted", text:"宛先が未選択です" }),
    total ? `（チャンネル ${ch}件・DM ${dm}件）` : ""
  );
  sendBtn.textContent = total ? `内容を確認して送信（${total}件）` : "内容を確認して送信";
}

// ---------- チャンネル一覧 ----------
function renderChannels() {
  const mode = getMode();
  if (mode === "user" && !personal.ok) {
    listEl.replaceChildren(emptyState("上の「確認」でトークンを確認すると、参加中のチャンネルが表示されます"));
    return updateCounts();
  }
  if (mode === "bot" && (botChecking || channelsLoading)) {
    listEl.replaceChildren(emptyState("読み込み中…", true));
    return updateCounts();
  }
  if (mode === "bot" && !botAuth.ok) {
    listEl.replaceChildren(emptyState("上で Bot トークンを入力して「確認」すると、Bot が参加しているチャンネルが表示されます"));
    return updateCounts();
  }
  if (mode === "bot" && channelsError) {
    listEl.replaceChildren(loadErrorState("チャンネル一覧", channelsError));
    return updateCounts();
  }
  const src = currentChannelSource();
  if (!src.length) {
    listEl.replaceChildren(emptyState("表示できるチャンネルがありません"));
    return updateCounts();
  }
  const q = filterInput.value.trim().toLowerCase();
  const items = src.filter(c =>
    (!q || (c.name || "").toLowerCase().includes(q)) &&
    (!onlySelectedCh.checked || selectedChannels.has(c.id)));
  listEl.replaceChildren(...(items.length ? items.map(buildChannelRow) : [emptyState("該当するチャンネルがありません")]));
  updateCounts();
}
const visibleChannelIds = () => [...listEl.querySelectorAll("[data-ch]")].map(n => n.dataset.ch);

function buildChannelRow(c) {
  const row = el("div", { class:"item", "data-ch":c.id });
  const cb = el("input", { type:"checkbox", id:`ch-${c.id}`, value:c.id });
  const badge = el("span", { class:"plan-badge" });
  const main = el("label", { class:"item-main", for:`ch-${c.id}` },
    cb,
    el("span", { class:"item-name", text:`# ${c.name}` }),
    c.is_private ? el("span", { class:"tag", text:"Private" }) : null,
    badge);
  const editor = el("div", { class:"mention-editor" });
  row.append(main, editor);

  function refresh() {
    const selected = selectedChannels.has(c.id);
    cb.checked = selected;
    row.classList.toggle("selected", selected);
    editor.hidden = !selected;
    badge.hidden = !selected;
    if (!selected) { row.classList.remove("attention"); return; }
    const s = summarizePlan(planFor(c.id));
    badge.textContent = s.text;
    badge.className = `plan-badge ${s.ok ? "ok" : "warn"}`;
    if (s.ok) row.classList.remove("attention");
  }

  function renderEditor() {
    const plan = planFor(c.id);
    const name = `m-${c.id}`;
    const seg = el("div", { class:"seg small", role:"radiogroup", "aria-label":`#${c.name} のメンション` },
      el("label", {}, el("input", { type:"radio", name, value:"channel", checked: plan.mode === "channel" }), el("span", { text:"@channel" })),
      el("label", {}, el("input", { type:"radio", name, value:"user", checked: plan.mode === "user" }), el("span", { text:"指定ユーザー" })));
    seg.addEventListener("change", (e) => {
      const prev = planFor(c.id);
      perChannelMentions.set(c.id, e.target.value === "channel" ? { mode:"channel" } : { mode:"user", users: prev.users || [] });
      savePlans();
      renderEditor();
      refresh();
      if (e.target.value === "user") editor.querySelector("input[type=search]")?.focus();
    });
    editor.replaceChildren(seg, plan.mode === "user" ? buildMemberPicker(c, () => refresh()) : "");
  }

  cb.addEventListener("change", () => {
    if (cb.checked) { selectedChannels.add(c.id); planFor(c.id); savePlans(); }
    else selectedChannels.delete(c.id);
    saveSelectedChannels();
    if (cb.checked) renderEditor();
    refresh();
    updateCounts();
  });

  if (selectedChannels.has(c.id)) renderEditor();
  refresh();
  return row;
}

// ---------- メンション先ユーザーの選択 ----------
async function fetchChannelMembers(chId) {
  const key = `${getMode()}:${chId}`;
  if (channelMembersCache.has(key)) return channelMembersCache.get(key);

  const params = new URLSearchParams({ channel: chId, mode: getMode() });
  if (getMode() === "user" && personal.teamId) params.set("teamId", personal.teamId);
  const r = await api(`/api/channel-members?${params.toString()}`, {
    headers: getMode() === "user" ? (personal.token ? { "x-user-token": personal.token } : {}) : botHeaders()
  });
  const arr = await robustJsonResponse(r);
  if (!Array.isArray(arr)) throw new Error(arr.error || "load_failed");
  const members = arr.map(m => ({ id:m.id, name: m.name || allUsersMap.get(m.id) || m.id }));
  channelMembersCache.set(key, members);
  return members;
}

function buildMemberPicker(c, onChange) {
  const chips = el("div", { class:"chips" });
  const input = el("input", { type:"search", placeholder:"メンバー名で検索して追加", "aria-label":`#${c.name} のメンション先を検索`, autocomplete:"off" });
  const suggest = el("div", { class:"suggest", role:"listbox" });
  suggest.hidden = true;
  let members = null, options = [], active = -1;

  const currentUsers = () => perChannelMentions.get(c.id)?.users || [];
  function setUsers(users) {
    perChannelMentions.set(c.id, { mode:"user", users });
    savePlans();
    renderChips();
    onChange();
  }
  function renderChips() {
    chips.replaceChildren(...currentUsers().map(u =>
      el("span", { class:"chip" }, u.name || u.id,
        el("button", { type:"button", "aria-label":`${u.name || u.id} を外す`, text:"×",
          onclick: () => { setUsers(currentUsers().filter(x => x.id !== u.id)); input.focus(); } }))));
  }
  function renderSuggest() {
    if (!members) { suggest.replaceChildren(emptyState("メンバーを読み込み中…", true)); suggest.hidden = false; return; }
    const q = input.value.trim().toLowerCase();
    const chosen = new Set(currentUsers().map(u => u.id));
    options = members.filter(m => !chosen.has(m.id) && (!q || (m.name || "").toLowerCase().includes(q))).slice(0, 50);
    active = options.length ? Math.min(Math.max(active, 0), options.length - 1) : -1;
    suggest.replaceChildren(...(options.length
      ? options.map((m, i) => el("div", {
          class:`suggest-item${i === active ? " active" : ""}`, role:"option", "aria-selected": String(i === active),
          onmousedown: (e) => { e.preventDefault(); add(m); }
        }, el("span", { text:m.name }), el("small", { text:m.id })))
      : [emptyState(members.length ? "該当するメンバーがいません" : "メンバーがいません")]));
    suggest.hidden = false;
    suggest.querySelector(".active")?.scrollIntoView({ block:"nearest" });
  }
  function add(m) {
    setUsers([...currentUsers(), { id:m.id, name:m.name }]);
    input.value = "";
    renderSuggest();
  }
  async function open() {
    renderSuggest();
    if (members) return;
    try { members = await fetchChannelMembers(c.id); }
    catch (e) { suggest.replaceChildren(emptyState(`メンバーを取得できませんでした：${errText(e.message)}`)); return; }
    if (document.activeElement === input) renderSuggest();
  }

  input.addEventListener("focus", open);
  input.addEventListener("input", () => { active = 0; renderSuggest(); });
  input.addEventListener("blur", () => { suggest.hidden = true; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!options.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      renderSuggest();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (options[active]) add(options[active]);
    } else if (e.key === "Escape" && !suggest.hidden) {
      e.stopPropagation();
      suggest.hidden = true;
    } else if (e.key === "Backspace" && !input.value && currentUsers().length) {
      setUsers(currentUsers().slice(0, -1));
    }
  });

  renderChips();
  return el("div", { class:"picker" }, chips, input, suggest);
}

filterInput.addEventListener("input", renderChannels);
onlySelectedCh.addEventListener("change", renderChannels);
$("selectAllCh").addEventListener("click", () => {
  visibleChannelIds().forEach(id => { selectedChannels.add(id); planFor(id); });
  savePlans(); saveSelectedChannels(); renderChannels();
});
$("clearCh").addEventListener("click", () => {
  selectedChannels.clear();
  saveSelectedChannels(); renderChannels();
});

// ---------- DM 宛先 ----------
// 個人モードでは個人トークンで取得（権限が無ければサーバー側で Bot にフォールバック）
let usersRequestSeq = 0;
async function loadUsers() {
  const seq = ++usersRequestSeq;
  const useToken = getMode() === "user" && personal.ok;
  usersLoading = true; usersError = "";
  renderUsers();
  let list, error = "";
  try {
    const r = await api(`/api/users?mode=${useToken ? "user" : "bot"}`, {
      headers: { ...botHeaders(), ...(useToken ? { "x-user-token": personal.token } : {}) }
    });
    list = await robustJsonResponse(r);
    if (!Array.isArray(list)) error = list.error || "load_failed";
  } catch {
    error = "network_error";
  }
  if (seq !== usersRequestSeq) return; // 後から出したリクエストを優先
  usersLoading = false;
  if (error) {
    usersError = error; // 原因は一覧内に表示する
  } else {
    allUsers = list;
    allUsersMap = new Map(allUsers.map(u => [u.id, u.name]));
  }
  renderUsers();
}
function renderUsers() {
  if (usersLoading) { usersEl.replaceChildren(emptyState("読み込み中…", true)); return updateCounts(); }
  if (usersError) { usersEl.replaceChildren(loadErrorState("ユーザー一覧", usersError)); return updateCounts(); }
  if (!allUsers.length) { usersEl.replaceChildren(emptyState("表示できるユーザーがいません")); return updateCounts(); }
  const q = userFilter.value.trim().toLowerCase();
  const items = allUsers.filter(u =>
    (!q || (u.name || "").toLowerCase().includes(q)) &&
    (!onlySelectedUsers.checked || selectedUsers.has(u.id)));
  usersEl.replaceChildren(...(items.length ? items.map(u => {
    const cb = el("input", { type:"checkbox", id:`u-${u.id}`, value:u.id, checked: selectedUsers.has(u.id) });
    const row = el("div", { class:`item${selectedUsers.has(u.id) ? " selected" : ""}`, "data-user":u.id },
      el("label", { class:"item-main", for:`u-${u.id}` }, cb, el("span", { class:"item-name", text:u.name })));
    cb.addEventListener("change", () => {
      cb.checked ? selectedUsers.add(u.id) : selectedUsers.delete(u.id);
      row.classList.toggle("selected", cb.checked);
      updateCounts();
    });
    return row;
  }) : [emptyState("該当するユーザーがいません")]));
  updateCounts();
}
userFilter.addEventListener("input", renderUsers);
onlySelectedUsers.addEventListener("change", renderUsers);
$("selectAllUsers").addEventListener("click", () => {
  usersEl.querySelectorAll("[data-user]").forEach(n => selectedUsers.add(n.dataset.user));
  renderUsers();
});
$("clearUsers").addEventListener("click", () => { selectedUsers.clear(); renderUsers(); });

// ---------- 送信者 ----------
async function loadChannelsBot() {
  channelsLoading = true; channelsError = "";
  renderChannels();
  try {
    const r = await api("/api/channels", { headers: botHeaders() });
    const list = await robustJsonResponse(r);
    if (!Array.isArray(list)) throw new Error(list.error);
    allChannels = list;
  } catch (e) {
    channelsError = e.message || "network_error"; // 原因は Bot モードの一覧内に表示する
  } finally {
    channelsLoading = false;
    renderChannels();
  }
}

function applyMode() {
  const user = getMode() === "user";
  userTokenRow.hidden = !user;
  botTokenRow.hidden = user;
  $("autoJoinRow").hidden = user;
  renderChannels();
}
modeRadios.forEach(r => r.addEventListener("change", loadUsers));
modeRadios.forEach(r => r.addEventListener("change", applyMode));

function setBotNote(text, type = "") {
  botVerifyNote.textContent = text;
  botVerifyNote.className = `note ${type}`;
}

// auto: ページ表示時の自動確認（サーバーに Bot トークンが無くてもエラー表示にしない）
async function verifyBot({ auto = false } = {}) {
  const token = botTokenInput.value.trim();
  botChecking = true;
  botVerifyBtn.disabled = true;
  botVerifyBtn.replaceChildren(el("span", { class:"spinner", "aria-hidden":"true" }), "確認中");
  setBotNote("");
  renderChannels();
  let j;
  try {
    const r = await api("/api/bot/verify", {
      method:"POST", headers: token ? { "x-bot-token": token } : {}
    });
    j = await robustJsonResponse(r);
  } catch {
    j = { ok:false, error:"network_error" };
  }
  botChecking = false;
  botVerifyBtn.disabled = false;
  botVerifyBtn.textContent = "確認";
  allChannels = [];
  channelMembersCache.clear();
  if (j.ok) {
    botAuth = { ok:true, bot:j.bot, token, fromServer: !!j.fromServer };
    setBotNote(`✓ Bot「${j.bot.name}」として送信できます${j.fromServer ? "（サーバーに設定されたトークン）" : ""}`, "ok");
    loadChannelsBot();
    loadUsers();
  } else {
    botAuth = { ok:false, bot:null, token:"", fromServer:false };
    if (auto && j.error === "no_token") setBotNote("");
    else if (j.error === "no_token") setBotNote("Bot トークンを入力してください。", "err");
    else setBotNote(`確認できませんでした：${errText(j.error)}`, "err");
    renderChannels();
  }
}
botVerifyBtn.addEventListener("click", () => verifyBot());
botTokenInput.addEventListener("keydown", (e) => { if (e.key === "Enter") verifyBot(); });
botTokenInput.addEventListener("input", () => {
  if (botAuth.ok && botTokenInput.value.trim() !== botAuth.token) {
    botAuth = { ok:false, bot:null, token:"", fromServer:false };
    allChannels = [];
    setBotNote("トークンが変更されました。もう一度「確認」してください。", "err");
    renderChannels();
  }
});

function setVerifyNote(text, type = "") {
  verifyNote.textContent = text;
  verifyNote.className = `note ${type}`;
}

async function verifyToken() {
  const userToken = userTokenInput.value.trim();
  const teamId = teamIdInput.value.trim();
  if (!userToken) { setVerifyNote("トークンを入力してください。", "err"); userTokenInput.focus(); return; }
  verifyBtn.disabled = true;
  verifyBtn.replaceChildren(el("span", { class:"spinner", "aria-hidden":"true" }), "確認中");
  setVerifyNote("");
  try {
    const r = await api("/api/personal/verify", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ userToken, teamId })
    });
    const j = await robustJsonResponse(r);
    if (j.ok) {
      personal = { ok:true, user:j.user, memberChannels:j.memberChannels, publicChannels:j.publicChannels, token:userToken, teamId };
      channelMembersCache.clear();
      loadUsers();
      setVerifyNote(`✓ ${j.user.name}（${j.user.id}）として送信できます。参加中のチャンネル ${j.memberChannels.length}件`, "ok");
      try { localStorage.setItem("teamId", teamId); } catch {}
    } else {
      personal = { ok:false, user:null, memberChannels:[], publicChannels:[], token:"", teamId:"" };
      setVerifyNote(`確認できませんでした：${errText(j.error)}`, "err");
    }
  } catch {
    setVerifyNote(`確認できませんでした：${errText("network_error")}`, "err");
  } finally {
    verifyBtn.disabled = false;
    verifyBtn.textContent = "確認";
    renderChannels();
  }
}
verifyBtn.addEventListener("click", verifyToken);
[userTokenInput, teamIdInput].forEach(i => i.addEventListener("keydown", (e) => { if (e.key === "Enter") verifyToken(); }));
userTokenInput.addEventListener("input", () => {
  if (personal.ok && userTokenInput.value.trim() !== personal.token) {
    personal = { ok:false, user:null, memberChannels:[], publicChannels:[], token:"", teamId:"" };
    setVerifyNote("トークンが変更されました。もう一度「確認」してください。", "err");
    renderChannels();
  }
});

// ---------- 本文 ----------
messageEl.addEventListener("input", () => {
  const n = messageEl.value.length;
  $("messageCount").textContent = `${n.toLocaleString()} / ${MAX_TEXT_LEN.toLocaleString()}`;
  $("messageCount").style.color = n > MAX_TEXT_LEN ? "var(--danger)" : "";
  if (n) { messageEl.classList.remove("invalid"); $("messageError").hidden = true; }
});

// ---------- モーダル ----------
let lastFocus = null;
function openModal(modal, focusEl) {
  lastFocus = document.activeElement;
  modal.hidden = false;
  (focusEl || modal.querySelector("button")).focus();
}
function closeModal(modal) {
  if (busy) return;
  modal.hidden = true;
  lastFocus?.focus?.();
}
[confirmModal, undoModal, helpModal].forEach(m => {
  m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) closeModal(m); });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = [confirmModal, undoModal, helpModal].find(m => !m.hidden);
  if (open) closeModal(open);
});

// ---------- 使い方（スライド） ----------
const slides = [...$("helpSlides").querySelectorAll(".slide")];
const helpPrev = $("helpPrev"), helpNext = $("helpNext");
const dots = slides.map((s, i) => {
  const b = el("button", { type:"button", "aria-label":`${i + 1}ページ目：${s.querySelector("h3").lastChild.textContent.trim()}` });
  b.addEventListener("click", () => showSlide(i));
  return b;
});
$("helpDots").replaceChildren(...dots);
let slideIndex = 0;

function showSlide(i) {
  slideIndex = Math.max(0, Math.min(slides.length - 1, i));
  slides.forEach((s, j) => { s.hidden = j !== slideIndex; });
  dots.forEach((d, j) => { if (j === slideIndex) d.setAttribute("aria-current", "step"); else d.removeAttribute("aria-current"); });
  $("helpCount").textContent = `${slideIndex + 1} / ${slides.length}`;
  helpPrev.disabled = slideIndex === 0;
  if (helpPrev.disabled && document.activeElement === helpPrev) helpNext.focus();
  helpNext.textContent = slideIndex === slides.length - 1 ? "はじめる" : "次へ";
  $("helpSlides").scrollTop = 0;
}
function openHelp(i = 0) {
  showSlide(i);
  openModal(helpModal, helpNext);
}
document.querySelectorAll("[data-help]").forEach(b =>
  b.addEventListener("click", () => openHelp(Number(b.dataset.help) || 0)));
helpPrev.addEventListener("click", () => showSlide(slideIndex - 1));
helpNext.addEventListener("click", () => {
  if (slideIndex === slides.length - 1) closeModal(helpModal);
  else showSlide(slideIndex + 1);
});
helpModal.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") showSlide(slideIndex + 1);
  else if (e.key === "ArrowLeft") showSlide(slideIndex - 1);
});
let touchX = null;
helpModal.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive:true });
helpModal.addEventListener("touchend", (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) showSlide(slideIndex + (dx < 0 ? 1 : -1));
});

// ---------- 送信 ----------
function collectPayload() {
  return {
    message: messageEl.value.trim(),
    summary: summaryEl.value,
    channelIds: effectiveChannelIds(),
    userIds: [...selectedUsers],
  };
}

function validate({ message, channelIds, userIds }) {
  if (!message) {
    messageEl.classList.add("invalid"); $("messageError").hidden = false;
    messageEl.focus(); messageEl.scrollIntoView({ block:"center", behavior:"smooth" });
    return false;
  }
  if (message.length > MAX_TEXT_LEN || summaryEl.value.length > MAX_TEXT_LEN) {
    toast(`本文・案件概要は ${MAX_TEXT_LEN.toLocaleString()} 文字以内にしてください。`, "err");
    return false;
  }
  if (!channelIds.length && !userIds.length) {
    const needsAuth = getMode() === "user" ? !personal.ok : !botAuth.ok;
    toast(needsAuth
      ? `先に${getMode() === "user" ? "ユーザー" : "Bot "}トークンを「確認」して、宛先を選択してください。`
      : "宛先を1件以上選択してください。", "err");
    return false;
  }
  const invalid = channelIds.filter(id => !planIsValid(planFor(id)));
  if (invalid.length) {
    // 問題のチャンネルが見えるよう絞り込みを解除して強調
    filterInput.value = ""; onlySelectedCh.checked = false; renderChannels();
    invalid.forEach(id => listEl.querySelector(`[data-ch="${id}"]`)?.classList.add("attention"));
    listEl.querySelector(`[data-ch="${invalid[0]}"]`)?.scrollIntoView({ block:"center", behavior:"smooth" });
    toast(`メンション先が未選択のチャンネルがあります（${invalid.map(id => "#" + channelName(id)).join("、")}）`, "err");
    return false;
  }
  return true;
}

sendBtn.addEventListener("click", () => {
  const p = collectPayload();
  if (!validate(p)) return;

  $("previewSender").textContent = getMode() === "user"
    ? `送信者：${personal.user?.name || ""}（個人として送信）`
    : `送信者：Bot「${botAuth.bot?.name || ""}」`;

  const channelMentionCount = p.channelIds.filter(id => planFor(id).mode === "channel").length;
  $("previewWarn").hidden = channelMentionCount === 0;
  $("previewWarn").textContent = `${channelMentionCount}件のチャンネルで @channel が通知されます。`;

  $("previewChTitle").textContent = `チャンネル（${p.channelIds.length}件）`;
  $("previewChannels").replaceChildren(...(p.channelIds.length ? p.channelIds.map(id => {
    const s = summarizePlan(planFor(id));
    return el("li", {}, el("span", { text:`# ${channelName(id)}` }), el("span", { class:"plan-badge ok", text:s.text }));
  }) : [el("li", { class:"muted", text:"なし" })]));

  $("previewDmTitle").textContent = `DM（${p.userIds.length}件）`;
  $("previewDMs").replaceChildren(...(p.userIds.length
    ? p.userIds.map(id => el("li", { text:userName(id) }))
    : [el("li", { class:"muted", text:"なし" })]));

  $("previewMessage").textContent = p.message;
  $("previewSummaryBlock").hidden = !p.summary.trim();
  $("previewSummary").textContent = p.summary;

  confirmSendBtn.textContent = `${p.channelIds.length + p.userIds.length}件に送信する`;
  openModal(confirmModal, confirmSendBtn);
});

function setBusy(on, button, label) {
  busy = on;
  button.disabled = on;
  sendBtn.disabled = on;
  undoBtn.disabled = on || !lastBroadcast;
  confirmModal.querySelectorAll("[data-close]").forEach(b => b.disabled = on);
  undoModal.querySelectorAll("[data-close]").forEach(b => b.disabled = on);
  if (on) button.replaceChildren(el("span", { class:"spinner", "aria-hidden":"true" }), label);
}

confirmSendBtn.addEventListener("click", async () => {
  const p = collectPayload();
  const total = p.channelIds.length + p.userIds.length;
  const labels = new Map(p.channelIds.map(id => [id, `# ${channelName(id)}`]));
  const body = {
    ...p,
    autoJoinPublic: getMode() === "bot" && $("autoJoin").checked,
    perChannelMentions: Object.fromEntries(p.channelIds.map(id => [id, planFor(id)])),
    mode: getMode()
  };
  if (getMode() === "user" && personal.ok) {
    body.userToken = personal.token; if (personal.teamId) body.teamId = personal.teamId;
  }

  setBusy(true, confirmSendBtn, `送信中…（${total}件・約${Math.ceil(total * 0.4) + 1}秒）`);
  let resp;
  try {
    const r = await api("/api/broadcast", {
      method:"POST", headers:{ "Content-Type":"application/json", ...(getMode() === "bot" ? botHeaders() : {}) },
      body: JSON.stringify(body)
    });
    resp = await robustJsonResponse(r);
  } catch {
    resp = { ok:false, error:"network_error" };
  }
  setBusy(false, confirmSendBtn);
  confirmSendBtn.textContent = `${total}件に送信する`;

  if (!Array.isArray(resp.results)) {
    toast(`送信できませんでした：${errText(resp.error)}`, "err");
    return;
  }
  closeModal(confirmModal);

  const rows = resp.results.map(r => {
    const label = r.dm_to ? `${userName(r.dm_to)}（DM）` : (labels.get(r.channel) || r.channel);
    if (r.ok && r.channel) labels.set(r.channel, label);
    return { label, ok:r.ok, note: r.ok ? "" : errText(r.error) };
  });
  renderResults("送信結果", rows, resp);

  const sent = resp.results.filter(r => r.ok).length;
  if (resp.broadcast_id && sent > 0) {
    lastBroadcast = { id: resp.broadcast_id, count: sent, labels, mode: body.mode };
    undoBtn.disabled = false;
  }
  toast(resp.ok ? `${sent}件に送信しました` : `${sent}件に送信、${resp.results.length - sent}件は失敗しました`, resp.ok ? "" : "err");
});

// ---------- 取り消し ----------
undoBtn.addEventListener("click", () => {
  if (!lastBroadcast) return;
  $("undoText").textContent = `直前に送信した ${lastBroadcast.count}件のメッセージを削除します。`;
  openModal(undoModal, undoModal.querySelector("[data-close]:not(.close)"));
});

confirmUndoBtn.addEventListener("click", async () => {
  setBusy(true, confirmUndoBtn, "取り消し中…");
  let j;
  try {
    const r = await api("/api/broadcast/undo-last", {
      method:"POST",
      headers:{ "Content-Type":"application/json",
        ...(lastBroadcast.mode === "user" ? (personal.token ? { "x-user-token": personal.token } : {}) : botHeaders()) },
      body: JSON.stringify({ broadcastId: lastBroadcast.id })
    });
    j = await robustJsonResponse(r);
  } catch {
    j = { ok:false, error:"network_error" };
  }
  const labels = lastBroadcast.labels;
  if (Array.isArray(j.results)) {
    // 失敗した分はサーバー側に残るので、もう一度取り消せるようにする
    const failed = j.results.filter(r => !r.ok).length;
    lastBroadcast = failed ? { ...lastBroadcast, count: failed } : null;
  }
  setBusy(false, confirmUndoBtn);
  confirmUndoBtn.textContent = "取り消す";

  if (!Array.isArray(j.results)) {
    toast(`取り消せませんでした：${errText(j.error)}`, "err");
    return;
  }
  closeModal(undoModal);
  renderResults("取り消し結果", j.results.map(r => ({
    label: labels.get(r.channel) || r.channel, ok:r.ok, note: r.ok ? "削除しました" : errText(r.error)
  })), j);
  toast(j.ok ? "送信を取り消しました" : "一部の取り消しに失敗しました。「送信を取り消す」で再試行できます", j.ok ? "" : "err");
});

// ---------- 結果表示 ----------
function renderResults(title, rows, raw) {
  const okCount = rows.filter(r => r.ok).length, ngCount = rows.length - okCount;
  $("resultTitle").textContent = title;
  $("resultSummary").replaceChildren(
    el("span", { class:"stat ok", text:`成功 ${okCount}件` }),
    ngCount ? el("span", { class:"stat err", text:`失敗 ${ngCount}件` }) : "");
  // 失敗を先頭に
  const sorted = [...rows].sort((a, b) => Number(a.ok) - Number(b.ok));
  $("resultRows").replaceChildren(...sorted.map(r => el("tr", {},
    el("td", { text:r.label }),
    el("td", { class: r.ok ? "status-ok" : "status-err", text: r.ok ? "✓ 成功" : "✕ 失敗" }),
    el("td", { text:r.note }))));
  out.textContent = JSON.stringify(raw, null, 2);
  $("resultCard").hidden = false;
  $("resultCard").scrollIntoView({ behavior:"smooth", block:"start" });
}

// ---------- init ----------
(function init() {
  loadPlans();
  loadSelectedChannels();
  try {
    localStorage.removeItem("xoxp");
    teamIdInput.value = localStorage.getItem("teamId") || "";
  } catch {}
  applyMode();
  renderUsers();
  verifyBot({ auto:true }); // サーバーに Bot トークンがあればそのまま使える
  loadUsers();
})();
