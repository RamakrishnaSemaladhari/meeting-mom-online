const CONFIG = {
  clientId: "143751867061-aq2n18bdepa6s23d6mrpufprtd7p87v7.apps.googleusercontent.com",
  driveScope: "https://www.googleapis.com/auth/drive.file"
};

let tokenClient = null;
let accessToken = null;
let startedAt = null;
let timerHandle = null;
let meetingRoot = null;
let meetingFolders = null;

const $ = id => document.getElementById(id);

function status(message, kind="") {
  const el = $("status");
  el.textContent = message;
  el.className = "status " + kind;
}

function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  return local.toISOString().slice(0,10);
}

function initGoogle() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(initGoogle, 300);
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
      $("connectBtn").classList.add("hidden");
      $("meetingCard").classList.remove("hidden");
      $("date").value = $("date").value || todayISO();
      try {
        await ensureAppDriveRoot();
        status("Google Drive connected. Ready.", "success");
      } catch (err) {
        status(err.message, "error");
      }
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

async function driveRequest(url, options={}) {
  const headers = Object.assign({}, options.headers || {}, {Authorization:"Bearer "+accessToken});
  const response = await fetch(url, Object.assign({}, options, {headers}));
  if (!response.ok) {
    let detail = "";
    try { detail = await response.text(); } catch (_) {}
    throw new Error("Drive request failed ("+response.status+"): "+detail.slice(0,180));
  }
  return response;
}

async function createFolder(name, parentId) {
  const response = await driveRequest("https://www.googleapis.com/drive/v3/files", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      name,
      mimeType:"application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : []
    })
  });
  return response.json();
}

async function ensureAppDriveRoot() {
  const saved = sessionStorage.getItem("meeting_mom_app_root");
  if (saved) {
    meetingRoot = JSON.parse(saved);
    return meetingRoot;
  }
  meetingRoot = await createFolder("MEETING MOM ONLINE", null);
  sessionStorage.setItem("meeting_mom_app_root", JSON.stringify(meetingRoot));
  return meetingRoot;
}

async function createMeetingWorkspace() {
  await ensureAppDriveRoot();
  const title = ($("title").value || "Untitled Meeting").trim().replace(/[\\/:*?"<>|#%{}~&]/g,"_").slice(0,100);
  const stamp = new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
  const meetingFolder = await createFolder(stamp+"_"+title, meetingRoot.id);

  const names = ["AUDIO","TRANSCRIPT","TRANSLATION","AI","MOM"];
  const folders = {};
  for (const name of names) folders[name] = await createFolder(name, meetingFolder.id);

  const metadata = {
    meeting_id: stamp,
    title: $("title").value.trim(),
    date: $("date").value,
    start_time: $("startTime").value,
    end_time: $("endTime").value,
    venue: $("venue").value.trim(),
    agenda: $("agenda").value.trim(),
    participants: collectParticipants(),
    created_at: new Date().toISOString()
  };

  const meta = await driveRequest("https://www.googleapis.com/drive/v3/files", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      name:"meeting_metadata.json",
      mimeType:"application/json",
      parents:[meetingFolder.id]
    })
  });
  const metaFile = await meta.json();

  meetingFolders = {meeting:meetingFolder,audio:folders.AUDIO,transcript:folders.TRANSCRIPT,translation:folders.TRANSLATION,ai:folders.AI,mom:folders.MOM,metadata:metaFile};
  await uploadTextToFile(metaFile.id, JSON.stringify(metadata,null,2), "application/json");
  return meetingFolders;
}

async function uploadTextToFile(fileId, text, mimeType) {
  const response = await driveRequest("https://www.googleapis.com/upload/drive/v3/files/"+fileId+"?uploadType=media", {
    method:"PATCH",
    headers:{"Content-Type":mimeType},
    body:text
  });
  return response.json();
}

