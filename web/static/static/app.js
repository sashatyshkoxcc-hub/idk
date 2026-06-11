const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  me: null,
  bot: null,
  chats: [],
  currentChat: null,
  messages: [],
  members: [],
  settings: {},
  replyTo: null,
  eventSource: null,
  memberById: new Map(),
  mutedLocally: new Set(),
  bannedLocally: new Set(),
};

const els = {
  app: $('#app'), loginView: $('#loginView'), dashboardView: $('#dashboardView'), loginForm: $('#loginForm'), loginError: $('#loginError'),
  chatList: $('#chatList'), chatSearch: $('#chatSearch'), activeChatTitle: $('#activeChatTitle'), activeChatMeta: $('#activeChatMeta'), activeChatAvatar: $('#activeChatAvatar'),
  emptyState: $('#emptyState'), messagesWrap: $('#messagesWrap'), messages: $('#messages'), composer: $('#composer'), messageInput: $('#messageInput'),
  sendBtn: $('#sendBtn'), attachBtn: $('#attachBtn'), fileInput: $('#fileInput'), replyPreview: $('#replyPreview'), replyText: $('#replyText'), cancelReplyBtn: $('#cancelReplyBtn'),
  settingsList: $('#settingsList'), membersTitle: $('#membersTitle'), membersList: $('#membersList'), toast: $('#toast'), leftPane: $('#leftPane'), rightPane: $('#rightPane'),
  mobileMenuOpen: $('#mobileMenuOpen'), mobileMenuClose: $('#mobileMenuClose'), toggleMembersBtn: $('#toggleMembersBtn'), closeMembersBtn: $('#closeMembersBtn'),
  refreshBtn: $('#refreshBtn'), logoutBtn: $('#logoutBtn'), navUsersBtn: $('#navUsersBtn'), navLogsBtn: $('#navLogsBtn'),
  profileDialog: $('#profileDialog'), profileAvatar: $('#profileAvatar'), profileName: $('#profileName'), profileUsername: $('#profileUsername'), profileUserId: $('#profileUserId'),
  profileCount: $('#profileCount'), profileLastSeen: $('#profileLastSeen'), profileStatus: $('#profileStatus'), muteBtn: $('#muteBtn'), unmuteBtn: $('#unmuteBtn'), banBtn: $('#banBtn'), unbanBtn: $('#unbanBtn'),
  panelDialog: $('#panelDialog'), panelTitle: $('#panelTitle'), panelContent: $('#panelContent'),
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function initials(name = '?') {
  const clean = String(name || '?').trim();
  return [...clean][0]?.toUpperCase() || '?';
}

function colorFor(value = '?') {
  const colors = ['#5288c1', '#e06d6d', '#6db38a', '#d4a756', '#9b6db3', '#d47b3f', '#5ba8a0', '#4078c0', '#ed8b49'];
  const sum = [...String(value || '?')].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return colors[sum % colors.length];
}

function formatTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function toast(text, type = 'ok') {
  els.toast.textContent = text;
  els.toast.className = `toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  const res = await fetch(path, { credentials: 'include', ...options, headers: { ...headers, ...(options.headers || {}) } });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const detail = typeof data === 'object' && data ? data.detail || data.description : data;
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return data;
}

function avatarHtml({ src, name, className = '' }) {
  const bg = colorFor(name);
  const safeName = escapeHtml(name || '?');
  return `<div class="avatar ${className}" style="background:${bg}" title="${safeName}">${src ? `<img src="${src}" alt="${safeName}" onerror="this.remove()">` : initials(name)}</div>`;
}

async function boot() {
  els.app.classList.remove('app-shell--boot');
  try {
    state.me = await api('/api/auth/me');
    showDashboard();
  } catch {
    showLogin();
  }
}

function showLogin() {
  els.loginView.hidden = false;
  els.dashboardView.hidden = true;
}

async function showDashboard() {
  els.loginView.hidden = true;
  els.dashboardView.hidden = false;
  await Promise.allSettled([loadBotInfo(), loadChats()]);
}

async function loadBotInfo() {
  try { state.bot = await api('/api/bot/info'); } catch { state.bot = null; }
}

async function loadChats() {
  els.chatList.innerHTML = '<div class="chat-preview" style="padding:12px">Загружаю чаты...</div>';
  try {
    state.chats = await api('/api/chats');
    renderChats();
  } catch (err) {
    els.chatList.innerHTML = `<div class="chat-preview" style="padding:12px;color:var(--red)">${escapeHtml(err.message)}</div>`;
  }
}

function renderChats() {
  const q = els.chatSearch.value.trim().toLowerCase();
  const chats = state.chats.filter((chat) => `${chat.title} ${chat.last_message?.text || ''}`.toLowerCase().includes(q));
  if (!chats.length) {
    els.chatList.innerHTML = '<div class="chat-preview" style="padding:12px">Чаты не найдены</div>';
    return;
  }
  els.chatList.innerHTML = chats.map((chat) => {
    const active = state.currentChat?.chat_id === chat.chat_id ? 'active' : '';
    const title = escapeHtml(chat.title || `Chat ${chat.chat_id}`);
    const preview = escapeHtml(chat.last_message?.text || chat.last_message?.file_name || `${chat.message_count || 0} сообщений`);
    return `<button class="chat-item ${active}" data-chat-id="${escapeHtml(chat.chat_id)}">
      ${avatarHtml({ src: `/api/photo/chat/${encodeURIComponent(chat.chat_id)}`, name: chat.title, className: 'avatar--chat' })}
      <div class="chat-main"><div class="chat-name">${title}</div><div class="chat-preview">${preview}</div></div>
      <div class="chat-side"><span class="chat-time">${formatTime(chat.last_date)}</span><span class="chat-count">${chat.message_count || 0}</span></div>
    </button>`;
  }).join('');
}

async function selectChat(chatId) {
  const chat = state.chats.find((item) => String(item.chat_id) === String(chatId));
  if (!chat) return;
  state.currentChat = chat;
  state.replyTo = null;
  renderReply();
  els.emptyState.hidden = true;
  els.messagesWrap.hidden = false;
  els.composer.hidden = false;
  els.activeChatTitle.textContent = chat.title || `Chat ${chat.chat_id}`;
  els.activeChatMeta.textContent = `${chat.message_count || 0} сообщений`;
  els.activeChatAvatar.innerHTML = `<img src="/api/photo/chat/${encodeURIComponent(chat.chat_id)}" alt="">`;
  els.activeChatAvatar.style.background = colorFor(chat.title || chat.chat_id);
  els.leftPane.classList.remove('open');
  renderChats();
  closeStream();
  await Promise.allSettled([loadMessages(), loadMembers(), loadSettings()]);
  openStream();
}

async function loadMessages() {
  if (!state.currentChat) return;
  els.messages.innerHTML = '<div class="day-sep">Загрузка сообщений...</div>';
  try {
    state.messages = await api(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/messages`);
    renderMessages(true);
  } catch (err) {
    els.messages.innerHTML = `<div class="day-sep" style="color:var(--red)">${escapeHtml(err.message)}</div>`;
  }
}

