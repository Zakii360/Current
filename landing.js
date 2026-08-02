import { supabase } from "./supabase.js";
import { generateIdentityKeyPair, hasIdentityKey, importKeyBackup, bufToB64 } from "./crypto.js";

// Username → deterministic fake email Supabase auth uses internally (never shown)
function usernameToEmail(u) {
  return `${u.toLowerCase()}@current.local`;
}

// Generate a random 8-word recovery code
function genRecoveryCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = crypto.getRandomValues(new Uint8Array(32));
  const groups = [];
  for(let g=0;g<8;g++){
    let w=''; for(let c=0;c<4;c++) w+=chars[arr[g*4+c]%chars.length];
    groups.push(w);
  }
  return groups.join('-');
}

async function hashCode(code) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code.toUpperCase().replace(/-/g,'')));
  return bufToB64(buf);
}

// ── Demo animation ────────────────────────────────────────────────────────────
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
  for(const [type,,text] of conversation){
    typing.style.display="flex"; await wait(900); typing.style.display="none";
    const div=document.createElement("div");
    div.className="message "+type;
    div.style.cssText="padding:10px 14px;border-radius:18px;max-width:80%;font-size:13px;background:"+(type==="right"?"var(--msg-out)":"var(--msg-in)");
    msgs.appendChild(div);
    for(const ch of text){ div.textContent+=ch; await wait(28+Math.random()*60); }
    await wait(500);
  }
  await wait(3000); msgs.innerHTML=""; animChat();
}
animChat();

// ── Ripple ────────────────────────────────────────────────────────────────────
document.querySelectorAll(".ripple-btn").forEach(btn=>{
  btn.onclick=e=>{
    const r=document.createElement("span"); r.className="ripple";
    const s=Math.max(btn.offsetWidth,btn.offsetHeight);
    r.style.cssText=`width:${s}px;height:${s}px;left:${e.offsetX-s/2}px;top:${e.offsetY-s/2}px`;
    btn.appendChild(r); setTimeout(()=>r.remove(),700);
  };
});

// ── Theme ─────────────────────────────────────────────────────────────────────
if(localStorage.getItem("current_theme")==="dark") document.body.classList.add("dark");
document.getElementById("theme").onclick=()=>{
  document.body.classList.toggle("dark");
  localStorage.setItem("current_theme", document.body.classList.contains("dark")?"dark":"light");
};

// ── Modals ────────────────────────────────────────────────────────────────────
const signupModal=document.getElementById("signup-modal");
const signinModal=document.getElementById("signin-modal");
const recoveryModal=document.getElementById("recovery-modal");
function openModal(m){ m.style.display="flex"; }
function closeModal(m){ m.style.display="none"; }

document.getElementById("open-signup").onclick=()=>openModal(signupModal);
document.getElementById("open-signin").onclick=()=>openModal(signinModal);
document.getElementById("hero-signup").onclick=()=>openModal(signupModal);
document.getElementById("hero-signin").onclick=()=>openModal(signinModal);
document.getElementById("su-cancel").onclick=()=>closeModal(signupModal);
document.getElementById("si-cancel").onclick=()=>closeModal(signinModal);
document.getElementById("si-forgot").onclick=()=>{ closeModal(signinModal); openModal(recoveryModal); };
document.getElementById("rec-cancel").onclick=()=>closeModal(recoveryModal);

[signupModal,signinModal,recoveryModal].forEach(m=>{
  m.onclick=e=>{ if(e.target===m) closeModal(m); };
});

// ── Sign Up ───────────────────────────────────────────────────────────────────
document.getElementById("su-submit").onclick=async()=>{
  const username=document.getElementById("su-username").value.trim().toLowerCase();
  const password=document.getElementById("su-password").value;
  const errEl=document.getElementById("su-error");
  errEl.style.color="var(--danger)"; errEl.textContent="";

  if(!username||username.length<3){ errEl.textContent="Username must be at least 3 characters."; return; }
  if(!/^[a-z0-9_]+$/.test(username)){ errEl.textContent="Letters, numbers, underscores only."; return; }
  if(password.length<8){ errEl.textContent="Password must be at least 8 characters."; return; }

  const btn=document.getElementById("su-submit");
  btn.innerHTML="<span>Creating…</span>"; btn.disabled=true;

  try {
    // Check username taken
    const { data: existing } = await supabase
      .from("current_profiles").select("id").eq("username", username).single();
    if(existing){ errEl.textContent="Username already taken."; btn.innerHTML="<span>Create account</span>"; btn.disabled=false; return; }

    // Generate E2EE keys + recovery code
    const identityKey = await generateIdentityKeyPair();
    const recoveryCode = genRecoveryCode();
    const recoveryHash = await hashCode(recoveryCode);

    // Sign up via fake email (user never sees this)
    const email = usernameToEmail(username);
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: {
        data: { username, display_name: username, identity_key: identityKey, recovery_hash: recoveryHash }
      }
    });
    if(error) throw error;

    // If profile wasn't created by trigger yet (race), insert manually
    if(data.user) {
      const { error: pe } = await supabase.from("current_profiles").upsert({
        id: data.user.id,
        username,
        display_name: username,
        identity_key: identityKey,
        recovery_hash: recoveryHash,
      }, { onConflict: "id" });
      // Ignore conflict — trigger may have already done it
    }

    // Show recovery code — user must save this
    closeModal(signupModal);
    showRecoveryCodeDialog(recoveryCode, ()=>location.replace("main.html"));

  } catch(e) {
    errEl.textContent = e.message||"Sign up failed.";
    btn.innerHTML="<span>Create account</span>"; btn.disabled=false;
  }
};

