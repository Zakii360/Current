import { supabase } from "./supabase.js";
import { encryptMessage, decryptMessage, hasIdentityKey } from "./crypto.js";

// ── State ─────────────────────────────────────────────────────────────────────
let me = null;          // current user profile
let activeConv = null;  // active conversation object
let activeMembers = []; // members of active conversation
let replyTo = null;     // message being replied to
let ctxMsgId = null;    // message right-clicked
let realtimeChannel = null;
let presenceChannel = null;
let typingTimeout = null;
let lastTypingSent = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function toast(msg, type="info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}

function fmtConvTime(ts) {
  if(!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if(diff < 86400000) return fmtTime(ts);
  if(diff < 604800000) return d.toLocaleDateString([],{weekday:"short"});
  return d.toLocaleDateString([],{month:"short",day:"numeric"});
}

function avatarInitial(name) {
  return (name||"?")[0].toUpperCase();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getMe() {
  const { data: { session } } = await supabase.auth.getSession();
  if(!session) { location.replace("landing.html"); return null; }

  const { data, error } = await supabase
    .from("current_profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if(error || !data) { location.replace("landing.html"); return null; }

  // Check local E2EE key
  if(!(await hasIdentityKey())) {
    toast("⚠️ No local key — old messages can't be decrypted. Go to Settings → Key backup to restore.", "error");
  }

  return data;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
if(localStorage.getItem("current_theme")==="dark") document.body.classList.add("dark");
document.getElementById("theme-btn").onclick=()=>{
  document.body.classList.toggle("dark");
  localStorage.setItem("current_theme", document.body.classList.contains("dark")?"dark":"light");
};

// ── Sign out ──────────────────────────────────────────────────────────────────
document.getElementById("signout-btn").onclick=async()=>{
  if(me) {
    await supabase.from("current_profiles").update({ online:false }).eq("id", me.id);
  }
  await supabase.auth.signOut();
  location.replace("landing.html");
};

document.getElementById("sidebar-settings").onclick=()=>{
  location.href="settings.html";
};

// ── Load conversations ─────────────────────────────────────────────────────────
async function loadConversations(filter="") {
  const { data: memberships } = await supabase
    .from("current_members")
    .select("conversation_id, last_read_at, muted, archived")
    .eq("user_id", me.id);

  if(!memberships?.length) {
    document.getElementById("chat-list").innerHTML =
      `<div style="padding:20px;color:var(--muted);font-size:13px;text-align:center">No conversations yet.<br>Start one with ✏️</div>`;
    return;
  }

  const convIds = memberships.map(m=>m.conversation_id);

  const { data: convs } = await supabase
    .from("current_conversations")
    .select("*")
    .in("id", convIds)
    .order("created_at", { ascending:false });

  // Load last messages
  const convMap = {};
  for(const c of convs||[]) convMap[c.id] = { ...c, lastMsg:null, unread:0 };

  // Fetch last message per conversation
  for(const cid of convIds) {
    const { data: msgs } = await supabase
      .from("current_messages")
      .select("id, sent_at, message_type, sender_id, deleted_for_all")
      .eq("conversation_id", cid)
      .eq("deleted_for_all", false)
      .order("sent_at", { ascending:false })
      .limit(1);
    if(msgs?.[0]) convMap[cid].lastMsg = msgs[0];
  }

  // Get other members for DM naming
  const allOtherMemberIds = [];
  for(const c of Object.values(convMap)) {
    if(c.type==="direct") {
      const { data: mems } = await supabase
        .from("current_members")
        .select("user_id")
        .eq("conversation_id", c.id)
        .neq("user_id", me.id);
      c._otherId = mems?.[0]?.user_id;
      if(c._otherId) allOtherMemberIds.push(c._otherId);
    }
  }

  // Fetch other profiles
  const profileMap = {};
  if(allOtherMemberIds.length) {
    const { data: profiles } = await supabase
      .from("current_profiles")
      .select("id, username, display_name, online, last_seen, avatar_color")
      .in("id", allOtherMemberIds);
    for(const p of profiles||[]) profileMap[p.id] = p;
  }

  // Render
  const list = document.getElementById("chat-list");
  const sorted = Object.values(convMap)
    .filter(c=>!filter || (c.name||"").toLowerCase().includes(filter) ||
      (c._otherId && (profileMap[c._otherId]?.username||"").toLowerCase().includes(filter)))
    .sort((a,b)=>(b.lastMsg?.sent_at||b.created_at) > (a.lastMsg?.sent_at||a.created_at) ? 1 : -1);

  if(!sorted.length) {
    list.innerHTML=`<div style="padding:20px;color:var(--muted);font-size:13px;text-align:center">No results</div>`;
    return;
  }

  list.innerHTML = sorted.map(c=>{
    const other = c._otherId ? profileMap[c._otherId] : null;
    const name = c.type==="direct" ? (other?.display_name||other?.username||"Unknown") : (c.name||"Group");
    const initial = avatarInitial(name);
    const online = other?.online || false;
    const preview = c.lastMsg ? (c.lastMsg.message_type==="text" ? "🔐 Encrypted" : `📎 ${c.lastMsg.message_type}`) : "No messages yet";
    const time = fmtConvTime(c.lastMsg?.sent_at);
    const isActive = activeConv?.id === c.id;
    return `
    <div class="chat-item${isActive?" active":""}" data-conv-id="${c.id}" data-other-id="${c._otherId||""}">
      <div class="avatar sm" style="background:${c.avatar_color||"#18a96b"};position:relative">
        ${initial}
        ${online ? `<span style="position:absolute;bottom:0;right:0;width:9px;height:9px;border-radius:50%;background:#18a96b;border:2px solid var(--bg)"></span>` : ""}
      </div>
      <div class="chat-item-info">
        <strong>${name}</strong>
        <div class="chat-item-preview">${preview}</div>
      </div>
      <div class="chat-item-meta">
        <div class="chat-item-time">${time}</div>
      </div>
    </div>`;
  }).join("");

  list.querySelectorAll(".chat-item").forEach(el=>{
    el.onclick=()=>{
      const convId = el.dataset.convId;
      const conv = convMap[convId];
      if(!conv) return;
      const other = conv._otherId ? profileMap[conv._otherId] : null;
      openConversation(conv, other);
    };
  });
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchTimeout;
document.getElementById("search-input").oninput=e=>{
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(()=>loadConversations(e.target.value.trim().toLowerCase()), 250);
};

// ── Open conversation ─────────────────────────────────────────────────────────
async function openConversation(conv, otherProfile) {
  // Unsubscribe old channel
  if(realtimeChannel) await supabase.removeChannel(realtimeChannel);

  activeConv = conv;

  // Show pane, hide empty
  document.getElementById("empty-state").style.display="none";
  document.getElementById("conversation-pane").style.display="flex";

  // Header
  const name = conv.type==="direct"
    ? (otherProfile?.display_name||otherProfile?.username||"Unknown")
    : (conv.name||"Group");

  document.getElementById("conv-name").textContent = name;
  document.getElementById("conv-avatar").textContent = avatarInitial(name);
  document.getElementById("conv-avatar").style.background = conv.avatar_color||"#18a96b";

  if(conv.type==="direct" && otherProfile) {
    const last = otherProfile.last_seen ? new Date(otherProfile.last_seen) : null;
    document.getElementById("conv-status").textContent = otherProfile.online
      ? "🟢 Online"
      : last ? `Last seen ${fmtConvTime(last.toISOString())}` : "Offline";
  }

  // Load members (for E2EE)
  const { data: mems } = await supabase
    .from("current_members")
    .select("user_id")
    .eq("conversation_id", conv.id);
  const memberIds = mems?.map(m=>m.user_id)||[];

  const { data: memberProfiles } = await supabase
    .from("current_profiles")
    .select("id, username, display_name, identity_key")
    .in("id", memberIds);

  activeMembers = memberProfiles||[];

  // Load messages
  await loadMessages();

  // Disappear button
  document.getElementById("conv-disappear-btn").onclick=()=>{
    const sel = document.getElementById("disappear-select");
    sel.value = conv.disappear_after_seconds||"";
    document.getElementById("disappear-modal").style.display="flex";
  };

  // Block button
  document.getElementById("conv-block-btn").onclick=async()=>{
    if(!otherProfile) return;
    if(!confirm(`Block ${name}? They won't be able to message you.`)) return;
    const { error } = await supabase.from("current_blocks").upsert({
      blocker_id: me.id, blocked_id: otherProfile.id
    });
    if(!error) toast("User blocked.", "success");
  };

  // Subscribe to realtime
  subscribeToConversation(conv.id, otherProfile);

  // Mark as read
  await supabase.from("current_members")
    .update({ last_read_at: new Date().toISOString() })
    .eq("conversation_id", conv.id)
    .eq("user_id", me.id);

  // Update sidebar active state
  document.querySelectorAll(".chat-item").forEach(el=>{
    el.classList.toggle("active", el.dataset.convId===conv.id);
  });

  // Mobile: close sidebar
  if(window.innerWidth<=700) {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("mobile-back").style.display="inline-flex";
  }
}

// ── Load messages ─────────────────────────────────────────────────────────────
async function loadMessages() {
  const area = document.getElementById("messages");
  area.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px">Loading…</div>`;

  const { data: msgs, error } = await supabase
    .from("current_messages")
    .select("*, sender:current_profiles(id,username,display_name,identity_key)")
    .eq("conversation_id", activeConv.id)
    .eq("deleted_for_all", false)
    .order("sent_at", { ascending:true })
    .limit(100);

  if(error) { area.innerHTML=`<div style="color:var(--danger);text-align:center;padding:20px">Failed to load messages.</div>`; return; }

  area.innerHTML = "";
  for(const msg of msgs||[]) {
    await renderMessage(msg, false);
  }
  area.scrollTop = area.scrollHeight;

  // Send read receipts for all
  if(msgs?.length) {
    const msgIds = msgs.filter(m=>m.sender_id!==me.id).map(m=>m.id);
    if(msgIds.length) {
      await supabase.from("current_receipts").upsert(
        msgIds.map(id=>({ message_id:id, user_id:me.id, status:"read" })),
        { onConflict:"message_id,user_id" }
      );
    }
  }
}

// ── Render a message ──────────────────────────────────────────────────────────
async function renderMessage(msg, scrollIntoView=true) {
  const area = document.getElementById("messages");
  const isMine = msg.sender_id === me.id;
  const sender = msg.sender || activeMembers.find(m=>m.id===msg.sender_id);

  // Decrypt
  let text = "";
  if(msg.deleted_for_all) {
    text = "🗑 Message deleted";
  } else {
    try {
      const senderKey = sender?.identity_key || me.identity_key;
      // For own messages, use own public key as sender
      const decryptSenderKey = isMine ? me.identity_key : senderKey;
      text = await decryptMessage(msg, me.id, decryptSenderKey);
    } catch(e) {
      text = "🔒 [Encrypted — cannot decrypt]";
    }
  }

  // Check if should auto-delete (disappearing)
  if(msg.disappears_at && new Date(msg.disappears_at) < new Date()) return;

  // Existing element?
  let el = document.getElementById("msg-"+msg.id);
  if(el) {
    const textEl = el.querySelector(".msg-text");
    if(textEl) textEl.textContent = text;
    return;
  }

  el = document.createElement("div");
  el.id = "msg-"+msg.id;
  el.className = `message ${isMine?"right":"left"}${msg.deleted_for_all?" deleted":""}${msg.disappears_at?" disappearing":""}`;
  el.dataset.msgId = msg.id;

  let inner = "";
  if(!isMine) {
    inner += `<div class="msg-sender-name">${sender?.display_name||sender?.username||"Unknown"}</div>`;
  }
  if(msg.reply_to) {
    inner += `<div class="msg-reply-preview">↩ ${msg.reply_to}</div>`;
  }
  inner += `<div class="msg-text">${escHtml(text)}</div>`;
  inner += `<div class="msg-meta">
    <span class="msg-time">${fmtTime(msg.sent_at)}</span>
    ${isMine ? `<span class="msg-status" id="status-${msg.id}">✓</span>` : ""}
  </div>`;
  inner += `<div class="msg-reactions" id="reactions-${msg.id}"></div>`;

  el.innerHTML = inner;

  // Right-click / long press context menu
  el.addEventListener("contextmenu", e=>{ e.preventDefault(); showCtxMenu(e.clientX, e.clientY, msg, text); });
  el.addEventListener("touchstart", ()=>{ ctxMsgId=msg.id; }, { passive:true });

  area.appendChild(el);

  if(scrollIntoView) el.scrollIntoView({ behavior:"smooth", block:"end" });

  // Schedule disappear
  if(msg.disappears_at) {
    const ms = new Date(msg.disappears_at) - Date.now();
    if(ms>0) setTimeout(()=>{ el.remove(); }, ms);
  }

  // Load reactions
  loadReactions(msg.id);
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br>");
}

// ── Context menu ──────────────────────────────────────────────────────────────
function showCtxMenu(x, y, msg, text) {
  ctxMsgId = msg.id;
  const menu = document.getElementById("ctx-menu");
  menu.style.display="block";
  menu.style.left = Math.min(x, window.innerWidth-180)+"px";
  menu.style.top = Math.min(y, window.innerHeight-180)+"px";

  document.getElementById("ctx-reply").onclick=()=>{
    replyTo = msg;
    document.getElementById("reply-banner").style.display="flex";
    document.getElementById("reply-name").textContent = msg.sender?.display_name||"";
    document.getElementById("reply-preview").textContent = text.slice(0,60);
    document.getElementById("messageInput").focus();
    hideCtx();
  };

  document.getElementById("ctx-copy").onclick=()=>{
    navigator.clipboard.writeText(text).then(()=>toast("Copied!","success"));
    hideCtx();
  };

  document.getElementById("ctx-react").onclick=()=>{
    hideCtx();
    showReactionPicker(x, y, msg.id);
  };

  document.getElementById("ctx-delete").onclick=async()=>{
    if(msg.sender_id!==me.id){ toast("You can only delete your own messages.","error"); hideCtx(); return; }
    if(!confirm("Delete this message for everyone?")) { hideCtx(); return; }
    await supabase.from("current_messages").update({ deleted_for_all:true }).eq("id", msg.id);
    const el = document.getElementById("msg-"+msg.id);
    if(el) { el.classList.add("deleted"); el.querySelector(".msg-text").textContent="🗑 Message deleted"; }
    hideCtx();
  };
}

function hideCtx() {
  document.getElementById("ctx-menu").style.display="none";
  document.getElementById("reaction-picker").style.display="none";
}
document.addEventListener("click", hideCtx);

// ── Reactions ─────────────────────────────────────────────────────────────────
function showReactionPicker(x, y, msgId) {
  const p = document.getElementById("reaction-picker");
  p.style.display="flex";
  p.style.left = Math.min(x, window.innerWidth-200)+"px";
  p.style.top = Math.min(y, window.innerHeight-60)+"px";

  p.querySelectorAll(".emoji-quick").forEach(btn=>{
    btn.onclick=async(e)=>{
      e.stopPropagation();
      await supabase.from("current_reactions").upsert(
        { message_id:msgId, user_id:me.id, emoji:btn.dataset.emoji },
        { onConflict:"message_id,user_id" }
      );
      loadReactions(msgId);
      hideCtx();
    };
  });
}

async function loadReactions(msgId) {
  const { data } = await supabase
    .from("current_reactions")
    .select("emoji, user_id")
    .eq("message_id", msgId);

  const container = document.getElementById("reactions-"+msgId);
  if(!container||!data) return;

  // Group by emoji
  const groups = {};
  for(const r of data) {
    groups[r.emoji] = (groups[r.emoji]||0)+1;
  }

  container.innerHTML = Object.entries(groups)
    .map(([emoji,count])=>`<span class="reaction-chip">${emoji} ${count}</span>`)
    .join("");
}

// ── Quick emoji in composer ────────────────────────────────────────────────────
document.querySelectorAll(".emoji-quick").forEach(btn=>{
  if(btn.closest("#reaction-picker")) return;
  btn.onclick=()=>{
    const input = document.getElementById("messageInput");
    input.value += btn.dataset.emoji;
    input.focus();
  };
});

// ── Send message ──────────────────────────────────────────────────────────────
document.getElementById("send").onclick = sendMessage;
document.getElementById("messageInput").addEventListener("keydown", e=>{
  if(e.key==="Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
const inputEl = document.getElementById("messageInput");
inputEl.addEventListener("input", ()=>{
  inputEl.style.height="auto";
  inputEl.style.height=Math.min(inputEl.scrollHeight,130)+"px";

  // Typing indicator
  const now = Date.now();
  if(now - lastTypingSent > 2000) {
    lastTypingSent = now;
    if(presenceChannel) {
      presenceChannel.track({ user_id:me.id, typing:true });
    }
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(()=>{
    if(presenceChannel) presenceChannel.track({ user_id:me.id, typing:false });
  }, 2500);
});

async function sendMessage() {
  if(!activeConv) return;
  const text = inputEl.value.trim();
  if(!text) return;

  inputEl.value="";
  inputEl.style.height="auto";

  // Build recipients list (all members with identity keys)
  const recipients = activeMembers
    .filter(m=>m.identity_key)
    .map(m=>({ userId:m.id, publicKeyB64:m.identity_key }));

  // Always include self (for decryption on own device)
  if(!recipients.find(r=>r.userId===me.id) && me.identity_key) {
    recipients.push({ userId:me.id, publicKeyB64:me.identity_key });
  }

  if(!recipients.length) {
    toast("⚠️ No encryption keys available — message not sent.","error");
    return;
  }

  try {
    const { ciphertext, iv, recipient_keys } = await encryptMessage(text, recipients);

    const msgData = {
      conversation_id: activeConv.id,
      sender_id: me.id,
      ciphertext,
      iv,
      recipient_keys,
      message_type: "text",
    };

    if(replyTo) { msgData.reply_to = replyTo.id; }

    if(activeConv.disappear_after_seconds) {
      msgData.disappears_at = new Date(Date.now() + activeConv.disappear_after_seconds*1000).toISOString();
    }

    const { data, error } = await supabase.from("current_messages").insert(msgData).select("*").single();
    if(error) throw error;

    // Clear reply
    replyTo=null;
    document.getElementById("reply-banner").style.display="none";

    // Optimistically render (realtime will also fire but deduplicate by id)
    const fullMsg = { ...data, sender:me };
    await renderMessage(fullMsg);

  } catch(e) {
    toast("Failed to send: "+e.message,"error");
    inputEl.value=text;
  }
}

document.getElementById("cancel-reply").onclick=()=>{
  replyTo=null;
  document.getElementById("reply-banner").style.display="none";
};

// ── Realtime subscription ─────────────────────────────────────────────────────
function subscribeToConversation(convId, otherProfile) {
  realtimeChannel = supabase
    .channel("conv:"+convId)
    .on("postgres_changes", {
      event:"INSERT", schema:"public", table:"current_messages",
      filter:`conversation_id=eq.${convId}`
    }, async payload=>{
      const msg = payload.new;
      if(msg.sender_id===me.id) {
        // Update our own status indicator
        const statusEl = document.getElementById("status-"+msg.id);
        if(statusEl) statusEl.textContent="✓✓";
        return;
      }
      // Fetch sender profile for decryption key
      const sender = activeMembers.find(m=>m.id===msg.sender_id);
      await renderMessage({ ...msg, sender });
      // Send read receipt
      await supabase.from("current_receipts").upsert(
        { message_id:msg.id, user_id:me.id, status:"read" },
        { onConflict:"message_id,user_id" }
      );
    })
    .on("postgres_changes", {
      event:"UPDATE", schema:"public", table:"current_messages",
      filter:`conversation_id=eq.${convId}`
    }, async payload=>{
      const msg = payload.new;
      const el = document.getElementById("msg-"+msg.id);
      if(!el) return;
      if(msg.deleted_for_all) {
        el.classList.add("deleted");
        const t=el.querySelector(".msg-text");
        if(t) t.textContent="🗑 Message deleted";
      }
    })
    .on("postgres_changes", {
      event:"INSERT", schema:"public", table:"current_receipts"
    }, payload=>{
      const { message_id, status } = payload.new;
      const statusEl = document.getElementById("status-"+message_id);
      if(statusEl && status==="read") { statusEl.textContent="✓✓"; statusEl.classList.add("read"); }
    })
    .subscribe();

  // Presence for typing + online
  if(presenceChannel) supabase.removeChannel(presenceChannel);
  presenceChannel = supabase.channel("presence:"+convId, { config:{ presence:{ key:me.id } } });
  presenceChannel
    .on("presence", { event:"sync" }, ()=>{
      const state = presenceChannel.presenceState();
      const others = Object.values(state).flat().filter(u=>u.user_id!==me.id);
      const typing = others.some(u=>u.typing);
      const typingArea = document.getElementById("typing-area");
      typingArea.style.display = typing?"block":"none";
      if(typing) {
        const typer = others.find(u=>u.typing);
        const name = activeMembers.find(m=>m.id===typer?.user_id)?.display_name||"Someone";
        document.getElementById("typing-label").textContent = `${name} is typing…`;
      }
    })
    .subscribe(async status=>{
      if(status==="SUBSCRIBED") {
        await presenceChannel.track({ user_id:me.id, typing:false });
      }
    });
}

// ── New conversation ──────────────────────────────────────────────────────────
document.getElementById("new-chat-btn").onclick=()=>{
  document.getElementById("nc-username").value="";
  document.getElementById("nc-result").textContent="";
  document.getElementById("new-chat-modal").style.display="flex";
};
document.getElementById("nc-cancel").onclick=()=>{ document.getElementById("new-chat-modal").style.display="none"; };
document.getElementById("new-chat-modal").onclick=e=>{
  if(e.target===document.getElementById("new-chat-modal")) document.getElementById("new-chat-modal").style.display="none";
};

let foundUser = null;
document.getElementById("nc-username").oninput=async function() {
  foundUser=null;
  const username = this.value.trim().toLowerCase();
  if(username.length<2){ document.getElementById("nc-result").textContent=""; return; }
  const { data } = await supabase
    .from("current_profiles")
    .select("id,username,display_name,identity_key")
    .eq("username", username)
    .neq("id", me.id)
    .single();
  const res = document.getElementById("nc-result");
  if(data) {
    foundUser=data;
    res.innerHTML=`<span style="color:var(--accent)">✓ Found: ${data.display_name||data.username}</span>`;
  } else {
    res.innerHTML=`<span style="color:var(--danger)">User not found</span>`;
  }
};

document.getElementById("nc-start").onclick=async()=>{
  if(!foundUser){ toast("Enter a valid username first.","error"); return; }

  // Check if DM already exists
  const { data: existingMems } = await supabase
    .from("current_members")
    .select("conversation_id")
    .eq("user_id", me.id);

  if(existingMems?.length) {
    const myConvIds = existingMems.map(m=>m.conversation_id);
    const { data: shared } = await supabase
      .from("current_members")
      .select("conversation_id")
      .eq("user_id", foundUser.id)
      .in("conversation_id", myConvIds);

    if(shared?.length) {
      // Existing conv — open it
      const { data: conv } = await supabase
        .from("current_conversations")
        .select("*")
        .eq("id", shared[0].conversation_id)
        .single();
      document.getElementById("new-chat-modal").style.display="none";
      openConversation(conv, foundUser);
      return;
    }
  }

  // Create new DM
  const { data: newConv, error } = await supabase
    .from("current_conversations")
    .insert({ type:"direct" })
    .select("*")
    .single();

  if(error){ toast("Error creating conversation.","error"); return; }

  await supabase.from("current_members").insert([
    { conversation_id:newConv.id, user_id:me.id, role:"admin" },
    { conversation_id:newConv.id, user_id:foundUser.id, role:"member" },
  ]);

  document.getElementById("new-chat-modal").style.display="none";
  await loadConversations();
  openConversation(newConv, foundUser);
};

// ── Disappearing messages ─────────────────────────────────────────────────────
document.getElementById("disappear-cancel").onclick=()=>{ document.getElementById("disappear-modal").style.display="none"; };
document.getElementById("disappear-save").onclick=async()=>{
  if(!activeConv) return;
  const secs = parseInt(document.getElementById("disappear-select").value)||null;
  const { error } = await supabase.from("current_conversations")
    .update({ disappear_after_seconds:secs })
    .eq("id", activeConv.id);
  if(!error) {
    activeConv.disappear_after_seconds = secs;
    toast(secs ? `Messages will disappear after ${document.getElementById("disappear-select").options[document.getElementById("disappear-select").selectedIndex].text}` : "Disappearing messages off", "success");
  }
  document.getElementById("disappear-modal").style.display="none";
};

// ── Mobile back ────────────────────────────────────────────────────────────────
document.getElementById("mobile-back").onclick=()=>{
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("conversation-pane").style.display="none";
  document.getElementById("empty-state").style.display="flex";
};

// ── Presence: set self online ─────────────────────────────────────────────────
async function setOnline(online) {
  if(!me) return;
  await supabase.from("current_profiles")
    .update({ online, last_seen:new Date().toISOString() })
    .eq("id", me.id);
}
document.addEventListener("visibilitychange", ()=>setOnline(!document.hidden));
window.addEventListener("beforeunload", ()=>setOnline(false));

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  me = await getMe();
  if(!me) return;

  // Populate own info
  document.getElementById("my-avatar").textContent = avatarInitial(me.display_name||me.username);
  document.getElementById("my-username").textContent = me.display_name||me.username;

  await setOnline(true);
  await loadConversations();

  // Listen for new messages in any of our convs (sidebar refresh)
  supabase
    .channel("global:"+me.id)
    .on("postgres_changes",{event:"INSERT",schema:"public",table:"current_messages"},()=>{
      loadConversations();
    })
    .subscribe();
}

init();
