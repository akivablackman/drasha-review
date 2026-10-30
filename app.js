// The review page's shell. No framework, no build step: this file, index.html
// and style.css are the whole site. Everything else lives in the Supabase
// project (TECH_STACK -> The review page): one shared sign-in, a private
// bucket for the audio and each version's chapter.json, four tables the
// signed-in role reads and inserts. The publishable key below is the
// browser's key by design; row-level security is the gate.

const SUPABASE_URL = "https://wscbszfmjebkedyobfyj.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_8AHKKiAtyTQD7VBXqZDynw_u1hwdorA";
const REVIEW_EMAIL = "review@parsha-book.review";
const BUCKET = "chapters";
const NAMES = ["Akiva", "Mum", "Dad"];

const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");
const audio = $("#audio");
let session = null;      // {access_token, refresh_token, expires_at}
let author = null;       // one of NAMES
let chapter = null;      // the open chapter: {row, data, comments, answers, approvals}

// --- storage of the session and the name (this browser only) -----------------

function remember(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private window */ }
}
function recall(key) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

// --- the project -------------------------------------------------------------

function status(text, ms = 2500) {
  const el = $("#status");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(status.t);
  status.t = setTimeout(() => { el.hidden = true; }, ms);
}

async function authFetch(path, opts = {}) {
  await ensureSession();
  const headers = Object.assign({ apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${session.access_token}` }, opts.headers || {});
  const r = await fetch(SUPABASE_URL + path, Object.assign({}, opts, { headers }));
  if (r.status === 401) { signOut(); throw new Error("Signed out; please sign in again."); }
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

async function signIn(password) {
  // A test login (SESSIONS -> The Phase 8 build run) sets its own email in
  // localStorage before signing in, on localhost only; the deployed page
  // signs in as the one review user whatever the browser holds.
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
  const email = (local && recall("email")) || REVIEW_EMAIL;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(r.status === 400 ? "That password is not right." : `Sign-in failed (${r.status}).`);
  const data = await r.json();
  session = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000, user_id: data.user && data.user.id };
  remember("session", session);
}

async function ensureSession() {
  if (!session) throw new Error("Not signed in.");
  if (Date.now() < session.expires_at - 60000) return;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!r.ok) { signOut(); throw new Error("The session ended; please sign in again."); }
  const data = await r.json();
  session = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000, user_id: data.user && data.user.id };
  remember("session", session);
}

function signOut() {
  session = null;
  remember("session", null);
  route();
}

async function rows(table, params) {
  const q = new URLSearchParams(params).toString();
  return (await authFetch(`/rest/v1/${table}?${q}`)).json();
}

async function insert(table, row) {
  const r = await authFetch(`/rest/v1/${table}`, {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(row),
  });
  return (await r.json())[0];
}

async function patch(table, id, fields) {
  const r = await authFetch(`/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(fields),
  });
  return (await r.json())[0];
}

async function remove(table, id) {
  await authFetch(`/rest/v1/${table}?id=eq.${id}`, { method: "DELETE" });
}

async function readJson(path) {
  return (await authFetch(`/storage/v1/object/authenticated/${BUCKET}/${path}`)).json();
}