async function uploadAudio(file) {
  if (!file) throw new Error("Please select an audio file first.");
  if (!meetingFolders) await createMeetingWorkspace();

  $("uploadBox").classList.remove("hidden");
  $("uploadText").textContent = "Starting upload: "+file.name;
  $("uploadProgress").style.width = "0%";

  const mime = file.type || "application/octet-stream";
  const initResponse = await driveRequest(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    {
      method:"POST",
      headers:{
        "Content-Type":"application/json; charset=UTF-8",
        "X-Upload-Content-Type":mime,
        "X-Upload-Content-Length":String(file.size)
      },
      body:JSON.stringify({name:file.name,mimeType:mime,parents:[meetingFolders.audio.id]})
    }
  );

  const sessionUrl = initResponse.headers.get("Location");
  if (!sessionUrl) throw new Error("Drive did not return a resumable upload session.");

  const chunkSize = 8 * 1024 * 1024;
  let start = 0;
  while (start < file.size) {
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start,end);
    let response = await fetch(sessionUrl,{
      method:"PUT",
      headers:{
        "Content-Length":String(chunk.size),
        "Content-Range":"bytes "+start+"-"+(end-1)+"/"+file.size
      },
      body:chunk
    });

    if (response.status === 308) {
      const range = response.headers.get("Range");
      if (range) {
        const match = range.match(/(\d+)$/);
        start = match ? Number(match[1])+1 : end;
      } else {
        start = end;
      }
    } else if (response.ok) {
      const uploaded = await response.json();
      $("uploadProgress").style.width = "100%";
      $("uploadText").textContent = "Audio uploaded to AUDIO folder.";
      status("Meeting audio uploaded successfully.", "success");
      return uploaded;
    } else {
      throw new Error("Audio upload failed ("+response.status+").");
    }

    const pct = Math.floor((start/file.size)*100);
    $("uploadProgress").style.width = pct+"%";
    $("uploadText").textContent = "Uploading audio... "+pct+"%";
  }
}

function collectParticipants() {
  return [...document.querySelectorAll(".participant")].map(box => ({
    name: box.querySelector(".pname")?.value.trim() || "",
    designation: box.querySelector(".pdesignation")?.value.trim() || "",
    organisation: box.querySelector(".porg")?.value.trim() || ""
  })).filter(p => p.name || p.designation || p.organisation);
}

function addParticipant(values={}) {
  const box = document.createElement("div");
  box.className = "participant";
  box.innerHTML =
    '<input class="pname" placeholder="Name" value="'+escapeHtml(values.name||"")+'">' +
    '<input class="pdesignation" placeholder="Designation" value="'+escapeHtml(values.designation||"")+'">' +
    '<input class="porg" placeholder="Organisation (optional)" value="'+escapeHtml(values.organisation||"")+'">' +
    '<button type="button" class="secondary mini removeParticipant">Remove</button>';
  box.querySelector(".removeParticipant").addEventListener("click",()=>box.remove());
  $("participants").appendChild(box);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatTime(ms) {
  const total=Math.floor(ms/1000), h=String(Math.floor(total/3600)).padStart(2,"0");
  const m=String(Math.floor(total%3600/60)).padStart(2,"0"), s=String(total%60).padStart(2,"0");
  return h+":"+m+":"+s;
}

async function startMeeting() {
  try {
    await createMeetingWorkspace();
    startedAt=Date.now();
    $("startBtn").classList.add("hidden");
    $("stopBtn").classList.remove("hidden");
    timerHandle=setInterval(()=>{$("timer").textContent=formatTime(Date.now()-startedAt)},250);
    status("Meeting workspace created. Recording session started.", "success");
  } catch (err) {
    status(err.message, "error");
  }
}

async async function uploadSelectedAudio() {
  const file = $("audioFile").files[0];
  if (!file) {
    status("Choose an audio file first.", "error");
    return;
  }
  try {
    if (!meetingFolders) await createMeetingWorkspace();
    await uploadAudio(file);
  } catch (err) {
    status(err.message, "error");
  }
}

function stopMeeting() {
  clearInterval(timerHandle);
  $("stopBtn").classList.add("hidden");
  $("startBtn").classList.remove("hidden");
  const file = $("audioFile").files[0];
  if (file) {
    try { await uploadAudio(file); }
    catch (err) { status(err.message, "error"); }
  } else {
    status("Recording session stopped. Native recorder upload integration will use this meeting AUDIO folder.", "success");
  }
}

function setupVoiceButton(buttonId, targetId) {
  const button = $(buttonId);
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    button.classList.add("hidden");
    return;
  }
  button.addEventListener("click",()=>{
    const recognition = new SpeechRecognition();
    recognition.lang = "en-IN";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = e => {
      const text = e.results[0][0].transcript;
      $(targetId).value = text;
    };
    recognition.onerror = () => status("Voice input was not available. You can type instead.", "error");
    recognition.start();
  });
}

$("connectBtn").addEventListener("click", connectGoogle);
$("startBtn").addEventListener("click", startMeeting);
$("stopBtn").addEventListener("click", stopMeeting);
$("addParticipant").addEventListener("click",()=>addParticipant());
$("audioFile").addEventListener("change", ()=>{
  const file = $("audioFile").files[0];
  if (file) status("Audio selected: "+file.name+". Click UPLOAD AUDIO TO GOOGLE DRIVE.", "success");
});
$("uploadBtn").addEventListener("click", uploadSelectedAudio);
setupVoiceButton("titleVoice","title");
setupVoiceButton("agendaVoice","agenda");
$("date").value=todayISO();
initGoogle();