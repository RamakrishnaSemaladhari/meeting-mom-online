/************************************************************
 * MEETING MOM ONLINE GATEWAY
 * COMPLETE Code.gs
 *
 * GOOGLE SPREADSHEET
 * File: MEETING_REGISTER
 * Tab : Sheet1
 *
 * WEB APP
 * Root URL:
 * https://script.google.com/macros/s/.../exec
 *
 * ARCHITECTURE
 *
 * UI
 *   ↓
 * Apps Script Web App
 *   ├── Dashboard
 *   ├── Meeting Registry
 *   ├── Meeting API
 *   ├── Rating API
 *   └── GitHub Dispatcher
 *          ↓
 * Google Drive
 *          ↓
 * GitHub Actions
 *          ↓
 * Whisper + Qwen
 *          ↓
 * Google Drive Reports
 ************************************************************/


/************************************************************
 * CONFIGURATION
 ************************************************************/

const CONFIG = {

  /*
   * Existing Google Spreadsheet FILE.
   *
   * File name:
   * MEETING_REGISTER
   */
  REGISTRY_SPREADSHEET_ID:
    '1CYQyL0gT_KZ1s0cegBj3CgDK10V5YfiWdutDx3wZMRM',

  /*
   * IMPORTANT:
   * This is the worksheet TAB.
   *
   * Spreadsheet file = MEETING_REGISTER
   * Worksheet tab    = Sheet1
   */
  REGISTRY_SHEET_NAME:
    'Sheet1',

  /*
   * Root Google Drive folder property.
   */
  ROOT_FOLDER_PROPERTY:
    'MEETING_ROOT_FOLDER_ID',

  /*
   * GitHub repository.
   */
  GITHUB_REPO:
    'RamakrishnaSemaladhari/meeting-mom-online',

  /*
   * GitHub repository dispatch endpoint.
   */
  GITHUB_DISPATCH_URL:
    'https://api.github.com/repos/RamakrishnaSemaladhari/meeting-mom-online/dispatches',

  /*
   * Script Property containing GitHub PAT.
   */
  GITHUB_TOKEN_PROPERTY:
    'GITHUB_TOKEN',

  /*
   * GitHub event type expected by workflow.
   */
  GITHUB_EVENT_TYPE:
    'meeting-ready',

  /*
   * India timezone.
   */
  TIMEZONE:
    'Asia/Kolkata'
};


/************************************************************
 * REGISTRY HEADERS
 *
 * A:AF = 32 columns
 ************************************************************/

const HEADERS = [

  'Meeting ID',
  'Meeting Title',
  'Meeting Initiator',
  'Meeting Mode',
  'Processing Engine',
  'Meeting Date',
  'Start Time',
  'End Time',
  'Audio Minutes',
  'Venue',
  'Agenda',
  'Participants',
  'Status',
  'Processing Start',
  'Processing End',
  'Processing Time',
  'Audio File ID',
  'Meeting Folder ID',
  'Audio Folder ID',
  'Report Folder URL',
  'Transcript URL',
  'Translation URL',
  'Summary URL',
  'MoM URL',
  'Evidence URL',
  'Rating',
  'Rating Comment',
  'Rated At',
  'Error Code',
  'Error Message',
  'Created At',
  'Updated At'

];


/************************************************************
 * WEB APP ENTRY
 *
 * Normal URL:
 *
 * /exec
 *
 * returns Index.html
 *
 * API:
 *
 * /exec?action=dashboard
 * /exec?action=meetings
 * /exec?action=meeting&meeting_id=...
 * /exec?action=health
 ************************************************************/

function doGet(e) {

  try {

    const params =
      e && e.parameter
        ? e.parameter
        : {};

    /*
     * No action = load dashboard UI.
     */
    if (!params.action) {

      return HtmlService
        .createTemplateFromFile(
          'Index'
        )
        .evaluate()
        .setTitle(
          'Meeting MoM Online'
        )
        .setXFrameOptionsMode(
          HtmlService.XFrameOptionsMode.ALLOWALL
        );
    }


    /*
     * API request.
     */
    const action =
      params.action;


    let result;


    switch (action) {

      case 'health':

        result = {

          success: true,

          service:
            'Meeting MoM Online Gateway',

          status:
            'OK',

          timestamp:
            now_()

        };

        break;


      case 'dashboard':

        result =
          getDashboardStats_();

        break;


      case 'meetings':

        result =
          listMeetings_(params);

        break;


      case 'meeting':

        result =
          getMeeting_(
            params.meeting_id ||
            params.id
          );

        break;


      case 'setup':

        result =
          setupMeetingSystem();

        break;


      default:

        result = {

          success: false,

          error:
            'UNKNOWN_ACTION',

          message:
            'Unknown GET action: ' +
            action

        };
    }


    return jsonResponse_(
      result
    );


  } catch (err) {

    return jsonResponse_({

      success: false,

      error:
        'GET_ERROR',

      message:
        err.message,

      timestamp:
        now_()

    });
  }
}


/************************************************************
 * POST ENTRY
 ************************************************************/

function doPost(e) {

  try {

    const body =
      parseRequestBody_(e);

    const action =
      body.action || '';


    let result;


    switch (action) {

      case 'setup':

        result =
          setupMeetingSystem();

        break;


      case 'create_meeting':

        result =
          createMeeting_(body);

        break;


      case 'start_processing':

        result =
          startProcessing_(body);

        break;


      case 'pause_processing':

        result =
          pauseProcessing_(body);

        break;


      case 'resume_processing':

        result =
          resumeProcessing_(body);

        break;


      case 'rerun_processing':

        result =
          rerunProcessing_(body);

        break;


      case 'delete_meeting':

        result =
          deleteMeeting_(body);

        break;


      case 'update_processing':

        result =
          updateProcessing_(body);

        break;


      case 'complete_meeting':

        result =
          completeMeeting_(body);

        break;


      case 'fail_meeting':

        result =
          failMeeting_(body);

        break;


      case 'update_reports':

        result =
          updateReports_(body);

        break;


      case 'rate_meeting':

        result =
          rateMeeting_(body);

        break;


      default:

        result = {

          success: false,

          error:
            'UNKNOWN_ACTION',

          message:
            'Unknown POST action: ' +
            action

        };
    }


    return jsonResponse_(
      result
    );


  } catch (err) {

    return jsonResponse_({

      success: false,

      error:
        'POST_ERROR',

      message:
        err.message,

      timestamp:
        now_()

    });
  }
}


/************************************************************
 * SETUP
 *
 * Run once manually:
 *
 * TEST_setup
 ************************************************************/

function setupMeetingSystem() {

  const spreadsheet =
    getRegistrySpreadsheet_();

  const sheet =
    getRegistrySheet_();


  ensureHeaders_(
    sheet
  );


  formatRegistrySheet_(
    sheet
  );


  const rootFolder =
    getOrCreateRootFolder_();


  return {

    success: true,

    spreadsheetId:
      spreadsheet.getId(),

    spreadsheetName:
      spreadsheet.getName(),

    sheetName:
      sheet.getName(),

    rootFolderId:
      rootFolder.getId(),

    rootFolderUrl:
      rootFolder.getUrl(),

    headers:
      HEADERS,

    headerCount:
      HEADERS.length,

    range:
      'A1:AF1',

    timestamp:
      now_()

  };
}


/************************************************************
 * CREATE MEETING
 ************************************************************/

