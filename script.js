    (() => {
    // ---------- Config ----------
    const BASE = "http://127.0.0.1:3000";
    const SPEED_CHAR_CHAT_LUMEN = 8;
    const SPEED_CHAR_MODAL      = 10;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;
    const SPEAK_TAIL = 280; // ms to gently linger before resetting


    // ---------- State ----------
    let sessionId = null;
    let role = "self";
    let steps = 0;
    let inFlight = false;
    let focusAfterSend = false;   // will request focus after UI re-enables

    // ---------- Elements ----------
    const phone = document.querySelector(".phone");
    const cards = document.getElementById("cards");
    const composer = document.getElementById("composer");
    const t = document.getElementById("t");
    const sendBtn = document.getElementById("send");
    const timeline = document.getElementById("timeline");
    const pills = Array.from({length:6}, (_,i)=> document.getElementById("p"+i));
    const statusBar = document.getElementById("statusBar");
    const errorMessage = document.getElementById("errorMessage");
    const selfBlob = document.getElementById("selfBlob");
    const monsterBlob = document.getElementById("monsterBlob");

    // Modals
    const modal = document.getElementById("modal");
    const modalText = document.getElementById("modalText");
    const closeBtn = document.getElementById("closeBtn");
    const copyBtn  = document.getElementById("copyBtn");
    const sos = document.getElementById("sos");
    const sosMsg = document.getElementById("sosMsg");
    const sosLink = document.getElementById("sosLink");
    const sosClose = document.getElementById("sosClose");
    const sosReset = document.getElementById("sosReset");
    // Help modal
    const help = document.getElementById("help");
    const helpBtn = document.getElementById("helpBtn");
    const helpClose = document.getElementById("helpClose");

    
    // ---------- Layout glue ----------
    function updateStackHeight(){
    if (!phone) return;

    const phoneRect    = phone.getBoundingClientRect();
    const cardsTop     = cards ? cards.getBoundingClientRect().top : phoneRect.bottom;
    const composerTop  = composer ? composer.getBoundingClientRect().top : phoneRect.bottom;

    // The stack is everything from the top edge of the first box (cards or composer)
    // down to the bottom of the phone container.
    const firstStackTop = Math.min(cardsTop, composerTop);
    let stackH = phoneRect.bottom - firstStackTop;

    // safety clamps + tiny cushion for outer margins
    stackH = Math.max(0, Math.round(stackH) + 8);

    phone.style.setProperty("--stackH", stackH + "px");
    }


    // Keep chairs glued on textarea growth / zoom / resize
    const ro = new ResizeObserver(() => {
        updateStackHeight();
        // if user was at bottom, keep pinned
        scrollTimeline();
    });
    if (composer) ro.observe(composer);
    if (cards) ro.observe(cards);

    window.addEventListener("resize", updateStackHeight);

    // ---------- FIXED Animation System ----------
    let animationTimeouts = new Set();

    // Clear all animation timeouts
    function clearAnimationTimeouts() {
        animationTimeouts.forEach(timeout => clearTimeout(timeout));
        animationTimeouts.clear();
    }

    // Set character state with proper cleanup
    function setCharacterState(character, state) {
  const blob = character === 'self' ? selfBlob : monsterBlob;
  if (!blob) return;

  const chair = blob.closest('.chair');

  // Remove blob state classes
  blob.classList.remove('state-idle','state-active','state-talking','state-listening');

  // Remove chair state helpers
  if (chair){
    chair.classList.remove('speaking','active');
  }

  // Add new blob state (or leave idle with no class)
  if (state && state !== 'idle') {
    blob.classList.add(`state-${state}`);   
  }

  // Reflect to chair for subtle physical response
  if (chair){
    if (state === 'talking') chair.classList.add('speaking');
    if (state === 'active')  chair.classList.add('active');
  }
}


    // Reset both characters to idle
    function resetToIdle() {
        clearAnimationTimeouts();
        setCharacterState('self', 'idle');
        setCharacterState('monster', 'idle');
    }

    // Set active character (for input mode)
    function setActiveCharacter(activeRole) {
        clearAnimationTimeouts();
        
        if (activeRole === 'self') {
        setCharacterState('self', 'active');
        setCharacterState('monster', 'idle');
        } else if (activeRole === 'monster') {
        setCharacterState('monster', 'active');
        setCharacterState('self', 'idle');
        } else {
        resetToIdle();
        }
    }

    // Smoothly return both blobs to neutral without snapping.
// After the tween, we restore focus/active highlight to `nextFocusRole`
// (or idle if 'lumen').
function settleToNeutral(nextFocusRole) {
  const blobs = [selfBlob, monsterBlob];

  // 1) Freeze current animated transform as inline style
  blobs.forEach(b => {
    const cs = getComputedStyle(b);
    const cur = cs.transform === 'none' ? 'matrix(1,0,0,1,0,0)' : cs.transform;

    // kill state classes so keyframes stop driving transform
    b.classList.remove('state-talking','state-listening','state-active','state-idle');

    // freeze pose and prep transition
    b.style.transform   = cur;
    b.style.transition  = 'transform 260ms cubic-bezier(.22,.61,.36,1), box-shadow 260ms ease';
  });

  // 2) Next frame: tween to neutral transform
  requestAnimationFrame(() => {
    blobs.forEach(b => {
      b.style.transform = 'translateY(0) scale(1) rotate(0)';
      // optional: fade out any extra glow quickly
      // b.style.boxShadow = '';
    });

    // 3) After tween: cleanup inline styles and restore target state
    setTimeout(() => {
      blobs.forEach(b => {
        b.style.transition = '';
        b.style.transform  = '';
        // b.style.boxShadow  = '';
      });

      if (nextFocusRole === 'lumen') {
        resetToIdle();
      } else if (nextFocusRole === 'self' || nextFocusRole === 'monster') {
        setActiveCharacter(nextFocusRole);
      } else {
        resetToIdle();
      }
    }, 280); // keep in sync with transition duration
  });
}


    // Animate speaking character
    function setSpeaking(speakingRole, duration = 1500, tail = SPEAK_TAIL) {
  clearAnimationTimeouts();

  // set current speaking/listening state
  if (speakingRole === 'self') {
    setCharacterState('self', 'talking');
    setCharacterState('monster', 'listening');
  } else if (speakingRole === 'monster') {
    setCharacterState('monster', 'talking');
    setCharacterState('self', 'listening');
  } else if (speakingRole === 'lumen') {
    setCharacterState('self', 'listening');
    setCharacterState('monster', 'listening');
  }

  // if duration <= 0, hold the pose until something else changes it
  if (duration <= 0) return;

  // after main duration, linger a bit (tail), then glide home
  const t1 = setTimeout(() => {
    // calm listening pose during the tail
    setCharacterState('self', 'listening');
    setCharacterState('monster', 'listening');

    const t2 = setTimeout(() => {
      // <— this is where we used to snap; now we tween
      if (speakingRole === 'lumen') {
        settleToNeutral('lumen');      // glide both to idle
      } else {
        settleToNeutral(speakingRole); // glide, then re-highlight current speaker as active
      }
    }, Math.max(0, tail));

    animationTimeouts.add(t2);
  }, Math.max(0, duration));

  animationTimeouts.add(t1);
}


    // ---------- Helpers ----------
    function paintPills(n){
        pills.forEach((p,i)=> {
        p.classList.toggle("on", i < n);
        p.setAttribute("aria-label", i < n ? `Step ${i+1} completed` : `Step ${i+1}`);
        });
    }

    function setComposerRole(){
        const placeholder = role === "self" ? "Type as SELF…" : "Type as MONSTER…";
        t.placeholder = placeholder;
        t.setAttribute("aria-label", `Message input — ${placeholder}`);
        setActiveCharacter(role);
    }

    function setDisabled(on){
        inFlight = on;
        t.disabled = on;
        sendBtn.disabled = on;
        composer.classList.toggle("disabled", on);

        if (on) {
        statusBar.textContent = "Processing...";
        statusBar.className = "status-bar connecting";
        } else {
        statusBar.className = "status-bar";
        }
    }

    function scrollTimeline(){
        requestAnimationFrame(() => {
        timeline.scrollTop = timeline.scrollHeight;
        });
    }

    function showError(message, duration = 5000) {
        errorMessage.textContent = message;
        errorMessage.classList.add("show");
        setTimeout(() => {
        errorMessage.classList.remove("show");
        }, duration);
    }

    function clearError() {
        errorMessage.classList.remove("show");
    }

    function makeEntry(roleName, text){
        const row = document.createElement("div");
        row.className = "entry " + roleName;
        const bub = document.createElement("div");
        bub.className = "bubble";
        bub.setAttribute("role", "article");
        if (text) bub.textContent = text;
        row.appendChild(bub);
        return {row, bub};
    }

    function addUserEntry(roleName, text){
    const {row, bub} = makeEntry(roleName, text);
    timeline.appendChild(row);
    const tag = document.createElement("div");
    tag.className = "tag " + (roleName==="self"?"left":"right");
    tag.textContent = roleName.toUpperCase();
    timeline.appendChild(tag);
    scrollTimeline();

    // Show speaking animation
    setSpeaking(roleName, 1500);

    return {row, bub};
    }

    function addTypingEntry(){
        const {row, bub} = makeEntry("lumen", "");
        row.classList.add("typing");
        row.setAttribute("aria-label", "Lumen is typing");

        const label = document.createElement("span");
        label.textContent = "Lumen is typing ";
        const dots = document.createElement("span");
        dots.className = "dots";
        dots.innerHTML = "<span></span><span></span><span></span>";
        dots.setAttribute("aria-hidden", "true");

        bub.appendChild(label);
        bub.appendChild(dots);
        timeline.appendChild(row);

        const tag = document.createElement("div");
        tag.className = "tag";
        tag.textContent = "LUMEN";
        timeline.appendChild(tag);
        scrollTimeline();

        setSpeaking('lumen', 0); // Lumen preparing to speak
        return {row, bub, tag};
    }

    function typewriter(node, text, speed, done){
        node.textContent = "";
        let i = 0;
        node.classList.add("loading");

        const len = text.length;
        const dyn = len > 600 ? 4 : len > 400 ? 6 : len > 250 ? 8 : len > 120 ? 10 : 12;
        const delay = Math.min(speed || dyn, dyn);

        setSpeaking('lumen', text.length * delay + 500); // Speaking for duration of typing

        (function go(){
        if (i < text.length) {
            node.textContent += text.charAt(i++);
            requestAnimationFrame(scrollTimeline);
            setTimeout(go, delay);
        } else {
            node.classList.remove("loading");
            // Animation will auto-reset via timeout in setSpeaking
            if (done) done();
        }
        })();
    }

    function openReflection(text){
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        typewriter(modalText, text, SPEED_CHAR_MODAL, ()=>{});
        closeBtn.focus();
    }

    function closeReflection(){
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
        modalText.textContent = "";
        t.focus();
    }

    function openSOS(message, hotlinesUrl, resourcesUrl){
    sosMsg.textContent = message || "We identified harmful words in your conversation. Life is worth living — you are not alone.";

    // Hotlines link
    if (hotlinesUrl) {
        sosLink.href = hotlinesUrl;
        sosLink.style.display = "flex";
    } else {
        sosLink.removeAttribute("href");
        sosLink.style.display = "none";
    }

    // Resources link
    const sosResources = document.getElementById("sosResources");
    if (sosResources) {
        if (resourcesUrl) {
            sosResources.href = resourcesUrl;
            sosResources.style.display = "flex";
        } else {
            sosResources.removeAttribute("href");
            sosResources.style.display = "none";
        }
    }

    sos.classList.add("open");
    sos.setAttribute("aria-hidden", "false");
    sosClose.focus();
}


    function closeSOS(){
        sos.classList.remove("open");
        sos.setAttribute("aria-hidden", "true");
    }

    async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
        for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return response;
        } catch (error) {
            if (i === retries - 1) throw error;
            showError(`Connection failed, retrying... (${i + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (i + 1)));
        }
        }
    }

    async function ensureSession(){
        if (sessionId) return;
        try {
        statusBar.textContent = "Connecting...";
        statusBar.className = "status-bar connecting";

        const r = await fetchWithRetry(BASE + "/api/session", {
            method:"POST",
            headers:{'Content-Type':'application/json'},
            body:"{}"
        });
        const j = await r.json();
        sessionId = j.sessionId;

        statusBar.className = "status-bar";
        clearError();
        } catch (error) {
        statusBar.textContent = "Connection failed";
        statusBar.className = "status-bar error";
        throw error;
        }
    }

    async function startNew(){
        sessionId = null;
        role = "self";
        steps = 0;
        paintPills(steps);
        timeline.innerHTML = "";
        setComposerRole();
        t.value = "";
        setDisabled(false);
        closeReflection();
        closeSOS();
        clearError();

        resetToIdle(); // Clean animation reset

        try {
        await ensureSession();
        } catch (error) {
        showError("Failed to start new session. Please check your connection and try again.");
        }
    }

    // ---------- Core Flow ----------
    async function handleSend(){
        if (inFlight) return;
        const text = (t.value || "").trim();
        if (!text) return;

        if (text.length > 2000) {
        showError("Message too long. Please keep it under 2000 characters.");
        return;
        }

        clearError();

        // add user bubble immediately in the timeline
        addUserEntry(role, text);
        t.value = "";

        // typing row only if about to trigger Lumen (after 6th message)
        const willTriggerLumen = (steps >= 5);
        let typingRow = null;
        if (willTriggerLumen) typingRow = addTypingEntry();

        setDisabled(true);
        try{
        await ensureSession();
        const r = await fetchWithRetry(BASE + "/api/message", {
            method:"POST",
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ sessionId, role, text })
        });

        const j = await r.json();

        // crisis -> SOS sheet
        if (j.crisis){
    if (typingRow){
        typingRow.row.remove();
        typingRow.tag.remove();
    }
    openSOS(j.alertMessage, j.hotlinesUrl, j.resourcesUrl);
            t.disabled = true;
            sendBtn.disabled = true;
            composer.classList.add("disabled");
            return;
        }

        steps++;
        paintPills(steps);

        if (j.awaitMore) {
        // mid-cycle, flip role
        role = (role === "self") ? "monster" : "self";
        setComposerRole();
        focusAfterSend = true;
            
        if (typingRow){
            typingRow.row.remove();
            typingRow.tag.remove();
        }

        } else {
            // full cycle -> Lumen reply
            const angel = (j.angel || j.lumen || "").trim();
            let lumenNode = null;

            if (typingRow){
            lumenNode = typingRow.bub;
            typingRow.bub.textContent = "";
            typingRow.row.classList.remove("typing");
            typingRow.row.removeAttribute("aria-label");
            } else {
            const made = makeEntry("lumen", "");
            timeline.appendChild(made.row);
            lumenNode = made.bub;
            const tag = document.createElement("div");
            tag.className = "tag";
            tag.textContent = "LUMEN";
            timeline.appendChild(tag);
            }

            if (angel) {
            typewriter(lumenNode, angel, SPEED_CHAR_CHAT_LUMEN, ()=>{
                lumenNode.setAttribute("aria-live", "polite");
                lumenNode.setAttribute("aria-label", "Lumen's response completed");
            });
            setTimeout(() => openReflection(angel), 1000);
            }

            // reset cycle
            role = "self";
            steps = 0;
            paintPills(steps);
            setComposerRole();
            focusAfterSend = true;

        }
            } catch (e) {
        console.error("Message send error:", e);

        if (typingRow){
            typingRow.row.remove();
            typingRow.tag.remove();
        }

        const err = makeEntry("lumen", "Network error. Please check the server and try again.");
        timeline.appendChild(err.row);
        const tag = document.createElement("div");
        tag.className="tag";
        tag.textContent="SYSTEM";
        timeline.appendChild(tag);
        scrollTimeline();

        showError("Failed to send message. Please check your connection and try again.");
        } finally {
    setDisabled(false);
    updateStackHeight(); // recalc in case textarea/cards changed

    // If we requested focus and no modal/sos is open, focus the textarea
    if (focusAfterSend && !modal.classList.contains("open") && !sos.classList.contains("open")) {
        focusAfterSend = false;
        requestAnimationFrame(() => {
        t.focus();
        try { t.setSelectionRange(t.value.length, t.value.length); } catch {}
        });
    }
    }

    }

    // ---------- Keyboard Navigation ----------
    function handleKeyNavigation(e) {
    if (e.key === 'Escape') {
        if (modal.classList.contains('open')) {
        closeReflection();
        } else if (sos.classList.contains('open')) {
        closeSOS();
        } else if (help.classList.contains('open')) {
        help.classList.remove('open');
        help.setAttribute('aria-hidden', 'true');
        }
    }
    }

    // ---------- Auto-resize textarea ----------
    function autoResize() {
        t.style.height = 'auto';
        const maxHeight = 200; // px
        const newHeight = Math.min(t.scrollHeight, maxHeight);
        t.style.height = newHeight + 'px';
        t.style.overflowY = t.scrollHeight > maxHeight ? 'auto' : 'hidden';
        updateStackHeight();
    }

    // ---------- Init ----------

    // cleanup: remove any stray dots on startup
    timeline.querySelectorAll('.dots').forEach(el => el.remove());

    (async () => {
        paintPills(steps);
        setComposerRole();

        // compute stack height after layout paints
        updateStackHeight();
        requestAnimationFrame(updateStackHeight);
        setTimeout(updateStackHeight, 100);
        resetToIdle(); // Ensure clean animation start

        try {
        await ensureSession();
        } catch (error) {
        showError("Failed to connect. Please refresh the page and try again.");
        }
    })();

    // ---------- Events ----------
    sendBtn.addEventListener("click", handleSend);

    t.addEventListener("keydown", e=>{
        if (e.key === "Enter" && !e.shiftKey){
        e.preventDefault();
        handleSend();
        }
    });

    t.addEventListener("input", autoResize);

    // Global keyboard navigation
    document.addEventListener("keydown", handleKeyNavigation);

    // Reflection modal events
    closeBtn.addEventListener("click", closeReflection);
    modal.addEventListener("click", (e)=> {
        if (e.target === modal) closeReflection();
    });

    copyBtn.addEventListener("click", async () => {
        try {
        await navigator.clipboard.writeText(modalText.textContent);
        copyBtn.textContent = "Copied!";
        copyBtn.setAttribute("aria-label", "Text copied to clipboard");
        setTimeout(()=> {
            copyBtn.textContent = "Copy";
            copyBtn.setAttribute("aria-label", "Copy reflection text");
        }, 1200);
        } catch {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = modalText.textContent;
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            copyBtn.textContent = "Copied!";
            setTimeout(()=> copyBtn.textContent = "Copy", 1200);
        } catch {
            showError("Could not copy text. Please select and copy manually.");
        }
        document.body.removeChild(ta);
        }
    });

    // SOS sheet events
    sosClose.addEventListener("click", closeSOS);
    sos.addEventListener("click", (e)=> {
        if (e.target === sos) closeSOS();
    });
    sosReset.addEventListener("click", startNew);

    // Menu burger (placeholder)
    const burger = document.querySelector('.burger');
    burger.addEventListener('click', () => {
        console.log('Menu clicked - implement settings/help menu');
    });
    burger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.currentTarget.click();
        }
    });

    // Help button -> open Help sheet
    helpBtn.addEventListener("click", () => {
    help.classList.add("open");
    help.setAttribute("aria-hidden", "false");
    });

    // Close Help sheet
    helpClose.addEventListener("click", () => {
    help.classList.remove("open");
    help.setAttribute("aria-hidden", "true");
    });

    // Click outside the card to close
    help.addEventListener("click", (e) => {
    if (e.target === help) {
        help.classList.remove("open");
        help.setAttribute("aria-hidden", "true");
    }
    });

    // Online/offline detection
    window.addEventListener('online', () => {
        statusBar.className = "status-bar";
        clearError();
    });
    window.addEventListener('offline', () => {
        statusBar.textContent = "No internet connection";
        statusBar.className = "status-bar error";
        showError("You're offline. Please check your internet connection.");
    });

    // Prevent Enter when disabled
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (t.disabled || sendBtn.disabled) && e.target === t) {
        e.preventDefault();
        }
    });

    // Auto-focus textarea on load
    setTimeout(() => {
        if (!t.disabled) t.focus();
    }, 100);

    // Recompute on orientation/zoom heuristics
    window.addEventListener('orientationchange', updateStackHeight);
    })();
