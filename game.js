// =============================================================
//  Cardinal Connections — Game Logic
// =============================================================

const GROUP_SIZE     = 4;
const MAX_MISTAKES   = 4;
const STORAGE_PREFIX = 'connections_state_';
const LEVEL_EMOJI    = ['🟨', '🟩', '🟦', '🟪'];
const WIN_MESSAGES   = ['Perfect!', 'Great!', 'Solid!', 'Phew!'];
const JUMP_MS        = 110;   // stagger between tile hops on submit

// ---- URL params (used when embedded via iframe) -------------
// ?d=<base64url JSON>  puzzle data: {"g":[[category, w1, w2, w3, w4], ...]}
//                      groups are listed easiest → hardest
// ?p=<number>          puzzle number
function getParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    d:   p.get('d'),
    num: p.get('p') ? parseInt(p.get('p'), 10) : 0,
  };
}

// Unicode-safe base64url decode (handles curly quotes, accents, emoji)
function decodeData(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bytes = Uint8Array.from(atob(s), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function loadPuzzle() {
  const { d, num } = getParams();
  if (!d) return null;
  try {
    const obj = JSON.parse(decodeData(d));
    if (!Array.isArray(obj.g) || obj.g.length !== 4) return null;
    const groups = obj.g.map((g, level) => ({
      category: String(g[0]),
      items:    g.slice(1, 1 + GROUP_SIZE).map(String),
      level,
    }));
    if (groups.some(g => g.items.length !== GROUP_SIZE)) return null;
    return { groups, num: isNaN(num) ? 0 : num, raw: d };
  } catch { return null; }
}

// ---- Game state ---------------------------------------------
let puzzle       = null;
let levelOf      = new Map();   // item → group level
let order        = [];          // items still on the board, in display order
let selected     = new Set();
let solvedLevels = [];          // levels in the order they were solved / revealed
let guesses      = [];          // [[item, item, item, item], ...] every submitted guess
let mistakesLeft = MAX_MISTAKES;
let gameOver     = false;
let wonGame      = false;
let animating    = false;

function storageKey() {
  return `${STORAGE_PREFIX}${puzzle.num || simpleHash(puzzle.raw)}`;
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---- Persisted game state -----------------------------------
function saveState() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({
      order, solvedLevels, guesses, mistakesLeft, gameOver, wonGame,
    }));
  } catch {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ---- Shuffling ----------------------------------------------
// Seeded so every reader sees the same starting layout for a given puzzle.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Rendering ----------------------------------------------
function tileEl(item) {
  return document.querySelector(`.tile[data-item="${CSS.escape(item)}"]`);
}

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  order.forEach(item => {
    const tile = document.createElement('button');
    tile.classList.add('tile');
    tile.dataset.item = item;
    tile.textContent = item;
    if (selected.has(item)) tile.classList.add('selected');
    board.appendChild(tile);
  });
  fitAllTiles();
  updateControls();
}

function renderSolvedGroup(level, animate) {
  const group = puzzle.groups[level];
  const el = document.createElement('div');
  el.classList.add('group', `level-${level}`);
  if (animate) el.classList.add('reveal');
  el.innerHTML = `<div class="group-category"></div><div class="group-items"></div>`;
  el.querySelector('.group-category').textContent = group.category;
  el.querySelector('.group-items').textContent    = group.items.join(', ');
  document.getElementById('solved').appendChild(el);
}

function renderMistakes() {
  const dots = document.getElementById('mistake-dots');
  dots.innerHTML = '';
  for (let i = 0; i < MAX_MISTAKES; i++) {
    const dot = document.createElement('span');
    dot.classList.add('dot');
    if (i >= mistakesLeft) dot.classList.add('used');
    dots.appendChild(dot);
  }
}

function updateControls() {
  document.getElementById('btn-submit').disabled   = gameOver || selected.size !== GROUP_SIZE;
  document.getElementById('btn-deselect').disabled = gameOver || selected.size === 0;
  document.getElementById('btn-shuffle').disabled  = gameOver;
}

// Shrink text until it fits the tile (long Stanford names like MIRRIELEES)
function fitTile(tile) {
  tile.style.fontSize = '';
  let size = parseFloat(getComputedStyle(tile).fontSize);
  while ((tile.scrollWidth > tile.clientWidth || tile.scrollHeight > tile.clientHeight) && size > 9) {
    size -= 0.5;
    tile.style.fontSize = `${size}px`;
  }
}

function fitAllTiles() {
  document.querySelectorAll('.tile').forEach(fitTile);
}

// ---- Selection ----------------------------------------------
function toggleTile(item) {
  if (gameOver || animating) return;
  const tile = tileEl(item);
  if (selected.has(item)) {
    selected.delete(item);
    tile.classList.remove('selected');
  } else {
    if (selected.size >= GROUP_SIZE) return;
    selected.add(item);
    tile.classList.add('selected');
  }
  updateControls();
}

function deselectAll() {
  if (gameOver || animating) return;
  selected.clear();
  document.querySelectorAll('.tile.selected').forEach(t => t.classList.remove('selected'));
  updateControls();
}

function shuffleBoard() {
  if (gameOver || animating) return;
  order = shuffle(order);
  renderBoard();
  saveState();
}

// ---- Submit -------------------------------------------------
function guessKey(items) {
  return items.slice().sort().join('\u0000');
}

function submitGuess() {
  if (gameOver || animating || selected.size !== GROUP_SIZE) return;

  // Keep the guess in board order so the hop animation reads left → right
  const guess = order.filter(item => selected.has(item));
  const key = guessKey(guess);
  if (guesses.some(g => guessKey(g) === key)) { showToast('Already guessed!'); return; }

  guesses.push(guess);
  animating = true;
  updateControls();

  guess.forEach((item, i) => {
    const tile = tileEl(item);
    setTimeout(() => {
      tile.classList.remove('jump');
      void tile.offsetWidth;
      tile.classList.add('jump');
    }, i * JUMP_MS);
  });

  setTimeout(() => evaluateGuess(guess), GROUP_SIZE * JUMP_MS + 300);
}

function evaluateGuess(guess) {
  const levels = guess.map(item => levelOf.get(item));
  const counts = {};
  levels.forEach(l => { counts[l] = (counts[l] || 0) + 1; });
  const best = Math.max(...Object.values(counts));

  if (best === GROUP_SIZE) {
    solveGroup(levels[0], true);
    animating = false;
    if (solvedLevels.length === puzzle.groups.length) handleWin();
    saveState();
    return;
  }

  if (best === GROUP_SIZE - 1) showToast('One away…');

  guess.forEach(item => {
    const tile = tileEl(item);
    tile.classList.remove('shake');
    void tile.offsetWidth;
    tile.classList.add('shake');
  });

  mistakesLeft--;
  renderMistakes();

  setTimeout(() => {
    animating = false;
    if (mistakesLeft === 0) handleLoss();
    else updateControls();
    saveState();
  }, 400);
}

function solveGroup(level, animate) {
  const items = puzzle.groups[level].items;
  solvedLevels.push(level);
  order = order.filter(item => !items.includes(item));
  items.forEach(item => selected.delete(item));
  renderSolvedGroup(level, animate);
  renderBoard();
}

// ---- Win / Loss ---------------------------------------------
function handleWin() {
  gameOver = true;
  wonGame  = true;
  updateControls();
  showEndState();
  const mistakes = MAX_MISTAKES - mistakesLeft;
  showToast(WIN_MESSAGES[Math.min(mistakes, WIN_MESSAGES.length - 1)], 2200);
  setTimeout(openShareModal, 1400);
}

function handleLoss() {
  gameOver = true;
  selected.clear();
  updateControls();
  showToast('Next time!', 2000);

  // Reveal the remaining groups one at a time, easiest first
  const remaining = puzzle.groups
    .map(g => g.level)
    .filter(l => !solvedLevels.includes(l));

  remaining.forEach((level, i) => {
    setTimeout(() => {
      solveGroup(level, true);
      saveState();
      if (i === remaining.length - 1) {
        showEndState();
        setTimeout(openShareModal, 1200);
      }
    }, 700 + i * 700);
  });
}

function showEndState() {
  document.getElementById('controls').classList.add('hidden');
  document.getElementById('mistakes').classList.add('hidden');
  document.getElementById('btn-view-results').classList.remove('hidden');
  document.getElementById('btn-open-share').classList.remove('hidden');
}

// ---- Share modal --------------------------------------------
function buildEmojiGrid() {
  return guesses
    .map(g => g.map(item => LEVEL_EMOJI[levelOf.get(item)]).join(''))
    .join('\n');
}

function getGamePageUrl() {
  return 'stanforddaily.com/category/games/connections';
}

function buildShareText() {
  return `Cardinal Connections #${puzzle.num}\n${buildEmojiGrid()}\n\n${getGamePageUrl()}`;
}

function openShareModal() {
  const mistakes   = MAX_MISTAKES - mistakesLeft;
  const resultLine = document.getElementById('share-result-line');
  if (wonGame) {
    resultLine.innerHTML =
      `${WIN_MESSAGES[Math.min(mistakes, WIN_MESSAGES.length - 1)]}` +
      `<span class="result-sub">${mistakes} ${mistakes === 1 ? 'mistake' : 'mistakes'}</span>`;
  } else {
    resultLine.innerHTML = `Nice try!<span class="result-sub">Better luck tomorrow</span>`;
  }

  const grid = document.getElementById('share-emoji-grid');
  grid.innerHTML = '';
  guesses.forEach(g => {
    const rowEl = document.createElement('div');
    rowEl.classList.add('share-row');
    g.forEach(item => {
      const cell = document.createElement('div');
      cell.classList.add('share-cell', `level-${levelOf.get(item)}`);
      rowEl.appendChild(cell);
    });
    grid.appendChild(rowEl);
  });

  const btn = document.getElementById('btn-share');
  btn.textContent = 'Share Results';
  btn.classList.remove('copied');

  openModal('share');
}

document.getElementById('btn-share').addEventListener('click', () => {
  const btn  = document.getElementById('btn-share');
  const text = buildShareText();

  function onCopied() {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Share Results';
      btn.classList.remove('copied');
    }, 2500);
  }

  function fallbackCopy() {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    Object.assign(el.style, { position: 'fixed', opacity: '0' });
    document.body.appendChild(el);
    el.select();
    el.setSelectionRange(0, el.value.length);
    document.execCommand('copy');
    el.remove();
    onCopied();
  }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(onCopied).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
});