function createMeeting_(data) {

  const sheet =
    getRegistrySheet_();


  ensureHeaders_(
    sheet
  );


  const meetingId =
    clean_(
      data.meeting_id
    ) ||
    generateMeetingId_();


  /*
   * Prevent duplicate meeting IDs.
   */
  const existingRow =
    findMeetingRow_(
      meetingId
    );


  if (existingRow > 0) {

    return {

      success: true,

      existing: true,

      meeting_id:
        meetingId,

      row:
        existingRow,

      message:
        'Meeting already exists'

    };
  }


  const now =
    new Date();


  const meetingTitle =
    clean_(
      data.meeting_title
    );


  const initiator =
    clean_(
      data.meeting_initiator
    );


  if (!meetingTitle) {

    throw new Error(
      'Meeting title is required'
    );
  }


  if (!initiator) {

    throw new Error(
      'Meeting initiator is required'
    );
  }


  const mode =
    clean_(
      data.meeting_mode
    )
    .toUpperCase() ||
    'ONLINE';


  const engine =
    clean_(
      data.processing_engine
    ) ||
    (
      mode === 'OFFLINE'
        ? 'OFFLINE'
        : 'ONLINE'
    );


  const meetingDate =
    clean_(
      data.meeting_date
    ) ||
    formatDate_(
      now
    );


  const startTime =
    clean_(
      data.start_time
    ) ||
    formatTime_(
      now
    );


  const endTime =
    clean_(
      data.end_time
    );


  const audioMinutes =
    toNumber_(
      data.audio_minutes
    );


  const venue =
    clean_(
      data.venue
    );


  const agenda =
    clean_(
      data.agenda
    );


  const participants =
    clean_(
      data.participants
    );


  const audioFileId =
    clean_(
      data.audio_file_id
    );


  const audioFolderId =
    clean_(
      data.audio_folder_id
    );


  let meetingFolderId =
    clean_(
      data.meeting_folder_id
    );


  let reportFolderUrl =
    '';


  /*
   * Create meeting folder if one
   * was not supplied by the UI.
   */
  if (!meetingFolderId) {

    const rootFolder =
      getOrCreateRootFolder_();


    const folderName =
      meetingId +
      ' - ' +
      (
        meetingTitle ||
        'Meeting'
      );


    const folder =
      rootFolder.createFolder(
        folderName
      );


    meetingFolderId =
      folder.getId();


    reportFolderUrl =
      folder.getUrl();


  } else {

    try {

      reportFolderUrl =
        DriveApp
          .getFolderById(
            meetingFolderId
          )
          .getUrl();

    } catch (err) {

      reportFolderUrl =
        '';
    }
  }


  const row = [

    meetingId,
    meetingTitle,
    initiator,
    mode,
    engine,
    meetingDate,
    startTime,
    endTime,
    audioMinutes,
    venue,
    agenda,
    participants,
    'CREATED',
    '',
    '',
    '',
    audioFileId,
    meetingFolderId,
    audioFolderId,
    reportFolderUrl,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    now,
    now

  ];


  sheet.appendRow(
    row
  );


  const rowNumber =
    sheet.getLastRow();


  return {

    success: true,

    existing: false,

    meeting_id:
      meetingId,

    row:
      rowNumber,

    meeting_folder_id:
      meetingFolderId,

    audio_folder_id:
      audioFolderId,

    audio_file_id:
      audioFileId,

    report_folder_url:
      reportFolderUrl,

    status:
      'CREATED',

    timestamp:
      now_()

  };
}


/************************************************************
 * START PROCESSING
 ************************************************************/

function startProcessing_(data) {

  const meetingId =
    clean_(
      data.meeting_id
    );


  if (!meetingId) {

    throw new Error(
      'meeting_id is required'
    );
  }


  const sheet =
    getRegistrySheet_();


  let rowNumber =
    findMeetingRow_(
      meetingId
    );


  let row =
    rowNumber >= 2
      ? getRowObject_(
          sheet,
          rowNumber
        )
      : null;


  /*
   * Exact Drive IDs supplied by the
   * production UI. If a registry row
   * already exists, its values remain
   * the fallback source.
   */
  const audioFileId =
    clean_(
      data.audio_file_id ||
      (row ? row['Audio File ID'] : '')
    );


  const audioFolderId =
    clean_(
      data.audio_folder_id ||
      (row ? row['Audio Folder ID'] : '')
    );


  const meetingFolderId =
    clean_(
      data.meeting_folder_id ||
      (row ? row['Meeting Folder ID'] : '')
    );


  /*
   * The browser creates the Drive
   * workspace directly. Therefore a
   * missing registry row must not block
   * production processing. Register the
   * exact workspace here before dispatch.
   */
  if (rowNumber < 2) {

    const registration =
      createMeeting_({
        meeting_id:
          meetingId,

        meeting_title:
          clean_(data.meeting_title) ||
          ('Meeting ' + meetingId),

        meeting_initiator:
          clean_(data.meeting_initiator) ||
          'Web UI',

        meeting_mode:
          clean_(data.meeting_mode) ||
          'ONLINE',

        processing_engine:
          clean_(data.processing_engine) ||
          'ONLINE',

        meeting_date:
          clean_(data.meeting_date),

        start_time:
          clean_(data.start_time),

        end_time:
          clean_(data.end_time),

        audio_minutes:
          data.audio_minutes,

        venue:
          clean_(data.venue),

        agenda:
          clean_(data.agenda),

        participants:
          clean_(data.participants),

        audio_file_id:
          audioFileId,

        audio_folder_id:
          audioFolderId,

        meeting_folder_id:
          meetingFolderId

      });


    rowNumber =
      registration.row;


    row =
      getRowObject_(
        sheet,
        rowNumber
      );

  }


  /*
   * Online processing requires
   * an exact audio file.
   */
  if (!audioFileId) {

    throw new Error(
      'Audio File ID is required before online processing can start.'
    );
  }


  writeProcessingMode_(meetingFolderId, clean_(data.processing_mode) || 'fresh');

  const start =
    new Date();


  setCellByHeader_(
    sheet,
    rowNumber,
    'Status',
    'PROCESSING'
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Processing Start',
    start
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Updated At',
    start
  );


  /*
   * Dispatch GitHub.
   */
  const githubResult =
    dispatchToGitHub_({

      meeting_id:
        meetingId,

      audio_folder_id:
        audioFolderId,

      meeting_folder_id:
        meetingFolderId,

      audio_file_id:
        audioFileId

    });


  /*
   * Dispatch failure.
   */
  if (!githubResult.success) {

    setCellByHeader_(
      sheet,
      rowNumber,
      'Status',
      'FAILED'
    );


    setCellByHeader_(
      sheet,
      rowNumber,
      'Error Code',
      'GITHUB_DISPATCH'
    );


    setCellByHeader_(
      sheet,
      rowNumber,
      'Error Message',
      githubResult.message ||
      'GitHub dispatch failed'
    );


    setCellByHeader_(
      sheet,
      rowNumber,
      'Updated At',
      new Date()
    );


    return {

      success: false,

      meeting_id:
        meetingId,

      status:
        'FAILED',

      error:
        'GITHUB_DISPATCH',

      message:
        githubResult.message

    };
  }


  return {

    success: true,

    meeting_id:
      meetingId,

    status:
      'PROCESSING',

    audio_file_id:
      audioFileId,

    audio_folder_id:
      audioFolderId,
    meeting_folder_id:
      meetingFolderId,

    github_status:
      githubResult.status,

    timestamp:
      now_()

  };
}


/************************************************************
 * MEETING CONTROL ACTIONS
 ************************************************************/

function pauseProcessing_(data) {
  const meetingId = clean_(data.meeting_id);
  if (!meetingId) throw new Error('meeting_id is required');
  const rowNumber = findMeetingRow_(meetingId);
  if (rowNumber < 2) throw new Error('Meeting not found: ' + meetingId);
  const sheet = getRegistrySheet_();
  const runId = clean_(data.run_id);
  if (runId) cancelGitHubRun_(runId);
  setCellByHeader_(sheet, rowNumber, 'Status', 'PAUSED');
  setCellByHeader_(sheet, rowNumber, 'Error Code', '');
  setCellByHeader_(sheet, rowNumber, 'Error Message', '');
  setCellByHeader_(sheet, rowNumber, 'Updated At', new Date());
  return {success:true, meeting_id:meetingId, status:'PAUSED', run_id:runId, timestamp:now_()};
}

function resumeProcessing_(data) {
  const meetingId = clean_(data.meeting_id);
  if (!meetingId) throw new Error('meeting_id is required');
  const rowNumber = findMeetingRow_(meetingId);
  if (rowNumber < 2) throw new Error('Meeting not found: ' + meetingId);
  const sheet = getRegistrySheet_();
  const row = getRowObject_(sheet, rowNumber);
  const payload = {
    meeting_id: meetingId,
    audio_file_id: clean_(data.audio_file_id || row['Audio File ID']),
    audio_folder_id: clean_(data.audio_folder_id || row['Audio Folder ID']),
    meeting_folder_id: clean_(data.meeting_folder_id || row['Meeting Folder ID']),
    processing_mode: 'resume'
  };
  if (!payload.audio_file_id) throw new Error('Audio File ID is required before processing can resume.');
  writeProcessingMode_(payload.meeting_folder_id, 'resume');
  return startProcessing_(payload);
}

function rerunProcessing_(data) {
  const meetingId = clean_(data.meeting_id);
  if (!meetingId) throw new Error('meeting_id is required');
  const rowNumber = findMeetingRow_(meetingId);
  if (rowNumber < 2) throw new Error('Meeting not found: ' + meetingId);
  const sheet = getRegistrySheet_();
  const row = getRowObject_(sheet, rowNumber);
  const payload = {
    meeting_id: meetingId,
    audio_file_id: clean_(data.audio_file_id || row['Audio File ID']),
    audio_folder_id: clean_(data.audio_folder_id || row['Audio Folder ID']),
    meeting_folder_id: clean_(data.meeting_folder_id || row['Meeting Folder ID']),
    processing_mode: 'rerun'
  };
  if (!payload.audio_file_id) throw new Error('Audio File ID is required before processing can re-run.');
  writeProcessingMode_(payload.meeting_folder_id, 'rerun');
  return startProcessing_(payload);
}

