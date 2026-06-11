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
  pendingFiles: [],
  pendingObjectUrls: [],
  panelUsers: [],
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
  uploadDialog: $('#uploadDialog'), uploadPreviewList: $('#uploadPreviewList'), uploadCaptionInput: $('#uploadCaptionInput'), uploadAddBtn: $('#uploadAddBtn'), uploadSendBtn: $('#uploadSendBtn'),
  mediaViewer: $('#mediaViewer'), mediaViewerBody: $('#mediaViewerBody'), mediaViewerClose: $('#mediaViewerClose'),
};

const PERMISSION_DEFS = [
  { key: 'chats_read', label: 'Просмотр чатов', hint: 'Видит список чатов и сообщения' },
  { key: 'messages_send', label: 'Отправка сообщений', hint: 'Может писать в чаты от панели' },
  { key: 'files_send', label: 'Отправка файлов', hint: 'Может прикреплять и отправлять файлы' },
  { key: 'moderation', label: 'Модерация', hint: 'Mute, unmute, ban и unban участников' },
  { key: 'settings', label: 'Настройки', hint: 'Видит и меняет настройки чатов' },
  { key: 'users', label: 'Пользователи', hint: 'Создаёт пользователей и меняет права' },
  { key: 'logs', label: 'Логи', hint: 'Просматривает журнал действий' },
];


