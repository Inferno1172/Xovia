import os, re, json, sqlite3, uuid
from datetime import datetime
from typing import List, Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import OpenAI

# ------------ Env & OpenAI ------------
load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
REPLY_MODEL     = os.getenv("REPLY_MODEL", "gpt-4.1-mini")
TONE_MODEL      = os.getenv("TONE_MODEL",  "gpt-4.1-mini")
MOD_MODEL       = os.getenv("MOD_MODEL",   "omni-moderation-latest")
PORT            = int(os.getenv("PORT", "3000"))
SOS_HOTLINES_URL  = os.getenv("SOS_HOTLINES_URL", "https://www.sos.org.sg/contact")
SOS_RESOURCES_URL = os.getenv(
    "SOS_RESOURCES_URL",
    "https://www.healthhub.sg/well-being-and-lifestyle/mental-wellness/mental-wellbeing"
)

if not OPENAI_API_KEY:
    raise RuntimeError("Missing OPENAI_API_KEY in .env")

client = OpenAI(api_key=OPENAI_API_KEY)

# ------------ FastAPI ------------
app = FastAPI(title="Two Chairs Backend (Python)")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r".*",   # accept everything, including file:// (null origin)
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,    # keep False when using wildcard origins
)

# ------------ SQLite ------------
conn = sqlite3.connect("data.db", check_same_thread=False)
conn.row_factory = sqlite3.Row

def init_db():
    cur = conn.cursor()
    cur.executescript("""
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      trusted_contact TEXT,
      user_summary TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      mode TEXT,
      status TEXT DEFAULT 'active',
      summary TEXT DEFAULT '',
      started_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT CHECK(role IN ('self','monster','angel')),
      text TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      type TEXT, -- 'cycle-negative' | 'crisis'
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    """)
    try: conn.execute("ALTER TABLE users ADD COLUMN user_summary TEXT DEFAULT ''")
    except Exception: pass
    try: conn.execute("ALTER TABLE sessions ADD COLUMN summary TEXT DEFAULT ''")
    except Exception: pass
    conn.commit()

init_db()

# ------------ Models ------------
class UserCreate(BaseModel):
    displayName: Optional[str] = None
    trustedContact: Optional[str] = None

class SessionCreate(BaseModel):
    userId: Optional[str] = None
    mode: Optional[str] = "two-chairs"

class MessageCreate(BaseModel):
    sessionId: str
    role: Literal["self","monster"]
    text: str

# ------------ Therapy Prompts & Checks ------------
SYSTEM_PROMPT = """
export const SYSTEM_PROMPT = `
You are Lumen, the Angel voice in a mental-health wellness app called **XOVIA** under the *Two Chairs Dialogue*.

## Mission & Boundaries
- Help users explore Self vs Monster (inner critic).
- Build safety, care, and unconditional acceptance.
- Provide wellness support only; no diagnosis, no treatment claims, no promises of safety.

## Therapeutic Style (CBT, ACT, MI)
- Validate → gently challenge → reframe → one small step.
- Adapt to stage of change.
- Tone: warm, calm, professional; short paragraphs; plain words.
- Use therapist-like phrasing; avoid being a yes-man.

## Two Chairs Protocol
- The frontend collects 3 pairs: SELF1/MONSTER1, SELF2/MONSTER2, SELF3/MONSTER3.
- Backend calls you with CYCLE_READY: true + the 6 snippets, or a single message clearly containing all 6 labeled snippets.
- Only with a full cycle, produce one integrated reply that validates, challenges distortions, and proposes one small actionable next step.
- If not a full cycle (CYCLE_READY: false), reply with ONE sentence that advances the protocol (e.g., prompt the next Self/Monster message).

## Safety & Crisis
- If any suicidal/self-harm/violence risk appears:
  1) Output exactly: “We identified harmful words in your conversation. Life is worth living — you are not alone. We’ve alerted your chosen trusted contact. In the meantime, click below to see all available help and hotlines: {{SOS_URL}}”
  2) Stop. Do not continue normal dialogue.

## Personalization
- Assume prior messages are stored; you may briefly reference past themes to personalize support.

## Output Rules
- CYCLE_READY: true → 2–4 short paragraphs + one specific next step.
- CYCLE_READY: false → one-sentence coaching prompt.
- No diagnosis. No medical claims. No long lectures.
`;
"""

