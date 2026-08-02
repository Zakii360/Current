import { supabase } from "./supabase.js";
import { getPublicKeyB64, exportKeyBackup, importKeyBackup, clearLocalKeys, generateIdentityKeyPair } from "./crypto.js";

function toast(msg, type="info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Theme ─────────────────────────────────────────────────────────────────────
const savedTheme = localStorage.getItem("current_theme");
if(savedTheme==="dark") document.body.classList.add("dark");

document.querySelectorAll(".theme-choice").forEach(btn => {
  btn.onclick = () => {
    const dark = btn.dataset.theme === "dark";
    document.body.classList.toggle("dark", dark);
    localStorage.setItem("current_theme", dark ? "dark" : "light");
    saveSettings({ theme: btn.dataset.theme });
  };
});

document.getElementById("accent-color").oninput = e => {
  document.documentElement.style.setProperty("--accent", e.target.value);
  saveSettings({ accent: e.target.value });
};

// ── Load user + settings ──────────────────────────────────────────────────────
let me = null;

async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if(!session) { location.replace("landing.html"); return; }

  const { data: profile } = await supabase
    .from("current_profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if(!profile) { location.replace("landing.html"); return; }
  me = profile;

  // Populate account section
  document.getElementById("s-username").textContent = "@" + profile.username;
  document.getElementById("s-email").textContent = session.user.email;
  document.getElementById("s-avatar").textContent = (profile.display_name || profile.username)[0].toUpperCase();
  document.getElementById("s-avatar").style.background = profile.avatar_color || "#18a96b";
  document.getElementById("display-name-input").value = profile.display_name || profile.username;
  document.getElementById("phone-input").value = profile.phone_number || "";

  // Public key display
  const pubKey = await getPublicKeyB64();
  const pkEl = document.getElementById("pubkey-display");
  if(pubKey) {
    pkEl.textContent = pubKey.slice(0, 40) + "…";
    pkEl.title = pubKey;
  } else {
    pkEl.textContent = "⚠️ No local key found — restore a backup or re-register.";
    pkEl.style.color = "var(--danger)";
  }

  // Load settings from current_settings table
  const { data: settings } = await supabase
    .from("current_settings")
    .select("*")
    .eq("user_id", me.id)
    .single();

  if(settings) {
    if(settings.theme === "dark") document.body.classList.add("dark");
    if(settings.accent) {
      document.documentElement.style.setProperty("--accent", settings.accent);
      document.getElementById("accent-color").value = settings.accent;
    }
    // Load privacy toggles from profile
    document.getElementById("toggle-receipts").checked = profile.show_read_receipts ?? true;
    document.getElementById("toggle-lastseen").checked = profile.show_last_seen ?? true;
    document.getElementById("toggle-online").checked = profile.show_online ?? true;
    document.getElementById("toggle-typing").checked = profile.show_typing ?? true;
    document.getElementById("default-disappear").value = profile.disappear_after_seconds || "";
  }
}

async function saveSettings(patch) {
  if(!me) return;
  await supabase.from("current_settings").upsert(
    { user_id: me.id, ...patch },
    { onConflict: "user_id" }
  );
}

// ── Save profile ──────────────────────────────────────────────────────────────
document.getElementById("save-profile").onclick = async () => {
  const display_name = document.getElementById("display-name-input").value.trim();
  const phone_number = document.getElementById("phone-input").value.trim() || null;

  const { error } = await supabase.from("current_profiles")
    .update({ display_name, phone_number })
    .eq("id", me.id);

  if(error) toast("Failed to save: " + error.message, "error");
  else toast("Profile saved!", "success");
};

// ── Save privacy ──────────────────────────────────────────────────────────────
document.getElementById("save-privacy").onclick = async () => {
  const patch = {
    show_read_receipts: document.getElementById("toggle-receipts").checked,
    show_last_seen: document.getElementById("toggle-lastseen").checked,
    show_online: document.getElementById("toggle-online").checked,
    show_typing: document.getElementById("toggle-typing").checked,
    disappear_after_seconds: parseInt(document.getElementById("default-disappear").value) || null,
  };

  // We need these columns — add them if not present (handled gracefully)
  const { error } = await supabase.from("current_profiles").update(patch).eq("id", me.id);
  if(error) {
    // Columns may not exist yet — save to current_settings instead
    await saveSettings(patch);
    toast("Privacy settings saved (profile columns pending migration).", "info");
  } else {
    toast("Privacy settings saved!", "success");
  }
};

// ── Key export ────────────────────────────────────────────────────────────────
document.getElementById("export-key").onclick = () => {
  const s = document.getElementById("export-section");
  s.style.display = s.style.display === "none" ? "block" : "none";
};

document.getElementById("do-export").onclick = async () => {
  const pw = document.getElementById("export-pw").value;
  if(!pw || pw.length < 6) { toast("Enter a password (min 6 chars).", "error"); return; }
  try {
    const backup = await exportKeyBackup(pw);
    const out = document.getElementById("export-output");
    out.value = backup;
    out.style.display = "block";
    document.getElementById("copy-backup").style.display = "inline-flex";
    toast("Backup generated! Copy and store it safely.", "success");
  } catch(e) {
    toast("Export failed: " + e.message, "error");
  }
};

document.getElementById("copy-backup").onclick = () => {
  navigator.clipboard.writeText(document.getElementById("export-output").value);
  toast("Copied to clipboard!", "success");
};

// ── Key import ────────────────────────────────────────────────────────────────
document.getElementById("import-key").onclick = () => {
  const s = document.getElementById("import-section");
  s.style.display = s.style.display === "none" ? "block" : "none";
};

document.getElementById("do-import").onclick = async () => {
  const json = document.getElementById("import-json").value.trim();
  const pw = document.getElementById("import-pw").value;
  if(!json || !pw) { toast("Provide both backup JSON and password.", "error"); return; }
  try {
    await importKeyBackup(json, pw);
    // Update identity_key on profile
    const pubKey = await getPublicKeyB64();
    if(pubKey) await supabase.from("current_profiles").update({ identity_key: pubKey }).eq("id", me.id);
    const r = document.getElementById("import-result");
    r.textContent = "✓ Key restored successfully!";
    r.style.display = "block";
    toast("Key restored!", "success");
  } catch(e) {
    toast("Restore failed — wrong password or invalid backup.", "error");
  }
};

// ── Regen keys ────────────────────────────────────────────────────────────────
document.getElementById("regen-key").onclick = async () => {
  if(!confirm("Regenerate keys? You will NOT be able to decrypt old messages unless you have a backup.")) return;
  try {
    const newPubKey = await generateIdentityKeyPair();
    await supabase.from("current_profiles").update({ identity_key: newPubKey }).eq("id", me.id);
    document.getElementById("pubkey-display").textContent = newPubKey.slice(0,40) + "…";
    toast("New keys generated and uploaded.", "success");
  } catch(e) {
    toast("Failed: " + e.message, "error");
  }
};

// ── Clear local keys ──────────────────────────────────────────────────────────
document.getElementById("clear-keys").onclick = async () => {
  if(!confirm("Remove your private key from this device? Old messages will be unreadable until you restore a backup.")) return;
  await clearLocalKeys();
  toast("Local keys cleared.", "success");
  document.getElementById("pubkey-display").textContent = "⚠️ No local key.";
  document.getElementById("pubkey-display").style.color = "var(--danger)";
};

// ── Sign out ──────────────────────────────────────────────────────────────────
document.getElementById("signout").onclick = async () => {
  if(me) await supabase.from("current_presence").upsert({ user_id: me.id, online: false }, { onConflict: "user_id" });
  await supabase.auth.signOut();
  location.replace("landing.html");
};

init();
