# Onboarding flow — deferred to the end of Phase 1

Agreed 2026-08-09; build last, after the abilities view and G1 tooling.

## Order of screens

1. **Appearance first.** The very first step: choose light or dark mode. Both
   themes must exist in the UI before this ships.
2. **Profile.** Ask the user's name; this creates the user profile. The profile
   is editable later, and a **private mode** exists alongside it.
3. **Mode choice.** "Jarvis" (recommended, for beginners) vs "OpenClaw with
   Jarvis enhancements" (intermediate). Present advantages and disadvantages of
   each side by side; the recommendation must be visible on the card. The mode
   can be switched later from the UI.
4. **Risk disclaimer, before any permissions.** Plain statement: Jarvis is
   designed to be private and hardened, but letting an agent act on a system
   carries risk; grant access only to files that are backed up. Terms include
   that the developer is not responsible for loss of data.
5. **Feature-driven permissions.** A list of features; the user picks the
   features they want, which determines the permissions requested. For each
   permission, prompt for it and describe the exact macOS Settings path to
   grant it.
6. **Model selection.** First ask: assistant only, or an assistant that also
   improves itself. Assistant-only picks one model (the main engine);
   self-improving picks two (main engine + improvement model). For each, the
   app checks the machine and preselects a recommended model — "(recommended)"
   in the dropdown label, changeable. A memory-budget formula must reject
   combinations that would not fit the machine before download can start.
7. **Download page.** Per-model progress. The base model downloads first; once
   it completes, the user may continue into the app while the improvement
   model finishes in the background.
8. **Reveal.** An animation — "Hi! I'm Jarvis" in fancy script — transitions
   into the normal UI.
9. **In-app follow-through.** If the user entered while the improvement model
   was still downloading, the UI offers a progress window with start/stop and
   a change-model button that routes to the settings page. Settings lets the
   user change either model, with the same memory-budget blockers applied.