async function signedUrl(path, seconds = 4 * 3600) {
  const r = await authFetch(`/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: seconds }),
  });
  const data = await r.json();
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

// --- rendering helpers -------------------------------------------------------

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function clock(t) { t = Math.floor(t || 0); return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; }
function inline(text) {
  // Italics and footnote markers, as the stages write them; Hebrew runs are shown as written.
  return esc(text).replace(/\*([^*]+)\*/g, "<i>$1</i>").replace(/\[\^(\d+)\]/g, '<sup class="fn"><a href="#fn$1">$1</a></sup>');
}
function h(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function when(iso) { const d = new Date(iso); return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }

// --- audio -------------------------------------------------------------------

let stopAt = null;
function play(s, e) {
  stopAt = e;
  $("#now").textContent = `${clock(s)}–${clock(e)}`;
  if (audio.readyState >= 1) { audio.currentTime = s; audio.play().catch(e => status(e.message, 5000)); return; }
  // Chrome defers a media load in a tab that is not visible until play() is
  // called; seek once the metadata is there.
  audio.addEventListener("loadedmetadata", () => { audio.currentTime = s; }, { once: true });
  audio.play().catch(() => {});
}
audio.addEventListener("timeupdate", () => { if (stopAt !== null && audio.currentTime >= stopAt) { audio.pause(); stopAt = null; } });

// --- views -------------------------------------------------------------------

function viewSignIn() {
  main.replaceChildren(h(`
    <form class="card" id="signin">
      <h1>Parsha book</h1>
      <p class="muted">The chapters for review. The password is the one Akiva gave you.</p>
      <label for="pw">Password</label>
      <input type="password" id="pw" autocomplete="current-password" autofocus>
      <button class="primary" type="submit">Sign in</button>
      <p class="muted" id="err"></p>
    </form>`));
  $("#signin").addEventListener("submit", async ev => {
    ev.preventDefault();
    const btn = $("#signin .primary");
    btn.disabled = true;
    try { await signIn($("#pw").value); route(); }
    catch (e) { $("#err").textContent = e.message; btn.disabled = false; }
  });
}

function viewName() {
  main.replaceChildren(h(`
    <div class="card">
      <h1>Who is reading?</h1>
      <p class="muted">Every comment and answer carries your name.</p>
      <div class="names">${NAMES.map(n => `<button type="button" data-name="${n}">${n}</button>`).join("")}</div>
    </div>`));
  main.querySelectorAll("[data-name]").forEach(b => b.addEventListener("click", () => { author = b.dataset.name; remember("author", author); route(); }));
}

async function viewList() {
  main.replaceChildren(h(`<div><h1>Chapters</h1><p class="muted">Loading…</p></div>`));
  const all = await rows("chapters", { select: "id,slug,version,title,published_at,blocks,words", order: "published_at.desc" });
  const newest = [];
  const seen = new Set();
  for (const c of all) { if (!seen.has(c.slug)) { seen.add(c.slug); newest.push(c); } }
  const list = newest.length
    ? `<ul class="chapters">${newest.map(c => `<li><a href="#/c/${esc(c.slug)}">${esc(c.title)}</a> <span class="muted">· ${c.blocks} paragraphs · published ${esc(when(c.published_at))}</span></li>`).join("")}</ul>`
    : `<p class="muted">Nothing published yet.</p>`;
  main.replaceChildren(h(`<div><h1>Chapters</h1>${list}</div>`));
}

async function viewChapter(slug, version) {
  main.replaceChildren(h(`<div><p class="muted">Loading the chapter…</p></div>`));
  const params = { select: "*", slug: `eq.${slug}`, order: "published_at.desc", limit: "1" };
  if (version) params.version = `eq.${version}`;
  const found = await rows("chapters", params);
  if (!found.length) { main.replaceChildren(h(`<p>No such chapter. <a href="#/">Back to the list</a>.</p>`)); return; }
  const row = found[0];
  // Comments and answers stay attached by block and item id across versions
  // of a chapter; an approval belongs to the version it was pressed on.
  const versions = await rows("chapters", { select: "id", slug: `eq.${slug}` });
  const ids = `in.(${versions.map(v => v.id).join(",")})`;
  const [data, comments, answers, approvals] = await Promise.all([
    readJson(row.path),
    rows("comments", { select: "*", chapter_id: ids, order: "created_at.asc" }),
    rows("answers", { select: "*", chapter_id: ids, order: "created_at.asc" }),
    rows("approvals", { select: "*", chapter_id: `eq.${row.id}`, order: "created_at.asc" }),
  ]);
  chapter = { row, data, comments, answers, approvals };
  document.title = `${data.title} — review`;
  audio.src = await signedUrl(row.audio_path);
  $("#bar").hidden = false;

  const para = (b, section) => `<p class="block" id="${section}-${esc(b.id)}" data-section="${section}" data-block="${esc(b.id)}" data-start="${b.start}" data-end="${b.end}">` +
    `<button class="play" type="button" title="play from here">▶<small>${clock(b.start)}</small></button><span class="t">${section === "chapter" ? inline(b.text) : esc(b.text)}</span></p>`;
  const epi = data.epigraph ? `<p class="epigraph">${esc(data.epigraph.hebrew)}</p><p class="epigraph-ref">— ${esc(data.epigraph.ref)}</p>` : "";
  const footnotes = data.footnotes.length
    ? `<h3>Sources</h3><ol class="footnotes">${data.footnotes.map(f => `<li id="fn${f.n}">${inline(f.text)}${f.url ? ` <a href="${esc(f.url)}" target="_blank" rel="noopener">see it on Sefaria</a>` : ""}</li>`).join("")}</ol>` +
      `<p class="instructions text">The source printed in the book is the reference itself (the verse, the machzor, the Gemara). ` +
      `Sefaria is only where the wording was checked; the link is there so you can see the text it was checked against. ` +
      `Sefaria is not named in the book.</p>`
    : "";

  const item = (section, it, body) => `<li class="item" data-section="${section}" data-item="${esc(it.id)}">${body}
      <div class="controls">
        <select><option value="">— choose —</option>${it.options.map(o => `<option>${esc(o)}</option>`).join("")}</select>
        <textarea placeholder="a note, if you want"></textarea>
        <button class="save" type="button">Save</button><span class="saved"></span>
      </div><div class="others"></div></li>`;
  const citations = data.citations_to_check.length
    ? `<ul class="items">${data.citations_to_check.map(q => item("citations", q,
        `<p class="q"><button class="play" type="button" data-start="${q.start}" data-end="${q.end + 1}" title="play">▶<small>${clock(q.start)}</small></button> ` +
        `<span class="heb">${esc(q.hebrew)}</span> <span class="muted">(${esc(q.transliteration)})</span>${q.named_source ? ` — he names <i>${esc(q.named_source)}</i>` : ""}. ` +
        `Candidate: ${q.url ? `<a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.ref)}</a>` : esc(q.ref || "none")}` +
        `${q.alternatives.length ? `. Also possible: ${esc(q.alternatives.join("; "))}` : ""}.</p>`)).join("")}</ul>`
    : "<p class=\"muted\">None this chapter.</p>";
  const decisions = data.decisions.length
    ? `<ul class="items">${data.decisions.map(d => item("decisions", d, `<p class="q"><b>${esc(d.title)}.</b> ${inline(d.question)}</p>`)).join("")}</ul>`
    : "<p class=\"muted\">None this chapter.</p>";
  const facts = data.facts.length
    ? `<ul class="items">${data.facts.map(f => item("facts", f, `<p class="q"><b>${esc(f.term)}</b>: ${esc(f.question)}</p>`)).join("")}</ul>`
    : "<p class=\"muted\">None this chapter.</p>";

  main.replaceChildren(h(`
    <div>
      <h1>${esc(data.title)}</h1>
      <p class="muted">Signed in as ${esc(author)} · <a href="#" id="switch">not you?</a> · version ${esc(data.version)}</p>

      <div class="overview text">
        <h2>How to read this page</h2>
        <p>This is one chapter of the book made from Dad's recorded shiurim on the parsha, as far as it has got. It comes to you one chapter at a time. Everything you write here is saved and comes back to Akiva with your name on it. Nothing is final until one of you presses Approve at the bottom.</p>
        <p>What is on the page, in order:</p>
        <ol>
          <li><b>The transcript.</b> The recording written down, paragraph by paragraph. Read it for one thing: was anything misheard or dropped?</li>
          <li><b>Questions about the book.</b> Five decisions that apply to every chapter, not just this one: how close to the recording, how the Hebrew is handled, names, sources, length. Read them before the chapter so you have them in mind as you read.</li>
          <li><b>The chapter.</b> The transcript condensed and set as it would go to print. Read it as a book, with three questions: is anything wrong; is anything not him; is anything missing or unwanted?</li>
          <li><b>Citations to check.</b> Sources that could not be confirmed automatically, for Dad.</li>
          <li><b>Facts for Dad.</b> Dates in the glossary that a reference disagrees with or cannot confirm.</li>
          <li><b>Approve.</b> When the chapter is right.</li>
        </ol>
        <p>How it works: press <b>▶</b> on any paragraph to hear it from the recording. To comment, <b>select some words</b> with the mouse and press <b>Comment</b>; the comment appears in the margin beside the paragraph, and you can edit or delete your own. The questions have a <b>dropdown</b> and a note; press <b>Save</b> after each. Spelling and punctuation are not yours to fix: say what is wrong and it is fixed everywhere.</p>
      </div>

      <h2>1. The transcript</h2>
      <p class="instructions text">The recording written down, with the ums and restarts removed and nothing else changed. Press ▶ to hear any paragraph. Read it for one thing only: <b>was anything misheard or dropped?</b> Select the words and comment. Do not judge the writing here; that is the chapter's job.</p>
      <div class="blocks" data-section="transcript"><div class="text">${data.transcript.map(b => para(b, "transcript")).join("")}</div><div class="aside"></div></div>

      <h2>2. Before the chapter: questions about the book</h2>
      <p class="instructions text">These five decisions apply to the whole book, and the chapter below was made under them. Read them now, keep them in mind as you read the chapter, and answer when you are ready: one choice each, a note if you want. "Fine as it is" is an answer.</p>
      ${decisions}

      <h2>3. The chapter <small>about ${data.pages_estimate} printed page${data.pages_estimate === 1 ? "" : "s"}, an estimate</small></h2>
      <p class="instructions text">The transcript condensed, with the Hebrew terms explained on first use and the sources in footnotes. Read it as a book. Three questions, for any line: <b>is anything wrong</b>; <b>is anything not him</b>; <b>is anything missing or unwanted</b>? Select the words and comment. Press ▶ to hear the passage a paragraph came from.</p>
      <div class="blocks book" data-section="chapter"><div class="text">${epi}${data.chapter.map(b => para(b, "chapter")).join("")}${footnotes}</div><div class="aside"></div></div>

      <h2>4. Citations to check</h2>
      <p class="instructions text">Sources that could not be confirmed automatically. The ▶ plays the passage; the candidate is the best guess, not a confirmed source. Is the candidate the right reference?</p>
      ${citations}

      <h2>5. Facts for Dad</h2>
      <p class="instructions text">Dates in the glossary that a reference disagrees with or cannot confirm. The answer goes into the glossary for the whole book.</p>
      ${facts}

      <h2>6. Approve</h2>
      <p class="instructions text">Pressing Approve closes the chapter: its text is frozen, and a later change of rule reaches it only as a note for you to see. Either of you can press it. Press once to arm, once more to approve.</p>
      <div class="approve"></div>
    </div>`));

  $("#switch").addEventListener("click", ev => { ev.preventDefault(); author = null; remember("author", null); route(); });
  main.querySelectorAll("p.block > .play").forEach(b => b.addEventListener("click", () => { const p = b.parentElement; play(+p.dataset.start, +p.dataset.end); }));
  main.querySelectorAll(".item .play").forEach(b => b.addEventListener("click", () => play(+b.dataset.start, +b.dataset.end)));
  renderComments();
  renderAnswers();
  renderApprovals();
  armSelection();
}

// --- margin comments ---------------------------------------------------------

function textNodes(el) {
  const out = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

function offsetsWithin(span, range) {
  // Character offsets of a selection inside the block's text span, by walking its text nodes.
  let pos = 0, start = -1, end = -1;
  for (const node of textNodes(span)) {
    if (node === range.startContainer) start = pos + range.startOffset;
    if (node === range.endContainer) end = pos + range.endOffset;
    pos += node.data.length;
  }
  if (start < 0 && span.contains(range.startContainer)) start = 0;
  if (end < 0 && span.contains(range.endContainer)) end = pos;
  return [start, end];
}

function rangeAt(span, start, end) {
  const r = document.createRange();
  let pos = 0, s = false;
  for (const node of textNodes(span)) {
    const next = pos + node.data.length;
    if (!s && start <= next) { r.setStart(node, Math.max(0, start - pos)); s = true; }
    if (s && end <= next) { r.setEnd(node, Math.max(0, end - pos)); return r; }
    pos = next;
  }
  if (s) r.setEndAfter(span.lastChild || span);
  return s ? r : null;
}

function renderComments() {
  main.querySelectorAll(".aside").forEach(a => a.replaceChildren());
  main.querySelectorAll("p.block.commented").forEach(p => p.classList.remove("commented"));
  const ranges = [];
  const nextTop = {};
  for (const c of chapter.comments) {
    const p = document.getElementById(`${c.section}-${c.block_id}`);
    if (!p) continue;
    p.classList.add("commented");
    const aside = p.closest(".blocks").querySelector(".aside");
    const mine = c.author === author;
    const card = h(`<div class="ccard" data-id="${c.id}"><div class="by">${esc(c.author)} · ${esc(when(c.created_at))}${c.edited_at ? " · edited" : ""}</div>` +
      `${c.quoted ? `<div class="q">${esc(c.quoted)}</div>` : ""}<div class="body">${esc(c.body)}</div>` +
      `${mine ? `<div class="tools"><a href="#" class="edit">edit</a> · <a href="#" class="del">delete</a></div>` : ""}</div>`);
    aside.appendChild(card);
    if (mine) armCardTools(card, c);
    const key = aside.parentElement.dataset.section;
    const top = Math.max(p.offsetTop, nextTop[key] || 0);
    card.style.top = `${top}px`;
    nextTop[key] = top + card.offsetHeight + 8;
    if (c.range_start != null && c.range_end != null) {
      const r = rangeAt(p.querySelector(".t"), c.range_start, c.range_end);
      if (r) ranges.push(r);
    }
  }
  if (window.Highlight && CSS.highlights) {
    CSS.highlights.set("commented", new Highlight(...ranges));
  }
}

function armCardTools(card, c) {
  // Edit in place; delete takes two presses, in the page.
  card.querySelector(".edit").addEventListener("click", async ev => {
    ev.preventDefault();
    if (card.querySelector("textarea")) return;
    const body = card.querySelector(".body");
    const box = h(`<div><textarea></textarea><div class="row"><button type="button" class="cancel">Cancel</button><button type="button" class="save">Save</button></div></div>`);
    box.querySelector("textarea").value = c.body;
    body.replaceWith(box);
    box.querySelector("textarea").focus();
    box.querySelector(".cancel").addEventListener("click", renderComments);
    box.querySelector(".save").addEventListener("click", async () => {
      const text = box.querySelector("textarea").value.trim();
      if (!text) return;
      box.querySelector(".save").disabled = true;
      try {
        const row = await patch("comments", c.id, { body: text, edited_at: new Date().toISOString() });
        Object.assign(c, row);
        renderComments();
        status("Comment saved.");
      } catch (e) { status(e.message, 6000); box.querySelector(".save").disabled = false; }
    });
  });
  const del = card.querySelector(".del");
  del.addEventListener("click", async ev => {
    ev.preventDefault();
    if (del.dataset.armed !== "yes") {
      del.dataset.armed = "yes";
      del.textContent = "really delete?";
      setTimeout(() => { if (del.isConnected) { del.dataset.armed = ""; del.textContent = "delete"; } }, 6000);
      return;
    }
    try {
      await remove("comments", c.id);
      chapter.comments = chapter.comments.filter(x => x.id !== c.id);
      renderComments();
      status("Comment deleted.");
    } catch (e) { status(e.message, 6000); }
  });
}

let pending = null;   // {section, block_id, start, end, quoted}
function armSelection() {
  const btn = $("#cbtn") || document.body.appendChild(h(`<button id="cbtn" type="button" hidden>Comment</button>`));
  document.addEventListener("mouseup", () => setTimeout(offerComment, 0));
  document.addEventListener("keyup", ev => { if (ev.key === "Shift" || ev.key.startsWith("Arrow")) offerComment(); });
  btn.addEventListener("mousedown", ev => ev.preventDefault());
  btn.addEventListener("click", openBox);
}

function offerComment() {
  const btn = $("#cbtn");
  if ($("#cbox")) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { btn.hidden = true; return; }
  const range = sel.getRangeAt(0);
  const p = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer.closest("p.block") : range.commonAncestorContainer.parentElement.closest("p.block");
  const span = p && p.querySelector(".t");
  if (!p || !span || !span.contains(range.startContainer) || !span.contains(range.endContainer)) { btn.hidden = true; return; }
  const [start, end] = offsetsWithin(span, range);
  const quoted = range.toString().trim();
  if (!quoted || start < 0 || end <= start) { btn.hidden = true; return; }
  pending = { section: p.dataset.section, block_id: p.dataset.block, start, end, quoted };
  const rect = range.getBoundingClientRect();
  btn.style.left = `${window.scrollX + rect.left}px`;
  btn.style.top = `${window.scrollY + rect.bottom + 6}px`;
  btn.hidden = false;
}

function openBox() {
  const btn = $("#cbtn");
  if (!pending) return;
  btn.hidden = true;
  const box = h(`<div id="cbox"><div class="q">“${esc(pending.quoted.length > 90 ? pending.quoted.slice(0, 90) + "…" : pending.quoted)}”</div>
    <textarea placeholder="Your comment" autofocus></textarea>
    <div class="row"><button type="button" class="cancel">Cancel</button><button type="button" class="save">Save</button></div></div>`);
  box.style.left = btn.style.left;
  box.style.top = btn.style.top;
  document.body.appendChild(box);
  box.querySelector("textarea").focus();
  box.querySelector(".cancel").addEventListener("click", () => { box.remove(); pending = null; });
  box.querySelector(".save").addEventListener("click", async () => {
    const body = box.querySelector("textarea").value.trim();
    if (!body) return;
    box.querySelector(".save").disabled = true;
    try {
      const row = await insert("comments", {
        chapter_id: chapter.row.id, author, section: pending.section, block_id: pending.block_id,
        range_start: pending.start, range_end: pending.end, quoted: pending.quoted, body,
      });
      chapter.comments.push(row);
      box.remove();
      pending = null;
      window.getSelection().removeAllRanges();
      renderComments();
      status("Comment saved.");
    } catch (e) { status(e.message, 6000); box.querySelector(".save").disabled = false; }
  });
}

// --- answers and approvals ---------------------------------------------------

function latest(list, section, itemId) {
  const mine = {};
  for (const a of list) if (a.section === section && a.item_id === itemId) mine[a.author] = a;
  return mine;
}

function renderAnswers() {
  main.querySelectorAll(".item").forEach(li => {
    const section = li.dataset.section, itemId = li.dataset.item;
    const by = latest(chapter.answers, section, itemId);
    const select = li.querySelector("select"), note = li.querySelector("textarea"), save = li.querySelector(".save"), saved = li.querySelector(".saved");
    if (by[author]) { select.value = by[author].choice || ""; note.value = by[author].note || ""; saved.textContent = `saved ${when(by[author].created_at)}`; }
    const others = Object.values(by).filter(a => a.author !== author).map(a => `${esc(a.author)}: ${esc(a.choice || "—")}${a.note ? ` (${esc(a.note)})` : ""}`);
    li.querySelector(".others").innerHTML = others.length ? `Also answered — ${others.join(" · ")}` : "";
    save.onclick = async () => {
      if (!select.value && !note.value.trim()) { status("Choose an answer or write a note first."); return; }
      save.disabled = true;
      try {
        const row = await insert("answers", { chapter_id: chapter.row.id, author, section, item_id: itemId, choice: select.value || null, note: note.value.trim() || null });
        chapter.answers.push(row);
        saved.textContent = `saved ${when(row.created_at)}`;
        status("Answer saved.");
      } catch (e) { status(e.message, 6000); }
      save.disabled = false;
    };
  });
}

function renderApprovals() {
  const box = $(".approve");
  const done = chapter.approvals.map(a => `${esc(a.author)} on ${esc(when(a.created_at))}`);
  box.innerHTML = (done.length ? `<p class="done">Approved by ${done.join(" and ")}.</p>` : "") +
    (chapter.approvals.some(a => a.author === author) ? "" : `<button class="primary" type="button" id="approve">Approve as ${esc(author)}</button>`);
  const b = $("#approve");
  if (b) b.addEventListener("click", async () => {
    // Two presses, in the page: the first arms it, the second approves.
    if (b.dataset.armed !== "yes") {
      b.dataset.armed = "yes";
      b.textContent = `Yes, approve "${chapter.data.title}" as ${author}`;
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ""; b.textContent = `Approve as ${author}`; } }, 8000);
      return;
    }
    b.disabled = true;
    try {
      const row = await insert("approvals", { chapter_id: chapter.row.id, author });
      chapter.approvals.push(row);
      renderApprovals();
      status("Approved.");
    } catch (e) { status(e.message, 6000); b.disabled = false; }
  });
}

// --- routing -----------------------------------------------------------------

async function route() {
  $("#who").textContent = author && session ? author : "";
  if (!session) { $("#bar").hidden = true; viewSignIn(); return; }
  if (!author) { $("#bar").hidden = true; viewName(); return; }
  const m = location.hash.match(/^#\/c\/([a-z0-9-]+)(?:\/([A-Za-z0-9-]+))?/);
  try {
    if (m) await viewChapter(m[1], m[2]);
    else { $("#bar").hidden = true; await viewList(); }
  } catch (e) {
    main.replaceChildren(h(`<p>${esc(e.message)} <a href="#/">Back</a></p>`));
  }
}

session = recall("session");
author = recall("author");
if (author && !NAMES.includes(author)) author = null;
window.addEventListener("hashchange", route);
window.addEventListener("resize", () => { if (chapter) renderComments(); });
route();