async function loadMembers() {
  if (!state.currentChat) return;
  try {
    state.members = await api(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/members`);
    state.memberById = new Map(state.members.map((m) => [String(m.user_id), m]));
    renderMembers();
  } catch (err) {
    els.membersList.innerHTML = `<div class="member-user">${escapeHtml(err.message)}</div>`;
  }
}

async function loadSettings() {
  if (!state.currentChat) return;
  try {
    state.settings = await api(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/settings`);
    renderSettings();
  } catch (err) {
    els.settingsList.innerHTML = `<div class="member-user">${escapeHtml(err.message)}</div>`;
  }
}

function renderSettings() {
  const labels = { antispam: 'Антиспам', antileak: 'Антислив', antinsfw: 'Защита 18+', anti_raid: 'Антирейд' };
  const entries = Object.entries(state.settings || {});
  els.settingsList.innerHTML = entries.length ? entries.map(([key, val]) => {
    const enabled = Boolean(typeof val === 'object' ? val.enabled : val);
    return `<div class="setting-row"><span>${escapeHtml(labels[key] || key)}</span><span class="badge ${enabled ? 'on' : 'off'}">${enabled ? 'ВКЛ' : 'ВЫКЛ'}</span></div>`;
  }).join('') : '<div class="member-user">Настройки не найдены</div>';
}

