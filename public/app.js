const telegram = window.Telegram?.WebApp;
telegram?.ready();
telegram?.expand();
const list = document.querySelector('#giveaways');
const template = document.querySelector('#giveaway-template');
const userLabel = document.querySelector('#user-label');
const participation = document.querySelector('#participation');
const status = document.querySelector('#check-status');
const resultStatus = document.querySelector('#result-status');
const dice = document.querySelector('.dice');
let scrollFrame = null;
let scrollStopTimer = null;

function renderDescription(container, value) {
  const text = String(value || 'Условия участия открываются в Telegram.');
  const pattern = /\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g;
  let cursor = 0;
  let match;

  container.replaceChildren();
  while ((match = pattern.exec(text)) !== null) {
    container.append(document.createTextNode(text.slice(cursor, match.index)));
    const link = document.createElement('a');
    link.href = match[2];
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = match[1];
    container.append(link);
    cursor = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(cursor)));
}

function formatResultDate(value) {
  if (!value) return 'вручную';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short'
  }).format(new Date(value));
}

function updateLight() {
  const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
  const progress = Math.min(window.scrollY / maxScroll, 1);
  const beamX = 78 - progress * 54;
  const beamY = 18 + progress * 68;
  const glassShift = Math.sin(progress * Math.PI * 2) * 18;
  document.documentElement.style.setProperty('--beam-x', `${beamX}%`);
  document.documentElement.style.setProperty('--beam-y', `${beamY}%`);
  document.documentElement.style.setProperty('--glass-shift', `${glassShift}px`);
  document.body.classList.add('is-scrolling');
  clearTimeout(scrollStopTimer);
  scrollStopTimer = setTimeout(() => document.body.classList.remove('is-scrolling'), 140);
  scrollFrame = null;
}

window.addEventListener('scroll', () => {
  if (scrollFrame === null) scrollFrame = requestAnimationFrame(updateLight);
}, { passive: true });

function getStartParam() {
  const urlParams = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const rawInitData = new URLSearchParams(telegram?.initData ?? '');
  return urlParams.get('giveaway')
    ?? urlParams.get('startapp')
    ?? hashParams.get('startapp')
    ?? hashParams.get('tgWebAppStartParam')
    ?? telegram?.initDataUnsafe?.start_param
    ?? rawInitData.get('start_param')
    ?? rawInitData.get('startapp');
}

const selectedId = getStartParam()?.replace(/^g_/, '').replace(/_r_\d+$/, '') ?? null;
let selectedGiveaway = null;

function render(giveaways) {
  list.replaceChildren();
  if (!giveaways.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Сейчас активных конкурсов нет.';
    list.replaceChildren(empty);
    return;
  }
  giveaways.forEach((giveaway, index) => {
    const fragment = template.content.cloneNode(true);
    fragment.querySelector('.number').textContent = String(index + 1).padStart(2, '0');
    fragment.querySelector('h2').textContent = giveaway.title;
    fragment.querySelector('.meta').textContent = `${giveaway.participants.length} участников · ${giveaway.winnersCount} победител${giveaway.winnersCount === 1 ? 'ь' : 'я'}\nИтоги: ${giveaway.status === 'finished' ? 'подведены' : formatResultDate(giveaway.endsAt)}`;
    renderDescription(fragment.querySelector('.description'), giveaway.description);
    if (giveaway.media?.type === 'photo') {
      const image = document.createElement('img');
      image.src = `/api/media/${encodeURIComponent(giveaway.media.fileId)}`;
      image.alt = giveaway.title;
      image.className = 'media';
      fragment.querySelector('.content').prepend(image);
    }
    fragment.querySelector('.join').addEventListener('click', () => openParticipation(giveaway));
    list.append(fragment);
  });
}

function openParticipation(giveaway) {
  selectedGiveaway = giveaway;
  const accent = '#ff1744';
  document.documentElement.style.setProperty('--accent', accent);
  telegram?.MainButton?.setParams({ text: 'УЧАСТВОВАТЬ', color: accent, text_color: '#111111' });
  list.hidden = false;
  participation.hidden = false;
  resultStatus.hidden = true;
  resultStatus.replaceChildren();
  if (giveaway.status === 'finished') {
    showResult(giveaway.viewerResult);
    return;
  }
  status.textContent = 'Проверяем условия конкурса';
  document.querySelector('#participate').hidden = true;
  dice.classList.remove('rolling');
  requestAnimationFrame(() => dice.classList.add('rolling'));
  setTimeout(participate, 1150);
}

