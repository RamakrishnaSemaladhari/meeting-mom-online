# Deploying the gateway (Apps Script) - the only way to do it

**Source of truth: `google-apps-script/Code.gs` on GitHub `main`.** Never paste a copy from the Apps Script editor
back into GitHub. `gateway/Code.gs` is an old file - never deploy it.

## 1. Update the Apps Script project

1. Open the Apps Script project that your web app URL points to.
2. Select **all** of `Code.gs` (Ctrl+A), delete it, paste the full contents of `google-apps-script/Code.gs`. **Save.**
   (Saving is not deploying.)
3. **Deploy -> Manage deployments -> pencil (Edit)** on the existing *Web app* deployment ->
   Version: **New version** -> **Deploy**. This keeps the same `/exec` URL.
   Execute as: **Me**. Who has access: the same as before.

## 2. Prove the new code is live

Open `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?action=health`. It must contain:

```
"version":"control-tower-2026-10-08"
```

`success:true / status:"OK"` alone proves nothing: older scripts answer health the same way.
If `version` is missing, the old code is still deployed - repeat step 1 (most often step 3 "New version" was skipped).

## 3. Script property

Project Settings -> Script properties -> `GITHUB_TOKEN`: fine-grained token for `meeting-mom-online` with
**Contents: Read and write** and **Actions: Read and write** (classic token: `repo`, `workflow`).

If it is wrong, the web page now says why within seconds (401 invalid/expired, 403 missing permission, 404 cannot see repo).

## 4. Test

Create a short meeting in the web app and start processing. Expected within ~1 minute: a GitHub run number appears
(Actions -> *Meeting MoM Online* -> new `meeting-ready` run). If the card shows a red message, it names the cause.
If nothing appears for 2 minutes, the card says the gateway did not confirm - go back to step 2.

## Why this exists

The script that was deployed contained two copies of `startProcessing_` (one nested in the other), so every
`start_processing` request threw `rowNumber is not defined`. The browser sends requests with `no-cors` and cannot read
replies, so it showed 5% forever and nothing reached GitHub. `google-apps-script/tests/` now runs the real script in a mocked
Google runtime in CI and fails on duplicate functions, wrong dispatch payloads and missing failure reporting.
