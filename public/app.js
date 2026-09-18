const telegram = window.Telegram?.WebApp;
telegram?.ready();
telegram?.expand();
const list = document.querySelector('#giveaways');
const template = document.querySelector('#giveaway-template');
const userLabel = document.querySelector('#user-label');
const participation = document.querySelector('#participation');
const status = document.querySelector('#check-status');
const dice = document.querySelector('.dice');

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

const selectedId = getStartParam()?.replace(/^g_/, '') ?? null;
let selectedGiveaway = null;

function render(giveaways) {
  list.replaceChildren();
  if (!giveaways.length) { list.innerHTML = '<p class="empty">Сейчас активных конкурсов нет.</p>'; return; }
  giveaways.forEach((giveaway, index) => {
    const fragment = template.content.cloneNode(true);
    fragment.querySelector('.number').textContent = String(index + 1).padStart(2, '0');
    fragment.querySelector('h2').textContent = giveaway.title;
    fragment.querySelector('.meta').textContent = `${giveaway.participants.length} участников · ${giveaway.winnersCount} победител${giveaway.winnersCount === 1 ? 'ь' : 'я'}`;
    fragment.querySelector('.description').textContent = giveaway.description || 'Условия участия открываются в Telegram.';
    fragment.querySelector('.join').style.backgroundColor = giveaway.miniAppButtonColor || 'var(--accent)';
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
  list.hidden = true;
  participation.hidden = false;
  status.textContent = 'Проверяем условия конкурса';
  document.querySelector('#participate').hidden = true;
  dice.classList.remove('rolling');
  requestAnimationFrame(() => dice.classList.add('rolling'));
  setTimeout(participate, 1150);
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
    status.textContent = result.error || 'Условия не выполнены';
    telegram?.showAlert(result.error || 'Подпишись на все обязательные каналы и повтори проверку.');
    document.querySelector('#participate').hidden = false;
    return;
  }
  status.textContent = result.added ? 'Участие подтверждено!' : 'Ты уже участвуешь в этом конкурсе.';
  telegram?.HapticFeedback?.notificationOccurred('success');
}

document.querySelector('#participate').addEventListener('click', participate);
document.querySelector('#back').addEventListener('click', () => { participation.hidden = true; list.hidden = false; });

async function load() {
  userLabel.textContent = telegram?.initDataUnsafe?.user?.first_name ?? 'Гость Telegram';
  const headers = { 'x-telegram-init-data': telegram?.initData ?? '' };
  const response = selectedId
    ? await fetch(`/api/giveaways/${encodeURIComponent(selectedId)}`)
    : telegram?.initData
      ? await fetch('/api/my-participations', { headers })
      : null;
  if (!response) {
    list.innerHTML = '<p class="empty">Открой Mini App из Telegram, чтобы увидеть свои участия.</p>';
    return;
  }
  const giveaways = await response.json();
  if (!response.ok) {
    list.innerHTML = `<p class="empty">${giveaways.error || `Не удалось загрузить конкурсы (${response.status})`}</p>`;
    return;
  }
  render(Array.isArray(giveaways) ? giveaways : [giveaways]);
  if (!selectedId && !giveaways.length) list.innerHTML = '<p class="empty">Ты пока не участвуешь ни в одном конкурсе.</p>';
  if (selectedId) {
    const giveaway = giveaways.find((item) => item.id === selectedId);
    if (giveaway) openParticipation(giveaway);
  }
}

document.querySelector('#refresh').addEventListener('click', load);
load().catch((error) => {
  list.innerHTML = `<p class="empty">Не удалось загрузить конкурсы.<br><small>${error.message || 'Проверьте подключение к серверу.'}</small></p>`;
});