function renderMembers() {
  els.membersTitle.textContent = `Участники (${state.members.length})`;
  if (!state.members.length) {
    els.membersList.innerHTML = '<div class="member-user">Список пуст</div>';
    return;
  }
  els.membersList.innerHTML = state.members.map((m) => {
    const name = m.user_name || m.username || m.user_id;
    const username = m.username ? `@${m.username}` : `ID ${m.user_id}`;
    const status = state.bannedLocally.has(String(m.user_id)) ? '⊘' : state.mutedLocally.has(String(m.user_id)) ? '🔇' : '◌';
    return `<button class="member-item" data-user-id="${escapeHtml(m.user_id)}">
      ${avatarHtml({ src: `/api/photo/user/${encodeURIComponent(m.user_id)}`, name, className: 'avatar--sm' })}
      <div><div class="member-name">${escapeHtml(name)}</div><div class="member-user">${escapeHtml(username)}</div></div>
      <div class="member-actions"><span title="status">${status}</span><span>${m.message_count || 0}</span></div>
    </button>`;
  }).join('');
}

function renderMessages(scrollBottom = false) {
  let lastDay = '';
  const chunks = [];
  for (const msg of state.messages) {
    const day = formatDate(msg.date);
    if (day !== lastDay) {
      chunks.push(`<div class="day-sep">${escapeHtml(day)}</div>`);
      lastDay = day;
    }
    chunks.push(messageHtml(msg));
  }
  els.messages.innerHTML = chunks.join('') || '<div class="day-sep">Сообщений нет</div>';
  if (scrollBottom) requestAnimationFrame(() => { els.messagesWrap.scrollTop = els.messagesWrap.scrollHeight; });
}

function messageHtml(msg) {
  const name = msg.user_name || msg.username || msg.user_id || 'Unknown';
  const username = msg.username ? `@${msg.username}` : '';
  const own = msg.is_bot ? 'own' : '';
  const text = msg.text ? linkify(escapeHtml(msg.text)) : '';
  const reply = msg.reply_to ? `<div class="reply-chip">↩ Ответ на сообщение #${escapeHtml(msg.reply_to)}</div>` : '';
  const media = mediaHtml(msg);
  return `<article class="message-row ${own}" data-message-id="${escapeHtml(msg.message_id || '')}" data-user-id="${escapeHtml(msg.user_id || '')}">
    ${avatarHtml({ src: msg.user_id ? `/api/photo/user/${encodeURIComponent(msg.user_id)}` : '', name, className: 'avatar--sm' })}
    <div class="bubble">
      <div class="message-meta"><span class="message-name">${escapeHtml(name)}</span>${username ? `<span class="message-username">${escapeHtml(username)}</span>` : ''}</div>
      ${reply}<div class="message-text">${text}</div>${media}
      <div class="message-foot"><button class="reply-action" data-reply="${escapeHtml(msg.message_id || '')}">↩ Ответить</button><span>${formatTime(msg.date)}</span></div>
    </div>
  </article>`;
}

