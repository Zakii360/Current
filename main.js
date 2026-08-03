import { supabase } from "./supabase.js";
import { encryptMessage, decryptMessage, hasIdentityKey } from "./crypto.js";

// ── Session ───────────────────────────────────────────────────────────────────
function getSession() {
  try { return JSON.parse(localStorage.getItem("current_session")); } catch { return null; }
}

// ── State ─────────────────────────────────────────────────────────────────────
let me = null;
let activeConv = null;
let activeMembers = [];
let replyTo = null;
let realtimeChannel = null;
let presenceChannel = null;
let typingTimeout = null;
let lastTypingSent = 0;
let decryptCache = {};  // msgId → plaintext

// ── Helpers ───────────────────────────────────────────────────────────────────
function toast(msg, type="info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`; el.textContent = msg;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}
function fmtConvTime(ts) {
  if(!ts) return "";
  const d = new Date(ts), now = new Date(), diff = now - d;
  if(diff < 86400000) return fmtTime(ts);
  if(diff < 604800000) return d.toLocaleDateString([],{weekday:"short"});
  return d.toLocaleDateString([],{month:"short",day:"numeric"});
}
function avatarInitial(name) { return (name||"?")[0].toUpperCase(); }
function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br>");
}
function linkify(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--accent)">$1</a>');
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getMe() {
  const session = getSession();
  if(!session?.id) { location.replace("landing.html"); return null; }
  const { data, error } = await supabase.from("current_profiles").select("*").eq("id", session.id).single();
  if(error||!data) { location.replace("landing.html"); return null; }
  if(!(await hasIdentityKey())) toast("⚠️ No local key — old messages can't decrypt. Settings → Key backup.", "error");
  return data;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
if(localStorage.getItem("current_theme")==="dark") document.body.classList.add("dark");
document.getElementById("theme-btn").onclick = () => {
  document.body.classList.toggle("dark");
  localStorage.setItem("current_theme", document.body.classList.contains("dark")?"dark":"light");
};

// ── Sign out ──────────────────────────────────────────────────────────────────
document.getElementById("signout-btn").onclick = async () => {
  if(me) await supabase.from("current_profiles").update({ online:false }).eq("id", me.id);
  localStorage.removeItem("current_session");
  location.replace("landing.html");
};
document.getElementById("sidebar-settings").onclick = () => location.href = "settings.html";

// ── Load conversations ─────────────────────────────────────────────────────────
async function loadConversations(filter="") {
  const { data: memberships, error: memErr } = await supabase
    .from("current_members").select("conversation_id,last_read_at,muted,archived").eq("user_id", me.id);

  if(memErr) { console.error("members error:", memErr); return; }
  if(!memberships?.length) {
    document.getElementById("chat-list").innerHTML =
      `<div style="padding:24px 16px;color:var(--muted);font-size:13px;text-align:center;line-height:1.7">
        No conversations yet.<br>Tap <strong>✏️</strong> to start one.
      </div>`;
    return;
  }

  const convIds = memberships.map(m => m.conversation_id);
  const { data: convs } = await supabase.from("current_conversations").select("*").in("id", convIds);
  const convMap = {};
  for(const c of convs||[]) convMap[c.id] = { ...c, lastMsg:null };

  for(const cid of convIds) {
    const { data: msgs } = await supabase.from("current_messages")
      .select("id,sent_at,message_type,sender_id").eq("conversation_id", cid)
      .eq("deleted_for_all", false).order("sent_at",{ascending:false}).limit(1);
    if(msgs?.[0]) convMap[cid].lastMsg = msgs[0];
  }

  const profileMap = {};
  for(const c of Object.values(convMap)) {
    if(c.type==="direct") {
      const { data: mems } = await supabase.from("current_members")
        .select("user_id").eq("conversation_id", c.id).neq("user_id", me.id);
      c._otherId = mems?.[0]?.user_id;
    }
  }
  const otherIds = [...new Set(Object.values(convMap).map(c=>c._otherId).filter(Boolean))];
  if(otherIds.length) {
    const { data: profiles } = await supabase.from("current_profiles")
      .select("id,username,display_name,online,last_seen,avatar_color,status_emoji,status_text").in("id", otherIds);
    for(const p of profiles||[]) profileMap[p.id] = p;
  }

  const sorted = Object.values(convMap)
    .filter(c => {
      if(!filter) return true;
      const name = c.type==="direct" ? (profileMap[c._otherId]?.username||"") : (c.name||"");
      return name.toLowerCase().includes(filter);
    })
    .sort((a,b)=>(b.lastMsg?.sent_at||b.created_at)>(a.lastMsg?.sent_at||a.created_at)?1:-1);

  const list = document.getElementById("chat-list");
  if(!sorted.length) { list.innerHTML=`<div style="padding:20px;color:var(--muted);font-size:13px;text-align:center">No results</div>`; return; }

  list.innerHTML = sorted.map(c => {
    const other = c._otherId ? profileMap[c._otherId] : null;
    const name = c.type==="direct" ? (other?.display_name||other?.username||"Unknown") : (c.name||"Group");
    const online = other?.online||false;
    const preview = c.lastMsg ? "🔐 Encrypted message" : "No messages yet";
    const mem = memberships.find(m=>m.conversation_id===c.id);
    const muted = mem?.muted;
    return `
    <div class="chat-item${activeConv?.id===c.id?" active":""}" data-conv-id="${c.id}">
      <div class="avatar sm" style="background:${other?.avatar_color||c.avatar_color||"#18a96b"};position:relative">
        ${avatarInitial(name)}
        ${online?`<span style="position:absolute;bottom:0;right:0;width:9px;height:9px;border-radius:50%;background:#18a96b;border:2px solid var(--bg)"></span>`:""}
      </div>
      <div class="chat-item-info">
        <strong>${escHtml(name)} ${muted?"🔇":""}</strong>
        <div class="chat-item-preview">${other?.status_emoji||""} ${preview}</div>
      </div>
      <div class="chat-item-meta">
        <div class="chat-item-time">${fmtConvTime(c.lastMsg?.sent_at||c.created_at)}</div>
      </div>
    </div>`;
  }).join("");

  list.querySelectorAll(".chat-item").forEach(el => {
    el.onclick = () => {
      const c = convMap[el.dataset.convId];
      if(!c) return;
      openConversation(c, c._otherId ? profileMap[c._otherId] : null);
    };
  });
}

let searchTimeout;
document.getElementById("search-input").oninput = e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => loadConversations(e.target.value.trim().toLowerCase()), 250);
};

