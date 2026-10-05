const DRIVE_ROOT_ID = "1kfwyuKxXdywPy9jhZjghFI4yGJEwh-Yl";
const DRIVE_INBOX_ID = "1IfS5M0bvmXYg1Oe_pqg1ZGhx7gHc2ufa";

const CONFIG = {
  clientId: "143751867061-aq2n18bdepa6s23d6mrpufprtd7p87v7.apps.googleusercontent.com",
  driveScope: "https://www.googleapis.com/auth/drive",
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
let pendingProcessingMeeting = null;
let backgroundProcessing = JSON.parse(localStorage.getItem("meeting_mom_processing_queue") || "[]");

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

function showRecoveredProcessingUI(message) {
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
  $("processingStageText").textContent = "Existing audio confirmed. No new upload is required.";
  $("processingStageEta").textContent = "Stage remaining: Checking processing status…";
  $("processingTotalEta").textContent = "Total estimated remaining: Calculating…";
  showProcessingSummaryHint(message || "Existing meeting found. Checking what has already been completed.");
}

function showProcessingSummaryHint(text) {
  const el = $("processingSummaryHint");
  if (el && text) el.textContent = text;
}

function setAudioControlsBusy(busy, message="") {
  const start = $("startBtn");
  const upload = $("uploadBtn");
  const file = $("audioFile");
  if (start) start.disabled = !!busy;
  if (upload) upload.disabled = !!busy;
  if (file) file.disabled = !!busy;
  if (busy) {
    if (start) start.classList.add("hidden");
    if (upload) upload.classList.add("hidden");
  } else {
    if (!isRecording) start?.classList.remove("hidden");
    upload?.classList.remove("hidden");
  }
  if (message && $("uploadText")) $("uploadText").textContent = message;
}

function saveBackgroundProcessingQueue() {
  try { localStorage.setItem("meeting_mom_processing_queue", JSON.stringify(backgroundProcessing.slice(0,10))); } catch (_) {}
}

function renderBackgroundProcessing() {
  const card = $("backgroundProcessingCard");
  const list = $("backgroundProcessingList");
  if (!card || !list) return;
  if (!backgroundProcessing.length) {
    card.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  card.classList.remove("hidden");
  list.innerHTML = backgroundProcessing.map(item => {
    const title = escapeHtml(item.title || "Meeting");
    const statusText = escapeHtml(item.statusText || "Processing request sent");
    const time = item.created_at ? new Date(item.created_at).toLocaleString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "";
    const canRestart =
      item.stage === "failed" ||
      statusText === "Processing failed" ||
      statusText === "Waiting to start processing" ||
      statusText === "Previous test run did not process the meeting audio.";

    return '<div class="background-row">' +
      '<div><b>' + title + '</b><div class="muted small">' + time + '</div></div>' +
      '<div class="background-status">' +
        '<div>' + statusText + '</div>' +
        (canRestart
          ? '<div class="background-actions">' +
              '<button type="button" class="secondary mini background-retry" data-meeting-id="' + escapeHtml(item.id) + '">RESTART PROCESSING</button>' +
              '<button type="button" class="secondary mini background-clear" data-meeting-id="' + escapeHtml(item.id) + '">CLEAR</button>' +
            '</div>'
          : '') +
      '</div>' +
      '</div>';
  }).join("");

  list.querySelectorAll(".background-retry").forEach(function(button) {
    button.addEventListener("click", function() {
      restartBackgroundMeeting(button.getAttribute("data-meeting-id"), button);
    });
  });

  list.querySelectorAll(".background-clear").forEach(function(button) {
    button.addEventListener("click", function() {
      clearBackgroundMeeting(button.getAttribute("data-meeting-id"));
    });
  });
}

function clearBackgroundMeeting(id) {
  const item = backgroundProcessing.find(function(x) { return x.id === id; });
  if (!item) return;

  const active = item.runId && item.stage !== "failed" && item.stage !== "complete";
  if (active) {
    status("This meeting is still processing. Clear is available after it stops or fails.", "error");
    return;
  }

  backgroundProcessing = backgroundProcessing.filter(function(x) { return x.id !== id; });
  saveBackgroundProcessingQueue();
  renderBackgroundProcessing();

  if (meetingFolders?.meeting?.id === id) {
    meetingFolders = null;
    audioUploaded = false;
    persistMeetingState();
  }

  status("Previous meeting removed from this page. The Google Drive files were not deleted.", "success");
}

function addBackgroundProcessing(meeting, statusText, extra) {
  if (!meeting || !meeting.meeting || !meeting.meeting.id) return;
  extra = extra || {};
  const existing = backgroundProcessing.find(x => x.id === meeting.meeting.id);
  const item = {
    id: meeting.meeting.id,
    title: meeting.meeting.name || "Meeting",
    statusText: statusText || "Processing request sent",
    created_at: existing && existing.created_at ? existing.created_at : new Date().toISOString(),
    meetingFolderId: meeting.meeting.id,
    aiFolderId: meeting.ai && meeting.ai.id ? meeting.ai.id : (existing && existing.aiFolderId ? existing.aiFolderId : ""),
    momFolderId: meeting.mom && meeting.mom.id ? meeting.mom.id : (existing && existing.momFolderId ? existing.momFolderId : ""),
    runId: extra.runId || (existing && existing.runId ? existing.runId : ""),
    percent: extra.percent !== undefined ? extra.percent : (existing && existing.percent !== undefined ? existing.percent : 0),
    stage: extra.stage || (existing && existing.stage ? existing.stage : "checking")
  };
  backgroundProcessing = [item, ...backgroundProcessing.filter(x => x.id !== item.id)].slice(0,10);
  saveBackgroundProcessingQueue();
  renderBackgroundProcessing();
  return item;
}

function updateBackgroundProcessing(id, patch) {
  const item = backgroundProcessing.find(x => x.id === id);
  if (!item) return;
  Object.assign(item, patch || {});
  saveBackgroundProcessingQueue();
  renderBackgroundProcessing();
}

function prepareNextMeeting() {
  const previous = meetingFolders;
  if (previous?.meeting?.id) {
    try {
      const history = JSON.parse(localStorage.getItem("meeting_mom_history") || "[]");
      history.unshift({
        meeting: previous.meeting,
        audio: previous.audio,
        transcript: previous.transcript,
        translation: previous.translation,
        ai: previous.ai,
        mom: previous.mom,
        metadata: previous.metadata,
        audioUploaded: !!audioUploaded,
        archived_at: new Date().toISOString()
      });
      localStorage.setItem("meeting_mom_history", JSON.stringify(history.slice(0,20)));
    } catch (_) {}
  }

  meetingFolders = null;
  audioUploaded = false;
  localStorage.removeItem("meeting_mom_active_meeting");

  $("title").value = "";
  $("date").value = todayISO();
  $("startTime").value = "";
  $("endTime").value = "";
  $("venue").value = "";
  $("agenda").value = "";
  $("participants").innerHTML = "";
  $("audioFile").value = "";
  $("timer").textContent = "00:00:00";
  $("processingCard")?.classList.add("hidden");
  $("uploadBox")?.classList.add("hidden");
  updateFilenamePreview();
  setAudioControlsBusy(false);
  renderBackgroundProcessing();
  status("READY FOR NEXT MEETING. You can record or upload the next meeting now.", "success");
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
    audioUploaded: !!audioUploaded,
    audioFile: meetingFolders.audioFile || null
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
        ? "Existing meeting audio is available."
        : "Previous meeting workspace restored.";
    }
    const existingJob = backgroundProcessing.find(x => x.id === meetingFolders.meeting.id);
    if (existingJob && existingJob.stage !== "failed" && existingJob.stage !== "complete") {
      showRecoveredProcessingUI("Processing is already in progress for this meeting. You do not need to retry it.");
      if (retryButton) retryButton.classList.add("hidden");
      setTimeout(function(){ if (existingJob.runId) monitorWorkflowRun(existingJob); }, 0);
    } else if (existingJob && existingJob.stage === "failed") {
      ensureRetryButton();
      if (retryButton) retryButton.classList.remove("hidden");
    } else {
      ensureRetryButton();
    }
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
  const existingJob = backgroundProcessing.find(x => x.id === meetingFolders.meeting.id);
  if (existingJob && existingJob.stage !== "failed" && existingJob.stage !== "complete") {
    if (retryButton) retryButton.classList.add("hidden");
    return;
  }
  if (retryButton) {
    retryButton.classList.remove("hidden");
    retryButton.disabled = false;
    retryButton.textContent = "RETRY PROCESSING";
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

async function loadBackgroundMeetingSnapshot(item) {
  if (!item || !item.meetingFolderId) {
    throw new Error("Saved meeting folder information is missing.");
  }

  const children = await listDriveFiles(
    "'" + item.meetingFolderId + "' in parents and trashed = false"
  );

  const audio = children.find(function(x) {
    return x.name === "AUDIO" &&
      x.mimeType === "application/vnd.google-apps.folder";
  });

  if (!audio) throw new Error("The saved meeting AUDIO folder could not be found.");

  const audioFiles = await listDriveFiles(
    "'" + audio.id + "' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'"
  );

  if (!audioFiles.length) {
    throw new Error("The saved meeting has no audio file in Google Drive.");
  }

  const subfolders = {};
  ["TRANSCRIPT","TRANSLATION","AI","MOM"].forEach(function(name) {
    subfolders[name] = children.find(function(x) {
      return x.name === name &&
        x.mimeType === "application/vnd.google-apps.folder";
    }) || null;
  });

  const metadata = children.find(function(x) {
    return x.name === "meeting_metadata.json";
  }) || null;

  return {
    meeting: {
      id: item.meetingFolderId,
      name: item.title || "Meeting",
      mimeType: "application/vnd.google-apps.folder"
    },
    audio: audio,
    transcript: subfolders.TRANSCRIPT,
    translation: subfolders.TRANSLATION,
    ai: subfolders.AI,
    mom: subfolders.MOM,
    metadata: metadata,
    audioFile: audioFiles[0],
    audioUploaded: true
  };
}

async function restartBackgroundMeeting(id, button) {
  const item = backgroundProcessing.find(function(x) {
    return x.id === id;
  });

  if (!item) {
    status("The previous meeting could not be found in the processing list.", "error");
    return;
  }

  if (item.stage === "complete") {
    status("This meeting has already completed processing.", "success");
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = "STARTING...";
  }

  try {
    status("Recovering the previous meeting from Google Drive...", "");
    const snapshot = await loadBackgroundMeetingSnapshot(item);

    updateBackgroundProcessing(id, {
      statusText: "Restarting processing",
      stage: "checking",
      percent: 5,
      runId: ""
    });

    await notifyProcessingStarted(snapshot, {backgroundOnly: true});

    status(
      "Previous meeting processing has been restarted. The existing audio will not be uploaded again.",
      "success"
    );
  } catch (err) {
    updateBackgroundProcessing(id, {
      statusText: "Waiting to start processing",
      stage: "failed"
    });

    if (button) {
      button.disabled = false;
      button.textContent = "RESTART PROCESSING";
    }

    status("Could not restart the previous meeting: " + err.message, "error");
  }
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
    showRecoveredProcessingUI("Existing audio confirmed. Starting processing without uploading it again.");
    status("Existing audio confirmed. Starting processing...", "");
    await notifyProcessingStarted();
    if (retryButton) retryButton.classList.add("hidden");
    if ($("uploadText")) $("uploadText").textContent = "Processing has started. Existing audio will not be uploaded again.";
    showRecoveredProcessingUI("Processing has started. Existing audio will not be uploaded again.");
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
      renderBackgroundProcessing();
      let restored = false;
      try {
        restored = restoreMeetingState();
        await ensureAppDriveRoot();
        await populateContinuityMeetings();
        if (restored) {
          const existingJob = meetingFolders?.meeting?.id
            ? backgroundProcessing.find(x => x.id === meetingFolders.meeting.id)
            : null;
          if (existingJob && existingJob.stage !== "failed" && existingJob.stage !== "complete") {
            showRecoveredProcessingUI("Processing is already in progress for this meeting. No retry is required.");
            if (existingJob.runId) monitorWorkflowRun(existingJob);
            status("Google Drive connected. Processing is already in progress.", "success");
          } else {
            status("Google Drive connected. Previous meeting restored.", "success");
          }
        } else {
          status("Google Drive connected. Ready.", "success");
          ensureRecoveryButton();
        }
      } catch (err) {
        if (restored) {
          status("Google Drive connection check is temporarily unavailable. Existing processing status is shown below.", "error");
        } else {
          status(err.message, "error");
        }
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

async function ensureAppDriveRoot() {
  // Use the established Meeting MoM workspace by ID.
  // Do not search by name or create a duplicate root.
  if (meetingRoot && meetingRoot.id === DRIVE_ROOT_ID) {
    return meetingRoot;
  }

  const response = await driveRequest(
    "https://www.googleapis.com/drive/v3/files/" +
      DRIVE_ROOT_ID +
      "?fields=id,name,mimeType,parents"
  );
  const root = await response.json();

  if (!root || root.id !== DRIVE_ROOT_ID) {
    throw new Error("The configured MEETING MOM ONLINE Drive root could not be opened.");
  }

  meetingRoot = root;
  sessionStorage.setItem("meeting_mom_app_root", JSON.stringify(root));
  return meetingRoot;
}

async function recoverLatestMeeting() {
  await ensureAppDriveRoot();
  status("Searching Google Drive for the latest Meeting MoM workspace...", "");
  const meetingFoldersList = await listDriveFiles(
    "'" + DRIVE_INBOX_ID + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
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
    if (metadataData.initiator) $("initiator").value = metadataData.initiator;
    if (metadataData.continuity_meeting_id) $("continuityMeeting").value = metadataData.continuity_meeting_id;
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
  // Meeting workspaces belong under the established INBOX.
  const meetingFolder = await createFolder(stamp+"_"+title, DRIVE_INBOX_ID);

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
    initiator: $("initiator")?.value.trim() || "",
    continuity_meeting_id: $("continuityMeeting")?.value || "",
    continuity_meeting_title: getSelectedContinuityTitle(),
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

async function updateMeetingMetadata() {
  if (!meetingFolders?.metadata?.id) {
    throw new Error("Meeting metadata file is not available.");
  }

  const metadata = {
    meeting_id: meetingFolders.meeting.id,
    title: $("title").value.trim(),
    date: $("date").value,
    start_time: $("startTime").value,
    end_time: $("endTime").value,
    venue: $("venue").value.trim(),
    agenda: $("agenda").value.trim(),
    initiator: $("initiator")?.value.trim() || "",
    continuity_meeting_id: $("continuityMeeting")?.value || "",
    continuity_meeting_title: getSelectedContinuityTitle(),
    participants: collectParticipants(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  await uploadTextToFile(
    meetingFolders.metadata.id,
    JSON.stringify(metadata, null, 2),
    "application/json"
  );

  persistMeetingState();
  updateFilenamePreview();
  return metadata;
}

async function uploadAudio(file) {
  if (!file) throw new Error("Please select an audio file first.");
  setAudioControlsBusy(true, "Uploading audio to Google Drive...");
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
      meetingFolders.audioFile = uploaded;
      $("uploadProgress").style.width = "100%";
      $("uploadText").textContent = "Audio uploaded to AUDIO folder.";
      audioUploaded = true;
      persistMeetingState();
      ensureRetryButton();
      status("Meeting audio uploaded successfully. You can now prepare the next meeting.", "success");
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
    '<div class="voice-wrap"><input class="pname" placeholder="Name" value="'+escapeHtml(values.name||"")+'"><button type="button" class="secondary voice-btn participantVoice" data-target="pname">🎤</button></div>' +
    '<div class="voice-wrap" style="margin-top:8px"><input class="pdesignation" placeholder="Designation" value="'+escapeHtml(values.designation||"")+'"><button type="button" class="secondary voice-btn participantVoice" data-target="pdesignation">🎤</button></div>' +
    '<div class="voice-wrap" style="margin-top:8px"><input class="porg" placeholder="Organisation (optional)" value="'+escapeHtml(values.organisation||"")+'"><button type="button" class="secondary voice-btn participantVoice" data-target="porg">🎤</button></div>' +
    '<button type="button" class="secondary mini removeParticipant" style="margin-top:8px">Remove</button>';
  box.querySelector(".removeParticipant").addEventListener("click",()=>box.remove());
  box.querySelectorAll(".participantVoice").forEach(btn => {
    btn.addEventListener("click",()=>startFieldVoice(btn, box.querySelector("." + btn.dataset.target)));
  });
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
    $("recordingDot")?.classList.remove("hidden");
    $("recordingState") && ($("recordingState").textContent = "Recording live — speak normally");
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

    // The upload is the only blocking operation for starting another meeting.
    await uploadAudio(file);
    await updateMeetingMetadata();

    const completedMeeting = meetingFolders;
    pendingProcessingMeeting = completedMeeting;

    // Audio is now safely in Drive. Prepare the browser immediately for Meeting 2.
    prepareNextMeeting();

    try {
      await notifyProcessingStarted(completedMeeting);
      addBackgroundProcessing(completedMeeting, "Processing started");
      pendingProcessingMeeting = null;
      status("Meeting 1 is processing in the background. READY FOR NEXT MEETING.", "success");
    } catch (triggerErr) {
      addBackgroundProcessing(completedMeeting, "Waiting to start processing");
      status("Meeting 1 audio is safely stored. Processing could not be started automatically: " + triggerErr.message, "error");
    }
  } catch (err) {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    setAudioControlsBusy(false);
    status(err.message, "error");
    $("stopBtn").classList.remove("hidden");
  } finally {
    $("stopBtn").disabled = false;
    $("stopBtn").textContent = "STOP & SAVE";
  }
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
    await updateMeetingMetadata();

    const completedMeeting = meetingFolders;
    pendingProcessingMeeting = completedMeeting;

    // Upload is complete: immediately free the browser for the next meeting.
    prepareNextMeeting();

    try {
      await notifyProcessingStarted(completedMeeting);
      pendingProcessingMeeting = null;
      status("Audio is safely stored and processing has started. READY FOR NEXT MEETING.", "success");
    } catch (triggerErr) {
      addBackgroundProcessing(completedMeeting, "Waiting to start processing");
      status("Audio is safely stored. Processing could not be started automatically: " + triggerErr.message, "error");
    }
  } catch (err) {
    setAudioControlsBusy(false);
    status(err.message, "error");
  }
}


async function createInitialProcessingStatus(snapshot) {
  const existing = await listDriveFiles(
    "'" + snapshot.meeting.id + "' in parents and name = 'PROCESSING_STATUS.json' and trashed = false",
    "files(id,name,mimeType,modifiedTime)"
  );
  const payload = JSON.stringify({
    meeting_id: snapshot.meeting.id,
    stage: "QUEUED",
    progress_percent: 5,
    message: "Processing request sent. Waiting for GitHub Actions to begin.",
    status: "PROCESSING",
    updated_at: new Date().toISOString()
  }, null, 2);

  if (existing[0]) {
    await uploadTextToFile(existing[0].id, payload, "application/json");
    return existing[0].id;
  }

  const response = await driveRequest("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      name: "PROCESSING_STATUS.json",
      mimeType: "application/json",
      parents: [snapshot.meeting.id]
    })
  });
  const file = await response.json();
  await uploadTextToFile(file.id, payload, "application/json");
  return file.id;
}

async function readProcessingStatus(item) {
  if (!item || !item.meetingFolderId) return null;
  try {
    const files = await listDriveFiles(
      "'" + item.meetingFolderId + "' in parents and name = 'PROCESSING_STATUS.json' and trashed = false",
      "files(id,name,modifiedTime)"
    );
    if (!files[0]) return null;
    const response = await driveRequest(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(files[0].id) + "?alt=media"
    );
    return await response.json();
  } catch (_) {
    return null;
  }
}

function driveStageToUi(stage) {
  const s = String(stage || "").toUpperCase();
  if (s === "COMPLETED") return "complete";
  if (s === "FAILED") return "checking";
  if (s === "ANALYZING" || s === "SUMMARIZING") return "ai";
  if (s === "GENERATING_MOM" || s === "UPLOADING") return "mom";
  if (s === "TRANSLATING") return "translation";
  if (s === "TRANSCRIBING" || s === "CONVERTING") return "whisper";
  return "checking";
}

async function monitorDriveProcessingStatus(item) {
  if (!item || item.stage === "complete" || item.stage === "failed") return;
  const data = await readProcessingStatus(item);
  if (data) {
    const pct = Number(data.progress_percent || 5);
    const rawStage = String(data.stage || "QUEUED").toUpperCase();
    const stage = rawStage === "COMPLETED" ? "complete" : rawStage === "FAILED" ? "failed" : rawStage.toLowerCase();
    updateBackgroundProcessing(item.id, {
      stage: stage,
      percent: pct,
      statusText: data.message || "Processing"
    });

    if (meetingFolders?.meeting?.id === item.id) {
      const card = $("processingCard");
      if (card) card.classList.remove("hidden");
      if (rawStage === "FAILED") {
        if ($("processingFill")) $("processingFill").style.width = pct + "%";
        if ($("processingPercent")) $("processingPercent").textContent = pct + "%";
        if ($("processingStageText")) $("processingStageText").textContent = data.message || "Processing failed";
        if ($("processingStageEta")) $("processingStageEta").textContent = "Stage remaining: Processing stopped";
        if ($("processingTotalEta")) $("processingTotalEta").textContent = "Total estimated remaining: —";
        if ($("processingSummaryHint")) $("processingSummaryHint").textContent =
          data.error_message ? (data.error_code + ": " + data.error_message) : "Processing failed. You can restart without uploading the audio again.";
      } else {
        const uiStage = driveStageToUi(rawStage);
        const stageLabel = PROCESS_LABELS[uiStage] || data.message || "Processing";
        showProcessingUI(
          uiStage,
          pct,
          rawStage === "COMPLETED" ? "None" : "In progress…",
          rawStage === "COMPLETED" ? "0 minutes" : "Updating…"
        );
        if ($("processingStageText")) $("processingStageText").textContent = data.message || stageLabel;
      }

      if (rawStage === "COMPLETED") {
        if ($("processingSummaryHint")) $("processingSummaryHint").textContent = "Results are ready in Google Drive.";
        return;
      }
    }
  }
  setTimeout(function(){ monitorDriveProcessingStatus(item); }, 4000);
}

async function notifyProcessingStarted(snapshot, options) {
  options = options || {};
  snapshot = snapshot || meetingFolders;
  if (!snapshot || !snapshot.meeting || !snapshot.audio) {
    throw new Error("Meeting workspace information is missing.");
  }

  const requestStarted = new Date().toISOString();

  // Show the live timeline immediately, including when this is a background retry.
  showRecoveredProcessingUI(
    "Processing request sent. Waiting for GitHub Actions to begin."
  );

  try {
    await createInitialProcessingStatus(snapshot);
  } catch (_) {
    // Processor status updates remain authoritative if initial status creation fails.
  }

  // Google Apps Script ContentService responses are redirected to
  // script.googleusercontent.com. A browser fetch that tries to read the
  // cross-origin response can therefore fail with "Failed to fetch" even
  // when the POST itself reached Apps Script. Send a CORS-safe simple POST
  // and use GitHub Actions polling as the authoritative confirmation.
  try {
    await fetch(CONFIG.gateway, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8"
      },
      body: JSON.stringify({
        action: "triggerProcessing",
        meeting_id: snapshot.meeting.id,
        meeting_folder_id: snapshot.meeting.id,
        audio_folder_id: snapshot.audio.id,
        audio_file_id: snapshot.audioFile ? snapshot.audioFile.id : "",
        metadata_file_id: snapshot.metadata ? snapshot.metadata.id : ""
      })
    });
  } catch (err) {
    throw new Error("Processing gateway request could not be sent: " + err.message);
  }

  const item = addBackgroundProcessing(snapshot, "Processing request sent", {
    stage: "checking",
    percent: 5
  });

  if (!options.backgroundOnly) {
    if (retryButton) retryButton.classList.add("hidden");
    if ($("uploadText")) {
      $("uploadText").textContent =
        "Processing request sent. Existing audio will not be uploaded again.";
    }
  }

  monitorDriveProcessingStatus(item);

  setTimeout(function() {
    findAndMonitorLatestRun(item, requestStarted);
  }, 2500);

  return {
    ok: true,
    status: "PROCESSING_REQUEST_SENT"
  };
}

async function findAndMonitorLatestRun(item,requestStarted) {
  if (!item || !item.id) return;
  try {
    const url="https://api.github.com/repos/RamakrishnaSemaladhari/meeting-mom-online/actions/runs?event=repository_dispatch&per_page=10";
    const r=await fetch(url,{headers:{"Accept":"application/vnd.github+json"}});
    if (!r.ok) throw new Error("Could not read processing status.");
    const data=await r.json();
    const since=Date.parse(requestStarted)-30000;
    const run=(data.workflow_runs||[]).find(function(x){return Date.parse(x.created_at)>=since;});
    if (!run) { setTimeout(function(){findAndMonitorLatestRun(item,requestStarted);},7000); return; }
    updateBackgroundProcessing(item.id,{runId:run.id,statusText:run.status==="completed" ? (run.conclusion==="success" ? "Processing complete" : "Processing failed") : "Processing started",percent:run.status==="completed"&&run.conclusion==="success"?100:8});
    monitorWorkflowRun(Object.assign({},item,{runId:run.id}));
  } catch(e) { setTimeout(function(){findAndMonitorLatestRun(item,requestStarted);},15000); }
}

async function monitorWorkflowRun(item) {
  if (!item || !item.runId) return;
  try {
    const r=await fetch("https://api.github.com/repos/RamakrishnaSemaladhari/meeting-mom-online/actions/runs/"+item.runId+"/jobs",{headers:{"Accept":"application/vnd.github+json"}});
    if (!r.ok) throw new Error("Workflow status unavailable.");
    const data=await r.json();
    const job=(data.jobs||[])[0];

    // Older test runs used a bootstrap-only job. They must never be treated
    // as successful meeting processing.
    if (job && job.name === "bootstrap") {
      updateBackgroundProcessing(item.id,{
        stage:"failed",
        statusText:"Previous test run did not process the meeting audio."
      });
      if (meetingFolders?.meeting?.id === item.id) {
        ensureRetryButton();
        if (retryButton) {
          retryButton.classList.remove("hidden");
          retryButton.disabled = false;
          retryButton.textContent = "START PROCESSING";
        }
        if ($("uploadText")) {
          $("uploadText").textContent =
            "Audio is already stored. The earlier test run was only a connectivity/bootstrap test.";
        }
        showRecoveredProcessingUI(
          "Audio is ready. The earlier GitHub run was a test only; actual processing has not started."
        );
      }
      return;
    }

    const steps=job && job.steps ? job.steps : [];
    const stages=[
      {key:"checking",name:"Validate meeting request",pct:10,label:"Checking meeting and processor access"},
      {key:"whisper",name:"Whisper transcription",pct:30,label:"Whisper transcription"},
      {key:"translation",name:"English translation",pct:48,label:"English translation"},
      {key:"ai",name:"AI understanding and evidence extraction",pct:68,label:"AI understanding & evidence extraction"},
      {key:"mom",name:"MoM preparation and validation",pct:88,label:"MoM preparation & validation"},
      {key:"complete",name:"Results ready",pct:100,label:"Results ready"}
    ];
    let current=stages[0];
    for (const st of stages) {
      const step=steps.find(function(x){return x.name===st.name;});
      if (step && step.status==="in_progress") {current=st;break;}
      if (step && step.conclusion==="success") current=st;
    }
    if (job && (job.conclusion==="failure" || job.conclusion==="cancelled")) {
      updateBackgroundProcessing(item.id,{stage:"failed",statusText:"Processing failed"});
      if (meetingFolders?.meeting?.id === item.id) {
        ensureRetryButton();
        if (retryButton) {
          retryButton.classList.remove("hidden");
          retryButton.disabled = false;
          retryButton.textContent = "RETRY PROCESSING";
        }
        if ($("uploadText")) $("uploadText").textContent = "Processing failed. The existing audio is still available. Retry only if you want to run it again.";
      }
      return;
    }
    if (job && job.status==="completed" && job.conclusion==="success") {
      updateBackgroundProcessing(item.id,{stage:"complete",percent:100,statusText:"Results ready"});
      if (meetingFolders?.meeting?.id === item.id) {
        if (retryButton) retryButton.classList.add("hidden");
        if ($("uploadText")) $("uploadText").textContent = "Processing complete. Existing audio was not uploaded again.";
      }
      await loadMeetingResults(item); return;
    }
    updateBackgroundProcessing(item.id,{stage:current.key,percent:current.pct,statusText:current.label});
    setTimeout(function(){monitorWorkflowRun(item);},12000);
  } catch(e) { setTimeout(function(){monitorWorkflowRun(item);},20000); }
}

let currentResultItem = null;

async function downloadDriveFile(fileId, fileName) {
  if (!fileId || !accessToken) throw new Error("Google Drive is not connected.");
  const response = await driveRequest("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || "Meeting_MoM.docx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function createDocxBlob(title, sections) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } =
    await import("https://cdn.jsdelivr.net/npm/docx@9.8.1/+esm");

  const children = [
    new Paragraph({
      text: title || "Minutes of Meeting",
      heading: HeadingLevel.TITLE
    })
  ];

  (sections || []).forEach(section => {
    children.push(new Paragraph({
      text: section.heading,
      heading: HeadingLevel.HEADING_1
    }));
    const values = Array.isArray(section.items) ? section.items : [section.text || ""];
    values.forEach(value => {
      const text = String(value || "").trim();
      if (text) children.push(new Paragraph({
        children: [new TextRun(text)]
      }));
    });
  });

  const doc = new Document({
    sections: [{ children }]
  });
  return Packer.toBlob(doc);
}

async function uploadBlobToDrive(parentId, name, blob, mime) {
  if (!parentId) throw new Error("MoM Drive folder is missing.");
  const metadata = JSON.stringify({
    name,
    parents: [parentId],
    mimeType: mime
  });
  const boundary = "meetingmom_" + Date.now();
  const body = new Blob([
    "--" + boundary + "\r\n",
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    metadata + "\r\n",
    "--" + boundary + "\r\n",
    "Content-Type: " + mime + "\r\n\r\n",
    blob,
    "\r\n--" + boundary + "--"
  ], { type: "multipart/related; boundary=" + boundary });

  const response = await driveRequest(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        "Content-Type": "multipart/related; boundary=" + boundary
      },
      body
    }
  );
  return response.json();
}