function writeProcessingMode_(folderId, mode) {
  if (!folderId) return;
  const payload = JSON.stringify({
    mode: mode || 'fresh',
    updated_at: new Date().toISOString()
  }, null, 2);
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByName('PROCESSING_CONTROL.json');
  if (files.hasNext()) {
    files.next().setContent(payload);
  } else {
    folder.createFile('PROCESSING_CONTROL.json', payload, MimeType.PLAIN_TEXT);
  }
}

function deleteMeeting_(data) {
  const meetingId = clean_(data.meeting_id);
  if (!meetingId) throw new Error('meeting_id is required');
  const rowNumber = findMeetingRow_(meetingId);
  if (rowNumber < 2) throw new Error('Meeting not found: ' + meetingId);
  const sheet = getRegistrySheet_();
  const runId = clean_(data.run_id);
  if (runId) {
    try { cancelGitHubRun_(runId); } catch (_) {}
  }
  setCellByHeader_(sheet, rowNumber, 'Status', 'DELETED');
  setCellByHeader_(sheet, rowNumber, 'Updated At', new Date());
  return {success:true, meeting_id:meetingId, status:'DELETED', drive_preserved:true, timestamp:now_()};
}

function cancelGitHubRun_(runId) {
  const token = PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);
  if (!token) throw new Error('GITHUB_TOKEN is not configured in Script Properties.');
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_REPO + '/actions/runs/' + encodeURIComponent(String(runId)) + '/cancel';
  const response = UrlFetchApp.fetch(url, {
    method:'post',
    headers:{
      Authorization:'Bearer ' + token,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28'
    },
    muteHttpExceptions:true
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('GitHub run cancellation failed (' + code + '): ' + response.getContentText());
  return true;
}


/************************************************************
 * UPDATE PROCESSING
 ************************************************************/

function updateProcessing_(data) {

  const meetingId =
    clean_(
      data.meeting_id
    );


  if (!meetingId) {

    throw new Error(
      'meeting_id is required'
    );
  }


  const rowNumber =
    findMeetingRow_(
      meetingId
    );


  if (rowNumber < 2) {

    throw new Error(
      'Meeting not found: ' +
      meetingId
    );
  }


  const sheet =
    getRegistrySheet_();


  if (
    data.status !==
    undefined
  ) {

    setCellByHeader_(
      sheet,
      rowNumber,
      'Status',
      clean_(
        data.status
      )
    );
  }


  if (
    data.processing_start !==
    undefined
  ) {

    setCellByHeader_(
      sheet,
      rowNumber,
      'Processing Start',
      parseDateValue_(
        data.processing_start
      )
    );
  }


  if (
    data.processing_end !==
    undefined
  ) {

    setCellByHeader_(
      sheet,
      rowNumber,
      'Processing End',
      parseDateValue_(
        data.processing_end
      )
    );
  }


  if (
    data.processing_time !==
    undefined
  ) {

    setCellByHeader_(
      sheet,
      rowNumber,
      'Processing Time',
      clean_(
        data.processing_time
      )
    );
  }


  if (
    data.audio_minutes !==
    undefined
  ) {

    setCellByHeader_(
      sheet,
      rowNumber,
      'Audio Minutes',
      toNumber_(
        data.audio_minutes
      )
    );
  }


  if (
    data.error_code !==
    undefined
  ) {

    setCellByHeader_(
      sheet,
      rowNumber,
      'Error Code',
      clean_(
        data.error_code
      )
    );
  }


  if (
    data.error_message !==
    undefined
  ) {

    setCellByHeader_(
      sheet,
      rowNumber,
      'Error Message',
      clean_(
        data.error_message
      )
    );
  }


  setCellByHeader_(
    sheet,
    rowNumber,
    'Updated At',
    new Date()
  );


  return {

    success: true,

    meeting_id:
      meetingId,

    row:
      rowNumber,

    timestamp:
      now_()

  };
}


/************************************************************
 * COMPLETE MEETING
 ************************************************************/

function completeMeeting_(data) {

  const meetingId =
    clean_(
      data.meeting_id
    );


  if (!meetingId) {

    throw new Error(
      'meeting_id is required'
    );
  }


  const rowNumber =
    findMeetingRow_(
      meetingId
    );


  if (rowNumber < 2) {

    throw new Error(
      'Meeting not found: ' +
      meetingId
    );
  }


  const sheet =
    getRegistrySheet_();


  const end =
    new Date();


  setCellByHeader_(
    sheet,
    rowNumber,
    'Status',
    'COMPLETED'
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Processing End',
    end
  );


  if (
    data.processing_time !==
    undefined
  ) {

    setCellByHeader_(
      sheet,
      rowNumber,
      'Processing Time',
      clean_(
        data.processing_time
      )
    );

  } else {

    calculateAndSetProcessingTime_(
      sheet,
      rowNumber
    );
  }


  if (
    data.audio_minutes !==
    undefined
  ) {

    setCellByHeader_(
      sheet,
      rowNumber,
      'Audio Minutes',
      toNumber_(
        data.audio_minutes
      )
    );
  }


  updateReportFields_(
    sheet,
    rowNumber,
    data
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Updated At',
    end
  );


  return {

    success: true,

    meeting_id:
      meetingId,

    status:
      'COMPLETED',

    timestamp:
      now_()

  };
}


/************************************************************
 * FAIL MEETING
 ************************************************************/

function failMeeting_(data) {

  const meetingId =
    clean_(
      data.meeting_id
    );


  if (!meetingId) {

    throw new Error(
      'meeting_id is required'
    );
  }


  const rowNumber =
    findMeetingRow_(
      meetingId
    );


  if (rowNumber < 2) {

    throw new Error(
      'Meeting not found: ' +
      meetingId
    );
  }


  const sheet =
    getRegistrySheet_();


  const end =
    new Date();


  setCellByHeader_(
    sheet,
    rowNumber,
    'Status',
    'FAILED'
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Processing End',
    end
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Error Code',
    clean_(
      data.error_code ||
      'PROCESSING_FAILED'
    )
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Error Message',
    clean_(
      data.error_message ||
      'Processing failed'
    )
  );


  calculateAndSetProcessingTime_(
    sheet,
    rowNumber
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Updated At',
    end
  );


  return {

    success: true,

    meeting_id:
      meetingId,

    status:
      'FAILED',

    timestamp:
      now_()

  };
}


/************************************************************
 * UPDATE REPORTS
 ************************************************************/

function updateReports_(data) {

  const meetingId =
    clean_(
      data.meeting_id
    );


  if (!meetingId) {

    throw new Error(
      'meeting_id is required'
    );
  }


  const rowNumber =
    findMeetingRow_(
      meetingId
    );


  if (rowNumber < 2) {

    throw new Error(
      'Meeting not found: ' +
      meetingId
    );
  }


  const sheet =
    getRegistrySheet_();


  updateReportFields_(
    sheet,
    rowNumber,
    data
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Updated At',
    new Date()
  );


  return {

    success: true,

    meeting_id:
      meetingId,

    timestamp:
      now_()

  };
}


/************************************************************
 * RATING
 ************************************************************/

function rateMeeting_(data) {

  const meetingId =
    clean_(
      data.meeting_id
    );


  if (!meetingId) {

    throw new Error(
      'meeting_id is required'
    );
  }


  const rating =
    Number(
      data.rating
    );


  if (
    !isFinite(rating) ||
    rating < 1 ||
    rating > 5
  ) {

    throw new Error(
      'Rating must be between 1 and 5'
    );
  }


  const rowNumber =
    findMeetingRow_(
      meetingId
    );


  if (rowNumber < 2) {

    throw new Error(
      'Meeting not found: ' +
      meetingId
    );
  }


  const sheet =
    getRegistrySheet_();


  const ratedAt =
    new Date();


  setCellByHeader_(
    sheet,
    rowNumber,
    'Rating',
    rating
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Rating Comment',
    clean_(
      data.rating_comment ||
      data.comment
    )
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Rated At',
    ratedAt
  );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Updated At',
    ratedAt
  );


  return {

    success: true,

    meeting_id:
      meetingId,

    rating:
      rating,

    rated_at:
      formatDateTime_(
        ratedAt
      )

  };
}


/************************************************************
 * DASHBOARD STATISTICS
 ************************************************************/

