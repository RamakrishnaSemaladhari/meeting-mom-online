# Google Drive Architecture

Root: MEETING MOM ONLINE

Folders:
- INBOX
- PROCESSING
- COMPLETED
- TRANSCRIPTS
- TRANSLATIONS
- MOM
- ARCHIVE

Per meeting folder:
- AUDIO
- TRANSCRIPT
- TRANSLATION
- AI
- MOM

Privacy boundary: meeting content is processed temporarily and is not committed to GitHub.

## Transcription safeguards (Whisper)

Audio -> **audio health check** (`MOM-020` if silent/too short) -> Silero VAD + Whisper primary
(`-nf`, `-mc 0`, entropy/log-prob thresholds) -> **transcript quality gate** -> stronger Whisper model
(`large-v3-turbo-q5_0`, cached best-effort) only if the gate fails -> `MOM-019` if every model fails.
Looping/garbled text is discarded and never reaches translation, the AI stage or the MoM.

- English recordings skip the second (`-tr`) Whisper pass; the transcript is the translation.
- A translation that fails its gate is dropped (with a warning in `PROCESSING_COMPLETE.json`);
  the AI continues on the original transcript, which already passed.
- The gate measures vocabulary variety per 200-word window, repeated phrases, runs of duplicate
  segments, invalid characters and how much of the recording the transcript covers.
- `MOM-019` and `MOM-020` extend the spec's error table (`MOM-016..018` stay reserved for the offline system).
- Whisper build, models and VAD are defined once in `.github/actions/whisper-runtime` and used by both jobs.