function showRecoveryCodeDialog(code, onDone) {
  const modal = document.getElementById("recovery-code-modal");
  document.getElementById("rc-code").textContent = code;
  modal.style.display="flex";

  document.getElementById("rc-copy").onclick=()=>{
    navigator.clipboard.writeText(code);
    document.getElementById("rc-copy").innerHTML="<span>✓ Copied!</span>";
  };
  document.getElementById("rc-done").onclick=()=>{
    modal.style.display="none";
    onDone();
  };
}

// ── Sign In ───────────────────────────────────────────────────────────────────
document.getElementById("si-submit").onclick=async()=>{
  const username=document.getElementById("si-username").value.trim().toLowerCase();
  const password=document.getElementById("si-password").value;
  const errEl=document.getElementById("si-error");
  errEl.style.color="var(--danger)"; errEl.textContent="";

  const btn=document.getElementById("si-submit");
  btn.innerHTML="<span>Signing in…</span>"; btn.disabled=true;

  try {
    const email = usernameToEmail(username);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if(error) throw new Error("Invalid username or password.");

    if(!(await hasIdentityKey())) {
      errEl.style.color="var(--warn,#d97706)";
      errEl.textContent="⚠️ No local key on this device — old messages can't decrypt. Use Settings → Restore key backup.";
      await wait(2200);
    }
    location.replace("main.html");
  } catch(e) {
    errEl.textContent=e.message||"Sign in failed.";
    btn.innerHTML="<span>Sign in</span>"; btn.disabled=false;
  }
};

// ── Account recovery ──────────────────────────────────────────────────────────
document.getElementById("rec-submit").onclick=async()=>{
  const username=document.getElementById("rec-username").value.trim().toLowerCase();
  const code=document.getElementById("rec-code").value.trim();
  const newPassword=document.getElementById("rec-newpassword").value;
  const errEl=document.getElementById("rec-error");
  errEl.style.color="var(--danger)"; errEl.textContent="";

  if(!username||!code||newPassword.length<8){
    errEl.textContent="Fill all fields. Password min 8 chars."; return;
  }

  const btn=document.getElementById("rec-submit");
  btn.innerHTML="<span>Verifying…</span>"; btn.disabled=true;

  try {
    // Fetch stored recovery hash for this username
    const { data: profile, error: pe } = await supabase
      .from("current_profiles")
      .select("id, recovery_hash")
      .eq("username", username)
      .single();

    if(pe||!profile) throw new Error("Username not found.");
    if(!profile.recovery_hash) throw new Error("No recovery code set for this account.");

    const inputHash = await hashCode(code);
    if(inputHash !== profile.recovery_hash) throw new Error("Recovery code incorrect.");

    // Code matches — update password via admin (use service key via edge function ideally)
    // For now: sign in with old method isn't possible, so we use updateUser after a magic approach
    // We'll call a Supabase RPC that does the password reset as SECURITY DEFINER
    const { error: rpcErr } = await supabase.rpc("reset_password_with_recovery", {
      p_user_id: profile.id,
      p_new_password: newPassword,
    });
    if(rpcErr) throw new Error("Password reset failed — "+rpcErr.message);

    errEl.style.color="var(--accent)";
    errEl.textContent="✓ Password reset! You can now sign in.";
    btn.innerHTML="<span>Recover account</span>"; btn.disabled=false;
    setTimeout(()=>{ closeModal(recoveryModal); openModal(signinModal); }, 2000);

  } catch(e) {
    errEl.textContent=e.message||"Recovery failed.";
    btn.innerHTML="<span>Recover account</span>"; btn.disabled=false;
  }
};

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
