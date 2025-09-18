
  (() => {
    const BASE = ""; // same orgin as render
    const SPEED = 10; const MAX_RETRIES = 3; const RETRY_DELAY = 1000;

    // Mode switching
    const tabCharacter = document.getElementById('tabCharacter');
    const tabChat = document.getElementById('tabChat');
    const viewCharacter = document.getElementById('viewCharacter');
    const viewChat = document.getElementById('viewChat');

    // Character mode elements
    const charInput = document.getElementById('charInput');
    const charSend = document.getElementById('charSend');
    const panelText = document.getElementById('panelText');
    const panelBubble = document.getElementById('panelBubble');
    const tapHint = document.getElementById('tapHint');
    const fullModal = document.getElementById('fullModal');
    const fullText = document.getElementById('fullText');
    const closeFull = document.getElementById('closeFull');

    // Chat log elements
    const timeline = document.getElementById('timeline');

    // Journal
    const openJournal1 = document.getElementById('openJournal1');
    const journal = document.getElementById('journal');
    const journalBody = document.getElementById('journalBody');
    const closeJournal = document.getElementById('closeJournal');
    const exportBtn = document.getElementById('exportBtn');

    // SOS
    const sos = document.getElementById('sos');
    const sosMsg = document.getElementById('sosMsg');
    const sosLink = document.getElementById('sosLink');
    const sosResources = document.getElementById('sosResources');
    const sosClose = document.getElementById('sosClose');
    const sosReset = document.getElementById('sosReset');

    // Menu
    const menuBtn = document.getElementById('menuBtn');
    const menuPanel = document.getElementById('menuPanel');
    const mNew = document.getElementById('mNew');
    const mJournal = document.getElementById('mJournal');
    const mCopy = document.getElementById('mCopy');
    const mHelp = document.getElementById('mHelp');

    // Shared state
    let mode = 'character';
    let sessionId = null;
    const history = []; // {role:'self'|'angel', text:string}
    let inFlight = false;
    let lastFull = panelText.textContent;

    // after other menu refs
    const mTwoChairs = document.getElementById('mTwoChairs');

    // open/close menu
    menuBtn.addEventListener('click', () => {
      menuPanel.classList.toggle('open');
    });
    document.addEventListener('click', (e)=>{
      if(!menuPanel.contains(e.target) && e.target !== menuBtn) {
        menuPanel.classList.remove('open');
      }
    });

    // navigate
    mTwoChairs.addEventListener('click', ()=>{
      window.location.href = '/2chairs.html';
    });


    function setMode(next){
      mode = next;
      if(next==='character'){
        tabCharacter.classList.add('active'); tabCharacter.setAttribute('aria-selected','true');
        tabChat.classList.remove('active'); tabChat.setAttribute('aria-selected','false');
        viewCharacter.classList.remove('hidden'); viewChat.classList.add('hidden');
        charInput.focus();
      }else{
        tabChat.classList.add('active'); tabChat.setAttribute('aria-selected','true');
        tabCharacter.classList.remove('active'); tabCharacter.setAttribute('aria-selected','false');
        viewChat.classList.remove('hidden'); viewCharacter.classList.add('hidden');
        syncChatLogFromServer();
      }
    }

    tabCharacter.addEventListener('click', () => setMode('character'));
    tabChat.addEventListener('click', () => setMode('chat'));

    function typewriter(node, text, speed=SPEED, done){
      node.textContent=''; let i=0; const len=text.length; const dyn=len>600?4:len>400?6:len>250?8:len>120?10:12; const delay=Math.min(speed||dyn,dyn);
      (function go(){ if(i<text.length){ node.textContent += text.charAt(i++); setTimeout(go, delay); } else { done && done(); } })();
    }

    function isClamped(el){ return el.scrollHeight > el.clientHeight + 1; }
    function applyClamp(){
      requestAnimationFrame(() => {
        const truncated = isClamped(panelText);
        panelBubble.classList.toggle('truncated', truncated);
        tapHint.style.display = truncated ? 'block' : 'none';
      });
    }

    async function fetchWithRetry(url, options, retries=MAX_RETRIES){
      for(let i=0;i<retries;i++){
        try{ const r = await fetch(url, options); if(!r.ok) throw new Error('HTTP '+r.status); return r; }
        catch(e){ if(i===retries-1) throw e; await new Promise(res=> setTimeout(res, RETRY_DELAY*(i+1))); }
      }
    }

    async function createSession(){
      const r = await fetchWithRetry(BASE + '/api/session', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mode:'therapist-room' }) });
      const j = await r.json(); sessionId = j.sessionId; return sessionId;
    }

    async function sendMessage(text){
      const r = await fetchWithRetry(BASE + '/api/message', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sessionId, role:'self', text }) });
      return r.json();
    }

    // Character mode flow
    async function handleSendCharacter(){
      if(inFlight) return; const text = (charInput.value||'').trim(); if(!text) return; if(text.length>2000) return;
      inFlight = true; charInput.value='';
      history.push({role:'self', text});
      panelText.textContent = '…'; applyClamp();
      try{
        if(!sessionId) await createSession();
        const res = await sendMessage(text);
        if(res && res.crisis && res.locked){
          sosMsg.textContent = res.alertMessage || sosMsg.textContent; if(res.hotlinesUrl){ sosLink.href=res.hotlinesUrl; sosLink.style.display='flex'; } else { sosLink.style.display='none'; } if(res.resourcesUrl){ sosResources.href=res.resourcesUrl; sosResources.style.display='flex'; } else { sosResources.style.display='none'; }
          sos.classList.add('open'); charInput.disabled = true; charSend.disabled = true; inFlight=false; return;
        }
        const reply = (res && (res.lumen||res.angel)) ? (res.lumen||res.angel) : "I’m here.";
        lastFull = reply; history.push({role:'angel', text: reply});
        typewriter(panelText, reply, SPEED, applyClamp);
      }catch(e){ panelText.textContent = 'Hmm, I couldn’t reach the server. Try again in a moment.'; applyClamp(); }
      finally{ inFlight=false; }
    }

    charSend.addEventListener('click', handleSendCharacter);
    charInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); handleSendCharacter(); } });

    panelBubble.addEventListener('click', () => {
      if(!panelBubble.classList.contains('truncated')) return;
      fullText.textContent = lastFull || panelText.textContent || '';
      fullModal.classList.add('open');
    });
    closeFull.addEventListener('click', ()=> fullModal.classList.remove('open'));
    fullModal.addEventListener('click', (e)=>{ if(e.target===fullModal) fullModal.classList.remove('open'); });

    // Chat Log (read-only)
    function makeEntry(roleName, text){
      const row = document.createElement('div'); row.className = 'entry ' + roleName;
      const bub = document.createElement('div'); bub.className='bubble'; bub.textContent=text; const meta = document.createElement('div'); meta.className='meta'; meta.textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      row.appendChild(bub); return {row, meta};
    }
    function renderChatAppend(role, text){
      const {row, meta} = makeEntry(role==='self'?'self':'lumen', text);
      timeline.appendChild(row); timeline.appendChild(meta); timeline.scrollTop = timeline.scrollHeight;
    }
    async function syncChatLogFromServer(){
      if(!sessionId){ try{ await createSession(); }catch(e){ return; } }
      try{
        const r = await fetchWithRetry(BASE + `/api/session/${sessionId}/messages`, { method:'GET' });
        const j = await r.json();
        timeline.innerHTML = '';
        if(Array.isArray(j.messages)){
          j.messages.forEach(m => {
            const role = m.role === 'self' ? 'self' : (m.role === 'angel' ? 'lumen' : null);
            if(!role) return; renderChatAppend(role, m.text || '');
          });
        }
      }catch(e){ timeline.innerHTML = '<div class="meta">Could not load log.</div>'; }
    }

    // Journal
    function renderJournal(){
      journalBody.innerHTML='';
      history.forEach(h => {
        const row = document.createElement('div'); row.style.display='flex'; row.style.justifyContent = h.role==='self'?'flex-end':'flex-start';
        const bub = document.createElement('div'); bub.style.maxWidth='80%'; bub.style.padding='8px 10px'; bub.style.border='1px solid var(--line)'; bub.style.borderRadius='12px'; bub.style.boxShadow='var(--shadow)'; bub.style.whiteSpace='pre-wrap'; bub.textContent=h.text;
        if(h.role==='self'){ bub.style.background='#BFEFE8'; bub.style.color='#063a34'; bub.style.borderColor='#6fd0c6'; }
        journalBody.appendChild(row); row.appendChild(bub);
      });
      journalBody.scrollTop = journalBody.scrollHeight;
    }

    document.getElementById('openJournal1').addEventListener('click', ()=>{ renderJournal(); journal.classList.add('open'); });
    closeJournal.addEventListener('click', ()=> journal.classList.remove('open'));
    journal.addEventListener('click', (e)=>{ if(e.target===journal) journal.classList.remove('open'); });

    exportBtn.addEventListener('click', ()=>{
      const parts = history.map(h => (h.role==='self'?'You: ':'Lumen: ') + h.text);
      const blob = new Blob([parts.join('\n\n')+'\n'], {type:'text/plain'}); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); const now = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      a.href=url; a.download='xovia-therapist-transcript-'+now+'.txt'; a.click(); URL.revokeObjectURL(url);
    });

    // Menu interactions
    function closeMenu(){ menuPanel.classList.remove('open'); }
    function toggleMenu(){ menuPanel.classList.toggle('open'); }

    menuBtn.addEventListener('click', (e)=>{ e.stopPropagation(); toggleMenu(); });
    menuBtn.addEventListener('keydown', (e)=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); toggleMenu(); }});
    document.addEventListener('click', (e)=>{ if(!menuPanel.contains(e.target) && e.target!==menuBtn){ closeMenu(); }});
    document.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ closeMenu(); }});

    // Menu actions
    function startNew(){
      sessionId=null; history.length=0; panelText.textContent='Hi, I’m here with you. What feels most important to talk about today?';
      timeline.innerHTML=''; charInput.disabled=false; charSend.disabled=false; applyClamp();
    }

    mNew.addEventListener('click', ()=>{ startNew(); closeMenu(); });
    mJournal.addEventListener('click', ()=>{ renderJournal(); document.getElementById('journal').classList.add('open'); closeMenu(); });
    mCopy.addEventListener('click', async ()=>{
      try{ await navigator.clipboard.writeText(lastFull || panelText.textContent || ''); mCopy.textContent='Copied!'; setTimeout(()=> mCopy.textContent='Copy Last Reply', 1200); }catch{ mCopy.textContent='Copy failed'; setTimeout(()=> mCopy.textContent='Copy Last Reply', 1200); }
      closeMenu();
    });
    mHelp.addEventListener('click', ()=>{
      // Reuse SOS resources as a quick Help entry point
      const link = document.getElementById('sosResources');
      if(link && link.href && link.href !== '#') window.open(link.href, '_blank'); else alert('For immediate support, please use the Help & Hotlines option shown during safety alerts.');
      closeMenu();
    });

    // SOS handlers
    sosClose.addEventListener('click', ()=> sos.classList.remove('open'));
    sos.addEventListener('click', (e)=>{ if(e.target===sos) sos.classList.remove('open'); });
    sosReset.addEventListener('click', async ()=>{ sos.classList.remove('open'); startNew(); });

    // Boot
    setMode('character');
    setTimeout(applyClamp, 60);
  })();