function linkify(html) {
  return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function mediaHtml(msg) {
  if (!msg.file_id) {
    if (msg.type && msg.type !== 'text') return `<div class="media-box doc-card"><div class="doc-ico">▧</div><div><div class="doc-name">${escapeHtml(msg.file_name || msg.type)}</div><div class="doc-sub">Файл отправлен, но backend не вернул file_id</div></div></div>`;
    return '';
  }
  const url = `/api/file/${encodeURIComponent(msg.file_id)}`;
  const type = String(msg.type || '').toLowerCase();
  const name = msg.file_name || type || 'file';
  if (['photo', 'image', 'animation', 'sticker'].includes(type) || /\.(png|jpe?g|gif|webp)$/i.test(name)) {
    return `<div class="media-box"><img src="${url}" alt="${escapeHtml(name)}" loading="lazy"></div>`;
  }
  if (['video'].includes(type) || /\.(mp4|webm|mov)$/i.test(name)) {
    return `<div class="media-box"><video src="${url}" controls preload="metadata"></video></div>`;
  }
  if (['audio', 'voice'].includes(type) || /\.(mp3|ogg|oga|wav)$/i.test(name)) {
    return `<div class="media-box audio-player" data-audio="${url}"><button class="play-btn">▶</button><div class="track"><span></span></div><small>00:00</small></div>`;
  }
  return `<div class="media-box"><a class="doc-card" href="${url}" target="_blank" rel="noopener noreferrer"><div class="doc-ico">📄</div><div><div class="doc-name">${escapeHtml(name)}</div><div class="doc-sub">Открыть документ</div></div></a></div>`;
}

function openStream() {
  if (!state.currentChat) return;
  state.eventSource = new EventSource(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/stream`, { withCredentials: true });
  state.eventSource.onmessage = (event) => {
    try {
      const next = JSON.parse(event.data);
      const nearBottom = els.messagesWrap.scrollHeight - els.messagesWrap.scrollTop - els.messagesWrap.clientHeight < 160;
      state.messages = next;
      renderMessages(nearBottom);
    } catch (err) { console.warn(err); }
  };
  state.eventSource.onerror = () => console.warn('SSE disconnected');
}

function closeStream() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
}

function renderReply() {
  if (!state.replyTo) {
    els.replyPreview.hidden = true;
    return;
  }
  els.replyPreview.hidden = false;
  els.replyText.textContent = `#${state.replyTo.message_id}: ${state.replyTo.text || state.replyTo.file_name || 'медиа'}`;
}

async function sendText() {
  if (!state.currentChat) return;
  const text = els.messageInput.value.trim();
  if (!text) return;
  els.sendBtn.disabled = true;
  try {
    const payload = { text, reply_to_message_id: state.replyTo?.message_id || null };
    await api(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/send`, { method: 'POST', body: JSON.stringify(payload) });
    els.messageInput.value = '';
    autoGrow();
    state.replyTo = null;
    renderReply();
    toast('Сообщение отправлено');
    await loadMessages();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    els.sendBtn.disabled = false;
  }
}

async function sendFiles(files) {
  if (!state.currentChat || !files.length) return;
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    if (els.messageInput.value.trim()) form.append('caption', els.messageInput.value.trim());
    if (state.replyTo?.message_id) form.append('reply_to', state.replyTo.message_id);
    try {
      await api(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/send_file`, { method: 'POST', body: form });
      toast(`Файл отправлен: ${file.name}`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 'error');
    }
  }
  els.messageInput.value = '';
  state.replyTo = null;
  renderReply();
  await loadMessages();
}

function openProfile(userId) {
  const m = state.memberById.get(String(userId)) || state.messages.find((msg) => String(msg.user_id) === String(userId));
  if (!m) return;
  const name = m.user_name || m.username || m.user_id;
  const username = m.username ? `@${m.username}` : 'username не найден';
  els.profileAvatar.innerHTML = `<img src="/api/photo/user/${encodeURIComponent(m.user_id)}" alt="">`;
  els.profileAvatar.style.background = colorFor(name);
  els.profileName.textContent = name;
  els.profileUsername.textContent = username;
  els.profileUserId.textContent = m.user_id;
  els.profileCount.textContent = m.message_count ?? state.messages.filter((msg) => String(msg.user_id) === String(m.user_id)).length;
  els.profileLastSeen.textContent = formatDate(m.last_seen || m.date);
  els.profileStatus.textContent = state.bannedLocally.has(String(m.user_id)) ? 'Забанен локально' : state.mutedLocally.has(String(m.user_id)) ? 'Замучен локально' : 'Участник';
  els.profileDialog.dataset.userId = m.user_id;
  els.profileDialog.showModal();
}

async function moderate(action) {
  const userId = els.profileDialog.dataset.userId;
  if (!state.currentChat || !userId) return;
  const duration = action === 'mute' ? 1800 : null;
  try {
    await api(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/moderate`, {
      method: 'POST', body: JSON.stringify({ action, user_id: Number(userId), duration }),
    });
    if (action === 'mute') state.mutedLocally.add(String(userId));
    if (action === 'unmute') state.mutedLocally.delete(String(userId));
    if (action === 'ban') state.bannedLocally.add(String(userId));
    if (action === 'unban') state.bannedLocally.delete(String(userId));
    renderMembers();
    toast(`Действие выполнено: ${action}`);
    openProfile(userId);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function showUsersPanel() {
  els.panelTitle.textContent = 'Пользователи панели';
  els.panelContent.innerHTML = 'Загрузка...';
  els.panelDialog.showModal();
  try {
    const users = await api('/api/auth/users');
    els.panelContent.innerHTML = users.map((u) => `<div class="table-row"><strong>${escapeHtml(u.name || u.login)}</strong><span>${escapeHtml(u.login)}${u.is_default ? ' · главный' : ''}</span><small>${escapeHtml(formatDate(u.created_at))}</small></div>`).join('') || 'Пользователей нет';
  } catch (err) { els.panelContent.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`; }
}

async function showLogsPanel() {
  els.panelTitle.textContent = 'Логи действий';
  els.panelContent.innerHTML = 'Загрузка...';
  els.panelDialog.showModal();
  try {
    const logs = await api('/api/admin/logs?limit=120');
    els.panelContent.innerHTML = logs.map((l) => `<div class="log-row"><strong>${escapeHtml(l.action)}</strong><span>${escapeHtml(l.name || l.login)} · ${escapeHtml(l.method || '')} ${escapeHtml(l.path || '')}</span><small>${escapeHtml(formatDate(l.ts))} ${escapeHtml(formatTime(l.ts))} · ${escapeHtml(JSON.stringify(l.details || {}))}</small></div>`).join('') || 'Логи пусты';
  } catch (err) { els.panelContent.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`; }
}

function autoGrow() {
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = `${Math.min(140, els.messageInput.scrollHeight)}px`;
}

function bindEvents() {
  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.loginError.textContent = '';
    try {
      const login = $('#loginInput').value;
      const password = $('#passwordInput').value;
      state.me = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ login, password }) });
      await showDashboard();
    } catch (err) { els.loginError.textContent = err.message; }
  });

  els.chatSearch.addEventListener('input', renderChats);
  els.chatList.addEventListener('click', (event) => {
    const item = event.target.closest('.chat-item');
    if (item) selectChat(item.dataset.chatId);
  });
  els.membersList.addEventListener('click', (event) => {
    const item = event.target.closest('.member-item');
    if (item) openProfile(item.dataset.userId);
  });
  els.messages.addEventListener('click', (event) => {
    const profile = event.target.closest('.message-row');
    const reply = event.target.closest('[data-reply]');
    if (reply) {
      const id = reply.dataset.reply;
      state.replyTo = state.messages.find((m) => String(m.message_id) === String(id));
      renderReply();
      els.messageInput.focus();
      return;
    }
    if (profile && event.target.closest('.avatar')) openProfile(profile.dataset.userId);
  });

  els.sendBtn.addEventListener('click', sendText);
  els.messageInput.addEventListener('input', autoGrow);
  els.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendText(); }
  });
  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => sendFiles([...els.fileInput.files]));
  els.cancelReplyBtn.addEventListener('click', () => { state.replyTo = null; renderReply(); });

  els.mobileMenuOpen.addEventListener('click', () => els.leftPane.classList.add('open'));
  els.mobileMenuClose.addEventListener('click', () => els.leftPane.classList.remove('open'));
  els.toggleMembersBtn.addEventListener('click', () => els.rightPane.classList.add('open'));
  els.closeMembersBtn.addEventListener('click', () => els.rightPane.classList.remove('open'));
  els.refreshBtn.addEventListener('click', async () => { await loadChats(); if (state.currentChat) await selectChat(state.currentChat.chat_id); });
  els.logoutBtn.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => null); location.reload(); });
  els.navUsersBtn.addEventListener('click', showUsersPanel);
  els.navLogsBtn.addEventListener('click', showLogsPanel);

  els.muteBtn.addEventListener('click', () => moderate('mute'));
  els.unmuteBtn.addEventListener('click', () => moderate('unmute'));
  els.banBtn.addEventListener('click', () => moderate('ban'));
  els.unbanBtn.addEventListener('click', () => moderate('unban'));

  document.addEventListener('click', (event) => {
    const audioBox = event.target.closest('.audio-player');
    if (!audioBox || !event.target.closest('.play-btn')) return;
    if (!audioBox.audio) {
      audioBox.audio = new Audio(audioBox.dataset.audio);
      audioBox.audio.addEventListener('timeupdate', () => {
        const p = audioBox.audio.duration ? (audioBox.audio.currentTime / audioBox.audio.duration) * 100 : 0;
        $('span', $('.track', audioBox)).style.width = `${p}%`;
        $('small', audioBox).textContent = new Date(audioBox.audio.currentTime * 1000).toISOString().slice(14, 19);
      });
      audioBox.audio.addEventListener('ended', () => $('.play-btn', audioBox).textContent = '▶');
    }
    if (audioBox.audio.paused) { audioBox.audio.play(); $('.play-btn', audioBox).textContent = 'Ⅱ'; }
    else { audioBox.audio.pause(); $('.play-btn', audioBox).textContent = '▶'; }
  });
}

bindEvents();
boot();
