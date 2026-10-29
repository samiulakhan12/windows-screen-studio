# Clean voice models

Two RNNoise models from rnnoise-models by Gregor Richards, run by ffmpeg's `arnndn` filter for
Clean voice (docs/design/clean-voice.md). They are bundled into the main process as text and
written to `userData/voice/` (each checked against the hash below before every use), because
ffmpeg cannot read files inside `app.asar`. Nothing is downloaded.

| File | Model | Used for | Bytes | SHA-256 |
|---|---|---|---|---|
| `sh.rnnn` | somnolent-hogwash (2018-09-01): speech in a recording environment (fans, AC, computers) | every strength | 297646 | 70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0 |
| `cb.rnnn` | conjoined-burgers (2018-08-28): any sound in a recording environment | Strong's second pass | 299741 | f1357c4e5be9dee8467bead486dfced2d75b640c26ad0b594fa7f102322371d9 |

- Source: https://github.com/GregorR/rnnoise-models at commit
  3eee541a283fd3b8f81b85b1748e3b9ccbefa04d (`somnolent-hogwash-2018-09-01/sh.rnnn`,
  `conjoined-burgers-2018-08-28/cb.rnnn`).
- Licence: the repository's README says: "With the exception of the tools/ directory and this
  file, none of this work is creative and thus none of it is subject to copyright." The models were
  trained on public-domain LibriVox readings, the TSP speech database, Xiph's RNNoise noise
  contributions and (cb) Freesound clips of coughs and laughter. The network and the filter that
  runs them are RNNoise (Xiph.Org Foundation, Jean-Marc Valin), BSD 3-Clause, inside FFmpeg; see
  resources/notices/33-rnnoise.txt.

`.gitattributes` keeps the files' line endings as they are (the hashes are of the exact bytes).
`tests/voiceCleanMain.test.ts` checks sizes and hashes against `VOICE_ENGINE` in
`src/shared/audio/voiceClean.ts`.
