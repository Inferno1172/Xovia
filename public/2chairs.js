(() => {
  // ---------- Config ----------
  const API_BASE = ""; // same origin as your site on Render
  const SPEED_CHAR_CHAT_LUMEN = 8;
  const SPEED_CHAR_MODAL = 10;
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;
  const SPEAK_TAIL = 280;

  // ---------- State ----------
  let sessionId = localStorage.getItem("tc_sessionId") || null;
  let role = "self";
  let steps = 0;
  let inFlight = false;
  let focusAfterSend = false;

  // ---------- Elements ----------
  const phone = document.querySelector(".phone");
  const cards = document.getElementById("cards");
  const composer = document.getElementById("composer");
  const t = document.getElementById("t");
  const sendBtn = document.getElementById("send");
  const timeline = document.getElementById("timeline");
  const pills = Array.from({ length: 6 }, (_, i) => document.getElementById("p" + i));
  const statusBar = document.getElementById("statusBar");
  const errorMessage = document.getElementById("errorMessage");
  const selfBlob = document.getElementById("selfBlob");
  const monsterBlob = document.getElementById("monsterBlob");

  const modal = document.getElementById("modal");
  const modalText = document.getElementById("modalText");
  const closeBtn = document.getElementById("closeBtn");
  const copyBtn = document.getElementById("copyBtn");
  const sos = document.getElementById("sos");
  const sosMsg = document.getElementById("sosMsg");
  const sosLink = document.getElementById("sosLink");
  const sosClose = document.getElementById("sosClose");
  const sosReset = document.getElementById("sosReset");
  const help = document.getElementById("help");
  const helpBtn = document.getElementById("helpBtn");
  const helpClose = document.getElementById("helpClose");

  const burger = document.getElementById('burger');
  const menu = document.getElementById('menu');
  const go1 = document.getElementById('go1to1');

  burger.addEventListener('click', () => {
    menu.style.display = (menu.style.display === 'none' || !menu.style.display) ? 'block' : 'none';
  });
  document.addEventListener('click', (e)=>{
    if(menu && !menu.contains(e.target) && e.target !== burger) {
      menu.style.display = 'none';
    }
  });
  go1.addEventListener('click', () => { window.location.href = '1to1.html'; });


  // ------------------ API helpers ------------------
  async function fetchWithRetry(url, opts, retries = MAX_RETRIES) {
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await fetch(url, opts);
        if (r.ok) return r;
        if (r.status >= 500 && i < retries) {
          await new Promise((res) => setTimeout(res, RETRY_DELAY * (i + 1)));
          continue;
        }
        return r;
      } catch (e) {
        if (i < retries) {
          await new Promise((res) => setTimeout(res, RETRY_DELAY * (i + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  // Start a new session
  async function startSession() {
    const r = await fetchWithRetry(`${API_BASE}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "two-chairs" }),
    });
    const j = await r.json();
    sessionId = j.sessionId;
    localStorage.setItem("tc_sessionId", sessionId);
    console.log("New session ID:", sessionId);
    return sessionId;
  }

  // Ensure there is a session
  async function ensureSession() {
    if (sessionId) return;
    await startSession();
  }

  // ---------- Cards ----------
  const defaultCardsHTML = cards ? cards.innerHTML : "";

  function escapeHtml(s) {
    return (s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function restoreDefaultCards() {
    if (!cards) return;
    cards.innerHTML = defaultCardsHTML;
    updateStackHeight();
  }

  function showSuggestions(suggestions) {
    if (!cards) return;
    const items = (suggestions || [])
      .slice(0, 4)
      .map((s) => {
        const esc = escapeHtml(s);
        return `<div class="ghost suggestion" role="button" tabindex="0" data-text="${esc}">${esc}</div>`;
      })
      .join("");

    cards.innerHTML = `
      <div class="card">
        <h4>Suggested replies</h4>
        ${items}
      </div>
    `;

    cards.querySelectorAll(".suggestion").forEach((el) => {
      el.addEventListener("click", () => {
        t.value = el.getAttribute("data-text") || "";
        t.focus();
        autoResize();
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          el.click();
        }
      });
    });

    updateStackHeight();
  }

  // NEW → Monster-turn helper (replaces the default two cards on MONSTER turns)
  function showMonsterGuide() {
    if (!cards) return;
    cards.innerHTML = `
      <div class="card">
        <h4>Write as your Monster</h4>
        <div class="ghost"><strong>Say it exactly</strong> how it shows up in your head — even if it’s harsh.</div>
        <div class="ghost"><strong>Keep it short:</strong> 1–2 sentences.</div>
        <div class="ghost"><strong>Point it at this situation</strong> (exam, surgery, relationship, etc.).</div>
      </div>
    `;
    updateStackHeight();
  }

  // ---------- Layout ----------
  function updateStackHeight() {
    if (!phone) return;
    const phoneRect = phone.getBoundingClientRect();
    const cardsTop = cards ? cards.getBoundingClientRect().top : phoneRect.bottom;
    const composerTop = composer ? composer.getBoundingClientRect().top : phoneRect.bottom;
    const firstStackTop = Math.min(cardsTop, composerTop);
    let stackH = phoneRect.bottom - firstStackTop;
    stackH = Math.max(0, Math.round(stackH) + 8);
    phone.style.setProperty("--stackH", stackH + "px");
  }
  const ro = new ResizeObserver(() => {
    updateStackHeight();
    scrollTimeline();
  });
  if (composer) ro.observe(composer);
  if (cards) ro.observe(cards);
  window.addEventListener("resize", updateStackHeight);

  // ---------- Animation ----------
  let animationTimeouts = new Set();
  function clearAnimationTimeouts() {
    animationTimeouts.forEach((timeout) => clearTimeout(timeout));
    animationTimeouts.clear();
  }
  function setCharacterState(character, state) {
    const blob = character === "self" ? selfBlob : monsterBlob;
    if (!blob) return;
    const chair = blob.closest(".chair");
    blob.classList.remove("state-idle", "state-active", "state-talking", "state-listening");
    if (chair) {
      chair.classList.remove("speaking", "active");
    }
    if (state && state !== "idle") {
      blob.classList.add(`state-${state}`);
    }
    if (chair) {
      if (state === "talking") chair.classList.add("speaking");
      if (state === "active") chair.classList.add("active");
    }
  }
  function resetToIdle() {
    clearAnimationTimeouts();
    setCharacterState("self", "idle");
    setCharacterState("monster", "idle");
  }
  function setActiveCharacter(activeRole) {
    clearAnimationTimeouts();
    if (activeRole === "self") {
      setCharacterState("self", "active");
      setCharacterState("monster", "idle");
    } else if (activeRole === "monster") {
      setCharacterState("monster", "active");
      setCharacterState("self", "idle");
    } else {
      resetToIdle();
    }
  }
  function smoothReturnToNeutral() {
    const time = setTimeout(() => resetToIdle(), SPEAK_TAIL);
    animationTimeouts.add(time);
  }
  function setSpeaking(who, on = true) {
    setCharacterState(who, on ? "talking" : "listening");
    if (!on) smoothReturnToNeutral();
  }
  function setComposerRole() {
    const isSelf = role === "self";
    t.placeholder = isSelf ? "Type as SELF…" : "Type as MONSTER…";
    setActiveCharacter(role);
  }
  function paintPills(n) {
    pills.forEach((p, i) => p.classList.toggle("on", i < n));
  }
  function scrollTimeline() {
    try {
      timeline.scrollTop = timeline.scrollHeight;
    } catch {}
  }

  // ---------- Timeline helpers ----------
  function makeEntry(role, text) {
    const row = document.createElement("div");
    row.className = "entry " + role;
    const bub = document.createElement("div");
    bub.className = "bubble";
    bub.textContent = text || "";
    row.appendChild(bub);
    return { row, bub };
  }
  function addUserEntry(role, text) {
    const made = makeEntry(role, text);
    timeline.appendChild(made.row);
    const tag = document.createElement("div");
    tag.className = "tag " + (role === "self" ? "left" : "right");
    tag.textContent = role.toUpperCase();
    timeline.appendChild(tag);
    setSpeaking(role, true);
    setTimeout(() => setSpeaking(role, false), 900);
    scrollTimeline();
    return made;
  }
  function addTypingEntry() {
    const made = makeEntry("lumen", "");
    made.row.classList.add("typing");
    const dots = document.createElement("span");
    dots.className = "dots";
    dots.innerHTML = `<span></span><span></span><span></span>`;
    made.bub.setAttribute("aria-label", "Lumen is typing");
    made.bub.appendChild(dots);
    timeline.appendChild(made.row);
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = "LUMEN";
    timeline.appendChild(tag);
    scrollTimeline();
    return { row: made.row, bub: made.bub, tag };
  }

  // ---------- Modal helpers ----------
  function openReflection(text) {
    modalText.textContent = text;
    modal.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeReflection() {
    modal.classList.remove("open");
    document.body.style.overflow = "";
    t.focus();
  }
  function openSOS(message, link, resources) {
    sosMsg.textContent = message || sosMsg.textContent;
    if (link) sosLink.href = link;
    const res = document.getElementById("sosResources");
    if (resources) res.href = resources;
    sos.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeSOS() {
    sos.classList.remove("open");
    document.body.style.overflow = "";
    t.focus();
  }

  // ---------- Utils ----------
  function autoResize() {
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 200) + "px";
    updateStackHeight();
  }
  function setDisabled(v) {
    t.disabled = v;
    sendBtn.disabled = v;
    composer.classList.toggle("disabled", v);
  }
  function showError(msg) {
    statusBar.textContent = msg;
    statusBar.classList.add("show");
    errorMessage.textContent = msg;
    errorMessage.style.display = "block";
  }
  function clearError() {
    statusBar.textContent = "";
    statusBar.classList.remove("show");
    errorMessage.textContent = "";
    errorMessage.style.display = "none";
  }

  // ---------- Core flow ----------
  async function handleSend() {
    if (inFlight) return;
    const text = (t.value || "").trim();
    if (!text) return;

    clearError();
    addUserEntry(role, text);
    t.value = "";

    const willTriggerLumen = steps >= 5;
    let typingRow = null;
    if (willTriggerLumen) typingRow = addTypingEntry();

    setDisabled(true);
    try {
      await ensureSession();
      const r = await fetchWithRetry(`${API_BASE}/api/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, role, text }),
      });
      const j = await r.json();

      if (j.crisis) {
        if (typingRow) {
          typingRow.row.remove();
          typingRow.tag.remove();
        }
        openSOS(j.alertMessage, j.hotlinesUrl, j.resourcesUrl);
        return;
      }

      steps++;
      paintPills(steps);

      if (j.awaitMore) {
        // flip turn
        role = role === "self" ? "monster" : "self";
        setComposerRole();
        focusAfterSend = true;

        // SELF: show suggestions (if provided). MONSTER: show the new guide.
        if (role === "self" && Array.isArray(j.suggestions) && j.suggestions.length) {
          showSuggestions(j.suggestions);
        } else if (role === "monster") {
          showMonsterGuide();
        } else {
          restoreDefaultCards();
        }

        if (typingRow) {
          typingRow.row.remove();
          typingRow.tag.remove();
        }
      } else {
        const angel = (j.angel || j.lumen || "").trim();
        let lumenNode = null;
        if (typingRow) {
          lumenNode = typingRow.bub;
          typingRow.bub.textContent = "";
          typingRow.row.classList.remove("typing");
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
          typewriter(lumenNode, angel, SPEED_CHAR_CHAT_LUMEN, () => {
            lumenNode.setAttribute("aria-live", "polite");
          });
          setTimeout(() => openReflection(angel), 1000);
        }
        role = "self";
        steps = 0;
        paintPills(steps);
        setComposerRole();
        focusAfterSend = true;
        restoreDefaultCards();
      }
    } catch (e) {
      console.error(e);
      showError("Network error — please try again.");
      setTimeout(clearError, 2000);
    } finally {
      setDisabled(false);
      updateStackHeight();
      if (focusAfterSend && !modal.classList.contains("open") && !sos.classList.contains("open")) {
        focusAfterSend = false;
        requestAnimationFrame(() => {
          t.focus();
        });
      }
    }
  }

  // ---------- Typewriter ----------
  function typewriter(node, text, speed, done) {
    node.textContent = "";
    let i = 0;
    const timer = setInterval(() => {
      node.textContent += text[i++];
      if (i >= text.length) {
        clearInterval(timer);
        if (done) done();
      }
    }, Math.max(1, 1000 / Math.max(1, speed)));
  }

  // ---------- Init ----------
  paintPills(steps);
  setComposerRole();
  updateStackHeight();
  requestAnimationFrame(updateStackHeight);
  setTimeout(updateStackHeight, 100);

  // auto-start a session
  window.addEventListener("DOMContentLoaded", async () => {
    await ensureSession();
  });

  sendBtn.addEventListener("click", handleSend);
  t.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  t.addEventListener("input", autoResize);

  closeBtn.addEventListener("click", closeReflection);
  sosClose.addEventListener("click", closeSOS);
  sosReset.addEventListener("click", () => window.location.reload());
  helpBtn?.addEventListener("click", () => {
    help.classList.add("open");
  });
  helpClose?.addEventListener("click", () => {
    help.classList.remove("open");
  });
})();