function getDashboardStats_() {

  const sheet =
    getRegistrySheet_();


  ensureHeaders_(
    sheet
  );


  const lastRow =
    sheet.getLastRow();


  if (
    lastRow < 2
  ) {

    return {

      success: true,

      total_meetings: 0,

      online_meetings: 0,

      offline_meetings: 0,

      total_audio_minutes: 0,

      total_audio_hours: 0,

      completed: 0,

      processing: 0,

      created: 0,

      failed: 0,

      unrated: 0,

      rated: 0,

      average_rating: 0,

      timestamp:
        now_()

    };
  }


  const values =
    sheet
      .getRange(
        2,
        1,
        lastRow - 1,
        HEADERS.length
      )
      .getValues();


  let total = 0;

  let online = 0;

  let offline = 0;

  let minutes = 0;

  let completed = 0;

  let processing = 0;

  let created = 0;

  let failed = 0;

  let unrated = 0;

  let ratingTotal = 0;

  let ratingCount = 0;


  values.forEach(
    function(row) {

      if (!row[0]) {
        return;
      }


      total++;


      const mode =
        String(
          row[3] || ''
        )
        .toUpperCase();


      if (
        mode === 'ONLINE'
      ) {

        online++;

      }


      if (
        mode === 'OFFLINE'
      ) {

        offline++;

      }


      const audio =
        Number(
          row[8]
        );


      if (
        isFinite(audio)
      ) {

        minutes +=
          audio;

      }


      const status =
        String(
          row[12] || ''
        )
        .toUpperCase();


      switch (status) {

        case 'COMPLETED':

          completed++;

          break;


        case 'PROCESSING':

          processing++;

          break;


        case 'FAILED':

          failed++;

          break;


        case 'CREATED':

          created++;

          break;

      }


      const rating =
        Number(
          row[25]
        );


      if (
        isFinite(rating) &&
        rating >= 1 &&
        rating <= 5
      ) {

        ratingTotal +=
          rating;

        ratingCount++;

      } else {

        unrated++;

      }

    }
  );


  const average =
    ratingCount > 0
      ? ratingTotal /
        ratingCount
      : 0;


  return {

    success: true,

    total_meetings:
      total,

    online_meetings:
      online,

    offline_meetings:
      offline,

    total_audio_minutes:
      round_(
        minutes,
        2
      ),

    total_audio_hours:
      round_(
        minutes / 60,
        2
      ),

    completed:
      completed,

    processing:
      processing,

    created:
      created,

    failed:
      failed,

    unrated:
      unrated,

    rated:
      ratingCount,

    average_rating:
      round_(
        average,
        2
      ),

    timestamp:
      now_()

  };
}


/************************************************************
 * LIST MEETINGS
 ************************************************************/

function listMeetings_(params) {

  const sheet =
    getRegistrySheet_();


  ensureHeaders_(
    sheet
  );


  const lastRow =
    sheet.getLastRow();


  if (
    lastRow < 2
  ) {

    return {

      success: true,

      total: 0,

      meetings: [],

      timestamp:
        now_()

    };
  }


  const values =
    sheet
      .getRange(
        2,
        1,
        lastRow - 1,
        HEADERS.length
      )
      .getValues();


  const search =
    String(
      params.search || ''
    )
    .trim()
    .toLowerCase();


  const mode =
    String(
      params.mode || ''
    )
    .trim()
    .toLowerCase();


  const status =
    String(
      params.status || ''
    )
    .trim()
    .toLowerCase();


  const initiator =
    String(
      params.initiator || ''
    )
    .trim()
    .toLowerCase();


  let meetings =
    values
      .map(
        function(row, index) {

          return rowToMeetingObject_(
            row,
            index + 2
          );

        }
      )
      .filter(
        function(meeting) {

          if (
            !meeting.meeting_id
          ) {

            return false;
          }


          if (
            search &&
            !(
              String(
                meeting.meeting_id
              )
              .toLowerCase()
              .includes(
                search              )

              ||

              String(
                meeting.meeting_title
              )
              .toLowerCase()
              .includes(
                search
              )

              ||

              String(
                meeting.agenda
              )
              .toLowerCase()
              .includes(
                search
              )

              ||

              String(
                meeting.meeting_initiator
              )
              .toLowerCase()
              .includes(
                search
              )
            )
          ) {

            return false;
          }


          if (
            mode &&
            String(
              meeting.meeting_mode
            )
            .toLowerCase() !==
            mode
          ) {

            return false;
          }


          if (
            status &&
            String(
              meeting.status
            )
            .toLowerCase() !==
            status
          ) {

            return false;
          }


          if (
            initiator &&
            !String(
              meeting.meeting_initiator
            )
            .toLowerCase()
            .includes(
              initiator
            )
          ) {

            return false;
          }


          return true;

        }
      );


  /*
   * Newest first.
   */
  meetings.sort(
    function(a, b) {

      return String(
        b.created_at || ''
      )
      .localeCompare(
        String(
          a.created_at || ''
        )
      );

    }
  );


  const requestedLimit =
    Number(
      params.limit || 100
    );


  const limit =
    Math.min(
      Math.max(
        requestedLimit,
        1
      ),
      500
    );


  meetings =
    meetings.slice(
      0,
      limit
    );


  return {

    success: true,

    total:
      meetings.length,

    meetings:
      meetings,

    timestamp:
      now_()

  };
}


/************************************************************
 * GET SINGLE MEETING
 ************************************************************/

function getMeeting_(
  meetingId
) {

  meetingId =
    clean_(
      meetingId
    );


  if (!meetingId) {

    return {

      success: false,

      error:
        'MEETING_ID_REQUIRED'

    };
  }


  const sheet =
    getRegistrySheet_();


  const rowNumber =
    findMeetingRow_(
      meetingId
    );


  if (
    rowNumber < 2
  ) {

    return {

      success: false,

      error:
        'MEETING_NOT_FOUND',

      meeting_id:
        meetingId

    };
  }


  const row =
    sheet
      .getRange(
        rowNumber,
        1,
        1,
        HEADERS.length
      )
      .getValues()[0];


  return {

    success: true,

    meeting:
      rowToMeetingObject_(
        row,
        rowNumber
      ),

    timestamp:
      now_()

  };
}


/************************************************************
 * GITHUB DISPATCH
 ************************************************************/

function dispatchToGitHub_(
  payload
) {

  const token =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        CONFIG.GITHUB_TOKEN_PROPERTY
      );


  if (!token) {

    return {

      success: false,

      status: 0,

      error:
        'GITHUB_TOKEN_MISSING',

      message:
        'GITHUB_TOKEN is not configured in Script Properties.'

    };
  }


  const body = {

    event_type:
      CONFIG.GITHUB_EVENT_TYPE,

    client_payload: {

      meeting_id:
        payload.meeting_id,

      audio_folder_id:
        payload.audio_folder_id,

      meeting_folder_id:
        payload.meeting_folder_id,

      audio_file_id:
        payload.audio_file_id,

      processing_mode:
        clean_(payload.processing_mode) || 'fresh'

    }

  };


  const options = {

    method:
      'post',

    contentType:
      'application/json',

    headers: {

      Authorization:
        'Bearer ' + token,

      Accept:
        'application/vnd.github+json',

      'X-GitHub-Api-Version':
        '2022-11-28'

    },

    payload:
      JSON.stringify(
        body
      ),

    muteHttpExceptions:
      true

  };


  const response =
    UrlFetchApp.fetch(
      CONFIG.GITHUB_DISPATCH_URL,
      options
    );


  const code =
    response.getResponseCode();


  const text =
    response.getContentText();


  if (
    code >= 200 &&
    code < 300
  ) {

    return {

      success: true,

      status:
        code,

      message:
        'GitHub processing dispatched',

      response:
        text

    };
  }


  return {

    success: false,

    status:
      code,

    error:
      'GITHUB_DISPATCH_FAILED',

    message:
      text ||
      'GitHub dispatch failed'

  };
}


/************************************************************
 * UPDATE REPORT FIELDS
 ************************************************************/

function updateReportFields_(
  sheet,
  rowNumber,
  data
) {

  const mapping = {

    report_folder_url:
      'Report Folder URL',

    transcript_url:
      'Transcript URL',

    translation_url:
      'Translation URL',

    summary_url:
      'Summary URL',

    mom_url:
      'MoM URL',

    evidence_url:
      'Evidence URL'

  };


  Object.keys(
    mapping
  )
  .forEach(
    function(key) {

      if (
        data[key] !==
        undefined
      ) {

        setCellByHeader_(
          sheet,
          rowNumber,
          mapping[key],
          clean_(
            data[key]
          )
        );
      }

    }
  );
}


/************************************************************
 * SPREADSHEET ACCESS
 ************************************************************/

function getRegistrySpreadsheet_() {

  if (
    !CONFIG.REGISTRY_SPREADSHEET_ID
  ) {

    throw new Error(
      'REGISTRY_SPREADSHEET_ID is missing'
    );
  }


  return SpreadsheetApp
    .openById(
      CONFIG.REGISTRY_SPREADSHEET_ID
    );
}


/************************************************************
 * SHEET ACCESS
 ************************************************************/

function getRegistrySheet_() {

  const spreadsheet =
    getRegistrySpreadsheet_();


  let sheet =
    spreadsheet.getSheetByName(
      CONFIG.REGISTRY_SHEET_NAME
    );


  /*
   * Safety fallback:
   * if Sheet1 somehow does not exist,
   * use first worksheet.
   */
  if (!sheet) {

    const sheets =
      spreadsheet.getSheets();


    if (
      sheets.length > 0
    ) {

      sheet =
        sheets[0];

    } else {

      sheet =
        spreadsheet.insertSheet(
          CONFIG.REGISTRY_SHEET_NAME
        );
    }
  }


  return sheet;
}