CRISIS_PATTERNS = [
    re.compile(r"kill myself", re.I),
    re.compile(r"suicide", re.I),
    re.compile(r"end my life", re.I),
    re.compile(r"want to die", re.I),
    re.compile(r"don'?t want to live", re.I),
    re.compile(r"hurt myself", re.I),
    re.compile(r"self[-\s]?harm", re.I),
    re.compile(r"cutting myself", re.I),
    re.compile(r"overdose", re.I),
    re.compile(r"jump off", re.I),
]

NEGATIVE_HINTS = [
    re.compile(r"\bi can'?t\b", re.I),
    re.compile(r"\bi won'?t\b", re.I),
    re.compile(r"\bnever\b", re.I),
    re.compile(r"\bhopeless\b", re.I),
    re.compile(r"\bworthless\b", re.I),
    re.compile(r"\bfail(ed|ing)?\b", re.I),
    re.compile(r"pointless|no point", re.I),
    re.compile(r"stupid|useless", re.I),
    re.compile(r"always mess", re.I),
    re.compile(r"nothing works", re.I),
]

USE_MODEL_TONE = False

# --- Memory knobs (make recall easy) ---
ALWAYS_INCLUDE_SESSION_SUMMARY = False
ALWAYS_INCLUDE_USER_SUMMARY    = False
MIN_OVERLAP                    = 2

def check_crisis_local(text: str) -> bool:
    return any(rx.search(text) for rx in CRISIS_PATTERNS)

def looks_negative_local(text: str) -> bool:
    return any(rx.search(text) for rx in NEGATIVE_HINTS)

# ------------ Memory relevance ------------
_STOP = set(("a an and are as at be but by for from has have i if in into is it its of on or so that the their them there they this to was we what when where which who why will with you your".split()))
def _kw(s: str) -> set:
    import re
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if len(w) >= 3 and w not in _STOP}

def is_connected_to_summary(current_round_text: str, summary_text: str, min_overlap: int = 3) -> bool:
    if not summary_text:
        return False
    return len(_kw(current_round_text) & _kw(summary_text)) >= min_overlap

def get_current_cycle(session_id: str):
    cur = conn.cursor()
    cur.execute("""
        SELECT role, text FROM messages
        WHERE session_id = ?
        ORDER BY id ASC
    """, (session_id,))
    rows = cur.fetchall()
    last_angel_idx = -1
    for i in range(len(rows)-1, -1, -1):
        if rows[i]["role"] == "angel":
            last_angel_idx = i
            break
    slice_rows = rows[last_angel_idx+1:]
    selfs = [r["text"] for r in slice_rows if r["role"] == "self"]
    monsters = [r["text"] for r in slice_rows if r["role"] == "monster"]
    return selfs, monsters

def build_two_chairs_prompt(selfs: List[str], monsters: List[str]) -> str:
    lines = []
    for i in range(max(len(selfs), len(monsters))):
        if i < len(selfs):
            lines.append(f"SELF {i+1}: {selfs[i]}")
        if i < len(monsters):
            lines.append(f"MONSTER {i+1}: {monsters[i]}")
    return f"""
We ran a Two Chairs exercise. Here are the entries:

{chr(10).join("• " + l for l in lines)}

Now respond as Lumen. Follow your rules and the ZERO-ECHO rule:
- Do NOT repeat the Monster’s wording; refer to it indirectly as “that harsh thought” or “that fear”.
- Validate briefly.
- Gently challenge at least one thought.
- Reframe with a more helpful perspective.
- Offer ONE small, doable next step (action or reflection) they can try today.
Keep it warm and compact. Aim for around 180–230 words, with at most 1–2 short questions.
""".strip()

def parse_output_text(resp) -> str:
    text = getattr(resp, "output_text", None)
    if text:
        return text.strip()
    try:
        blocks = resp.output[0].content
        for b in blocks:
            if b.type == "output_text":
                return b.text.strip()
    except Exception:
        pass
    return "I'm here with you."

def classify_negatives_with_model(texts: List[str]) -> List[bool]:
    prompt = (
        'Return JSON only: {"labels":[booleans matching each input as negative or not]}.\n'
        'Mark "negative" when there is self-judgment, hopelessness about self, global negative self-evaluation, or strongly pessimistic outlook.\n\n'
        + "\n".join([f"#{i+1}: {json.dumps(t)}" for i, t in enumerate(texts)])
    )
    try:
        resp = client.responses.create(
            model=TONE_MODEL,
            input=[
                {"role": "system", "content": "Return only valid JSON. No preface."},
                {"role": "user", "content": prompt},
            ],
        )
        out = parse_output_text(resp)
        data = json.loads(out)
        labels = data.get("labels")
        if isinstance(labels, list) and len(labels) == len(texts):
            return [bool(x) for x in labels]
    except Exception:
        pass
    return [looks_negative_local(t) for t in texts]

