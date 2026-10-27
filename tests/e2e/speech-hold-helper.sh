#!/bin/bash
# The speech helper for the cancel-and-resume test (docs/design/offline-captions.md §10.3 item 5),
# set with SSW_SPEECH_HELPER (unpackaged only). A transcription of part-1.wav (the second part)
# says it is ready and working, then holds until the app cancels it (a "cancel" line or the end of
# stdin), and reports the cancel like the real helper. Every other call runs the real helper,
# found next to this script: the helper's environment is minimal, so no variable can carry it.
for arg in "$@"; do
  if [[ "$arg" == *part-1.wav ]]; then
    echo '{"type":"ready","model":"tiny","multilingual":true,"dtw":"TINY","build":"host","system":"hold"}'
    echo '{"type":"progress","percent":10,"at":0.5}'
    read -t 30 line
    echo '{"type":"cancelled","done_until":0}'
    exit 2
  fi
done
exec "$(dirname "$0")/../../native/bin/ssw-speech" "$@"
