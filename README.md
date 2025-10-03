# Form Buddy - Voice Form Helper (MVP)

A Chrome MV3 extension that helps seniors fill out forms with voice guidance, clarifying questions, and confirm-before-fill.

Install
1. Open Chrome > Extensions > Manage Extensions > enable Developer mode.
2. Click Load unpacked and select this folder.
3. Open Options to add your OpenAI API key (optional).
4. In the popup, enable the current site and click Start Helper.

Notes
- Uses Web Speech APIs for TTS/STT (Chrome recommended).
- Optional OpenAI calls for better explanations/clarifications.
- Simple PII redaction is included; harden for production.