# --------- NEW: personalised suggestions using the WHOLE current conversation ---------
def _truncate(s: str, limit: int) -> str:
    if len(s) <= limit: return s
    return s[:limit-1] + "…"

def generate_self_suggestions_full_context(selfs: List[str], monsters: List[str]) -> List[str]:
    """
    Create 4 short, first-person, compassionate SELF reply ideas for the *next* round.
    Personalises using the WHOLE current cycle (all SELF + MONSTER lines so far).
    Guardrails:
      - 6–14 words
      - begin with 'I …'
      - ZERO-ECHO: do not repeat harsh labels/slurs
      - provide variety: (1) validate/feelings, (2) strengths/values/effort, (3) tiny step/plan, (4) kinder reframe
    """
    # Build compact context list like "SELF1: ..., MONSTER1: ..."
    pairs = []
    for i in range(max(len(selfs), len(monsters))):
        if i < len(selfs):
            pairs.append(f"SELF{i+1}: {selfs[i]}")
        if i < len(monsters):
            pairs.append(f"MONSTER{i+1}: {monsters[i]}")
    convo = _truncate(" | ".join(pairs), 1600)  # keep token usage in check

    last_self = selfs[-1] if selfs else ""
    last_mon  = monsters[-1] if monsters else ""

    prompt = f"""
Return JSON only: {{"suggestions":["...","...","...","..."]}}

You are a supportive coach in a Two Chairs exercise (Self vs Monster).
Write 4 *first-person* reply ideas the user (SELF) could try next, using the FULL context below.

FULL CONTEXT (ordered):
{convo}

Most recent SELF: {last_self!r}
Most recent MONSTER: {last_mon!r}

Rules:
- ZERO-ECHO: don't repeat the critic's harsh labels; refer indirectly (e.g., "that harsh thought").
- 6–14 words each. Start every line with “I ”.
- Provide this spread:
  1) gently name/validate the feeling,
  2) remind a strength/value or prior effort from context,
  3) propose one tiny next step the user can actually do soon,
  4) offer a kinder reframe of the situation.
- Context-specific, natural phrasing (avoid generic platitudes).
- No clinical claims. No toxic positivity. No questions.
"""
    try:
        resp = client.responses.create(
            model=REPLY_MODEL, temperature=0.2,
            input=[
                {"role": "system", "content": "Return only valid JSON. No preface."},
                {"role": "user", "content": prompt},
            ],
        )
        data = json.loads(parse_output_text(resp))
        sugs = data.get("suggestions") or []
        clean = []
        for s in sugs:
            if not isinstance(s, str): continue
            s = s.strip()
            if not s.lower().startswith("i "): continue
            wc = len(s.split())
            if 6 <= wc <= 14:
                clean.append(s)
        # Fallbacks (neutral but session-aware phrasing)
        if len(clean) < 4:
            fallback = [
                "I notice what I’m feeling, and it makes sense right now.",
                "I can recognise my effort and let that count for something.",
                "I’ll take one small step next, then give myself a short break.",
                "I’m learning to speak to myself with a kinder voice.",
            ]
            clean = (clean + fallback)[:4]
        # de-dup
        uniq = []
        for s in clean:
            if s not in uniq: uniq.append(s)
        return uniq[:4]
    except Exception:
        return [
            "I notice what I’m feeling, and it makes sense right now.",
            "I can recognise my effort and let that count for something.",
            "I’ll take one small step next, then give myself a short break.",
            "I’m learning to speak to myself with a kinder voice.",
        ]

# ------------ DB Helpers ------------
def insert_user(display_name: Optional[str], trusted_contact: Optional[str]) -> str:
    uid = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO users (id, display_name, trusted_contact) VALUES (?,?,?)",
        (uid, display_name, trusted_contact),
    )
    conn.commit()
    return uid

def insert_session(user_id: Optional[str], mode: str) -> str:
    sid = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO sessions (id, user_id, mode) VALUES (?,?,?)",
        (sid, user_id, mode),
    )
    conn.commit()
    return sid

def insert_message(session_id: str, role: str, text: str):
    conn.execute(
        "INSERT INTO messages (session_id, role, text) VALUES (?,?,?)",
        (session_id, role, text),
    )
    conn.commit()