// ---- Toast --------------------------------------------------
function showToast(message, duration = 1800) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.classList.add('toast');
  toast.textContent = message;
  toast.style.animationDuration = `${duration / 1000}s`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ---- Modals -------------------------------------------------
function openModal(name)  { document.getElementById(`modal-${name}`).classList.remove('hidden'); }
function closeModal(name) { document.getElementById(`modal-${name}`).classList.add('hidden'); }

document.querySelectorAll('.modal-close').forEach(btn =>
  btn.addEventListener('click', () => closeModal(btn.dataset.modal))
);
document.querySelectorAll('.modal').forEach(modal =>
  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal(modal.id.replace('modal-', ''));
  })
);

// ---- Event listeners ----------------------------------------
document.getElementById('board').addEventListener('click', e => {
  const tile = e.target.closest('.tile');
  if (tile) toggleTile(tile.dataset.item);
});

document.getElementById('btn-shuffle').addEventListener('click', shuffleBoard);
document.getElementById('btn-deselect').addEventListener('click', deselectAll);
document.getElementById('btn-submit').addEventListener('click', submitGuess);
document.getElementById('btn-view-results').addEventListener('click', openShareModal);
document.getElementById('btn-open-share').addEventListener('click', openShareModal);
document.getElementById('btn-help').addEventListener('click', () => openModal('help'));