// ── Open conversation ─────────────────────────────────────────────────────────
async function openConversation(conv, otherProfile) {
  if(realtimeChannel) await supabase.removeChannel(realtimeChannel);
  if(presenceChannel) await supabase.removeChannel(presenceChannel);
  activeConv = conv;
  decryptCache = {};

  document.getElementById("empty-state").style.display = "none";
  document.getElementById("conversation-pane").style.display = "flex";

  const name = conv.type==="direct"
    ? (otherProfile?.display_name||otherProfile?.username||"Unknown") : (conv.name||"Group");
  document.getElementById("conv-name").textContent = name;
  document.getElementById("conv-avatar").textContent = avatarInitial(name);
  document.getElementById("conv-avatar").style.background = otherProfile?.avatar_color||conv.avatar_color||"#18a96b";

  if(conv.type==="direct" && otherProfile) {
    const statusText = otherProfile.status_text ? ` · ${otherProfile.status_text}` : "";
    document.getElementById("conv-status").textContent = otherProfile.online
      ? `🟢 Online${statusText}`
      : otherProfile.last_seen ? `Last seen ${fmtConvTime(otherProfile.last_seen)}` : "Offline";
  } else {
    document.getElementById("conv-status").textContent = conv.type==="group" ? "Group · E2EE" : "";
  }

  const { data: mems } = await supabase.from("current_members").select("user_id").eq("conversation_id", conv.id);
  const { data: memberProfiles } = await supabase.from("current_profiles")
    .select("id,username,display_name,identity_key,avatar_color")
    .in("id", mems?.map(m=>m.user_id)||[]);
  activeMembers = memberProfiles||[];

  await loadMessages();
  await loadPinnedMessages();
  subscribeToConversation(conv.id);

  // Disappear button
  document.getElementById("conv-disappear-btn").onclick = () => {
    document.getElementById("disappear-select").value = conv.disappear_after_seconds||"";
    document.getElementById("disappear-modal").style.display = "flex";
  };

  // Block button
  document.getElementById("conv-block-btn").onclick = async () => {
    if(!otherProfile) return;
    if(!confirm(`Block ${name}? They won't be able to message you.`)) return;
    await supabase.from("current_blocks").upsert({ blocker_id:me.id, blocked_id:otherProfile.id });
    toast("User blocked.", "success");
  };

  // Info button → show profile/conversation info
  document.getElementById("conv-info-btn").onclick = () => showConvInfo(conv, otherProfile);

  await supabase.from("current_members").update({ last_read_at:new Date().toISOString() })
    .eq("conversation_id", conv.id).eq("user_id", me.id);

  document.querySelectorAll(".chat-item").forEach(el =>
    el.classList.toggle("active", el.dataset.convId===conv.id));

  if(window.innerWidth<=700) {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("mobile-back").style.display = "inline-flex";
  }
}