/************************************************************
 * ENSURE HEADERS
 ************************************************************/

function ensureHeaders_(
  sheet
) {

  const required =
    HEADERS.length;


  /*
   * Ensure A:AF exist.
   */
  if (
    sheet.getMaxColumns() <
    required
  ) {

    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      required -
      sheet.getMaxColumns()
    );
  }


  const current =
    sheet
      .getRange(
        1,
        1,
        1,
        required
      )
      .getValues()[0];


  let different =
    false;


  for (
    let i = 0;
    i < required;
    i++
  ) {

    if (
      current[i] !==
      HEADERS[i]
    ) {

      different =
        true;

      break;
    }
  }


  if (different) {

    sheet
      .getRange(
        1,
        1,
        1,
        required
      )
      .setValues([
        HEADERS
      ]);
  }


  return HEADERS;
}


/************************************************************
 * FORMAT REGISTRY SHEET
 ************************************************************/

function formatRegistrySheet_(
  sheet
) {

  const headerRange =
    sheet.getRange(
      1,
      1,
      1,
      HEADERS.length
    );


  headerRange
    .setFontWeight(
      'bold'
    )
    .setWrap(
      true
    )
    .setVerticalAlignment(
      'middle'
    );


  sheet.setFrozenRows(
    1
  );


  const widths = [

    180,
    220,
    160,
    100,
    150,
    110,
    100,
    100,
    100,
    180,
    280,
    280,
    120,
    170,
    170,
    130,
    240,
    240,
    240,
    280,
    280,
    280,
    280,
    280,
    280,
    80,
    280,
    170,
    150,
    320,
    170,
    170

  ];


  widths.forEach(
    function(width, index) {

      sheet.setColumnWidth(
        index + 1,
        width
      );

    }
  );


  const lastRow =
    Math.max(
      sheet.getLastRow(),
      2
    );


  if (
    lastRow >= 2
  ) {

    /*
     * F = Meeting Date
     */
    sheet
      .getRange(
        2,
        6,
        lastRow - 1,
        1
      )
      .setNumberFormat(
        'dd mmm yyyy'
      );


    /*
     * N:O
     */
    sheet
      .getRange(
        2,
        14,
        lastRow - 1,
        2
      )
      .setNumberFormat(
        'dd mmm yyyy hh:mm:ss'
      );


    /*
     * AB = Rated At
     */
    sheet
      .getRange(
        2,
        28,
        lastRow - 1,
        1
      )
      .setNumberFormat(
        'dd mmm yyyy hh:mm:ss'
      );


    /*
     * AE:AF
     */
    sheet
      .getRange(
        2,
        31,
        lastRow - 1,
        2
      )
      .setNumberFormat(
        'dd mmm yyyy hh:mm:ss'
      );
  }
}


/************************************************************
 * FIND MEETING ROW
 ************************************************************/

function findMeetingRow_(
  meetingId
) {

  const sheet =
    getRegistrySheet_();


  const lastRow =
    sheet.getLastRow();


  if (
    lastRow < 2
  ) {

    return -1;
  }


  const values =
    sheet
      .getRange(
        2,
        1,
        lastRow - 1,
        1
      )
      .getValues();


  const target =
    String(
      meetingId
    ).trim();


  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    if (
      String(
        values[i][0]
      ).trim() ===
      target
    ) {

      return i + 2;
    }
  }


  return -1;
}


/************************************************************
 * GET ROW OBJECT
 ************************************************************/

function getRowObject_(
  sheet,
  rowNumber
) {

  const row =
    sheet
      .getRange(
        rowNumber,
        1,
        1,
        HEADERS.length
      )
      .getValues()[0];


  const object = {};


  HEADERS.forEach(
    function(header, index) {

      object[header] =
        row[index];

    }
  );


  return object;
}


/************************************************************
 * ROW → API OBJECT
 ************************************************************/

function rowToMeetingObject_(
  row,
  rowNumber
) {

  return {

    row:
      rowNumber,

    meeting_id:
      valueToString_(
        row[0]
      ),

    meeting_title:
      valueToString_(
        row[1]
      ),

    meeting_initiator:
      valueToString_(
        row[2]
      ),

    meeting_mode:
      valueToString_(
        row[3]
      ),

    processing_engine:
      valueToString_(
        row[4]
      ),

    meeting_date:
      formatApiDate_(
        row[5]
      ),

    start_time:
      valueToString_(
        row[6]
      ),

    end_time:
      valueToString_(
        row[7]
      ),

    audio_minutes:
      Number(
        row[8]
      ) || 0,

    venue:
      valueToString_(
        row[9]
      ),

    agenda:
      valueToString_(
        row[10]
      ),

    participants:
      valueToString_(
        row[11]
      ),

    status:
      valueToString_(
        row[12]
      ),

    processing_start:
      formatApiDateTime_(
        row[13]
      ),

    processing_end:
      formatApiDateTime_(
        row[14]
      ),

    processing_time:
      valueToString_(
        row[15]
      ),

    audio_file_id:
      valueToString_(
        row[16]
      ),

    meeting_folder_id:
      valueToString_(
        row[17]
      ),

    audio_folder_id:
      valueToString_(
        row[18]
      ),

    report_folder_url:
      valueToString_(
        row[19]
      ),

    transcript_url:
      valueToString_(
        row[20]
      ),

    translation_url:
      valueToString_(
        row[21]
      ),

    summary_url:
      valueToString_(
        row[22]
      ),

    mom_url:
      valueToString_(
        row[23]
      ),

    evidence_url:
      valueToString_(
        row[24]
      ),

    rating:
      Number(
        row[25]
      ) || 0,

    rating_comment:
      valueToString_(
        row[26]
      ),

    rated_at:
      formatApiDateTime_(
        row[27]
      ),

    error_code:
      valueToString_(
        row[28]
      ),

    error_message:      valueToString_(
        row[29]
      ),

    created_at:
      formatApiDateTime_(
        row[30]
      ),

    updated_at:
      formatApiDateTime_(
        row[31]
      )

  };
}


/************************************************************
 * SET CELL BY HEADER
 ************************************************************/

function setCellByHeader_(
  sheet,
  rowNumber,
  header,
  value
) {

  const index =
    HEADERS.indexOf(
      header
    );


  if (
    index < 0
  ) {

    throw new Error(
      'Unknown header: ' +
      header
    );
  }


  sheet
    .getRange(
      rowNumber,
      index + 1
    )
    .setValue(
      value
    );
}


/************************************************************
 * PROCESSING TIME
 ************************************************************/

function calculateAndSetProcessingTime_(
  sheet,
  rowNumber
) {

  const start =
    sheet
      .getRange(
        rowNumber,
        14
      )
      .getValue();


  const end =
    sheet
      .getRange(
        rowNumber,
        15
      )
      .getValue();


  if (
    !(start instanceof Date) ||
    !(end instanceof Date)
  ) {

    return;
  }


  const seconds =
    Math.max(
      0,
      Math.round(
        (
          end.getTime() -
          start.getTime()
        ) /
        1000
      )
    );


  setCellByHeader_(
    sheet,
    rowNumber,
    'Processing Time',
    formatDuration_(
      seconds
    )
  );
}


/************************************************************
 * DRIVE ROOT
 ************************************************************/

function getOrCreateRootFolder_() {

  const properties =
    PropertiesService
      .getScriptProperties();


  const existingId =
    properties.getProperty(
      CONFIG.ROOT_FOLDER_PROPERTY
    );


  if (existingId) {

    try {

      return DriveApp
        .getFolderById(
          existingId
        );

    } catch (err) {

      /*
       * Recreate if deleted.
       */
    }
  }


  const folder =
    DriveApp.createFolder(
      'Meeting MoM Online'
    );


  properties.setProperty(
    CONFIG.ROOT_FOLDER_PROPERTY,
    folder.getId()
  );


  return folder;
}


/************************************************************
 * MEETING ID
 ************************************************************/

function generateMeetingId_() {

  const timestamp =
    Utilities.formatDate(
      new Date(),
      CONFIG.TIMEZONE,
      'yyyyMMdd-HHmmss'
    );


  const random =
    Utilities
      .getUuid()
      .substring(
        0,
        8
      )
      .toUpperCase();


  return (
    'MOM-' +
    timestamp +
    '-' +
    random
  );
}


/************************************************************
 * REQUEST BODY
 ************************************************************/

