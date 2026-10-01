const CONFIG = {
  clientId: "143751867061-aq2n18bdepa6s23d6mrpufprtd7p87v7.apps.googleusercontent.com",
  driveScope: "https://www.googleapis.com/auth/drive.file",
  gateway: "https://script.google.com/macros/s/AKfycbwisXCTq0olYGcrJE2e2w1VqFSuLhjVvbGiYhGm4XzwrmAlYKlLudr9DwhYl2SYyFQE3w/exec"
};

let tokenClient = null;
let accessToken = null;
let startedAt = null;
let timerHandle = null;
let meetingRoot = null;
let meetingFolders = null;
let audioUploaded = false;
let retryButton = null;
let recoveryButton = null;
let mediaRecorder = null;
let mediaStream = null;
let recordedChunks = [];
let isRecording = false;

const $ = id => document.getElementById(id);

function status(message, kind="") {
  const el = $("status");
  el.textContent = message;
  el.className = "status " + kind;
}

const PROCESS_STAGES = ["checking","upload","whisper","translation","ai","mom","complete"];
const PROCESS_LABELS = {
  checking: "Checking your existing meeting and audio",
  upload: "Uploading audio to Google Drive",
  whisper: "Whisper transcription",
  translation: "English translation",
  ai: "AI understanding & evidence extraction",
  mom: "MoM preparation & validation",
  complete: "Results ready"
};

function showProcessingUI(stage="upload", percent=10, stageEta="Calculating…", totalEta="Calculating…") {
  const card = $("processingCard");
  if (!card) return;
  card.classList.remove("hidden");
  const index = Math.max(0, PROCESS_STAGES.indexOf(stage));
  PROCESS_STAGES.forEach((name, i) => {
    const el = document.querySelector('.stage[data-stage="' + name + '"]');
    if (!el) return;
    el.classList.toggle("done", i < index || stage === "complete" && i === index);
    el.classList.toggle("active", i === index && stage !== "complete");
  });
  $("processingFill").style.width = Math.max(0, Math.min(100, percent)) + "%";
  $("processingPercent").textContent = Math.round(percent) + "%";
  $("processingStageText").textContent = PROCESS_LABELS[stage] || "Processing...";
  $("processingStageEta").textContent = "Stage remaining: " + (stageEta || "—");
  $("processingTotalEta").textContent = "Total estimated remaining: " + (totalEta || "—");
}

function showProcessingStartedUI() {
  showProcessingUI("upload", 10, "Calculating…", "Calculating…");
}

function showRecoveredProcessingUI() {
  const card = $("processingCard");
  if (!card) return;
  card.classList.remove("hidden");
  $("processingFill").style.width = "5%";
  $("processingPercent").textContent = "5%";
  PROCESS_STAGES.forEach((name, i) => {
    const el = document.querySelector('.stage[data-stage="' + name + '"]');
    if (!el) return;
    el.classList.remove("done","active");
    el.classList.toggle("active", name === "checking");
  });
  $("processingStageText").textContent = "Existing audio confirmed. It will NOT be uploaded again."; 
  $("processingStageEta").textContent = "Stage remaining: Checking previous processing status…";
  $("processingTotalEta").textContent = "Total estimated remaining: Calculating…";
  showProcessingSummaryHint("Existing meeting found. Checking what has already been completed.");
}

function showProcessingSummaryHint(text) {
  const el = $("processingSummaryHint");
  if (el && text) el.textContent = text;
}

function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  return local.toISOString().slice(0,10);
}

function formatMeetingDate(value) {
  if (!value) return "";
  const d = new Date(value + "T00:00:00");
  return d.toLocaleDateString("en-GB", {day:"2-digit", month:"short", year:"numeric"});
}