// ── Conversation info panel ───────────────────────────────────────────────────
function showConvInfo(conv, otherProfile) {
  const existing = document.getElementById("info-panel");
  if(existing) { existing.remove(); return; }

  const panel = document.createElement("div");
  panel.id = "info-panel";
  panel.style.cssText = `position:absolute;top:0;right:0;bottom:0;width:300px;background:var(--glass2);
    backdrop-filter:blur(30px);border-left:1px solid var(--border);z-index:10;
    display:flex;flex-direction:column;padding:24px;gap:14px;overflow-y:auto;animation:slideUp .2s`;

  const other = otherProfile;
  const name = other?.display_name||other?.username||conv.name||"Group";
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <strong style="font-size:16px">Info</strong>
      <button onclick="this.closest('#info-panel').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted)">✕</button>
    </div>
    <div style="text-align:center;padding:16px 0">
      <div class="avatar lg" style="margin:0 auto 10px;background:${other?.avatar_color||"#18a96b"}">${avatarInitial(name)}</div>
      <strong style="font-size:18px">${escHtml(name)}</strong><br>
      ${other ? `<small style="color:var(--muted)">@${escHtml(other.username)}</small>` : ""}
      ${other?.bio ? `<p style="font-size:13px;color:var(--muted);margin-top:8px">${escHtml(other.bio)}</p>` : ""}
      ${other?.status_text ? `<div style="margin-top:8px;font-size:13px">${other.status_emoji||""} ${escHtml(other.status_text)}</div>` : ""}
    </div>
    <div style="border-top:1px solid var(--border);padding-top:14px">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Encryption</div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6">
        🔐 End-to-end encrypted<br>
        Messages encrypted with AES-256-GCM.<br>Keys never leave your device.
      </div>
    </div>
    ${conv.type==="direct" ? `
    <div style="border-top:1px solid var(--border);padding-top:14px;display:flex;flex-direction:column;gap:8px">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Actions</div>
      <button class="button ghost sm" onclick="document.getElementById('info-panel').remove();document.getElementById('conv-block-btn').click()"><span>🚫 Block user</span></button>
    </div>` : ""}
  `;
  document.getElementById("conversation-pane").style.position = "relative";
  document.getElementById("conversation-pane").appendChild(panel);
}

// ── Pinned messages ───────────────────────────────────────────────────────────
async function loadPinnedMessages() {
  const { data: pins } = await supabase.from("current_pins")
    .select("message_id").eq("conversation_id", activeConv.id);
  const pinBar = document.getElementById("pin-bar");
  if(!pins?.length) { pinBar.style.display="none"; return; }
  pinBar.style.display = "flex";
  pinBar.innerHTML = `<span style="font-size:12px;color:var(--muted)">📌 ${pins.length} pinned message${pins.length>1?"s":""}</span>
    <button class="button ghost sm" onclick="scrollToPinned('${pins[pins.length-1].message_id}')"><span>View</span></button>`;
}

function scrollToPinned(msgId) {
  const el = document.getElementById("msg-"+msgId);
  if(el) { el.scrollIntoView({behavior:"smooth",block:"center"}); el.style.background="rgba(24,169,107,.2)"; setTimeout(()=>el.style.background="",1500); }
}

// ── Load messages ─────────────────────────────────────────────────────────────
async function loadMessages() {
  const area = document.getElementById("messages");
  area.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:40px">Loading…</div>`;

  const { data: msgs, error } = await supabase.from("current_messages")
    .select("*, sender:current_profiles(id,username,display_name,identity_key,avatar_color)")
    .eq("conversation_id", activeConv.id).eq("deleted_for_all", false)
    .order("sent_at",{ascending:true}).limit(150);

  if(error) { area.innerHTML=`<div style="color:var(--danger);text-align:center;padding:20px">Failed to load messages.</div>`; return; }

  area.innerHTML = "";
  let lastDate = "", lastSenderId = "";
  for(const msg of msgs||[]) {
    const d = new Date(msg.sent_at).toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"});
    if(d !== lastDate) {
      lastDate = d; lastSenderId = "";
      const div = document.createElement("div");
      div.className = "msg-date-divider"; div.textContent = d;
      area.appendChild(div);
    }
    const grouped = msg.sender_id === lastSenderId;
    lastSenderId = msg.sender_id;
    await renderMessage(msg, false, grouped);
  }
  area.scrollTop = area.scrollHeight;

  const unread = (msgs||[]).filter(m=>m.sender_id!==me.id).map(m=>m.id);
  if(unread.length) {
    await supabase.from("current_receipts").upsert(
      unread.map(id=>({ message_id:id, user_id:me.id, status:"read" })),
      { onConflict:"message_id,user_id" }
    );
  }
}

