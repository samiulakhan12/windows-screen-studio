/**
 * The model manager's IPC (SPEECH_CHANNELS, docs/design/offline-captions.md §5.1). Every handler
 * accepts the app's own page only (isAppUrl, as the AI handlers) and catalog ids only; 'speech:changed'
 * goes to the app's windows, at most 4 times a second. Workstream B registers the handlers here;
 * until then none is registered, so the renderer's calls reject and the Captions tab offers
 * only the AI providers, exactly as before.
 */
export function registerSpeechIpc(): void {}
