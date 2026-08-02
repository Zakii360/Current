import { supabase } from "./supabase.js";
import { generateIdentityKeyPair, hasIdentityKey, importKeyBackup } from "./crypto.js";

// ── Demo chat animation ───────────────────────────────────────────────────────
const msgs = document.getElementById("phone-messages");
const typing = document.getElementById("typing");
const conversation = [
  ["left","A","Hey, have you tried Current yet?"],
  ["right"," ","Yeah — the E2EE is actually real this time."],
  ["left","A","And keys never hit the server 🔐"],
  ["right"," ","Disappearing messages too. Finally."],
];
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function animChat(){
  for(const [type,name,text] of conversation){
    typing.style.display="flex";
    await wait(900);
    typing.style.display="none";
    const div=document.createElement("div");
    div.className="message "+type;
    div.style.cssText="padding:10px 14px;border-radius:18px;max-width:80%;font-size:13px;background:"+(type==="right"?"var(--msg-out)":"var(--msg-in)");
    msgs.appendChild(div);
    for(const ch of text){ div.textContent+=ch; await wait(28+Math.random()*60); }
    await wait(500);
  }
  await wait(3000);
  msgs.innerHTML="";
  animChat();
}
animChat();

// ── Ripple ────────────────────────────────────────────────────────────────────
document.querySelectorAll(".ripple-btn").forEach(btn=>{
  btn.onclick=e=>{
    const r=document.createElement("span");
    r.className="ripple";
    const s=Math.max(btn.offsetWidth,btn.offsetHeight);
    r.style.cssText=`width:${s}px;height:${s}px;left:${e.offsetX-s/2}px;top:${e.offsetY-s/2}px`;
    btn.appendChild(r);
    setTimeout(()=>r.remove(),700);
  };
});

// ── Theme ─────────────────────────────────────────────────────────────────────
const savedTheme = localStorage.getItem("current_theme");
if(savedTheme==="dark") document.body.classList.add("dark");
document.getElementById("theme").onclick=()=>{
  document.body.classList.toggle("dark");
  localStorage.setItem("current_theme", document.body.classList.contains("dark")?"dark":"light");
};

// ── Modal helpers ─────────────────────────────────────────────────────────────
const signupModal=document.getElementById("signup-modal");
const signinModal=document.getElementById("signin-modal");

function openModal(m){ m.style.display="flex"; }
function closeModal(m){ m.style.display="none"; }

document.getElementById("open-signup").onclick=()=>openModal(signupModal);
document.getElementById("open-signin").onclick=()=>openModal(signinModal);
document.getElementById("hero-signup").onclick=()=>openModal(signupModal);
document.getElementById("hero-signin").onclick=()=>openModal(signinModal);
document.getElementById("su-cancel").onclick=()=>closeModal(signupModal);
document.getElementById("si-cancel").onclick=()=>closeModal(signinModal);

[signupModal, signinModal].forEach(m=>{
  m.onclick=e=>{ if(e.target===m) closeModal(m); };
});

// ── Sign Up ───────────────────────────────────────────────────────────────────
document.getElementById("su-submit").onclick=async()=>{
  const username=document.getElementById("su-username").value.trim().toLowerCase();
  const email=document.getElementById("su-email").value.trim();
  const password=document.getElementById("su-password").value;
  const phone=document.getElementById("su-phone").value.trim();
  const errEl=document.getElementById("su-error");
  errEl.textContent="";

  if(!username||username.length<3){ errEl.textContent="Username must be at least 3 characters."; return; }
  if(!/^[a-z0-9_]+$/.test(username)){ errEl.textContent="Username: letters, numbers, underscores only."; return; }
  if(!email){ errEl.textContent="Email required."; return; }
  if(password.length<8){ errEl.textContent="Password must be at least 8 characters."; return; }

  const btn=document.getElementById("su-submit");
  btn.innerHTML="<span>Creating…</span>"; btn.disabled=true;

  try {
    // 1. Generate E2EE key pair
    const identityKey = await generateIdentityKeyPair();

    // 2. Create Supabase auth user
    const { data, error } = await supabase.auth.signUp({ email, password });
    if(error) throw error;

    const userId = data.user.id;

    // 3. Create profile
    const profileData = {
      id: userId,
      username,
      display_name: username,
      identity_key: identityKey,
    };
    if(phone) profileData.phone_number = phone;

    const { error: profErr } = await supabase.from("current_profiles").insert(profileData);
    if(profErr) throw profErr;

    // 4. Go to app
    location.replace("main.html");
  } catch(e) {
    errEl.textContent = e.message || "Sign up failed.";
    btn.innerHTML="<span>Create account</span>"; btn.disabled=false;
  }
};

// ── Sign In ───────────────────────────────────────────────────────────────────
document.getElementById("si-submit").onclick=async()=>{
  const email=document.getElementById("si-email").value.trim();
  const password=document.getElementById("si-password").value;
  const backupJson=document.getElementById("si-backup").value.trim();
  const backupPw=document.getElementById("si-backup-pw").value;
  const errEl=document.getElementById("si-error");
  errEl.textContent="";

  const btn=document.getElementById("si-submit");
  btn.innerHTML="<span>Signing in…</span>"; btn.disabled=true;

  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if(error) throw error;

    // If user provided a key backup, restore it
    if(backupJson && backupPw) {
      try {
        await importKeyBackup(backupJson, backupPw);
      } catch(e) {
        errEl.textContent = "⚠️ Key backup restore failed — wrong password? Messages may not decrypt.";
        // Still proceed to app
      }
    } else if(!(await hasIdentityKey())) {
      // No local key — user is on a new device
      errEl.textContent = "⚠️ No local key found. Paste a key backup to decrypt old messages, or old chats will be unreadable.";
      // Still proceed after 2s
      await new Promise(r=>setTimeout(r,2000));
    }

    location.replace("main.html");
  } catch(e) {
    errEl.textContent = e.message || "Sign in failed.";
    btn.innerHTML="<span>Sign in</span>"; btn.disabled=false;
  }
};