function cleanFilePart(value) {
  return String(value || "").trim()
    .replace(/[\\/:*?"<>|#%{}~&]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function getMeetingFileBaseName() {
  const title = cleanFilePart($("title")?.value);
  const date = formatMeetingDate($("date")?.value) || formatMeetingDate(todayISO());
  return (title ? title + " - " : "") + date;
}

function getMoMFileNames() {
  const base = getMeetingFileBaseName();
  return {
    ai: base + " - AI_MOM.docx",
    edited: base + " - EDITED_MOM.docx",
    final: base + " - FINAL_MOM.docx"
  };
}

function updateFilenamePreview() {
  const names = getMoMFileNames();
  const el = $("filenamePreview");
  if (el) el.innerHTML = "MoM filename: <b>" + escapeHtml(names.final) + "</b>";
}

function persistMeetingState() {
  if (!meetingFolders?.meeting?.id) return;
  const state = {
    meeting: meetingFolders.meeting,
    audio: meetingFolders.audio,
    transcript: meetingFolders.transcript,
    translation: meetingFolders.translation,
    ai: meetingFolders.ai,
    mom: meetingFolders.mom,
    metadata: meetingFolders.metadata,
    audioUploaded: !!audioUploaded
  };
  localStorage.setItem("meeting_mom_active_meeting", JSON.stringify(state));
}

function restoreMeetingState() {
  try {
    const saved = localStorage.getItem("meeting_mom_active_meeting");
    if (!saved) return false;
    const state = JSON.parse(saved);
    if (!state?.meeting?.id || !state?.audio?.id) return false;
    meetingFolders = state;
    audioUploaded = !!state.audioUploaded;
    const box = $("uploadBox");
    if (box) {
      box.classList.remove("hidden");
      $("uploadText").textContent = audioUploaded
        ? "Previous meeting audio is available. You can retry processing."
        : "Previous meeting workspace restored.";
    }
    ensureRetryButton();
    return true;
  } catch (_) {
    return false;
  }
}

function ensureRetryButton() {
  if (!meetingFolders?.meeting?.id) return;
  const box = $("uploadBox");
  if (!box) return;
  box.classList.remove("hidden");
  if (retryButton) {
    retryButton.classList.remove("hidden");
    return;
  }
  retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "secondary";
  retryButton.textContent = "RETRY PROCESSING";
  retryButton.style.marginTop = "10px";
  retryButton.addEventListener("click", retryProcessing);
  box.appendChild(retryButton);
}

async function retryProcessing() {
  if (!meetingFolders?.meeting?.id || !meetingFolders?.audio?.id) {
    status("The saved meeting workspace could not be recovered.", "error");
    return;
  }
  if (!audioUploaded) {
    status("This meeting has no confirmed uploaded audio yet.", "error");
    return;
  }
  try {
    ensureRetryButton();
    if (retryButton) {
      retryButton.disabled = true;
      retryButton.textContent = "STARTING PROCESSING...";
    }
    showRecoveredProcessingUI();
    status("Existing audio confirmed. It will NOT be uploaded again. Checking previous processing status...", "");
    await notifyProcessingStarted();
    if (retryButton) retryButton.classList.add("hidden");
    if ($("uploadText")) $("uploadText").textContent = "Your meeting is now being processed.";
      showRecoveredProcessingUI();
    status("Your meeting is now being processed. The existing audio was not uploaded again.", "success");
  } catch (err) {
    if (retryButton) {
      retryButton.disabled = false;
      retryButton.textContent = "RETRY PROCESSING";
    }
    status(err.message, "error");
  }
}

function initGoogle() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(initGoogle, 300);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.clientId,
    scope: CONFIG.driveScope,
    error_callback: (error) => {
      status("Google authorization error: " + (error?.type || error?.message || "unknown error"), "error");
    },
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
        const restored = restoreMeetingState();
        await ensureAppDriveRoot();
        if (restored) {
          status("Google Drive connected. Previous meeting restored.", "success");
        } else {
          status("Google Drive connected. Ready.", "success");
          ensureRecoveryButton();
        }
      } catch (err) {
        status(err.message, "error");
      }
    }
  });
}