def insert_alert(session_id: str, type_: str, payload: dict):
    conn.execute(
        "INSERT INTO alerts (session_id, type, payload) VALUES (?,?,?)",
        (session_id, type_, json.dumps(payload)),
    )
    conn.commit()

# ------------ Summary (SQLite) ------------
def get_sql_summary(session_id: str) -> str:
    row = conn.execute("SELECT summary FROM sessions WHERE id=?", (session_id,)).fetchone()
    return row["summary"] if row and row["summary"] else ""

def set_sql_summary(session_id: str, text: str):
    conn.execute("UPDATE sessions SET summary=? WHERE id=?", (text, session_id))
    conn.commit()

# --- Cross-session (user-level) summary helpers ---
def get_user_id_for_session(session_id: str) -> Optional[str]:
    row = conn.execute("SELECT user_id FROM sessions WHERE id=?", (session_id,)).fetchone()
    return row["user_id"] if row and row["user_id"] else None

def get_user_summary(user_id: str) -> str:
    row = conn.execute("SELECT user_summary FROM users WHERE id=?", (user_id,)).fetchone()
    return row["user_summary"] if row and row["user_summary"] else ""

def set_user_summary(user_id: str, text: str):
    conn.execute("UPDATE users SET user_summary=? WHERE id=?", (text, user_id))
    conn.commit()

# --- Session status ---
def get_session_status(session_id: str) -> Optional[str]:
    row = conn.execute("SELECT status FROM sessions WHERE id=?", (session_id,)).fetchone()
    return row["status"] if row else None

def set_session_status(session_id: str, status: str):
    conn.execute("UPDATE sessions SET status=? WHERE id=?", (status, session_id))
    conn.commit()

# ------------ Routes ------------
@app.get("/api/health")
def health():
    return {"ok": True, "time": datetime.utcnow().isoformat()}

@app.post("/api/user")
def create_user(body: UserCreate):
    uid = insert_user(body.displayName, body.trustedContact)
    return {"userId": uid}

@app.post("/api/session")
def create_session(body: SessionCreate):
    uid = body.userId or insert_user(display_name=None, trusted_contact=None)
    sid = insert_session(uid, body.mode or "two-chairs")
    return {"sessionId": sid, "userId": uid, "teach": "Two Chairs ready."}

@app.get("/api/session/{session_id}/messages")
def get_messages(session_id: str):
    cur = conn.cursor()
    cur.execute(
        "SELECT id, role, text, created_at FROM messages WHERE session_id=? ORDER BY id ASC",
        (session_id,),
    )
    return {"messages": [dict(r) for r in cur.fetchall()]}

