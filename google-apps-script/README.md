# Google Apps Script Control Tower

Replace the deployed Code.gs in the existing Meeting MoM Apps Script project with Code.gs from this folder.

## Script Properties

Set:
- GITHUB_TOKEN — a GitHub token stored only in Apps Script, never in the web UI. It needs permission to create repository dispatches and cancel/read workflow runs.
- GITHUB_OWNER — RamakrishnaSemaladhari
- GITHUB_REPO — meeting-mom-online
- GITHUB_API_VERSION — 2026-03-10

## Deployment

1. Open the existing Apps Script project that owns the Meeting MoM gateway URL.
2. Replace its Code.gs with this repository version.
3. Add the Script Properties above.
4. Deploy > Manage deployments > Edit the existing web-app deployment.
5. Execute as the account that owns/has access to the private meeting Drive workspace.
6. Set access to the same web-app access level currently used by the Meeting MoM page.
7. Keep the existing deployment URL unchanged.

The web UI sends start_processing, status, and cancel_processing actions to the gateway. The gateway writes CONTROL_STATUS.json into the meeting folder. The UI combines that control status with PROCESSING_STATUS.json, batch status files, and public GitHub Actions status.

Do not put the GitHub token in web/app.js.