async function connectGoogle() {
  status("Opening Google authorization...", "");
  if (!tokenClient) {
    status("Google authorization library is still loading. Please wait 2 seconds and try again.", "error");
    return;
  }
  try {
    tokenClient.requestAccessToken({prompt:"select_account"});
  } catch (err) {
    status("Google authorization could not start: " + err.message, "error");
  }
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

async function listDriveFiles(query, fields="files(id,name,mimeType,parents,createdTime,modifiedTime,webViewLink,webContentLink)") {
  const params = new URLSearchParams({
    q: query,
    pageSize: "100",
    orderBy: "createdTime desc",
    fields: fields
  });
  const response = await driveRequest("https://www.googleapis.com/drive/v3/files?" + params.toString());
  return (await response.json()).files || [];
}

async function findExistingAppRoot() {
  const roots = await listDriveFiles(
    "name = 'MEETING MOM ONLINE' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
  );
  return roots[0] || null;
}

async function ensureAppDriveRoot() {
  const saved = sessionStorage.getItem("meeting_mom_app_root");
  if (saved) {
    meetingRoot = JSON.parse(saved);
    return meetingRoot;
  }
  const existing = await findExistingAppRoot();
  meetingRoot = existing || await createFolder("MEETING MOM ONLINE", null);
  sessionStorage.setItem("meeting_mom_app_root", JSON.stringify(meetingRoot));
  return meetingRoot;
}

async function recoverLatestMeeting() {
  await ensureAppDriveRoot();
  status("Searching Google Drive for the latest Meeting MoM workspace...", "");
  const meetingFoldersList = await listDriveFiles(
    "'" + meetingRoot.id + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
  );

  for (const meeting of meetingFoldersList) {
    const children = await listDriveFiles(
      "'" + meeting.id + "' in parents and trashed = false"
    );
    const audio = children.find(x =>
      x.name === "AUDIO" &&
      x.mimeType === "application/vnd.google-apps.folder"
    );
    if (!audio) continue;

    const audioFiles = await listDriveFiles(
      "'" + audio.id + "' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'"
    );
    if (!audioFiles.length) continue;

    const subfolders = {};
    for (const name of ["TRANSCRIPT","TRANSLATION","AI","MOM"]) {
      subfolders[name] = children.find(x =>
        x.name === name &&
        x.mimeType === "application/vnd.google-apps.folder"
      ) || null;
    }

    const metadata = children.find(x => x.name === "meeting_metadata.json") || null;
    let metadataData = {};
    if (metadata) {
      try {
        const response = await driveRequest(
          "https://www.googleapis.com/drive/v3/files/" + metadata.id + "?alt=media"
        );
        metadataData = await response.json();
      } catch (_) {}
    }

    meetingFolders = {
      meeting,
      audio,
      transcript: subfolders.TRANSCRIPT,
      translation: subfolders.TRANSLATION,
      ai: subfolders.AI,
      mom: subfolders.MOM,
      metadata
    };
    audioUploaded = true;
    persistMeetingState();

    if (metadataData.title) $("title").value = metadataData.title;
    if (metadataData.date) $("date").value = metadataData.date;
    if (metadataData.start_time) $("startTime").value = metadataData.start_time;
    if (metadataData.end_time) $("endTime").value = metadataData.end_time;
    if (metadataData.venue) $("venue").value = metadataData.venue;
    if (metadataData.agenda) $("agenda").value = metadataData.agenda;
    if (Array.isArray(metadataData.participants)) {
      $("participants").innerHTML = "";
      metadataData.participants.forEach(p => addParticipant(p));
    }
    updateFilenamePreview();

    showRecoveredAudio(audioFiles[0]);
    ensureRetryButton();
    if (retryButton) retryButton.classList.remove("hidden");
    status("Previous meeting recovered. Existing audio was not uploaded again.", "success");
    return meetingFolders;
  }

  status("No previous Meeting MoM workspace with audio was found.", "error");
  return null;
}

function showRecoveredAudio(audioFile) {
  if (!audioFile) return;
  const box = $("uploadBox");
  box.classList.remove("hidden");
  $("uploadText").innerHTML =
    'Recovered audio: <b>' + escapeHtml(audioFile.name) + '</b>' +
    (audioFile.webViewLink
      ? ' — <a href="' + audioFile.webViewLink + '" target="_blank" rel="noopener">OPEN IN GOOGLE DRIVE</a>'
      : '');
  $("uploadProgress").style.width = "100%";
}

function ensureRecoveryButton() {
  if (recoveryButton) return;
  const box = $("uploadBox");
  if (!box) return;
  recoveryButton = document.createElement("button");
  recoveryButton.type = "button";
  recoveryButton.className = "secondary";
  recoveryButton.textContent = "RECOVER PREVIOUS MEETING";
  recoveryButton.style.marginTop = "10px";
  recoveryButton.addEventListener("click", async () => {
    recoveryButton.disabled = true;
    recoveryButton.textContent = "SEARCHING GOOGLE DRIVE...";
    try {
      await recoverLatestMeeting();
      if (!meetingFolders) {
        recoveryButton.disabled = false;
        recoveryButton.textContent = "RECOVER PREVIOUS MEETING";
      } else {
        recoveryButton.classList.add("hidden");
      }
    } catch (err) {
      recoveryButton.disabled = false;
      recoveryButton.textContent = "RECOVER PREVIOUS MEETING";
      status(err.message, "error");
    }
  });
  box.appendChild(recoveryButton);
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
  audioUploaded = false;
  persistMeetingState();
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
      audioUploaded = true;
      persistMeetingState();
      ensureRetryButton();
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

function getRecordingMimeType() {
  const choices = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4"
  ];
  return choices.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || "";
}

async function startMeeting() {
  if (isRecording) return;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone recording. Use Chrome or Edge on HTTPS.");
    }
    await createMeetingWorkspace();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const mimeType = getRecordingMimeType();
    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, {mimeType})
      : new MediaRecorder(mediaStream);

    recordedChunks = [];
    mediaRecorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data);
    };

    mediaRecorder.start(1000);
    isRecording = true;
    startedAt = Date.now();
    $("startTime").value = new Date().toTimeString().slice(0,5);
    $("startBtn").classList.add("hidden");
    $("stopBtn").classList.remove("hidden");
    $("timer").textContent = "00:00:00";
    timerHandle = setInterval(() => {
      $("timer").textContent = formatTime(Date.now() - startedAt);
    }, 250);
    status("Microphone recording started. Noise suppression and echo cancellation are enabled.", "success");
  } catch (err) {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    isRecording = false;
    status(err.message || "Could not start microphone recording.", "error");
  }
}