function parseRequestBody_(
  e
) {

  if (!e) {

    return {};
  }


  if (
    e.postData &&
    e.postData.contents
  ) {

    const contents =
      e.postData.contents;


    try {

      return JSON.parse(
        contents
      );

    } catch (err) {

      /*
       * Support normal form POST.
       */
      if (
        e.parameter
      ) {

        return e.parameter;
      }


      throw new Error(
        'Invalid JSON request body'
      );
    }
  }


  return e.parameter || {};
}


/************************************************************
 * JSON RESPONSE
 ************************************************************/

function jsonResponse_(
  object
) {

  return ContentService
    .createTextOutput(
      JSON.stringify(
        object
      )
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}


/************************************************************
 * DATE/TIME
 ************************************************************/

function now_() {

  return Utilities.formatDate(
    new Date(),
    CONFIG.TIMEZONE,
    "yyyy-MM-dd'T'HH:mm:ss"
  );
}


function formatDate_(
  date
) {

  return Utilities.formatDate(
    date,
    CONFIG.TIMEZONE,
    'yyyy-MM-dd'
  );
}


function formatTime_(
  date
) {

  return Utilities.formatDate(
    date,
    CONFIG.TIMEZONE,
    'HH:mm:ss'
  );
}


function formatDateTime_(
  date
) {

  if (
    !(date instanceof Date)
  ) {

    return '';
  }


  return Utilities.formatDate(
    date,
    CONFIG.TIMEZONE,
    'dd MMM yyyy HH:mm:ss'
  );
}


function formatApiDate_(
  value
) {

  if (
    value instanceof Date
  ) {

    return Utilities.formatDate(
      value,
      CONFIG.TIMEZONE,
      'yyyy-MM-dd'
    );
  }


  return value
    ? String(value)
    : '';
}


function formatApiDateTime_(
  value
) {

  if (
    value instanceof Date
  ) {

    return Utilities.formatDate(
      value,
      CONFIG.TIMEZONE,
      "yyyy-MM-dd'T'HH:mm:ss"
    );
  }


  return value
    ? String(value)
    : '';
}


function parseDateValue_(
  value
) {

  if (!value) {

    return '';
  }


  if (
    value instanceof Date
  ) {

    return value;
  }


  const date =
    new Date(
      value
    );


  if (
    isNaN(
      date.getTime()
    )
  ) {

    return value;
  }


  return date;
}


/************************************************************
 * GENERIC HELPERS
 ************************************************************/

function clean_(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return '';
  }


  return String(
    value
  ).trim();
}


function valueToString_(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return '';
  }


  if (
    value instanceof Date
  ) {

    return formatApiDateTime_(
      value
    );
  }


  return String(
    value
  );
}


function toNumber_(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {

    return 0;
  }


  const number =
    Number(
      value
    );


  return isFinite(
    number
  )
    ? number
    : 0;
}


function round_(
  value,
  decimals
) {

  const multiplier =
    Math.pow(
      10,
      decimals
    );


  return (
    Math.round(
      value *
      multiplier
    ) /
    multiplier
  );
}


function formatDuration_(
  seconds
) {

  seconds =
    Math.max(
      0,
      Math.round(
        Number(
          seconds
        ) || 0
      )
    );


  const hours =
    Math.floor(
      seconds / 3600
    );


  const minutes =
    Math.floor(
      (
        seconds % 3600
      ) / 60
    );


  const secs =
    seconds % 60;


  if (
    hours > 0
  ) {

    return (
      hours +
      'h ' +
      minutes +
      'm ' +
      secs +
      's'
    );
  }


  if (
    minutes > 0
  ) {

    return (
      minutes +
      'm ' +
      secs +
      's'
    );
  }


  return (
    secs +
    's'
  );
}



/************************************************************
 * MANUAL TESTS / PRODUCTION DIAGNOSTICS
 *
 * TEST_01 through TEST_05 are NON-DESTRUCTIVE.
 *
 * TEST_06_REAL_DISPATCH sends a REAL repository_dispatch
 * and therefore starts a REAL GitHub Actions processing run.
 *
 * TEST_07 and TEST_08 inspect GitHub after dispatch.
 ************************************************************/


/************************************************************
 * DEBUG LOGGER
 ************************************************************/

function DEBUG_log_(label, data) {

  Logger.log(
    '\n==============================\n' +
    label +
    '\n==============================\n' +
    JSON.stringify(
      data,
      null,
      2
    )
  );

  return data;
}


/************************************************************
 * TEST 01
 *
 * Apps Script gateway configuration.
 *
 * NON-DESTRUCTIVE
 ************************************************************/

function TEST_01_gatewayConfig() {

  const props =
    PropertiesService
      .getScriptProperties();

  const token =
    props.getProperty(
      CONFIG.GITHUB_TOKEN_PROPERTY
    );

  const result = {

    success:
      true,

    repository:
      CONFIG.GITHUB_REPO,

    dispatch_url:
      CONFIG.GITHUB_DISPATCH_URL,

    event_type:
      CONFIG.GITHUB_EVENT_TYPE,

    spreadsheet_id:
      CONFIG.REGISTRY_SPREADSHEET_ID,

    sheet_name:
      CONFIG.REGISTRY_SHEET_NAME,

    timezone:
      CONFIG.TIMEZONE,

    github_token_configured:
      !!token,

    github_token_length:
      token
        ? token.length
        : 0,

    timestamp:
      now_()

  };

  return DEBUG_log_(
    'TEST 01 - GATEWAY CONFIG',
    result
  );
}


/************************************************************
 * TEST 02
 *
 * Spreadsheet + Sheet + 32 registry headers.
 *
 * NON-DESTRUCTIVE
 ************************************************************/

function TEST_02_registry() {

  const spreadsheet =
    getRegistrySpreadsheet_();

  const sheet =
    getRegistrySheet_();

  ensureHeaders_(
    sheet
  );

  const actualHeaders =
    sheet
      .getRange(
        1,
        1,
        1,
        HEADERS.length
      )
      .getValues()[0];

  const result = {

    success:
      true,

    spreadsheet_id:
      spreadsheet.getId(),

    spreadsheet_name:
      spreadsheet.getName(),

    sheet_name:
      sheet.getName(),

    last_row:
      sheet.getLastRow(),

    last_column:
      sheet.getLastColumn(),

    expected_header_count:
      HEADERS.length,

    actual_header_count:
      actualHeaders.length,

    headers_match:
      JSON.stringify(
        actualHeaders
      ) ===
      JSON.stringify(
        HEADERS
      ),

    headers:
      actualHeaders,

    timestamp:
      now_()

  };

  return DEBUG_log_(
    'TEST 02 - REGISTRY',
    result
  );
}


/************************************************************
 * TEST 03
 *
 * Validate the newest Meeting Register row and
 * the three Drive containers + audio file.
 *
 * NON-DESTRUCTIVE
 ************************************************************/

function TEST_03_latestMeetingAndDrive() {

  const sheet =
    getRegistrySheet_();

  const lastRow =
    sheet.getLastRow();

  if (lastRow < 2) {

    return DEBUG_log_(
      'TEST 03 - NO MEETING',
      {
        success:
          false,

        message:
          'Meeting Register contains no meeting rows.'
      }
    );
  }

  const rowNumber =
    lastRow;

  const row =
    getRowObject_(
      sheet,
      rowNumber
    );

  const meetingId =
    clean_(
      row['Meeting ID']
    );

  const audioFileId =
    clean_(
      row['Audio File ID']
    );

  const audioFolderId =
    clean_(
      row['Audio Folder ID']
    );

  const meetingFolderId =
    clean_(
      row['Meeting Folder ID']
    );

  const result = {

    success:
      true,

    row:
      rowNumber,

    meeting_id:
      meetingId,

    meeting_title:
      clean_(
        row['Meeting Title']
      ),

    status:
      clean_(
        row['Status']
      ),

    audio_file_id:
      audioFileId,

    audio_folder_id:
      audioFolderId,

    meeting_folder_id:
      meetingFolderId,

    audio_file_exists:
      false,

    audio_folder_exists:
      false,

    meeting_folder_exists:
      false,

    audio_file_name:
      '',

    audio_folder_name:
      '',

    meeting_folder_name:
      ''

  };


  if (audioFileId) {

    try {

      const file =
        DriveApp.getFileById(
          audioFileId
        );

      result.audio_file_exists =
        true;

      result.audio_file_name =
        file.getName();

      result.audio_file_size =
        file.getSize();

      result.audio_file_mime =
        file.getMimeType();

    } catch (err) {

      result.audio_file_error =
        err.message;

    }

  }


  if (audioFolderId) {

    try {

      const folder =
        DriveApp.getFolderById(
          audioFolderId
        );

      result.audio_folder_exists =
        true;

      result.audio_folder_name =
        folder.getName();

    } catch (err) {

      result.audio_folder_error =
        err.message;

    }

  }


  if (meetingFolderId) {

    try {

      const folder =
        DriveApp.getFolderById(
          meetingFolderId
        );

      result.meeting_folder_exists =
        true;

      result.meeting_folder_name =
        folder.getName();

    } catch (err) {

      result.meeting_folder_error =
        err.message;

    }

  }


  result.ids_complete =
    !!(
      meetingId &&
      audioFileId &&
      audioFolderId &&
      meetingFolderId
    );

  result.drive_validation =
    (
      result.audio_file_exists &&
      result.audio_folder_exists &&
      result.meeting_folder_exists
    );

  result.ready_for_processing =
    (
      result.ids_complete &&
      result.drive_validation
    );

  result.timestamp =
    now_();


  return DEBUG_log_(
    'TEST 03 - LATEST MEETING + DRIVE',
    result
  );
}