document.getElementById('btn-start-over').addEventListener('click', () => {
  if (puzzle) { try { localStorage.removeItem(storageKey()); } catch {} }
  location.reload();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !document.querySelector('.modal:not(.hidden)')) submitGuess();
  if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
});

window.addEventListener('resize', fitAllTiles);

// ---- Init ---------------------------------------------------
function init() {
  puzzle = loadPuzzle();
  if (!puzzle) {
    document.getElementById('empty-msg').classList.remove('hidden');
    document.getElementById('controls').classList.add('hidden');
    document.getElementById('mistakes').classList.add('hidden');
    return;
  }

  if (puzzle.num) document.getElementById('puzzle-label').textContent = `Puzzle #${puzzle.num}`;
  puzzle.groups.forEach(g => g.items.forEach(item => levelOf.set(item, g.level)));

  const saved = loadState();
  if (saved) {
    order        = saved.order;
    solvedLevels = saved.solvedLevels;
    guesses      = saved.guesses;
    mistakesLeft = saved.mistakesLeft;
    gameOver     = saved.gameOver;
    wonGame      = saved.wonGame;
    solvedLevels.forEach(level => renderSolvedGroup(level, false));
    // Reader left mid-way through the end-of-game reveal
    if (gameOver) {
      puzzle.groups.forEach(g => { if (!solvedLevels.includes(g.level)) solveGroup(g.level, false); });
    }
  } else {
    const allItems = puzzle.groups.flatMap(g => g.items);
    order = shuffle(allItems, seededRandom(puzzle.num || parseInt(simpleHash(puzzle.raw), 36)));
  }

  renderBoard();
  renderMistakes();
  if (gameOver) showEndState();

  // Fonts can load after first paint and change text widths
  if (document.fonts) document.fonts.ready.then(fitAllTiles);
}

init();