function icon(name, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

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

function formatBytes(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
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
    const error = new Error(detail || `HTTP ${res.status}`);
    error.status = res.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function normalizeArray(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const preferred = [...keys, 'items', 'data', 'results', 'users', 'logs', 'chats', 'messages', 'members'];
  for (const key of preferred) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = normalizeArray(value, keys);
      if (nested.length) return nested;
    }
  }
  return Object.values(payload).filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function avatarHtml({ src, name, className = '' }) {
  const bg = colorFor(name);
  const safeName = escapeHtml(name || '?');
  return `<div class="avatar ${className}" style="background:${bg}" title="${safeName}">${src ? `<img src="${src}" alt="${safeName}" onerror="this.remove()">` : initials(name)}</div>`;
}

function getRawContentType(msg = {}) {
  return String(msg.content_type || msg.media_type || msg.type || msg.kind || '').toLowerCase();
}

function contentTypeOf(msg = {}) {
  const type = getRawContentType(msg);
  const mime = String(msg.mime_type || msg.mime || '').toLowerCase();
  const name = String(msg.file_name || msg.name || '').toLowerCase();
  if (!msg.file_id && !msg.file_url && !msg.url && !type) return msg.text ? 'text' : 'service';
  if (['text', 'message'].includes(type)) return 'text';
  if (['photo', 'image', 'animation', 'sticker'].includes(type) || mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return type === 'sticker' ? 'sticker' : type === 'animation' ? 'animation' : 'photo';
  if (['video', 'video_note'].includes(type) || mime.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(name)) return type === 'video_note' ? 'video_note' : 'video';
  if (['audio', 'voice'].includes(type) || mime.startsWith('audio/') || /\.(mp3|ogg|oga|wav|m4a|aac|flac)$/i.test(name)) return type === 'voice' ? 'voice' : 'audio';
  if (['document', 'file'].includes(type) || msg.file_id || msg.file_url || msg.url) return 'document';
  if (['poll', 'quiz', 'location', 'venue', 'contact', 'dice', 'game', 'invoice', 'paid_media', 'story', 'service'].includes(type)) return type;
  return type || 'unknown';
}

function contentMeta(type) {
  const meta = {
    text: ['file', 'Текст'], photo: ['image', 'Фото'], image: ['image', 'Фото'], animation: ['image', 'Анимация'], sticker: ['image', 'Стикер'],
    video: ['video', 'Видео'], video_note: ['video', 'Видеосообщение'], audio: ['mic', 'Аудио'], voice: ['mic', 'Голосовое'], document: ['file', 'Документ'], file: ['file', 'Файл'],
    poll: ['logs', 'Опрос'], quiz: ['logs', 'Викторина'], location: ['file', 'Геопозиция'], venue: ['file', 'Место'], contact: ['users', 'Контакт'],
    dice: ['file', 'Кубик'], game: ['play', 'Игра'], invoice: ['file', 'Счёт'], paid_media: ['image', 'Платное медиа'], story: ['image', 'История'], service: ['logs', 'Сервисное'], unknown: ['file', 'Контент'],
  }[type] || ['file', type || 'Контент'];
  return { icon: meta[0], label: meta[1] };
}

function deriveUserStatus(user = {}) {
  const userId = String(user.user_id ?? user.id ?? '');
  const raw = String(user.status || user.member_status || user.chat_status || user.role || '').toLowerCase();
  if (state.bannedLocally.has(userId) || user.is_banned || user.banned || ['kicked', 'left', 'banned'].includes(raw)) return { key: 'banned', label: 'Забанен', icon: 'ban' };
  if (state.mutedLocally.has(userId) || user.is_muted || user.muted || user.can_send_messages === false || raw === 'restricted') return { key: 'muted', label: 'Замучен', icon: 'mic' };
  if (user.is_owner || raw === 'creator' || raw === 'owner') return { key: 'owner', label: 'Владелец', icon: 'shield' };
  if (user.is_admin || raw === 'administrator' || raw === 'admin') return { key: 'admin', label: 'Админ', icon: 'shield' };
  if (user.is_bot) return { key: 'bot', label: 'Бот', icon: 'check' };
  if (user.is_online || raw === 'online') return { key: 'online', label: 'Онлайн', icon: 'check' };
  if (user.last_seen || user.last_activity || user.date) return { key: 'seen', label: `Был ${formatDate(user.last_seen || user.last_activity || user.date)}`, icon: 'check' };
  return { key: 'member', label: 'Участник', icon: 'check' };
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
    state.chats = normalizeArray(await api('/api/chats'), ['chats']);
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
    const lastType = contentTypeOf(chat.last_message || {});
    const typeLabel = contentMeta(lastType).label;
    const preview = escapeHtml(chat.last_message?.text || chat.last_message?.file_name || `${typeLabel} · ${chat.message_count || 0} сообщений`);
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
    state.messages = normalizeArray(await api(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/messages`), ['messages']);
    renderMessages(true);
  } catch (err) {
    els.messages.innerHTML = `<div class="day-sep" style="color:var(--red)">${escapeHtml(err.message)}</div>`;
  }
}

async function loadMembers() {
  if (!state.currentChat) return;
  try {
    state.members = normalizeArray(await api(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/members`), ['members']);
    state.memberById = new Map(state.members.map((m) => [String(m.user_id ?? m.id), m]));
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
    const userId = m.user_id ?? m.id;
    const name = m.user_name || m.name || m.full_name || m.username || userId;
    const username = m.username ? `@${m.username}` : `ID ${userId}`;
    const status = deriveUserStatus({ ...m, user_id: userId });
    return `<button class="member-item" data-user-id="${escapeHtml(userId)}">
      ${avatarHtml({ src: `/api/photo/user/${encodeURIComponent(userId)}`, name, className: 'avatar--sm' })}
      <div><div class="member-name">${escapeHtml(name)}</div><div class="member-user">${escapeHtml(username)}</div></div>
      <div class="member-actions"><span class="user-status user-status--${status.key}" title="${escapeHtml(status.label)}">${icon(status.icon)}</span><span>${m.message_count || 0}</span></div>
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
  const name = msg.user_name || msg.name || msg.username || msg.user_id || 'Unknown';
  const username = msg.username ? `@${msg.username}` : '';
  const own = msg.is_bot || msg.is_own ? 'own' : '';
  const type = contentTypeOf(msg);
  const meta = contentMeta(type);
  const text = msg.text || msg.caption ? linkify(escapeHtml(msg.text || msg.caption)) : '';
  const reply = msg.reply_to ? `<div class="reply-chip">Ответ на сообщение #${escapeHtml(msg.reply_to)}</div>` : '';
  const media = mediaHtml(msg, type);
  return `<article class="message-row ${own}" data-message-id="${escapeHtml(msg.message_id || '')}" data-user-id="${escapeHtml(msg.user_id || '')}" data-content-type="${escapeHtml(type)}">
    ${avatarHtml({ src: msg.user_id ? `/api/photo/user/${encodeURIComponent(msg.user_id)}` : '', name, className: 'avatar--sm' })}
    <div class="bubble">
      <div class="message-meta"><span class="content-badge">${icon(meta.icon)}${escapeHtml(meta.label)}</span><span class="message-name">${escapeHtml(name)}</span>${username ? `<span class="message-username">${escapeHtml(username)}</span>` : ''}</div>
      ${reply}${text ? `<div class="message-text">${text}</div>` : ''}${media}
      <div class="message-foot"><button class="reply-action" data-reply="${escapeHtml(msg.message_id || '')}">Ответить</button><span>${formatTime(msg.date)}</span></div>
    </div>
  </article>`;
}

function linkify(html) {
  return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function mediaUrl(msg) {
  if (msg.file_url || msg.url) return msg.file_url || msg.url;
  return msg.file_id ? `/api/file/${encodeURIComponent(msg.file_id)}` : '';
}

function mediaHtml(msg, type = contentTypeOf(msg)) {
  const url = mediaUrl(msg);
  const name = msg.file_name || msg.name || type || 'file';
  const safeName = escapeHtml(name);
  if (!url) {
    if (type !== 'text') {
      const meta = contentMeta(type);
      return `<div class="media-box doc-card doc-card--inline"><div class="doc-ico">${icon(meta.icon)}</div><div><div class="doc-name">${safeName}</div><div class="doc-sub">${escapeHtml(meta.label)} без file_id/file_url</div></div></div>`;
    }
    return '';
  }
  if (['photo', 'image', 'animation', 'sticker'].includes(type)) {
    return `<button class="media-box image-card" data-viewer="image" data-src="${escapeHtml(url)}" data-name="${safeName}"><img src="${escapeHtml(url)}" alt="${safeName}" loading="lazy"><span class="media-open">Открыть</span></button>`;
  }
  if (['video', 'video_note'].includes(type)) {
    return `<div class="media-box custom-video" data-video-src="${escapeHtml(url)}"><video src="${escapeHtml(url)}" preload="metadata" playsinline></video><div class="video-controls"><button class="video-play" type="button">${icon('play')}</button><input class="video-progress" type="range" min="0" max="1000" value="0"><span class="video-time">00:00</span><button class="video-full" type="button">${icon('video')}</button></div></div>`;
  }
  if (['audio', 'voice'].includes(type)) {
    return `<div class="media-box audio-player" data-audio="${escapeHtml(url)}"><button class="play-btn" type="button">${icon('play')}</button><div class="track"><span></span></div><small>00:00</small></div>`;
  }
  const meta = contentMeta(type);
  return `<div class="media-box"><a class="doc-card" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><div class="doc-ico">${icon(meta.icon)}</div><div><div class="doc-name">${safeName}</div><div class="doc-sub">${escapeHtml(meta.label)} · открыть</div></div></a></div>`;
}

function openStream() {
  if (!state.currentChat) return;
  state.eventSource = new EventSource(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/stream`, { withCredentials: true });
  state.eventSource.onmessage = (event) => {
    try {
      const next = normalizeArray(JSON.parse(event.data), ['messages']);
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
  els.replyText.textContent = `#${state.replyTo.message_id}: ${state.replyTo.text || state.replyTo.file_name || contentMeta(contentTypeOf(state.replyTo)).label}`;
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

function clearUploadObjects() {
  for (const url of state.pendingObjectUrls) URL.revokeObjectURL(url);
  state.pendingObjectUrls = [];
}

function setPendingFiles(files, append = false) {
  if (!append) state.pendingFiles = [];
  state.pendingFiles.push(...files);
  if (!state.pendingFiles.length) return;
  els.uploadCaptionInput.value = els.messageInput.value.trim();
  renderUploadPreview();
  if (!els.uploadDialog.open) els.uploadDialog.showModal();
}

function fileIconName(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'mic';
  return 'file';
}

function renderUploadPreview() {
  clearUploadObjects();
  els.uploadPreviewList.innerHTML = state.pendingFiles.map((file, index) => {
    let thumb = `<div class="upload-file-icon">${icon(fileIconName(file))}</div>`;
    if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
      const objectUrl = URL.createObjectURL(file);
      state.pendingObjectUrls.push(objectUrl);
      thumb = file.type.startsWith('image/') ? `<img class="upload-thumb" src="${objectUrl}" alt="">` : `<video class="upload-thumb" src="${objectUrl}" muted></video>`;
    }
    return `<div class="upload-preview-item" data-file-index="${index}">${thumb}<div class="upload-file-info"><strong>${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div><button type="button" class="icon-btn upload-remove" title="Убрать файл">${icon('close')}</button></div>`;
  }).join('');
}

async function sendPendingFiles() {
  if (!state.currentChat || !state.pendingFiles.length) return;
  els.uploadSendBtn.disabled = true;
  const caption = els.uploadCaptionInput.value.trim();
  try {
    for (const file of state.pendingFiles) {
      const form = new FormData();
      form.append('file', file);
      if (caption) form.append('caption', caption);
      if (state.replyTo?.message_id) form.append('reply_to', state.replyTo.message_id);
      await api(`/api/chats/${encodeURIComponent(state.currentChat.chat_id)}/send_file`, { method: 'POST', body: form });
    }
    toast(state.pendingFiles.length === 1 ? `Файл отправлен: ${state.pendingFiles[0].name}` : `Файлы отправлены: ${state.pendingFiles.length}`);
    state.pendingFiles = [];
    clearUploadObjects();
    els.uploadDialog.close();
    els.messageInput.value = '';
    state.replyTo = null;
    renderReply();
    await loadMessages();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    els.uploadSendBtn.disabled = false;
  }
}

function openProfile(userId) {
  const m = state.memberById.get(String(userId)) || state.messages.find((msg) => String(msg.user_id) === String(userId));
  if (!m) return;
  const actualId = m.user_id ?? m.id;
  const name = m.user_name || m.name || m.full_name || m.username || actualId;
  const username = m.username ? `@${m.username}` : 'username не найден';
  const status = deriveUserStatus({ ...m, user_id: actualId });
  els.profileAvatar.innerHTML = `<img src="/api/photo/user/${encodeURIComponent(actualId)}" alt="">`;
  els.profileAvatar.style.background = colorFor(name);
  els.profileName.textContent = name;
  els.profileUsername.textContent = username;
  els.profileUserId.textContent = actualId;
  els.profileCount.textContent = m.message_count ?? state.messages.filter((msg) => String(msg.user_id) === String(actualId)).length;
  els.profileLastSeen.textContent = formatDate(m.last_seen || m.last_activity || m.date);
  els.profileStatus.innerHTML = `<span class="profile-status user-status--${status.key}">${icon(status.icon)}${escapeHtml(status.label)}</span>`;
  els.profileDialog.dataset.userId = actualId;
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

function getUserId(user = {}) {
  return user.id ?? user.user_id ?? user.login ?? user.username ?? '';
}

function isDefaultPanelUser(user = {}) {
  return Boolean(user.is_default || user.is_owner || user.is_superuser || user.role === 'default' || user.role === 'owner');
}

function canManagePanelUsers() {
  return !state.me || isDefaultPanelUser(state.me) || permissionsOf(state.me).includes('users');
}

function permissionsOf(user = {}) {
  if (Array.isArray(user.permissions)) return user.permissions.map(String);
  if (Array.isArray(user.rights)) return user.rights.map(String);
  const source = user.permissions || user.rights || user.scopes || {};
  if (typeof source === 'string') return source.split(/[\s,]+/).filter(Boolean);
  if (source && typeof source === 'object') return Object.entries(source).filter(([, value]) => Boolean(value)).map(([key]) => key);
  return [];
}

function permissionPayloadFromForm(form) {
  const permissions = {};
  for (const def of PERMISSION_DEFS) {
    permissions[def.key] = Boolean(form.elements[`perm_${def.key}`]?.checked);
  }
  return permissions;
}

function permissionBadges(user = {}) {
  const permissions = permissionsOf(user);
  if (isDefaultPanelUser(user)) return '<span class="rights-badge rights-badge--owner">Все права</span>';
  if (!permissions.length) return '<span class="rights-badge rights-badge--empty">Права не заданы</span>';
  return permissions.map((key) => {
    const def = PERMISSION_DEFS.find((item) => item.key === key);
    return `<span class="rights-badge">${escapeHtml(def?.label || key)}</span>`;
  }).join('');
}

function permissionsFields(user = {}) {
  const selected = new Set(permissionsOf(user));
  const disabled = isDefaultPanelUser(user) ? 'disabled' : '';
  return `<div class="rights-grid">${PERMISSION_DEFS.map((def) => `<label class="right-toggle" title="${escapeHtml(def.hint)}"><input type="checkbox" name="perm_${escapeHtml(def.key)}" ${selected.has(def.key) || isDefaultPanelUser(user) ? 'checked' : ''} ${disabled}><span><strong>${escapeHtml(def.label)}</strong><small>${escapeHtml(def.hint)}</small></span></label>`).join('')}</div>`;
}

function userFormHtml(user = null) {
  const editing = Boolean(user);
  const defaultUser = user && isDefaultPanelUser(user);
  const title = editing ? `Редактирование: ${escapeHtml(user.login || user.username || user.name || getUserId(user))}` : 'Создать пользователя';
  return `<form id="panelUserForm" class="user-form" data-mode="${editing ? 'edit' : 'create'}" data-user-id="${escapeHtml(editing ? getUserId(user) : '')}">
    <div class="user-form-head"><h3>${title}</h3><button type="button" class="soft-btn" data-users-cancel>Отмена</button></div>
    ${defaultUser ? '<div class="hint-box">Главный пользователь всегда имеет все права. Их нельзя отключить из панели.</div>' : ''}
    <div class="form-grid">
      <label><span>Логин</span><input name="login" value="${escapeHtml(user?.login || user?.username || '')}" autocomplete="username" ${editing ? 'readonly' : 'required'}></label>
      <label><span>Имя</span><input name="name" value="${escapeHtml(user?.name || user?.full_name || '')}" autocomplete="name"></label>
      <label><span>${editing ? 'Новый пароль' : 'Пароль'}</span><input name="password" type="password" autocomplete="new-password" ${editing ? 'placeholder="Оставь пустым, чтобы не менять"' : 'required'}></label>
    </div>
    <h4>Права доступа</h4>
    ${permissionsFields(user || {})}
    <div class="user-form-actions"><button class="primary-btn" type="submit">${editing ? 'Сохранить' : 'Создать'}</button></div>
  </form>`;
}

function renderUsersPanel(formHtml = '') {
  const canManage = canManagePanelUsers();
  const usersHtml = state.panelUsers.map((u) => {
    const defaultUser = isDefaultPanelUser(u);
    return `<div class="user-card" data-user-id="${escapeHtml(getUserId(u))}">
      <div class="user-card-main">
        <strong>${escapeHtml(u.name || u.login || u.username || getUserId(u))}</strong>
        <span>${escapeHtml(u.login || u.username || '')}${defaultUser ? ' · главный' : ''} · ${escapeHtml(formatDate(u.created_at || u.created || u.ts))}</span>
        <div class="rights-badges">${permissionBadges(u)}</div>
      </div>
      ${canManage ? `<button type="button" class="soft-btn" data-edit-user="${escapeHtml(getUserId(u))}">Права</button>` : ''}
    </div>`;
  }).join('') || '<div class="member-user">Пользователей нет</div>';
  els.panelContent.innerHTML = `<div class="users-panel">
    <div class="panel-toolbar">
      <p>${canManage ? 'Главный пользователь может создавать аккаунты и менять права доступа.' : 'У вас нет права управлять пользователями.'}</p>
      ${canManage ? '<button type="button" class="primary-btn" data-create-user>Создать пользователя</button>' : ''}
    </div>
    <div id="userFormMount">${formHtml}</div>
    <div class="users-list">${usersHtml}</div>
  </div>`;
}

async function loadPanelUsers() {
  state.panelUsers = normalizeArray(await api('/api/auth/users'), ['users']);
  renderUsersPanel();
}

async function savePanelUser(form) {
  const mode = form.dataset.mode;
  const userId = form.dataset.userId;
  const permissions = permissionPayloadFromForm(form);
  const payload = {
    login: form.elements.login.value.trim(),
    name: form.elements.name.value.trim(),
    permissions,
    rights: permissions,
  };
  const password = form.elements.password.value;
  if (password) payload.password = password;
  if (mode !== 'edit') {
    await api('/api/auth/users', { method: 'POST', body: JSON.stringify(payload) });
    return;
  }

  const encodedId = encodeURIComponent(userId);
  try {
    await api(`/api/auth/users/${encodedId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  } catch (err) {
    if (![404, 405].includes(err.status)) throw err;
    try {
      await api(`/api/auth/users/${encodedId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } catch (fallbackErr) {
      if (![404, 405].includes(fallbackErr.status)) throw fallbackErr;
      await api(`/api/auth/users/${encodedId}/permissions`, { method: 'POST', body: JSON.stringify({ permissions, rights: permissions }) });
    }
  }
}

async function showUsersPanel() {
  els.panelTitle.textContent = 'Пользователи панели';
  els.panelContent.innerHTML = 'Загрузка...';
  els.panelDialog.showModal();
  try {
    await loadPanelUsers();
  } catch (err) { els.panelContent.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`; }
}

async function showLogsPanel() {
  els.panelTitle.textContent = 'Логи действий';
  els.panelContent.innerHTML = 'Загрузка...';
  els.panelDialog.showModal();
  try {
    const logs = normalizeArray(await api('/api/admin/logs?limit=120'), ['logs']);
    els.panelContent.innerHTML = logs.map((l) => `<div class="log-row"><strong>${escapeHtml(l.action)}</strong><span>${escapeHtml(l.name || l.login || '')} · ${escapeHtml(l.method || '')} ${escapeHtml(l.path || '')}</span><small>${escapeHtml(formatDate(l.ts || l.created_at))} ${escapeHtml(formatTime(l.ts || l.created_at))} · ${escapeHtml(JSON.stringify(l.details || {}))}</small></div>`).join('') || 'Логи пусты';
  } catch (err) { els.panelContent.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`; }
}

function openMediaViewer(type, src, name = '') {
  const safeSrc = escapeHtml(src);
  const safeName = escapeHtml(name || 'media');
  els.mediaViewerBody.innerHTML = type === 'video'
    ? `<div class="viewer-video custom-video" data-video-src="${safeSrc}"><video src="${safeSrc}" preload="metadata" playsinline></video><div class="video-controls"><button class="video-play" type="button">${icon('play')}</button><input class="video-progress" type="range" min="0" max="1000" value="0"><span class="video-time">00:00</span><button class="video-full" type="button">${icon('video')}</button></div></div>`
    : `<img class="viewer-image" src="${safeSrc}" alt="${safeName}">`;
  els.mediaViewer.showModal();
}

function closeMediaViewer() {
  $$('video', els.mediaViewerBody).forEach((video) => video.pause());
  els.mediaViewer.close();
  els.mediaViewerBody.innerHTML = '';
}

function formatMediaTime(seconds = 0) {
  const safe = Number.isFinite(seconds) ? seconds : 0;
  return new Date(safe * 1000).toISOString().slice(14, 19);
}

function toggleVideo(box) {
  const video = $('video', box);
  const button = $('.video-play', box);
  if (!video) return;
  if (video.paused) {
    video.play();
    button.innerHTML = icon('pause');
  } else {
    video.pause();
    button.innerHTML = icon('play');
  }
}

function syncVideoControls(box) {
  const video = $('video', box);
  const progress = $('.video-progress', box);
  const time = $('.video-time', box);
  const play = $('.video-play', box);
  if (!video || !progress || !time || !play) return;
  const percent = video.duration ? (video.currentTime / video.duration) * 1000 : 0;
  progress.value = String(percent);
  time.textContent = `${formatMediaTime(video.currentTime)}${video.duration ? ` / ${formatMediaTime(video.duration)}` : ''}`;
  play.innerHTML = video.paused ? icon('play') : icon('pause');
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
    const image = event.target.closest('[data-viewer="image"]');
    const videoBox = event.target.closest('.custom-video');
    const profile = event.target.closest('.message-row');
    const reply = event.target.closest('[data-reply]');
    if (image) {
      openMediaViewer('image', image.dataset.src, image.dataset.name);
      return;
    }
    if (videoBox && event.target.closest('.video-play')) { toggleVideo(videoBox); return; }
    if (videoBox && event.target.closest('.video-full')) { openMediaViewer('video', videoBox.dataset.videoSrc, 'video'); return; }
    if (reply) {
      const id = reply.dataset.reply;
      state.replyTo = state.messages.find((m) => String(m.message_id) === String(id));
      renderReply();
      els.messageInput.focus();
      return;
    }
    if (profile && event.target.closest('.avatar')) openProfile(profile.dataset.userId);
  });
  els.messages.addEventListener('input', (event) => {
    const progress = event.target.closest('.video-progress');
    if (!progress) return;
    const box = progress.closest('.custom-video');
    const video = $('video', box);
    if (video?.duration) video.currentTime = (Number(progress.value) / 1000) * video.duration;
  });
  els.messages.addEventListener('timeupdate', (event) => {
    const box = event.target.closest('.custom-video');
    if (box) syncVideoControls(box);
  }, true);
  els.messages.addEventListener('ended', (event) => {
    const box = event.target.closest('.custom-video');
    if (box) syncVideoControls(box);
  }, true);

  els.sendBtn.addEventListener('click', sendText);
  els.messageInput.addEventListener('input', autoGrow);
  els.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendText(); }
  });
  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => { setPendingFiles([...els.fileInput.files], els.uploadDialog.open); els.fileInput.value = ''; });
  els.cancelReplyBtn.addEventListener('click', () => { state.replyTo = null; renderReply(); });

  els.uploadAddBtn.addEventListener('click', () => els.fileInput.click());
  els.uploadSendBtn.addEventListener('click', sendPendingFiles);
  els.uploadDialog.addEventListener('close', () => { if (els.uploadDialog.returnValue === 'cancel') { state.pendingFiles = []; clearUploadObjects(); } });
  els.uploadPreviewList.addEventListener('click', (event) => {
    const btn = event.target.closest('.upload-remove');
    if (!btn) return;
    const item = btn.closest('.upload-preview-item');
    state.pendingFiles.splice(Number(item.dataset.fileIndex), 1);
    if (state.pendingFiles.length) renderUploadPreview(); else els.uploadDialog.close('cancel');
  });

  els.mobileMenuOpen.addEventListener('click', () => els.leftPane.classList.add('open'));
  els.mobileMenuClose.addEventListener('click', () => els.leftPane.classList.remove('open'));
  els.toggleMembersBtn.addEventListener('click', () => els.rightPane.classList.add('open'));
  els.closeMembersBtn.addEventListener('click', () => els.rightPane.classList.remove('open'));
  els.refreshBtn.addEventListener('click', async () => { await loadChats(); if (state.currentChat) await selectChat(state.currentChat.chat_id); });
  els.logoutBtn.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => null); location.reload(); });
  els.navUsersBtn.addEventListener('click', showUsersPanel);
  els.navLogsBtn.addEventListener('click', showLogsPanel);
  els.panelContent.addEventListener('click', (event) => {
    const createBtn = event.target.closest('[data-create-user]');
    const editBtn = event.target.closest('[data-edit-user]');
    const cancelBtn = event.target.closest('[data-users-cancel]');
    if (createBtn) { renderUsersPanel(userFormHtml()); return; }
    if (editBtn) {
      const user = state.panelUsers.find((item) => String(getUserId(item)) === String(editBtn.dataset.editUser));
      if (user) renderUsersPanel(userFormHtml(user));
      return;
    }
    if (cancelBtn) renderUsersPanel();
  });
  els.panelContent.addEventListener('submit', async (event) => {
    const form = event.target.closest('#panelUserForm');
    if (!form) return;
    event.preventDefault();
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      await savePanelUser(form);
      toast(form.dataset.mode === 'edit' ? 'Права пользователя обновлены' : 'Пользователь создан');
      await loadPanelUsers();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });

  els.muteBtn.addEventListener('click', () => moderate('mute'));
  els.unmuteBtn.addEventListener('click', () => moderate('unmute'));
  els.banBtn.addEventListener('click', () => moderate('ban'));
  els.unbanBtn.addEventListener('click', () => moderate('unban'));

  els.mediaViewerClose.addEventListener('click', closeMediaViewer);
  els.mediaViewer.addEventListener('click', (event) => { if (event.target === els.mediaViewer) closeMediaViewer(); });
  els.mediaViewer.addEventListener('click', (event) => {
    const videoBox = event.target.closest('.custom-video');
    if (videoBox && event.target.closest('.video-play')) toggleVideo(videoBox);
    if (videoBox && event.target.closest('.video-full')) $('video', videoBox)?.requestFullscreen?.();
  });
  els.mediaViewer.addEventListener('input', (event) => {
    const progress = event.target.closest('.video-progress');
    if (!progress) return;
    const box = progress.closest('.custom-video');
    const video = $('video', box);
    if (video?.duration) video.currentTime = (Number(progress.value) / 1000) * video.duration;
  });
  els.mediaViewer.addEventListener('timeupdate', (event) => {
    const box = event.target.closest('.custom-video');
    if (box) syncVideoControls(box);
  }, true);

  document.addEventListener('click', (event) => {
    const audioBox = event.target.closest('.audio-player');
    if (!audioBox || !event.target.closest('.play-btn')) return;
    if (!audioBox.audio) {
      audioBox.audio = new Audio(audioBox.dataset.audio);
      audioBox.audio.addEventListener('timeupdate', () => {
        const p = audioBox.audio.duration ? (audioBox.audio.currentTime / audioBox.audio.duration) * 100 : 0;
        $('span', $('.track', audioBox)).style.width = `${p}%`;
        $('small', audioBox).textContent = formatMediaTime(audioBox.audio.currentTime);
      });
      audioBox.audio.addEventListener('ended', () => $('.play-btn', audioBox).innerHTML = icon('play'));
    }
    if (audioBox.audio.paused) { audioBox.audio.play(); $('.play-btn', audioBox).innerHTML = icon('pause'); }
    else { audioBox.audio.pause(); $('.play-btn', audioBox).innerHTML = icon('play'); }
  });
}

bindEvents();
boot();
