import { ipcRenderer } from "electron";
import {
  SOUND_LIBRARY_CHANNELS,
  type SoundLibraryApi,
} from "../shared/api/soundLibrary";
import { subscribe } from "./ipc";

/**
 * The music and sound-effects library (docs/design/editing-polish.md §10.3). Contracts step: the
 * channels are fixed here; main answers them once part P5's src/main/soundLibrary/ipc.ts registers
 * its handlers (until then a call rejects with "No handler registered").
 */
export const soundLibraryApi: SoundLibraryApi = {
  soundLibraryList: () => ipcRenderer.invoke(SOUND_LIBRARY_CHANNELS.list),
  soundLibraryDownload: (id) =>
    ipcRenderer.invoke(SOUND_LIBRARY_CHANNELS.download, id),
  soundLibraryCancel: (id) =>
    ipcRenderer.invoke(SOUND_LIBRARY_CHANNELS.cancel, id),
  soundLibraryRemove: () => ipcRenderer.invoke(SOUND_LIBRARY_CHANNELS.remove),
  soundLibraryUseBed: (projectId, id) =>
    ipcRenderer.invoke(SOUND_LIBRARY_CHANNELS.useBed, projectId, id),
  onSoundLibraryProgress: (listener) =>
    subscribe(SOUND_LIBRARY_CHANNELS.progress, listener),
};