function showResult(result) {
  dice.hidden = true;
  document.querySelector('#participate').hidden = true;
  status.hidden = true;
  resultStatus.hidden = false;
  resultStatus.className = `result-status ${result?.won ? 'is-winner' : ''}`;
  if (result?.won) {
    const title = document.createElement('strong');
    title.textContent = 'Ты победил!';
    const place = document.createElement('span');
    place.textContent = `Место в списке: ${result.place}`;
    resultStatus.replaceChildren(title, place);
  } else if (result?.participated) {
    const title = document.createElement('strong');
    title.textContent = 'В этот раз без победы';
    const message = document.createElement('span');
    message.textContent = 'Спасибо за участие. Следи за новыми конкурсами.';
    resultStatus.replaceChildren(title, message);
  } else {
    const title = document.createElement('strong');
    title.textContent = 'Ты не участвовал';
    const message = document.createElement('span');
    message.textContent = 'Этот конкурс уже завершён.';
    resultStatus.replaceChildren(title, message);
  }
}

async function participate() {
  if (!selectedGiveaway) return;
  status.textContent = 'Проверяем подписки…';
  document.querySelector('#participate').hidden = true;
  dice.classList.add('rolling');
  const response = await fetch(`/api/giveaways/${selectedGiveaway.id}/participate`, {
    method: 'POST',
    headers: { 'x-telegram-init-data': telegram?.initData ?? '' }
  });
  const result = await response.json();
  dice.classList.remove('rolling');
  if (!response.ok) {
    const missing = result.missingChannels ?? [];
    status.textContent = result.error || 'Условия не выполнены';
    if (missing.length) {
      const message = document.createElement('span');
      message.textContent = result.error;
      status.replaceChildren(message);
      for (const channel of missing) {
        status.append(document.createElement('br'));
        if (channel.url) {
          const link = document.createElement('a');
          link.href = channel.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = `Подписаться: ${channel.title}`;
          status.append(link);
        } else {
          const detail = document.createElement('span');
          detail.textContent = `${channel.title}: ${channel.error || 'нужен ID канала'}`;
          status.append(detail);
        }
      }
    }
    telegram?.showAlert(result.error || 'Подпишись на все обязательные каналы и повтори проверку.');
    document.querySelector('#participate').hidden = false;
    return;
  }
  status.textContent = result.added ? 'Участие подтверждено!' : 'Ты уже участвуешь в этом конкурсе.';
  telegram?.HapticFeedback?.notificationOccurred('success');
}

document.querySelector('#participate').addEventListener('click', participate);
document.querySelector('#back').addEventListener('click', () => {
  participation.hidden = true;
  list.hidden = false;
  dice.hidden = false;
  status.hidden = false;
  resultStatus.hidden = true;
  window.scrollTo({ top: Math.max(list.offsetTop - 12, 0), behavior: 'smooth' });
});

async function load() {
  userLabel.textContent = telegram?.initDataUnsafe?.user?.first_name ?? 'Гость Telegram';
  const headers = { 'x-telegram-init-data': telegram?.initData ?? '' };
  const response = selectedId
    ? await fetch(`/api/giveaways/${encodeURIComponent(selectedId)}`, { headers })
    : telegram?.initData
      ? await fetch('/api/my-participations', { headers })
      : null;
  if (!response) {
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = 'Открой Mini App из Telegram, чтобы увидеть свои участия.';
    list.replaceChildren(message);
    return;
  }
  const payload = await response.json();
  if (!response.ok) {
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = payload.error || `Не удалось загрузить конкурсы (${response.status})`;
    list.replaceChildren(message);
    return;
  }
  const giveaways = Array.isArray(payload) ? payload : [payload];
  render(giveaways);
  if (!selectedId && !giveaways.length) {
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = 'Ты пока не участвуешь ни в одном конкурсе.';
    list.replaceChildren(message);
  }
  if (selectedId) {
    const giveaway = giveaways.find((item) => item.id === selectedId);
    if (giveaway) openParticipation(giveaway);
  }
}

document.querySelector('#refresh').addEventListener('click', load);
load().catch((error) => {
  const message = document.createElement('p');
  message.className = 'empty';
  message.textContent = `Не удалось загрузить конкурсы. ${error.message || 'Проверьте подключение к серверу.'}`;
  list.replaceChildren(message);
});