function stopRecorderAndBuildFile() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder) {
      reject(new Error("No active recording was found."));
      return;
    }

    mediaRecorder.onstop = () => {
      try {
        const mimeType = mediaRecorder.mimeType || "audio/webm";
        const blob = new Blob(recordedChunks, {type:mimeType});
        const extension = mimeType.includes("mp4") ? "m4a" : "webm";
        const date = $("date").value || todayISO();
        const safeTitle = cleanFilePart($("title").value || "Meeting Recording");
        const file = new File(
          [blob],
          safeTitle + " - " + date + " - Recording." + extension,
          {type:mimeType}
        );
        resolve(file);
      } catch (err) {
        reject(err);
      }
    };

    mediaRecorder.onerror = event => {
      reject(event.error || new Error("Browser recording failed."));
    };

    mediaRecorder.stop();
  });
}

async function stopMeeting() {
  if (!isRecording) {
    $("timer").textContent = "00:00:00";
    return;
  }

  clearInterval(timerHandle);
  timerHandle = null;
  isRecording = false;

  try {
    $("stopBtn").disabled = true;
    $("stopBtn").textContent = "SAVING...";
    $("endTime").value = new Date().toTimeString().slice(0,5);

    const file = await stopRecorderAndBuildFile();

    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }

    $("timer").textContent = formatTime(Date.now() - startedAt);
    await uploadAudio(file);
    await updateMeetingMetadata();

    $("uploadText").textContent = "Recording uploaded. Preparing your meeting...";
    status("Recording saved to Google Drive. Preparing your meeting...", "");

    try {
      await notifyProcessingStarted();
      $("uploadText").textContent = "Your meeting is now being processed.";
      showProcessingStartedUI();
      status("PROCESSING — your meeting is being understood and prepared.", "success");
    } catch (triggerErr) {
      ensureRetryButton();
      if (retryButton) retryButton.classList.remove("hidden");
      status(triggerErr.message + " Use RETRY PROCESSING.", "error");
    }

    $("stopBtn").classList.add("hidden");
    $("startBtn").classList.remove("hidden");
  } catch (err) {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    status(err.message, "error");
    $("stopBtn").classList.remove("hidden");
  } finally {
    $("stopBtn").disabled = false;
    $("stopBtn").textContent = "STOP & SAVE";
  }
}

