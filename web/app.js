const CONFIG = {
  clientId: "REPLACE_WITH_GOOGLE_WEB_CLIENT_ID",
  driveScope: "https://www.googleapis.com/auth/drive.file"
};

let tokenClient = null;
let accessToken = null;
let startedAt = null;
let timerHandle = null;

const $ = id => document.getElementById(id);
const status = (message, kind="") => {
  const el = $("status");
  el.textContent = message;
  el.className = "status " + kind;
};

function initGoogle() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(initGoogle, 300);
    return;
  }
  if (CONFIG.clientId.startsWith("REPLACE_")) {
    status("Google OAuth client ID is not installed yet.", "error");
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.clientId,
    scope: CONFIG.driveScope,
    callback: async (response) => {
      if (response.error) {
        status("Google authorization failed: " + response.error, "error");
        return;
      }
      accessToken = response.access_token;
      sessionStorage.setItem("meeting_mom_google_connected","1");
      status("Google Drive connected.", "success");
      $("connectBtn").classList.add("hidden");
      $("meetingCard").classList.remove("hidden");
      await ensureMoMFolder();
    }
  });
}

async function connectGoogle() {
  if (!tokenClient) {
    status("Google authorization is still loading. Please try again.", "error");
    return;
  }
  tokenClient.requestAccessToken({prompt:"consent"});
}

async function ensureMoMFolder() {
  const q = encodeURIComponent("name='MoM' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const response = await fetch("https://www.googleapis.com/drive/v3/files?q="+q+"&spaces=drive&fields=files(id,name)", {
    headers:{Authorization:"Bearer "+accessToken}
  });
  if (!response.ok) throw new Error("Drive folder check failed: "+response.status);
  const data = await response.json();
  if (data.files?.length) return data.files[0];

  const create = await fetch("https://www.googleapis.com/drive/v3/files", {
    method:"POST",
    headers:{Authorization:"Bearer "+accessToken,"Content-Type":"application/json"},
    body:JSON.stringify({name:"MoM",mimeType:"application/vnd.google-apps.folder"})
  });
  if (!create.ok) throw new Error("Could not create MoM folder: "+create.status);
  return create.json();
}

function formatTime(ms) {
  const total=Math.floor(ms/1000), h=String(Math.floor(total/3600)).padStart(2,"0");
  const m=String(Math.floor(total%3600/60)).padStart(2,"0"), s=String(total%60).padStart(2,"0");
  return h+":"+m+":"+s;
}

function startMeeting() {
  startedAt=Date.now();
  $("startBtn").classList.add("hidden");
  $("stopBtn").classList.remove("hidden");
  timerHandle=setInterval(()=>{$("timer").textContent=formatTime(Date.now()-startedAt)},250);
  status("Meeting recording session started.", "success");
}

function stopMeeting() {
  clearInterval(timerHandle);
  $("stopBtn").classList.add("hidden");
  $("startBtn").classList.remove("hidden");
  status("Recording stopped. Native recorder upload will be connected next.", "success");
}

$("connectBtn").addEventListener("click", connectGoogle);
$("startBtn").addEventListener("click", startMeeting);
$("stopBtn").addEventListener("click", stopMeeting);
initGoogle();