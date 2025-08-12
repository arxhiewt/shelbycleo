/* script.js
   Shelby & Cleo Meow Clicker
   Basic anti-cheat & persistence via localStorage with integrity checksum.
*/

(() => {
  // ---------- Configuration ----------
  const CONFIG = {
    CLICK_COOLDOWN_MS: 200,
    AUTOCLICK_DETECT_RATE_PER_SEC: 7, // if recent clicks/sec exceeds this => lock
    CASINO_MIN_BET: 5,
    CASINO_MAX_BET: 200000,
    CHECKSUM_KEY: 'sc_check', // key in localStorage for checksum
    STORAGE_KEY: 'sc_state', // base key for saved state
    STATS_KEY: 'sc_stats', // saved stats
    SAVE_INTERVAL_MS: 2000
  };

  // ---------- Utilities ----------
  function $(sel){return document.querySelector(sel)}
  function $all(sel){return Array.from(document.querySelectorAll(sel))}

  // simple SHA-256 wrapper (returns hex) using SubtleCrypto
  async function sha256hex(str){
    const enc=new TextEncoder().encode(str);
    const buf=await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  // ---------- Session secret & storage helpers ----------
  const sessionSecret = sessionStorage.getItem('sc_secret') || (function(){
    const r = crypto.getRandomValues(new Uint32Array(4)).join('-');
    sessionStorage.setItem('sc_secret', r);
    return r;
  })();

  function loadState(){
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if(!raw) return null;
      const obj = JSON.parse(raw);
      return obj;
    } catch(e){
      return null;
    }
  }

  async function computeChecksum(stateObj){
    // include session secret to make ad-hoc tampering harder (but not impossible).
    const s = JSON.stringify(stateObj) + '|' + sessionSecret;
    return await sha256hex(s);
  }

  async function saveState(state){
    const checksum = await computeChecksum(state);
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(CONFIG.CHECKSUM_KEY, checksum);
  }

  async function verifyIntegrity(){
    const state = loadState();
    if(!state) return true; // nothing to verify
    const saved = localStorage.getItem(CONFIG.CHECKSUM_KEY);
    const cur = await computeChecksum(state);
    return saved === cur;
  }

  // ---------- Default data model ----------
  const DEFAULT = {
    meows: 0,
    multiplier: 1.0,
    owned: [], // array of item ids
    totalEarned: 0,
    totalSpent: 0,
    activeTimeSeconds: 0
  };

  // ---------- Shop items ----------
  const SHOP = [
    { id: 'm_1.5', title: 'Tiny Treat', desc: '1.5× meows', price: 100, mult: 1.5 },
    { id: 'm_2', title: 'Fancy Feathers', desc: '2× meows', price: 500, mult: 2.0 },
    { id: 'm_3', title: 'Golden Scratcher', desc: '3× meows', price: 2000, mult: 3.0 },
    { id: 'm_5', title: 'Cuddle Throne', desc: '5× meows', price: 10000, mult: 5.0 }
  ];

  // ---------- State & runtime ----------
  let STATE = loadState() || {...DEFAULT};
  let recentClicks = []; // timestamps of recent clicks for autoclick detection
  let lastClickAt = 0;
  let locked = false; // locked on cheat detection
  let visibleActive = false;
  let activeTimeStart = null;

  // ---------- DOM references ----------
  const meowDisplay = $('#meow-display');
  const multiplierDisplay = $('#multiplier');
  const clickBox = $('#click-box');
  const clicksPerSecElem = $('#clicks-ps');
  const shopItemsWrap = $('#shop-items');
  const ownedList = $('#owned-list');
  const ownedMult = $('#owned-mult');
  const statTotalEarned = $('#stat-total-earned');
  const statTimePlayed = $('#stat-time-played');
  const statTotalSpent = $('#stat-total-spent');
  const coinflipBtn = $('#coinflip-btn');
  const betInput = $('#bet-input');
  const casinoLog = $('#casino-log');
  const tabButtons = $all('.tab-btn');
  const tabs = $all('.tab');

  // ---------- Display helpers ----------
  function fmt(n){ // friendly integer formatting
    if (n >= 1e9) return (n/1e9).toFixed(2)+'B';
    if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
    if (n >= 1e3) return (n/1e3).toFixed(1)+'k';
    return Math.floor(n).toString();
  }

  function updateDisplays(){
    // correct DOM from source-of-truth
    meowDisplay.textContent = fmt(STATE.meows);
    multiplierDisplay.textContent = STATE.multiplier.toFixed(2) + '×';
    ownedMult.textContent = STATE.multiplier.toFixed(2) + '×';
    statTotalEarned.textContent = fmt(STATE.totalEarned);
    statTotalSpent.textContent = fmt(STATE.totalSpent);
    updateOwnedList();
  }

  function updateOwnedList(){
    if(STATE.owned.length === 0){
      ownedList.textContent = 'None yet';
      return;
    }
    ownedList.innerHTML = STATE.owned.map(id=>{
      const it = SHOP.find(s=>s.id===id);
      return `<div class="muted">• ${it.title} — ${it.desc}</div>`;
    }).join('');
  }

  // ---------- Shop init ----------
  function renderShop(){
    shopItemsWrap.innerHTML = SHOP.map(item => {
      const owned = STATE.owned.includes(item.id);
      return `
        <div class="shop-item" data-id="${item.id}">
          <h4>${item.title}</h4>
          <div class="price">${item.desc} • ${item.price} meows</div>
          <div class="muted" style="margin-bottom:8px">${owned ? 'Owned' : 'One-time purchase'}</div>
          <button class="buy-btn" ${owned ? 'disabled' : ''}>${owned ? 'Bought' : 'Buy'}</button>
        </div>
      `;
    }).join('');
    // attach listeners
    Array.from(shopItemsWrap.querySelectorAll('.buy-btn')).forEach(btn=>{
      btn.addEventListener('click', async (ev)=>{
        if(locked) return alert('Account locked due to suspicious activity.');
        const wrap = ev.currentTarget.closest('.shop-item');
        const id = wrap.dataset.id;
        buyItem(id);
      });
    });
  }

  // ---------- Buy logic ----------
  async function buyItem(id){
    const item = SHOP.find(s=>s.id===id);
    if(!item) return;
    if(STATE.meows < item.price){
      flashCasinoLog('Not enough meows to buy that upgrade.', 'muted');
      return;
    }
    STATE.meows -= item.price;
    STATE.totalSpent += item.price;
    STATE.owned.push(item.id);
    // multiply stack multiplicatively
    STATE.multiplier *= item.mult;
    STATE.multiplier = Number(STATE.multiplier.toFixed(6));
    await saveState(STATE);
    renderShop();
    updateDisplays();
  }

  // ---------- Click handling & anti-cheat ----------
  async function registerClick(){
    if(locked) return;
    const now = Date.now();
    // Cooldown check
    if(now - lastClickAt < CONFIG.CLICK_COOLDOWN_MS){
      // too fast
      return;
    }
    lastClickAt = now;
    recentClicks.push(now);
    // purge old
    const cutoff = now - 2000;
    recentClicks = recentClicks.filter(t=>t > cutoff);
    // detect rapid click-rate
    const clicksSec = recentClicks.length / 2; // since window 2s
    clicksPerSecElem.textContent = clicksSec.toFixed(1);

    if(clicksSec > CONFIG.AUTOCLICK_DETECT_RATE_PER_SEC){
      // lock account to prevent cheating
      locked = true;
      alert('Suspicious click activity detected — account locked. Refresh to attempt reload.');
      console.warn('Auto-lock due to click spamming');
      return;
    }

    // Apply meow gain with multiplier
    const gain = 1 * STATE.multiplier;
    const intGain = Number(gain.toFixed(6)); // allow fractional multipliers internally, but keep display integer currency
    STATE.meows = Number((STATE.meows + intGain).toFixed(6));
    STATE.totalEarned = Math.floor(STATE.totalEarned + intGain);
    await saveState(STATE);
    updateDisplays();

    // visual micro animation
    clickBox.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-6px)' }, { transform: 'translateY(0)' }], { duration: 220, easing: 'ease-out' });
  }

  // Prevent keyboard spamming and accessibility: allow Enter/Space to click
  clickBox.addEventListener('click', (e)=>{ registerClick(); });
  clickBox.addEventListener('keydown', (e)=>{ if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); registerClick(); } });

  // ---------- Casino logic ----------
  function flashCasinoLog(msg, cls=''){
    const el = document.createElement('div');
    el.textContent = msg;
    if(cls) el.classList.add(cls);
    casinoLog.prepend(el);
    // limit
    while(casinoLog.children.length > 50) casinoLog.removeChild(casinoLog.lastChild);
  }

  function randChoice(){
    return Math.random() < 0.5 ? 'heads' : 'tails';
  }

  async function coinflip(){
    if(locked) return alert('Account locked due to suspicious activity.');
    let bet = Number(betInput.value) || 0;
    bet = Math.floor(bet);
    if(bet < CONFIG.CASINO_MIN_BET) return flashCasinoLog(`Minimum bet is ${CONFIG.CASINO_MIN_BET}`);
    if(bet > CONFIG.CASINO_MAX_BET) return flashCasinoLog(`Maximum bet is ${CONFIG.CASINO_MAX_BET}`);
    if(bet > STATE.meows) return flashCasinoLog(`You don't have ${bet} meows to bet.`);
    const pick = $('#coin-pick').value;
    const result = randChoice();

    // Deduct bet immediately
    STATE.meows -= bet;
    STATE.totalSpent += bet;
    await saveState(STATE);
    updateDisplays();

    // flip animation (text)
    flashCasinoLog(`You bet ${bet} meows on ${pick}. Flipping...`);

    setTimeout(async () => {
      if(result === pick){
        // win: payout = bet * 2 (profit = bet)
        const payout = bet * 2;
        STATE.meows += payout;
        await saveState(STATE);
        flashCasinoLog(`🎉 You won! It was ${result}. You receive ${payout} meows.`);
      } else {
        flashCasinoLog(`😿 You lost. It was ${result}.`);
      }
      updateDisplays();
    }, 800);
  }

  coinflipBtn.addEventListener('click', coinflip);

  // ---------- Tab navigation ----------
  tabButtons.forEach(btn=>{
    btn.addEventListener('click', () => {
      tabButtons.forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const name = btn.dataset.tab;
      tabs.forEach(t => { t.classList.toggle('active', t.id === name); });
    });
  });

  // ---------- Load / Save loop & integrity check ----------
  async function periodicSave(){
    try {
      // verify integrity
      const ok = await verifyIntegrity();
      if(!ok){
        locked = true;
        alert('Data integrity check failed. Possible tampering detected — account locked.');
        console.warn('integrity fail');
        return;
      }
      // save current state
      await saveState(STATE);
    } catch (e){
      console.error('Save error', e);
    }
  }
  setInterval(periodicSave, CONFIG.SAVE_INTERVAL_MS);

  // ---------- Initialize stats time tracking ----------
  function startActiveTimer(){
    if(visibleActive) return;
    visibleActive = true;
    activeTimeStart = Date.now();
  }

  function stopActiveTimer(){
    if(!visibleActive) return;
    visibleActive = false;
    const delta = Math.floor((Date.now() - activeTimeStart) / 1000);
    STATE.activeTimeSeconds += delta;
    activeTimeStart = null;
    saveState(STATE);
  }

  // update time display every second if active
  setInterval(()=>{
    if(visibleActive && activeTimeStart){
      const elapsed = STATE.activeTimeSeconds + Math.floor((Date.now() - activeTimeStart)/1000);
      statTimePlayed.textContent = formatTime(elapsed);
    } else {
      statTimePlayed.textContent = formatTime(STATE.activeTimeSeconds);
    }
  }, 1000);

  function formatTime(sec){
    if(sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if(m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m`;
  }

  // visibility tracking
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible') startActiveTimer();
    else stopActiveTimer();
  });
  // start if open
  if(document.visibilityState === 'visible') startActiveTimer();

  // ---------- Integrity observer: auto-correct DOM tampering attempts ----------
  // If someone changes #meow-display by hand, we will restore it from STATE every 500ms and increment a suspicion counter.
  let tamperCount = 0;
  setInterval(()=> {
    const displayed = meowDisplay.textContent.replace(/[^\dKM\.]/g,''); // rough
    const expected = fmt(STATE.meows);
    if(displayed !== expected){
      tamperCount++;
      // restore
      meowDisplay.textContent = expected;
      // minor penalty for repeated tamper attempts
      if(tamperCount > 3){
        locked = true;
        alert('Multiple tampering attempts detected. Account locked.');
        console.warn('tamper lock');
      }
    }
  }, 500);

  // ---------- Expose reset for upgrades & export stats ----------
  $('#reset-upgrades').addEventListener('click', async () => {
    if(!confirm('Reset upgrades? This will remove owned shop items and reset multiplier to 1.')) return;
    STATE.owned = [];
    STATE.multiplier = 1.0;
    await saveState(STATE);
    renderShop();
    updateDisplays();
  });

  $('#export-stats').addEventListener('click', ()=>{
    const payload = {
      totalEarned: STATE.totalEarned,
      totalSpent: STATE.totalSpent,
      activeSeconds: STATE.activeTimeSeconds,
      meows: STATE.meows,
      owned: STATE.owned
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'shelby_cleo_stats.json'; a.click();
    URL.revokeObjectURL(url);
  });

  // ---------- Load flow & UI init ----------
  async function init(){
    // integrity check first
    const ok = await verifyIntegrity();
    if(!ok){
      alert('Data integrity check failed on load. Resetting local data for safety.');
      localStorage.removeItem(CONFIG.STORAGE_KEY);
      localStorage.removeItem(CONFIG.CHECKSUM_KEY);
      STATE = {...DEFAULT};
      await saveState(STATE);
    } else {
      const saved = loadState();
      if(saved) STATE = Object.assign({}, DEFAULT, saved);
    }

    renderShop();
    updateDisplays();

    // attach click handlers in shop
    // attach tooltip etc.

    // listeners for manual editing prevention: intercept paste on body to avoid quick injection attempts
    document.addEventListener('paste', (e)=> {
      // small check: if user tries to paste numbers into meow-display (rare), block
      const clipboard = (e.clipboardData || window.clipboardData).getData('text');
      if(/[0-9]{2,}/.test(clipboard) && e.target && e.target.id === 'meow-display'){
        e.preventDefault();
      }
    });

    // restore some UI
    updateDisplays();
  }

  init();

  // ---------- click stat smoothing (recent clicks per second) ----------
  setInterval(()=>{
    const now = Date.now();
    recentClicks = recentClicks.filter(t => t > now - 2000);
    const cps = (recentClicks.length / 2).toFixed(1);
    clicksPerSecElem.textContent = cps;
  }, 300);

  // ---------- Accessibility: keyboard controls for coinflip quick bet +- ----------
  // small helpers: up/down adjust bet
  betInput.addEventListener('keydown', (e)=>{
    if(e.key === 'ArrowUp'){ e.preventDefault(); betInput.value = Math.min(CONFIG.CASINO_MAX_BET, Number(betInput.value||0) + 5); }
    if(e.key === 'ArrowDown'){ e.preventDefault(); betInput.value = Math.max(CONFIG.CASINO_MIN_BET, Number(betInput.value||0) - 5); }
  });

  // Visual safety: prevent contextmenu on clickbox to avoid injection attempts
  clickBox.addEventListener('contextmenu', (e)=>{ e.preventDefault(); });

  // ---------- Finally: periodic quick auto-save of state in case user leaves ----------
  setInterval(()=>{ saveState(STATE); }, 5000);

  // ---------- Additional UI improvements: populate shop after initial render ----------
  renderShop();

  // ---------- Export small helper for debugging (developer only) ----------
  window._SC_DEBUG = {
    STATE, verifyIntegrity: () => verifyIntegrity().then(ok => console.log('integrity', ok))
  };
})();