/************************************************************
 * TEST 04
 *
 * Validate exactly what startProcessing_ needs.
 *
 * NON-DESTRUCTIVE
 ************************************************************/

function TEST_04_startProcessingPrerequisites() {

  const sheet =
    getRegistrySheet_();

  const lastRow =
    sheet.getLastRow();

  if (lastRow < 2) {

    return DEBUG_log_(
      'TEST 04 - NO MEETING',
      {
        success:
          false,

        ready_for_startProcessing:
          false,

        message:
          'No meeting exists in the registry.'
      }
    );
  }

  const row =
    getRowObject_(
      sheet,
      lastRow
    );

  const checks = {

    meeting_id:
      !!clean_(
        row['Meeting ID']
      ),

    meeting_title:
      !!clean_(
        row['Meeting Title']
      ),

    meeting_initiator:
      !!clean_(
        row['Meeting Initiator']
      ),

    audio_file_id:
      !!clean_(
        row['Audio File ID']
      ),

    audio_folder_id:
      !!clean_(
        row['Audio Folder ID']
      ),

    meeting_folder_id:
      !!clean_(
        row['Meeting Folder ID']
      )

  };

  const ready =
    Object.keys(
      checks
    )
    .every(
      function(key) {

        return (
          checks[key] ===
          true
        );

      }
    );

  const result = {

    success:
      ready,

    ready_for_startProcessing:
      ready,

    row:
      lastRow,

    meeting_id:
      clean_(
        row['Meeting ID']
      ),

    audio_file_id:
      clean_(
        row['Audio File ID']
      ),

    audio_folder_id:
      clean_(
        row['Audio Folder ID']
      ),

    meeting_folder_id:
      clean_(
        row['Meeting Folder ID']
      ),

    checks:
      checks,

    timestamp:
      now_()

  };

  return DEBUG_log_(
    'TEST 04 - START PROCESSING PREREQUISITES',
    result
  );
}


/************************************************************
 * TEST 05
 *
 * GitHub API authentication + repository access.
 *
 * NON-DESTRUCTIVE
 ************************************************************/

function TEST_05_githubConnection() {

  const token =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        CONFIG.GITHUB_TOKEN_PROPERTY
      );

  if (!token) {

    return DEBUG_log_(
      'TEST 05 - GITHUB CONNECTION',
      {
        success:
          false,

        error:
          'GITHUB_TOKEN_MISSING',

        message:
          'GITHUB_TOKEN is not configured in Script Properties.'
      }
    );
  }

  const url =
    'https://api.github.com/repos/' +
    CONFIG.GITHUB_REPO;

  const response =
    UrlFetchApp.fetch(
      url,
      {

        method:
          'get',

        headers: {

          Authorization:
            'Bearer ' +
            token,

          Accept:
            'application/vnd.github+json',

          'X-GitHub-Api-Version':
            '2022-11-28'

        },

        muteHttpExceptions:
          true

      }
    );

  const code =
    response.getResponseCode();

  const responseText =
    response.getContentText();

  let data = {};

  try {

    data =
      JSON.parse(
        responseText
      );

  } catch (err) {

    data = {

      raw:
        responseText

    };

  }

  const result = {

    success:
      code >= 200 &&
      code < 300,

    http_status:
      code,

    repository:
      CONFIG.GITHUB_REPO,

    repository_name:
      data.name ||
      '',

    repository_private:
      data.private,

    message:
      (
        code >= 200 &&
        code < 300
      )
        ? 'GitHub API reachable and repository accessible.'
        : responseText,

    timestamp:
      now_()

  };

  return DEBUG_log_(
    'TEST 05 - GITHUB CONNECTION',
    result
  );
}


/************************************************************
 * TEST 06
 *
 * REAL PRODUCTION DISPATCH.
 *
 * WARNING:
 * THIS STARTS A REAL GITHUB ACTIONS RUN.
 *
 * This uses the newest registry meeting and therefore
 * exercises dispatchToGitHub_() with the real four IDs.
 ************************************************************/

function TEST_06_REAL_DISPATCH() {

  const sheet =
    getRegistrySheet_();

  const lastRow =
    sheet.getLastRow();

  if (lastRow < 2) {

    throw new Error(
      'No meeting exists in Meeting Register.'
    );
  }

  const row =
    getRowObject_(
      sheet,
      lastRow
    );

  const payload = {

    meeting_id:
      clean_(
        row['Meeting ID']
      ),

    audio_folder_id:
      clean_(
        row['Audio Folder ID']
      ),

    meeting_folder_id:
      clean_(
        row['Meeting Folder ID']
      ),

    audio_file_id:
      clean_(
        row['Audio File ID']
      )

  };

  if (
    !payload.meeting_id ||
    !payload.audio_file_id ||
    !payload.audio_folder_id ||
    !payload.meeting_folder_id
  ) {

    throw new Error(
      'Latest meeting does not contain all four production IDs.'
    );
  }

  const result =
    dispatchToGitHub_(
      payload
    );

  return DEBUG_log_(
    'TEST 06 - REAL GITHUB DISPATCH',
    {

      success:
        result.success,

      dispatch_result:
        result,

      payload:
        payload,

      timestamp:
        now_()

    }
  );
}


/************************************************************
 * TEST 07
 *
 * Find the newest repository_dispatch workflow run.
 *
 * NON-DESTRUCTIVE
 ************************************************************/

function TEST_07_findLatestGitHubRun() {

  const token =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        CONFIG.GITHUB_TOKEN_PROPERTY
      );

  if (!token) {

    throw new Error(
      'GITHUB_TOKEN is missing.'
    );
  }

  const url =
    'https://api.github.com/repos/' +
    CONFIG.GITHUB_REPO +
    '/actions/workflows/meeting-mom.yml/runs' +
    '?event=repository_dispatch' +
    '&per_page=10';

  const response =
    UrlFetchApp.fetch(
      url,
      {

        method:
          'get',

        headers: {

          Authorization:
            'Bearer ' +
            token,

          Accept:
            'application/vnd.github+json',

          'X-GitHub-Api-Version':
            '2022-11-28'

        },

        muteHttpExceptions:
          true

      }
    );

  const code =
    response.getResponseCode();

  const responseText =
    response.getContentText();

  let data = {};

  try {

    data =
      JSON.parse(
        responseText
      );

  } catch (err) {

    data = {

      raw:
        responseText

    };

  }

  if (
    code < 200 ||
    code >= 300
  ) {

    return DEBUG_log_(
      'TEST 07 - GITHUB RUN QUERY FAILED',
      {

        success:
          false,

        http_status:
          code,

        response:
          responseText,

        timestamp:
          now_()

      }
    );
  }

  const runs =
    data.workflow_runs ||
    [];

  const latest =
    runs.length
      ? runs[0]
      : null;

  const result = {

    success:
      !!latest,

    run_detected:
      !!latest,

    total_runs:
      runs.length,

    latest_run:
      latest
        ? {

            id:
              latest.id,

            run_number:
              latest.run_number,

            status:
              latest.status,

            conclusion:
              latest.conclusion,

            event:
              latest.event,

            branch:
              latest.head_branch,

            created_at:
              latest.created_at,

            updated_at:
              latest.updated_at,

            html_url:
              latest.html_url

          }
        : null,

    timestamp:
      now_()

  };

  return DEBUG_log_(
    'TEST 07 - LATEST GITHUB RUN',
    result
  );
}


/************************************************************
 * TEST 08
 *
 * Inspect the newest run's jobs.
 *
 * This identifies:
 *   prepare
 *   matrix / parallel workers
 *   finalize
 *
 * NON-DESTRUCTIVE
 ************************************************************/