@app.post("/api/message")
def post_message(body: MessageCreate):
    if not body.sessionId or not body.role or not body.text:
        raise HTTPException(status_code=400, detail="sessionId, role, text are required")
    if body.role not in ("self", "monster"):
        raise HTTPException(status_code=400, detail="role must be 'self' or 'monster'")

    text = body.text.strip()

    # crisis lock
    status = get_session_status(body.sessionId)
    if status == "crisis":
        return {
            "crisis": True,
            "locked": True,
            "alertMessage": "We identified harmful words in your conversation. Life is worth living — you are not alone.",
            "hotlinesUrl": SOS_HOTLINES_URL,
            "resourcesUrl": SOS_RESOURCES_URL
        }

    # local crisis
    if check_crisis_local(text):
        insert_message(body.sessionId, body.role, text)
        insert_alert(body.sessionId, "crisis", {"matched": "keyword"})
        set_session_status(body.sessionId, "crisis")
        return {
            "crisis": True,
            "locked": True,
            "alertMessage": "We identified harmful words in your conversation. Life is worth living — you are not alone.",
            "hotlinesUrl": SOS_HOTLINES_URL,
            "resourcesUrl": SOS_RESOURCES_URL,
            "notifiedTrustedContact": False
        }

    # moderation (OpenAI)
    try:
        mod = client.moderations.create(model=MOD_MODEL, input=text)
        flagged = False
        try:
            flagged = bool(mod.results[0].categories.self_harm)
        except Exception:
            flagged = False
        if flagged:
            insert_message(body.sessionId, body.role, text)
            insert_alert(body.sessionId, "crisis", {"matched": "moderation"})
            set_session_status(body.sessionId, "crisis")
            return {
                "crisis": True,
                "locked": True,
                "alertMessage": "We identified harmful words in your conversation. Life is worth living — you are not alone.",
                "hotlinesUrl": SOS_HOTLINES_URL,
                "resourcesUrl": SOS_RESOURCES_URL,
                "notifiedTrustedContact": False
            }
    except Exception:
        pass

    # store the message
    insert_message(body.sessionId, body.role, text)

    # figure out cycle progress
    selfs, monsters = get_current_cycle(body.sessionId)
    total = len(selfs) + len(monsters)

    # -------- Suggestions after ANY Monster turn while cycle isn't complete --------
    if total < 6:
        payload = {
            "awaitMore": True,
            "have": {"self": len(selfs), "monster": len(monsters)},
            "need": 6 - total
        }
        # If last message was Monster → next input is SELF → include 4 suggestions using FULL CONTEXT
        if body.role == "monster" and len(monsters) >= 1 and len(selfs) == len(monsters):
            payload["suggestions"] = generate_self_suggestions_full_context(selfs, monsters)
        return payload
    # -----------------------------------------------------------------------------

    # tone (for safety popup after full cycle)
    if USE_MODEL_TONE:
        self_labels = classify_negatives_with_model(selfs)
    else:
        self_labels = [looks_negative_local(t) for t in selfs]

    # memory composition
    current_round_text = " ".join(selfs + monsters)
    session_summary = get_sql_summary(body.sessionId)
    user_id = get_user_id_for_session(body.sessionId)
    user_summary = get_user_summary(user_id) if user_id else ""

    use_session_summary = bool(session_summary) if ALWAYS_INCLUDE_SESSION_SUMMARY else \
        is_connected_to_summary(current_round_text, session_summary, min_overlap=MIN_OVERLAP)
    use_user_summary = bool(user_summary) if ALWAYS_INCLUDE_USER_SUMMARY else \
        is_connected_to_summary(current_round_text, user_summary, min_overlap=MIN_OVERLAP)

    twc_block = build_two_chairs_prompt(selfs, monsters)
    parts = []
    if use_user_summary and user_summary:
        parts.append("Long-term context (previous sessions):\n" + user_summary)
    if use_session_summary and session_summary:
        parts.append("This-session context so far:\n" + session_summary)
    parts.append(twc_block)
    composed = "\n\n".join(parts)

    # final Lumen reply after 6 messages
    ai = client.responses.create(
        model=REPLY_MODEL,
        temperature=0.3,
        input=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": composed}
        ]
    )
    reply = parse_output_text(ai)
    insert_message(body.sessionId, "angel", reply)

    # (optional) rolling session summary update — best-effort
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT role, text FROM messages WHERE session_id=? ORDER BY id ASC",
            (body.sessionId,)
        )
        history = [{"role": r["role"], "text": r["text"]} for r in cur.fetchall()]
        sum_prompt = (
            "Summarize the earlier conversation in 5–8 concise bullets. "
            "Be concrete; capture themes, triggers, and helpful actions. "
            "Avoid quoting harsh 'Monster' lines verbatim. "
            "Keep to about 250–300 tokens.\n\n"
            + "\n".join([f"{h['role'].upper()}: {h['text']}" for h in history])
        )
        sum_resp = client.responses.create(
            model=REPLY_MODEL,
            temperature=0.2,
            input=[{"role": "user", "content": sum_prompt}]
        )
        new_summary = parse_output_text(sum_resp).strip()
        if new_summary:
            set_sql_summary(body.sessionId, new_summary)
    except Exception:
        pass

    # safety popup if all 3 SELF entries look negative
    all_three_negative = (len(self_labels) == 3 and all(bool(x) for x in self_labels))
    safety = None
    if all_three_negative:
        insert_alert(body.sessionId, "cycle-negative", {"selfNegatives": self_labels})
        safety = {
            "showSafetyPopup": True,
            "message": "Would you like to switch to the 1-on-1 Therapist Room?",
            "acceptRedirect": "/therapist-room",
            "declineStay": True
        }

    return {
        "awaitMore": False,
        "angel": reply,
        "lumen": reply,
        "safety": safety,
        "next": {"askToContinue": True}
    }

from fastapi.staticfiles import StaticFiles

# Serve everything in ./public at /
app.mount("/", StaticFiles(directory="public", html=True), name="public")

# ------------- Notes (run with uvicorn) -------------
# pip install -r requirements.txt
# uvicorn server:app --reload --host 0.0.0.0 --port 3000
# http://127.0.0.1:3000/api/health