// ── Render message ────────────────────────────────────────────────────────────
async function renderMessage(msg, scrollIntoView=true, grouped=false) {
  if(msg.disappears_at && new Date(msg.disappears_at) < new Date()) return;

  const area = document.getElementById("messages");
  const isMine = msg.sender_id === me.id;
  const sender = msg.sender || activeMembers.find(m=>m.id===msg.sender_id) || {};

  let text = decryptCache[msg.id];
  if(!text) {
    if(msg.deleted_for_all) { text = "🗑 This message was deleted"; }
    else {
      try {
        const senderKey = isMine ? me.identity_key : sender.identity_key;
        text = await decryptMessage(msg, me.id, senderKey);
        decryptCache[msg.id] = text;
      } catch { text = "🔒 [Cannot decrypt]"; }
    }
  }

  let el = document.getElementById("msg-"+msg.id);
  if(el) {
    const t = el.querySelector(".msg-text");
    if(t) t.innerHTML = linkify(escHtml(text));
    return;
  }

  el = document.createElement("div");
  el.id = "msg-"+msg.id;
  el.dataset.msgId = msg.id;
  el.style.cssText = `display:flex;flex-direction:column;align-items:${isMine?"flex-end":"flex-start"};margin:${grouped?"1px 0":"6px 0 1px"}`;

  let inner = "";

  // Avatar + name for first in group
  if(!isMine && !grouped) {
    inner += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;padding:0 2px">
      <div class="avatar sm" style="background:${sender.avatar_color||"#18a96b"}">${avatarInitial(sender.display_name||sender.username)}</div>
      <span style="font-size:12px;font-weight:600;color:var(--accent)">${escHtml(sender.display_name||sender.username||"")}</span>
    </div>`;
  }

  const bubbleStyle = `padding:9px 14px;border-radius:${isMine?"18px 18px 4px 18px":"18px 18px 18px 4px"};
    max-width:68%;font-size:14px;line-height:1.5;word-break:break-word;
    background:${isMine?"var(--msg-out)":"var(--msg-in)"};
    animation:appear .2s ease;
    ${msg.deleted_for_all?"opacity:.5;font-style:italic":""}
    ${msg.pinned?"border-left:3px solid var(--accent)":""}`;

  inner += `<div class="msg-bubble" style="${bubbleStyle}">`;
  if(msg.reply_to) {
    const orig = document.getElementById("msg-"+msg.reply_to);
    const preview = orig?.querySelector(".msg-text")?.textContent?.slice(0,60)||"…";
    inner += `<div class="msg-reply-preview" onclick="scrollToPinned('${msg.reply_to}')">↩ ${escHtml(preview)}</div>`;
  }
  inner += `<div class="msg-text">${linkify(escHtml(text))}</div>`;
  inner += `<div class="msg-meta">
    <span class="msg-time">${fmtTime(msg.sent_at)}</span>
    ${msg.edited?`<span style="font-size:10px;color:var(--muted)">edited</span>`:""}
    ${isMine?`<span class="msg-status" id="status-${msg.id}">✓</span>`:""}
    ${msg.disappears_at?`<span style="font-size:10px;color:var(--warn,#d97706)">⏳</span>`:""}
  </div>`;
  inner += `</div>`;
  inner += `<div class="msg-reactions" id="reactions-${msg.id}" style="margin-top:3px"></div>`;

  el.innerHTML = inner;

  const bubble = el.querySelector(".msg-bubble");
  bubble.addEventListener("contextmenu", e => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, msg, text); });
  bubble.addEventListener("dblclick", () => {
    // Double-click to react with ❤️
    quickReact(msg.id, "❤️");
  });

  area.appendChild(el);
  if(scrollIntoView) { el.scrollIntoView({behavior:"smooth",block:"end"}); }

  if(msg.disappears_at) {
    const ms = new Date(msg.disappears_at) - Date.now();
    if(ms > 0) setTimeout(() => el.remove(), ms);
  }

  loadReactions(msg.id);
}

// ── Context menu ──────────────────────────────────────────────────────────────
let ctxMsg = null;
function showCtxMenu(x, y, msg, text) {
  ctxMsg = { msg, text };
  const menu = document.getElementById("ctx-menu");
  menu.style.display = "block";
  menu.style.left = Math.min(x, window.innerWidth-180)+"px";
  menu.style.top  = Math.min(y, window.innerHeight-240)+"px";

  document.getElementById("ctx-reply").onclick = () => {
    replyTo = msg;
    document.getElementById("reply-banner").style.display = "flex";
    document.getElementById("reply-name").textContent = msg.sender?.display_name||msg.sender?.username||"";
    document.getElementById("reply-preview").textContent = text.slice(0,60);
    document.getElementById("messageInput").focus();
    hideCtx();
  };
  document.getElementById("ctx-copy").onclick = () => {
    navigator.clipboard.writeText(text).then(()=>toast("Copied!","success"));
    hideCtx();
  };
  document.getElementById("ctx-react").onclick = () => { hideCtx(); showReactionPicker(x, y, msg.id); };
  document.getElementById("ctx-pin").onclick = async () => {
    await supabase.from("current_pins").upsert({ conversation_id:activeConv.id, message_id:msg.id, pinned_by:me.id });
    await supabase.from("current_messages").update({ pinned:true }).eq("id", msg.id);
    await loadPinnedMessages();
    toast("Message pinned 📌","success");
    hideCtx();
  };
  document.getElementById("ctx-delete").onclick = async () => {
    if(msg.sender_id!==me.id) { toast("You can only delete your own messages.","error"); hideCtx(); return; }
    if(!confirm("Delete for everyone?")) { hideCtx(); return; }
    await supabase.from("current_messages").update({ deleted_for_all:true }).eq("id", msg.id);
    const el = document.getElementById("msg-"+msg.id);
    if(el) el.querySelector(".msg-text").textContent="🗑 This message was deleted";
    hideCtx();
  };
}
function hideCtx() {
  document.getElementById("ctx-menu").style.display = "none";
  document.getElementById("reaction-picker").style.display = "none";
}
document.addEventListener("click", hideCtx);

// ── Reactions ─────────────────────────────────────────────────────────────────
async function quickReact(msgId, emoji) {
  await supabase.from("current_reactions").upsert(
    { message_id:msgId, user_id:me.id, emoji }, { onConflict:"message_id,user_id" }
  );
  loadReactions(msgId);
}

function showReactionPicker(x, y, msgId) {
  const p = document.getElementById("reaction-picker");
  p.style.display = "flex";
  p.style.left = Math.min(x, window.innerWidth-210)+"px";
  p.style.top  = Math.min(y, window.innerHeight-60)+"px";
  p.querySelectorAll(".emoji-quick").forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      await quickReact(msgId, btn.dataset.emoji);
      hideCtx();
    };
  });
}

async function loadReactions(msgId) {
  const { data } = await supabase.from("current_reactions").select("emoji,user_id").eq("message_id", msgId);
  const container = document.getElementById("reactions-"+msgId);
  if(!container) return;
  if(!data?.length) { container.innerHTML=""; return; }
  const groups = {};
  for(const r of data) {
    if(!groups[r.emoji]) groups[r.emoji] = { count:0, mine:false };
    groups[r.emoji].count++;
    if(r.user_id===me.id) groups[r.emoji].mine = true;
  }
  container.innerHTML = Object.entries(groups).map(([e,{count,mine}])=>
    `<span class="reaction-chip${mine?" mine":""}" data-emoji="${e}" style="${mine?"border-color:var(--accent);background:rgba(24,169,107,.12)":""}">${e} ${count}</span>`
  ).join("");
  container.querySelectorAll(".reaction-chip").forEach(chip => {
    chip.onclick = () => quickReact(msgId, chip.dataset.emoji);
  });
}

// ── Quick emoji ───────────────────────────────────────────────────────────────
document.querySelectorAll(".emoji-bar .emoji-quick").forEach(btn => {
  btn.onclick = () => { const inp=document.getElementById("messageInput"); inp.value+=btn.dataset.emoji; inp.focus(); };
});

// ── Composer ──────────────────────────────────────────────────────────────────
document.getElementById("send").onclick = sendMessage;
document.getElementById("messageInput").addEventListener("keydown", e => {
  if(e.key==="Enter"&&!e.shiftKey) { e.preventDefault(); sendMessage(); }
});

const inputEl = document.getElementById("messageInput");
inputEl.addEventListener("input", () => {
  inputEl.style.height="auto";
  inputEl.style.height=Math.min(inputEl.scrollHeight,130)+"px";
  const now=Date.now();
  if(now-lastTypingSent>2000) {
    lastTypingSent=now;
    if(presenceChannel) presenceChannel.track({ user_id:me.id, typing:true });
  }
  clearTimeout(typingTimeout);
  typingTimeout=setTimeout(()=>{ if(presenceChannel) presenceChannel.track({ user_id:me.id, typing:false }); },2500);
});

async function sendMessage() {
  if(!activeConv) return;
  const text = inputEl.value.trim();
  if(!text) return;
  inputEl.value=""; inputEl.style.height="auto";

  const recipients = activeMembers.filter(m=>m.identity_key).map(m=>({ userId:m.id, publicKeyB64:m.identity_key }));
  if(!recipients.find(r=>r.userId===me.id)&&me.identity_key) recipients.push({ userId:me.id, publicKeyB64:me.identity_key });
  if(!recipients.length) { toast("⚠️ No encryption keys found.","error"); inputEl.value=text; return; }

  try {
    const { ciphertext, iv, recipient_keys } = await encryptMessage(text, recipients);
    const msgData = { conversation_id:activeConv.id, sender_id:me.id, ciphertext, iv, recipient_keys, message_type:"text" };
    if(replyTo) msgData.reply_to = replyTo.id;
    if(activeConv.disappear_after_seconds)
      msgData.disappears_at = new Date(Date.now()+activeConv.disappear_after_seconds*1000).toISOString();

    const { data, error } = await supabase.from("current_messages").insert(msgData).select("*").single();
    if(error) throw error;

    replyTo=null; document.getElementById("reply-banner").style.display="none";
    decryptCache[data.id] = text;
    await renderMessage({ ...data, sender:me });
  } catch(e) {
    toast("Send failed: "+e.message,"error"); inputEl.value=text;
  }
}

document.getElementById("cancel-reply").onclick = () => { replyTo=null; document.getElementById("reply-banner").style.display="none"; };

// ── Message search ────────────────────────────────────────────────────────────
document.getElementById("conv-search-btn").onclick = () => {
  const bar = document.getElementById("msg-search-bar");
  bar.style.display = bar.style.display==="none" ? "flex" : "none";
  if(bar.style.display==="flex") document.getElementById("msg-search-input").focus();
};

document.getElementById("msg-search-input").oninput = async function() {
  const q = this.value.trim().toLowerCase();
  if(!q) { document.querySelectorAll(".msg-bubble.search-match").forEach(e=>e.classList.remove("search-match")); return; }
  document.querySelectorAll(".msg-bubble").forEach(b => {
    const t = b.querySelector(".msg-text")?.textContent?.toLowerCase()||"";
    b.classList.toggle("search-match", t.includes(q));
  });
  const first = document.querySelector(".msg-bubble.search-match");
  if(first) first.scrollIntoView({ behavior:"smooth", block:"center" });
};

// ── Realtime ──────────────────────────────────────────────────────────────────
function subscribeToConversation(convId) {
  realtimeChannel = supabase.channel("conv:"+convId)
    .on("postgres_changes",{ event:"INSERT",schema:"public",table:"current_messages",filter:`conversation_id=eq.${convId}` }, async payload => {
      const msg = payload.new;
      if(msg.sender_id===me.id) { const s=document.getElementById("status-"+msg.id); if(s) s.textContent="✓✓"; return; }
      const sender = activeMembers.find(m=>m.id===msg.sender_id);
      await renderMessage({ ...msg, sender });
      await supabase.from("current_receipts").upsert({ message_id:msg.id, user_id:me.id, status:"read" },{ onConflict:"message_id,user_id" });
      loadConversations();
    })
    .on("postgres_changes",{ event:"UPDATE",schema:"public",table:"current_messages",filter:`conversation_id=eq.${convId}` }, async payload => {
      const msg = payload.new;
      if(msg.deleted_for_all) {
        const el=document.getElementById("msg-"+msg.id);
        if(el) el.querySelector(".msg-text").textContent="🗑 This message was deleted";
      }
    })
    .on("postgres_changes",{ event:"INSERT",schema:"public",table:"current_receipts" }, payload => {
      if(payload.new.status==="read") {
        const s=document.getElementById("status-"+payload.new.message_id);
        if(s) { s.textContent="✓✓"; s.classList.add("read"); }
      }
    })
    .on("postgres_changes",{ event:"INSERT",schema:"public",table:"current_reactions" }, payload => {
      loadReactions(payload.new.message_id);
    })
    .subscribe();

  presenceChannel = supabase.channel("presence:"+convId, { config:{ presence:{ key:me.id } } })
    .on("presence",{ event:"sync" }, () => {
      const state = presenceChannel.presenceState();
      const others = Object.values(state).flat().filter(u=>u.user_id!==me.id);
      const typing = others.some(u=>u.typing);
      document.getElementById("typing-area").style.display = typing?"block":"none";
      if(typing) {
        const typer = activeMembers.find(m=>m.id===others.find(u=>u.typing)?.user_id);
        document.getElementById("typing-label").textContent = `${typer?.display_name||"Someone"} is typing…`;
      }
    })
    .subscribe(async status => {
      if(status==="SUBSCRIBED") await presenceChannel.track({ user_id:me.id, typing:false });
    });
}

// ── New conversation ──────────────────────────────────────────────────────────
document.getElementById("new-chat-btn").onclick = () => {
  document.getElementById("nc-username").value="";
  document.getElementById("nc-result").textContent="";
  document.getElementById("new-chat-modal").style.display="flex";
};
document.getElementById("nc-cancel").onclick = () => document.getElementById("new-chat-modal").style.display="none";
document.getElementById("new-chat-modal").onclick = e => { if(e.target===document.getElementById("new-chat-modal")) document.getElementById("new-chat-modal").style.display="none"; };

let foundUser = null;
document.getElementById("nc-username").oninput = async function() {
  foundUser=null;
  const username=this.value.trim().toLowerCase();
  const res=document.getElementById("nc-result");
  if(username.length<2){ res.textContent=""; return; }
  const { data } = await supabase.from("current_profiles")
    .select("id,username,display_name,identity_key,avatar_color,status_emoji,status_text,online")
    .eq("username",username).neq("id",me.id).maybeSingle();
  if(data) {
    foundUser=data;
    res.innerHTML=`<div style="display:flex;align-items:center;gap:10px;margin-top:8px;padding:10px;background:rgba(24,169,107,.08);border-radius:10px">
      <div class="avatar sm" style="background:${data.avatar_color||"#18a96b"}">${avatarInitial(data.display_name||data.username)}</div>
      <div><strong>${escHtml(data.display_name||data.username)}</strong><br>
      <small style="color:var(--muted)">@${escHtml(data.username)} ${data.online?"🟢":""} ${data.status_emoji||""} ${escHtml(data.status_text||"")}</small></div>
    </div>`;
  } else {
    res.innerHTML=`<div style="color:var(--danger);font-size:13px;margin-top:6px">User not found</div>`;
  }
};

document.getElementById("nc-start").onclick = async () => {
  if(!foundUser) { toast("Enter a valid username first.","error"); return; }
  const { data:mine } = await supabase.from("current_members").select("conversation_id").eq("user_id",me.id);
  if(mine?.length) {
    const { data:shared } = await supabase.from("current_members")
      .select("conversation_id").eq("user_id",foundUser.id).in("conversation_id",mine.map(m=>m.conversation_id));
    if(shared?.length) {
      const { data:conv } = await supabase.from("current_conversations").select("*").eq("id",shared[0].conversation_id).single();
      document.getElementById("new-chat-modal").style.display="none";
      openConversation(conv, foundUser); return;
    }
  }
  const { data:newConv, error } = await supabase.from("current_conversations").insert({ type:"direct" }).select("*").single();
  if(error) { toast("Error: "+error.message,"error"); return; }
  await supabase.from("current_members").insert([
    { conversation_id:newConv.id, user_id:me.id, role:"admin" },
    { conversation_id:newConv.id, user_id:foundUser.id, role:"member" },
  ]);
  document.getElementById("new-chat-modal").style.display="none";
  await loadConversations();
  openConversation(newConv, foundUser);
};

// ── Disappearing messages ─────────────────────────────────────────────────────
document.getElementById("disappear-cancel").onclick = () => document.getElementById("disappear-modal").style.display="none";
document.getElementById("disappear-save").onclick = async () => {
  if(!activeConv) return;
  const secs=parseInt(document.getElementById("disappear-select").value)||null;
  await supabase.from("current_conversations").update({ disappear_after_seconds:secs }).eq("id",activeConv.id);
  activeConv.disappear_after_seconds=secs;
  const label=document.getElementById("disappear-select").selectedOptions[0].text;
  toast(secs?`Messages disappear after ${label}`:"Disappearing messages off","success");
  document.getElementById("disappear-modal").style.display="none";
};

// ── Mobile back ───────────────────────────────────────────────────────────────
document.getElementById("mobile-back").onclick = () => {
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("conversation-pane").style.display="none";
  document.getElementById("empty-state").style.display="flex";
};

// ── Presence ──────────────────────────────────────────────────────────────────
async function setOnline(online) {
  if(!me) return;
  await supabase.from("current_profiles").update({ online, last_seen:new Date().toISOString() }).eq("id",me.id);
}
document.addEventListener("visibilitychange", ()=>setOnline(!document.hidden));
window.addEventListener("beforeunload", ()=>setOnline(false));

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  me = await getMe();
  if(!me) return;
  document.getElementById("my-avatar").textContent = avatarInitial(me.display_name||me.username);
  document.getElementById("my-username").textContent = `${me.status_emoji||"🟢"} ${me.display_name||me.username}`;
  await setOnline(true);
  await loadConversations();
  supabase.channel("global:"+me.id)
    .on("postgres_changes",{ event:"INSERT",schema:"public",table:"current_messages" },()=>loadConversations())
    .subscribe();
}
init();