function TEST_08_githubJobs() {

  const token =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        CONFIG.GITHUB_TOKEN_PROPERTY
      );

  if (!token) {

    throw new Error(
      'GITHUB_TOKEN is missing.'
    );
  }

  const runsUrl =
    'https://api.github.com/repos/' +
    CONFIG.GITHUB_REPO +
    '/actions/workflows/meeting-mom.yml/runs' +
    '?event=repository_dispatch' +
    '&per_page=1';

  const runsResponse =
    UrlFetchApp.fetch(
      runsUrl,
      {

        method:
          'get',

        headers: {

          Authorization:
            'Bearer ' +
            token,

          Accept:
            'application/vnd.github+json',

          'X-GitHub-Api-Version':
            '2022-11-28'

        },

        muteHttpExceptions:
          true

      }
    );

  const runsCode =
    runsResponse.getResponseCode();

  if (
    runsCode < 200 ||
    runsCode >= 300
  ) {

    return DEBUG_log_(
      'TEST 08 - RUN QUERY FAILED',
      {

        success:
          false,

        http_status:
          runsCode,

        response:
          runsResponse.getContentText(),

        timestamp:
          now_()

      }
    );
  }

  const runsData =
    JSON.parse(
      runsResponse.getContentText()
    );

  const latest =
    (
      runsData.workflow_runs &&
      runsData.workflow_runs.length
    )
      ? runsData.workflow_runs[0]
      : null;

  if (!latest) {

    return DEBUG_log_(
      'TEST 08 - NO RUN',
      {

        success:
          false,

        message:
          'No repository_dispatch workflow run found yet.',

        timestamp:
          now_()

      }
    );
  }

  const jobsUrl =
    'https://api.github.com/repos/' +
    CONFIG.GITHUB_REPO +
    '/actions/runs/' +
    latest.id +
    '/jobs?per_page=100';

  const jobsResponse =
    UrlFetchApp.fetch(
      jobsUrl,
      {

        method:
          'get',

        headers: {

          Authorization:
            'Bearer ' +
            token,

          Accept:
            'application/vnd.github+json',

          'X-GitHub-Api-Version':
            '2022-11-28'

        },

        muteHttpExceptions:
          true

      }
    );

  const jobsCode =
    jobsResponse.getResponseCode();

  const jobsText =
    jobsResponse.getContentText();

  if (
    jobsCode < 200 ||
    jobsCode >= 300
  ) {

    return DEBUG_log_(
      'TEST 08 - JOB QUERY FAILED',
      {

        success:
          false,

        run_id:
          latest.id,

        http_status:
          jobsCode,

        response:
          jobsText,

        timestamp:
          now_()

      }
    );
  }

  const jobsData =
    JSON.parse(
      jobsText
    );

  const jobs =
    jobsData.jobs ||
    [];

  const simplified =
    jobs.map(
      function(job) {

        return {

          id:
            job.id,

          name:
            job.name,

          status:
            job.status,

          conclusion:
            job.conclusion,

          started_at:
            job.started_at,

          completed_at:
            job.completed_at

        };

      }
    );

  const names =
    simplified.map(
      function(job) {

        return String(
          job.name
        )
        .toLowerCase();

      }
    );

  const prepareDetected =
    names.some(
      function(name) {

        return name.includes(
          'prepare'
        );

      }
    );

  const parallelDetected =
    names.some(
      function(name) {

        return (
          name.includes('batch') ||
          name.includes('parallel') ||
          name.includes('worker')
        );

      }
    );

  const finalizeDetected =
    names.some(
      function(name) {

        return (
          name.includes('final')
        );

      }
    );

  const result = {

    success:
      true,

    run_id:
      latest.id,

    run_number:
      latest.run_number,

    run_status:
      latest.status,

    run_conclusion:
      latest.conclusion,

    job_count:
      simplified.length,

    prepare_detected:
      prepareDetected,

    parallel_detected:
      parallelDetected,

    finalize_detected:
      finalizeDetected,

    jobs:
      simplified,

    timestamp:
      now_()

  };

  return DEBUG_log_(
    'TEST 08 - GITHUB JOBS',
    result
  );
}


/************************************************************
 * TEST 09
 *
 * Single-screen production status.
 *
 * NON-DESTRUCTIVE
 ************************************************************/

function TEST_09_PRODUCTION_STATUS() {

  const result = {

    gateway:
      false,

    registry:
      false,

    meeting:
      false,

    audio:
      false,

    audio_folder:
      false,

    meeting_folder:
      false,

    github_token:
      false,

    github_run:
      false,

    prepare:
      false,

    parallel:
      false,

    finalize:
      false,

    ready_for_real_test:
      false,

    timestamp:
      now_()

  };


  /*
   * Gateway configuration.
   */

  result.gateway =
    !!(
      CONFIG.GITHUB_REPO &&
      CONFIG.GITHUB_DISPATCH_URL &&
      CONFIG.GITHUB_EVENT_TYPE &&
      CONFIG.REGISTRY_SPREADSHEET_ID
    );


  /*
   * Registry + latest meeting.
   */

  try {

    const sheet =
      getRegistrySheet_();

    result.registry =
      true;

    const lastRow =
      sheet.getLastRow();

    if (lastRow >= 2) {

      const row =
        getRowObject_(
          sheet,
          lastRow
        );

      result.meeting =
        !!clean_(
          row['Meeting ID']
        );

      result.audio =
        !!clean_(
          row['Audio File ID']
        );

      result.audio_folder =
        !!clean_(
          row['Audio Folder ID']
        );

      result.meeting_folder =
        !!clean_(
          row['Meeting Folder ID']
        );

    }

  } catch (err) {

    result.registry_error =
      err.message;

  }


  /*
   * Token.
   */

  const token =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        CONFIG.GITHUB_TOKEN_PROPERTY
      );

  result.github_token =
    !!token;


  /*
   * Latest GitHub run and jobs.
   */

  if (token) {

    try {

      const runsUrl =
        'https://api.github.com/repos/' +
        CONFIG.GITHUB_REPO +
        '/actions/workflows/meeting-mom.yml/runs' +
        '?event=repository_dispatch' +
        '&per_page=1';

      const runsResponse =
        UrlFetchApp.fetch(
          runsUrl,
          {

            method:
              'get',

            headers: {

              Authorization:
                'Bearer ' +
                token,

              Accept:
                'application/vnd.github+json',

              'X-GitHub-Api-Version':
                '2022-11-28'

            },

            muteHttpExceptions:
              true

          }
        );

      const runsCode =
        runsResponse.getResponseCode();

      if (
        runsCode >= 200 &&
        runsCode < 300
      ) {

        const runsData =
          JSON.parse(
            runsResponse.getContentText()
          );

        const latest =
          (
            runsData.workflow_runs &&
            runsData.workflow_runs.length
          )
            ? runsData.workflow_runs[0]
            : null;

        if (latest) {

          result.github_run =
            true;

          result.latest_run =
            {

              id:
                latest.id,

              run_number:
                latest.run_number,

              status:
                latest.status,

              conclusion:
                latest.conclusion,

              html_url:
                latest.html_url

            };


          const jobsUrl =
            'https://api.github.com/repos/' +
            CONFIG.GITHUB_REPO +
            '/actions/runs/' +
            latest.id +
            '/jobs?per_page=100';

          const jobsResponse =
            UrlFetchApp.fetch(
              jobsUrl,
              {

                method:
                  'get',

                headers: {

                  Authorization:
                    'Bearer ' +
                    token,

                  Accept:
                    'application/vnd.github+json',

                  'X-GitHub-Api-Version':
                    '2022-11-28'

                },

                muteHttpExceptions:
                  true

              }
            );

          if (
            jobsResponse.getResponseCode() >= 200 &&
            jobsResponse.getResponseCode() < 300
          ) {

            const jobsData =
              JSON.parse(
                jobsResponse.getContentText()
              );

            const jobs =
              jobsData.jobs ||
              [];

            jobs.forEach(
              function(job) {

                const name =
                  String(
                    job.name
                  )
                  .toLowerCase();

                if (
                  name.includes(
                    'prepare'
                  )
                ) {

                  result.prepare =
                    true;

                }

                if (
                  name.includes('batch') ||
                  name.includes('parallel') ||
                  name.includes('worker')
                ) {

                  result.parallel =
                    true;

                }

                if (
                  name.includes(
                    'final'
                  )
                ) {

                  result.finalize =
                    true;

                }

              }
            );

          }

        }

      }

    } catch (err) {

      result.github_error =
        err.message;

    }

  }


  result.ready_for_real_test =
    (
      result.gateway &&
      result.registry &&
      result.meeting &&
      result.audio &&
      result.audio_folder &&
      result.meeting_folder &&
      result.github_token
    );


  return DEBUG_log_(
    'TEST 09 - PRODUCTION STATUS',
    result
  );
}


/************************************************************
 * LEGACY SAFE TESTS
 ************************************************************/

function TEST_setup() {

  const result =
    setupMeetingSystem();

  return DEBUG_log_(
    'TEST_setup',
    result
  );
}


function TEST_dashboard() {

  const result =
    getDashboardStats_();

  return DEBUG_log_(
    'TEST_dashboard',
    result
  );
}


function TEST_listMeetings() {

  const result =
    listMeetings_({
      limit:
        100
    });

  return DEBUG_log_(
    'TEST_listMeetings',
    result
  );
}


/************************************************************
 * END OF Code.gs
 ************************************************************/