async function updateMeetingMetadata() {
  if (!meetingFolders?.metadata?.id) return;
  const metadata = {
    meeting_id: meetingFolders.meeting.id,
    title: $("title").value.trim(),
    date: $("date").value,
    start_time: $("startTime").value,
    end_time: $("endTime").value,
    venue: $("venue").value.trim(),
    agenda: $("agenda").value.trim(),
    participants: collectParticipants(),
    updated_at: new Date().toISOString()
  };
  await uploadTextToFile(
    meetingFolders.metadata.id,
    JSON.stringify(metadata, null, 2),
    "application/json"
  );
}

async function notifyProcessingStarted() {
  if (!meetingFolders?.meeting?.id || !meetingFolders?.audio?.id) {
    throw new Error("Meeting workspace is not ready for processing.");
  }
  const payload = {
    action: "triggerProcessing",
    meeting_id: meetingFolders.meeting.id,
    meeting_folder_id: meetingFolders.meeting.id,
    audio_folder_id: meetingFolders.audio.id,
    metadata_file_id: meetingFolders.metadata.id
  };
  const response = await fetch(CONFIG.gateway, {
    method: "POST",
    headers: {"Content-Type":"text/plain;charset=utf-8"},
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "Automatic processing trigger failed.");
  return data;
}

async function uploadSelectedAudio() {
  const file = $("audioFile").files[0];
  if (!file) {
    status("Choose an audio file first.", "error");
    return;
  }
  try {
    if (!meetingFolders) await createMeetingWorkspace();
    await uploadAudio(file);
    $("uploadText").textContent = "Audio uploaded. Preparing your meeting...";
    status("Audio uploaded. Preparing your meeting...", "");
    try {
      await notifyProcessingStarted();
      $("uploadText").textContent = "Your meeting is now being processed.";
      ensureRetryButton();
      if (retryButton) retryButton.classList.add("hidden");
      status("PROCESSING — your meeting is being understood and prepared.", "success");
    } catch (triggerErr) {
      ensureRetryButton();
      status(triggerErr.message + " Use RETRY PROCESSING after correcting the gateway.", "error");
      if (retryButton) retryButton.classList.remove("hidden");
    }
  } catch (err) {
    status(err.message, "error");
  }
}

function copyTextFrom(id) {
  const value = $(id)?.value || "";
  if (!value) return;
  navigator.clipboard.writeText(value)
    .then(()=>status("Copied to clipboard.", "success"))
    .catch(()=>status("Copy was blocked by the browser.", "error"));
}

function toggleEditor(id, buttonId) {
  const field = $(id), button = $(buttonId);
  if (!field || !button) return;
  field.readOnly = !field.readOnly;
  button.textContent = field.readOnly ? "EDIT" : "DONE EDITING";
  if (!field.readOnly) field.focus();
}

function listenText(id) {
  const value = $(id)?.value || "";
  if (!value || !("speechSynthesis" in window)) {
    status("Text-to-speech is not available in this browser.", "error");
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(value);
  utterance.lang = "en-IN";
  speechSynthesis.speak(utterance);
}

function showMeetingResults(data={}) {
  const names = getMoMFileNames();
  $("resultsCard").classList.remove("hidden");
  $("resultMeetingName").textContent = ($("title").value.trim() || "Meeting") + " • " + formatMeetingDate($("date").value);
  $("aiDocName").textContent = data.aiFileName || names.ai;
  $("editedDocName").textContent = data.editedFileName || names.edited;
  $("finalDocName").textContent = data.finalFileName || names.final;
  $("editSummary").value = data.summary || "";
  $("editDecisions").value = data.decisions || "";
  $("editActions").value = data.actions || "";
  $("editFollowup").value = data.followup || "";
  $("editMom").value = data.mom || "";
  if (data.aiDownloadUrl) { $("downloadAiBtn").disabled=false; $("downloadAiBtn").onclick=()=>window.open(data.aiDownloadUrl,"_blank"); }
  if (data.editedDownloadUrl) { $("downloadEditedBtn").disabled=false; $("downloadEditedBtn").onclick=()=>window.open(data.editedDownloadUrl,"_blank"); }
  if (data.finalDownloadUrl) { $("downloadFinalBtn").disabled=false; $("downloadFinalBtn").onclick=()=>window.open(data.finalDownloadUrl,"_blank"); }
  if (data.meetingFolderUrl) { $("openDriveBtn").disabled=false; $("openDriveBtn").onclick=()=>window.open(data.meetingFolderUrl,"_blank"); }
}

async function saveFinalMom() {
  const names = getMoMFileNames();
  const payload = {
    action: "saveFinalMom",
    file_name: names.final,
    meeting_id: meetingFolders?.meeting?.id || "",
    summary: $("editSummary").value,
    decisions: $("editDecisions").value,
    actions: $("editActions").value,
    followup: $("editFollowup").value,
    mom: $("editMom").value
  };
  status("Saving final MoM...", "");
  try {
    const response = await fetch(CONFIG.gateway, {
      method:"POST",
      headers:{"Content-Type":"text/plain;charset=utf-8"},
      body:JSON.stringify(payload)
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "Could not save final MoM.");
    status("Final MoM saved as " + names.final, "success");
  } catch (err) {
    status(err.message, "error");
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
ensureRecoveryButton();
setupVoiceButton("titleVoice","title");
setupVoiceButton("agendaVoice","agenda");
$("date").value=todayISO();
["title","date"].forEach(id => $(id)?.addEventListener("input", updateFilenamePreview));
updateFilenamePreview();
restoreMeetingState();

["summary","decisions","actions","followup","mom"].forEach(key => {
  const fieldId="edit"+key.charAt(0).toUpperCase()+key.slice(1);
  const btnId=fieldId+"Btn";
  const copyId="copy"+key.charAt(0).toUpperCase()+key.slice(1)+"Btn";
  const listenId="listen"+key.charAt(0).toUpperCase()+key.slice(1)+"Btn";
  $(btnId)?.addEventListener("click",()=>toggleEditor(fieldId,btnId));
  $(copyId)?.addEventListener("click",()=>copyTextFrom(fieldId));
  $(listenId)?.addEventListener("click",()=>listenText(fieldId));
});
$("saveFinalBtn")?.addEventListener("click", saveFinalMom);
initGoogle();
window.addEventListener("error", function(e) {
  status("App error: " + (e.message || "JavaScript error"), "error");
});
window.addEventListener("unhandledrejection", function(e) {
  status("App error: " + (e.reason?.message || e.reason || "Promise error"), "error");
});
