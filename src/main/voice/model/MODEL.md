# Clean voice model

`sh.rnnn` is the RNNoise model **somnolent-hogwash** (2018-09-01) from rnnoise-models by Gregor
Richards, "speech in a reasonable recording environment: fans, AC, computers". ffmpeg's `arnndn`
filter runs it for Clean voice (docs/design/clean-voice.md). It is bundled into the main process as
text and written to `userData/voice/sh.rnnn` (checked against the hash below before every use),
because ffmpeg cannot read files inside `app.asar`. Nothing is downloaded.

- Source: https://github.com/GregorR/rnnoise-models/blob/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d/somnolent-hogwash-2018-09-01/sh.rnnn
- Bytes: 297646
- SHA-256: 70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0
- Licence: the repository's README says: "With the exception of the tools/ directory and this
  file, none of this work is creative and thus none of it is subject to copyright." It was trained
  on public-domain LibriVox readings, the TSP speech database and Xiph's RNNoise noise
  contributions. The network and the filter that runs it are RNNoise (Xiph.Org Foundation,
  Jean-Marc Valin), BSD 3-Clause, inside FFmpeg; see resources/notices/33-rnnoise.txt.

`.gitattributes` keeps the file's line endings as they are (the hash is of the exact bytes).
`tests/voiceCleanMain.test.ts` checks the size and hash against `VOICE_ENGINE` in
`src/shared/audio/voiceClean.ts`.