function resultSectionsFromEditor() {
  return [
    { heading: "AI Understanding / Executive Summary", text: $("editSummary")?.value || "" },
    { heading: "Decisions", text: $("editDecisions")?.value || "" },
    { heading: "Action Items", text: $("editActions")?.value || "" },
    { heading: "Pending Follow-up", text: $("editFollowup")?.value || "" },
    { heading: "Full Minutes of Meeting", text: $("editMom")?.value || "" }
  ];
}

async function saveFinalMom() {
  if (!currentResultItem?.momFolderId) {
    status("The meeting MoM Drive folder is not available yet.", "error");
    return;
  }

  const button = $("saveFinalBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "SAVING FINAL MOM...";
  }

  try {
    const names = getMoMFileNames();
    const sections = resultSectionsFromEditor();
    const blob = await createDocxBlob($("resultMeetingName")?.textContent || "Minutes of Meeting", sections);

    // Keep an editable snapshot and a final snapshot in the meeting MOM folder.
    const edited = await uploadBlobToDrive(
      currentResultItem.momFolderId,
      names.edited,
      blob,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    const finalBlob = await createDocxBlob($("resultMeetingName")?.textContent || "Minutes of Meeting", sections);
    const final = await uploadBlobToDrive(
      currentResultItem.momFolderId,
      names.final,
      finalBlob,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    setDocumentButton("downloadEditedBtn", edited.id, names.edited);
    setDocumentButton("downloadFinalBtn", final.id, names.final);
    $("editedDocName").textContent = names.edited;
    $("finalDocName").textContent = names.final;
    status("Final MoM saved to Google Drive.", "success");
  } catch (err) {
    status("Final MoM could not be saved: " + err.message, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "SAVE FINAL MOM";
    }
  }
}

function setDocumentButton(buttonId, fileId, fileName) {
  const button = $(buttonId);
  if (!button) return;
  button.disabled = !fileId;
  button.onclick = fileId
    ? () => downloadDriveFile(fileId, fileName)
    : null;
}

async function loadMeetingResults(item) {
  if (!accessToken || !item?.aiFolderId) return;
  currentResultItem = item;
  try {
    const files=await listDriveFiles("'"+item.aiFolderId+"' in parents and name = 'AI Evidence.json' and trashed = false");
    if (!files.length) return;
    const response=await driveRequest("https://www.googleapis.com/drive/v3/files/"+files[0].id+"?alt=media");
    const evidence=await response.json();
    $("resultMeetingName").textContent=item.title||"Meeting";
    $("editSummary").value=evidence.summary||"";
    $("editDecisions").value=(evidence.decisions||[]).map(function(x){return "- "+(x.decision||"")+" ["+(x.timestamp||"")+"]\n  Evidence: "+(x.evidence||"");}).join("\n");
    $("editActions").value=(evidence.action_items||[]).map(function(x){return "- "+(x.action||"")+" | Owner: "+(x.owner||"Not explicitly assigned")+" | Deadline: "+(x.deadline||"Not explicitly stated")+" | "+(x.timestamp||"")+"\n  Evidence: "+(x.evidence||"");}).join("\n");
    $("editFollowup").value=(evidence.open_questions||[]).map(function(x){return "- "+x;}).join("\n");
    $("editMom").value="AI UNDERSTANDING SUMMARY\n"+(evidence.summary||"")+"\n\nKEY DISCUSSIONS\n"+(evidence.discussion_points||[]).map(function(x){return "- "+x;}).join("\n")+"\n\nDECISIONS\n"+$("editDecisions").value+"\n\nACTION ITEMS\n"+$("editActions").value+"\n\nPENDING FOLLOW-UP\n"+$("editFollowup").value;
    $("resultsCard").classList.remove("hidden");

    // Locate the processor-generated AI MoM document and any previously saved edited/final documents.
    if (item.momFolderId) {
      const docs = await listDriveFiles("'"+item.momFolderId+"' in parents and trashed = false");
      const aiDoc = docs.find(x => /AI_MOM\.docx$/i.test(x.name));
      const editedDoc = docs.find(x => /EDITED_MOM\.docx$/i.test(x.name));
      const finalDoc = docs.find(x => /FINAL_MOM\.docx$/i.test(x.name));
      const names = getMoMFileNames();

      $("aiDocName").textContent = aiDoc?.name || names.ai;
      $("editedDocName").textContent = editedDoc?.name || names.edited;
      $("finalDocName").textContent = finalDoc?.name || names.final;

      setDocumentButton("downloadAiBtn", aiDoc?.id, aiDoc?.name);
      setDocumentButton("downloadEditedBtn", editedDoc?.id, editedDoc?.name);
      setDocumentButton("downloadFinalBtn", finalDoc?.id, finalDoc?.name);

      const openDrive = $("openDriveBtn");
      if (openDrive) {
        openDrive.disabled = false;
        openDrive.onclick = function() {
          window.open("https://drive.google.com/drive/folders/" + item.meetingFolderId, "_blank", "noopener");
        };
      }
    }
  } catch(e) {
    console.warn("Results load failed",e);
  }
}


function toggleEditor(id,buttonId) {
  const el=$(id),btn=$(buttonId); if(!el||!btn)return; el.readOnly=!el.readOnly; btn.textContent=el.readOnly?"EDIT":"DONE";
}
async function copyField(id) { const el=$(id); if(!el)return; if(navigator.clipboard)await navigator.clipboard.writeText(el.value||""); status("Copied to clipboard.","success"); }
function listenField(id) { const el=$(id); if(!el||!window.speechSynthesis)return; speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(el.value||"")); }
function initSpeechButton(buttonId,inputId) {
  const btn=$(buttonId),input=$(inputId); if(!btn||!input)return;
  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SpeechRecognition){btn.disabled=true;return;}
  const rec=new SpeechRecognition(); rec.lang="en-IN"; rec.interimResults=false; rec.continuous=false;
  btn.addEventListener("click",function(){rec.start();status("Listening...","");});
  rec.onresult=function(e){input.value=e.results[0][0].transcript;input.dispatchEvent(new Event("input"));};
}

function parseVoiceDate(text) {
  const raw=String(text||"").trim().toLowerCase();
  const d=new Date(raw);
  if(!isNaN(d.getTime())) return d.toISOString().slice(0,10);
  const m=raw.match(/(\d{1,2})[\s\/-]+(\d{1,2})[\s\/-]+(\d{2,4})/);
  if(m){let y=Number(m[3]);if(y<100)y+=2000;const dt=new Date(y,Number(m[2])-1,Number(m[1]));if(!isNaN(dt.getTime()))return dt.toISOString().slice(0,10);}
  return text;
}
function parseVoiceTime(text) {
  const raw=String(text||"").toLowerCase().replace(/\./g,"");
  const m=raw.match(/(\d{1,2})(?::|\s+)?(\d{2})?\s*(am|pm)?/);
  if(!m) return text;
  let h=Number(m[1]), min=Number(m[2]||0); const ap=m[3];
  if(ap==="pm"&&h<12)h+=12;if(ap==="am"&&h===12)h=0;
  if(h>23||min>59)return text;
  return String(h).padStart(2,"0")+":"+String(min).padStart(2,"0");
}
function startFieldVoice(button,input,parser) {
  if(!button||!input)return;
  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SpeechRecognition){button.disabled=true;return;}
  if(button._recognition){try{button._recognition.abort();}catch(_){}}
  const rec=new SpeechRecognition(); button._recognition=rec;
  rec.lang="en-IN";rec.interimResults=false;rec.continuous=false;
  rec.onstart=()=>{button.classList.add("listening");button.textContent="■";status("Listening for "+(input.getAttribute("placeholder")||input.id)+"...","");};
  rec.onend=()=>{button.classList.remove("listening");button.textContent="🎤";};
  rec.onerror=e=>status("Voice input unavailable: "+(e.error||"unknown error"),"error");
  rec.onresult=e=>{const t=e.results?.[0]?.[0]?.transcript||"";input.value=parser?parser(t):t;input.dispatchEvent(new Event("input",{bubbles:true}));};
  button.onclick=()=>{try{rec.start();}catch(_){}};
}
function getSelectedContinuityTitle() {
  const select=$("continuityMeeting"); if(!select?.value)return "";
  return select.options[select.selectedIndex]?.textContent.replace(/^.*?—\s*/,"").trim()||"";
}
async function populateContinuityMeetings() {
  const select=$("continuityMeeting"); if(!select||!accessToken)return;
  try {
    const folders=await listDriveFiles("'"+DRIVE_INBOX_ID+"' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false","files(id,name,createdTime)");
    const rows=[];
    for(const folder of folders.slice(0,20)){
      let title=folder.name;
      try {
        const files=await listDriveFiles("'"+folder.id+"' in parents and name = 'meeting_metadata.json' and trashed = false","files(id,name)");
        if(files.length){
          const r=await driveRequest("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(files[0].id)+"?alt=media");
          const m=await r.json(); if(m.title)title=m.title;
        }
      }catch(_){}
      rows.push({id:folder.id,title,createdTime:folder.createdTime});
    }
    rows.sort((a,b)=>String(b.createdTime).localeCompare(String(a.createdTime)));
    select.innerHTML='<option value="">No previous meeting — start fresh</option>'+rows.map(x=>'<option value="'+escapeHtml(x.id)+'">'+escapeHtml(new Date(x.createdTime).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}))+' — '+escapeHtml(x.title)+'</option>').join("");
  }catch(e){console.warn("Continuity list failed",e);}
}
async function loadContinuityMeeting() {
  const id=$("continuityMeeting")?.value;
  if(!id){$("continuityStatus").textContent="Continuity cleared. This meeting will be treated as a new meeting.";return;}
  try {
    const item={meetingFolderId:id,title:$("continuityMeeting").options[$("continuityMeeting").selectedIndex].textContent};
    const snapshot=await loadBackgroundMeetingSnapshot(item);
    const files=await listDriveFiles("'"+id+"' in parents and name = 'meeting_metadata.json' and trashed = false","files(id,name)");
    if(files.length){
      const r=await driveRequest("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(files[0].id)+"?alt=media");
      const m=await r.json();
      if(m.title)$("title").value=m.title+" — Continuation";
      if(m.venue)$("venue").value=m.venue;
      if(m.agenda)$("agenda").value=m.agenda;
      if(m.initiator)$("initiator").value=m.initiator;
      if(Array.isArray(m.participants)){$("participants").innerHTML="";m.participants.forEach(p=>addParticipant(p));}
      updateFilenamePreview();
    }
    $("continuityStatus").textContent="Previous meeting context loaded. Your new recording/upload remains separate.";
    status("Previous meeting context loaded. New meeting audio will be stored separately.","success");
  }catch(e){$("continuityStatus").textContent=e.message;status(e.message,"error");}
}
function clearContinuityMeeting() {
  $("continuityMeeting").value="";
  $("continuityStatus").textContent="Continuity cleared.";
}


document.addEventListener("DOMContentLoaded",function(){
  $("connectBtn")?.addEventListener("click",connectGoogle);
  $("addParticipant")?.addEventListener("click",function(){addParticipant();});
  $("uploadBtn")?.addEventListener("click",uploadSelectedAudio);
  $("startBtn")?.addEventListener("click",startMeeting);
  $("stopBtn")?.addEventListener("click",stopMeeting);
  $("audioFile")?.addEventListener("change",function(){const f=$("audioFile").files[0];if(f)status("Audio selected: "+f.name+". Ready to upload.","");});
  ["title","date","startTime","endTime","venue","agenda"].forEach(function(id){$(id)?.addEventListener("input",updateFilenamePreview);});
  [["editSummaryBtn","editSummary"],["editDecisionsBtn","editDecisions"],["editActionsBtn","editActions"],["editFollowupBtn","editFollowup"],["editMomBtn","editMom"]].forEach(function(x){$(x[0])?.addEventListener("click",function(){toggleEditor(x[1],x[0]);});});
  [["copySummaryBtn","editSummary"],["copyDecisionsBtn","editDecisions"],["copyActionsBtn","editActions"],["copyFollowupBtn","editFollowup"],["copyMomBtn","editMom"]].forEach(function(x){$(x[0])?.addEventListener("click",function(){copyField(x[1]);});});
  [["listenSummaryBtn","editSummary"],["listenDecisionsBtn","editDecisions"],["listenActionsBtn","editActions"],["listenFollowupBtn","editFollowup"],["listenMomBtn","editMom"]].forEach(function(x){$(x[0])?.addEventListener("click",function(){listenField(x[1]);});});
  $("saveFinalBtn")?.addEventListener("click",saveFinalMom);
  initSpeechButton("titleVoice","title"); initSpeechButton("agendaVoice","agenda");
  startFieldVoice($("initiatorVoice"),$("initiator"));
  startFieldVoice($("dateVoice"),$("date"),parseVoiceDate);
  startFieldVoice($("startTimeVoice"),$("startTime"),parseVoiceTime);
  startFieldVoice($("endTimeVoice"),$("endTime"),parseVoiceTime);
  startFieldVoice($("venueVoice"),$("venue"));
  $("loadContinuityBtn")?.addEventListener("click",loadContinuityMeeting);
  $("clearContinuityBtn")?.addEventListener("click",clearContinuityMeeting);
  updateFilenamePreview(); renderBackgroundProcessing(); initGoogle();
});