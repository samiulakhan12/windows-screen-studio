# Sound library

The music beds and sound effects of the library (docs/design/editing-polish.md §10), made by `scripts/build-sound-library.mjs` from the pinned upstream files below. Every file is CC0 1.0 (public domain): no credit is required, and this list is kept for provenance. The four beds and sixteen effects in this folder ship in the installer; the eight other beds download on request from the release the catalogue names (`SOUND_LIBRARY_RELEASE`), checked against the same pins.

Bundled: 2,776,628 bytes.

## Music beds

48 kHz stereo Ogg Opus 64 kb/s, −16 LUFS over one pass plus one loop, true peak at most −1.5 dBTP. One pass is loop end / 48000 s; the loop repeats from loop start to loop end; the last 12,000 samples are a pad that is never played.

| File | Title — artist (album) | Mood | Licence | Where | Loop start | Loop end | Bytes | SHA-256 |
|---|---|---|---|---|---|---|---|---|
| bed-calm-spring-on-the-horizon.ogg | Spring On The Horizon — HoliznaCC0 (Background Music) | calm | CC0 1.0 | installer | 1,174,744 | 3,558,192 | 604,864 | 92bc8ad1815b32a077a4bb46de28ed1a9028b79ebef920ccb2a232dba81aebba |
| bed-calm-drifting-piano.ogg | Drifting Piano — HoliznaCC0 (Background Music) | calm | CC0 1.0 | download | 1,237,159 | 3,989,960 | 678,125 | 5150ecbc1a55cce6f9124c2f8c2a3b9a3bebd91a35a3f16195ad18dc2668e962 |
| bed-calm-old-key.ogg | Old Key — Loyalty Freak Music (MINIMAL AMBIENT BOUNCE) | calm | CC0 1.0 | download | 833,689 | 3,906,068 | 663,765 | 4bc4d1856008300296201df97108875e0783cac98eff8dbc1b499111b3c2a938 |
| bed-upbeat-sweet-sun.ogg | Sweet Sun — Loyalty Freak Music (POSITIVE ATTITUDE !) | upbeat | CC0 1.0 | installer | 1,622,796 | 4,962,069 | 842,458 | ca09ecdc3fe485ec5661ac9ab3c370803c40d65ec55b7ef75e586ed585701c2b |
| bed-upbeat-go-to-the-picnic.ogg | Go to the Picnic — Loyalty Freak Music (POSITIVE ATTITUDE !) | upbeat | CC0 1.0 | download | 615,236 | 6,044,344 | 1,025,969 | 68983dbc9fb83848832a065411ebb381f32bffd4deeaae9edff54cb311b318dc |
| bed-corporate-one-cool-minute.ogg | One Cool Minute — Loyalty Freak Music (MINIMAL AMBIENT BOUNCE) | corporate | CC0 1.0 | installer | 285,327 | 3,165,403 | 538,449 | e17cf5beef335ab85fb267078d73545d3ed7d58d458ccdaafa905f3e8035cec9 |
| bed-corporate-work.ogg | Work — Loyalty Freak Music (MELODIES WITH A BEAT) | corporate | CC0 1.0 | download | 3,122,991 | 6,194,991 | 1,051,173 | a1ace35b290ca9e5146d3788e899525a6785599fdfa819b5a79931c792784cb0 |
| bed-lofi-coexistenz.ogg | Coexistenz — Loyalty Freak Music (TO CHILL AND STAY AWAKE) | lofi | CC0 1.0 | installer | 1,660,691 | 4,413,491 | 749,669 | 82dbfd329915e916efea0bb411f957c3fbc900d8e8475df7bd597208f083ab6a |
| bed-lofi-find-your-peace.ogg | Find Your Peace — HoliznaCC0 (Be Happy With Who You Are) | lofi | CC0 1.0 | download | 1,486,820 | 4,955,208 | 841,483 | e0d7850414988b1a3c57b143197a72867ed905c2aa267c4984bcefcfc212b359 |
| bed-lofi-walking-away.ogg | Walking Away — HoliznaCC0 (Public Domain Lofi) | lofi | CC0 1.0 | download | 3,484,108 | 6,864,501 | 1,164,869 | a5dc3ce6edce13b0a9d83147860af91046112cbd368a745952c744fd45e7d0a4 |
| bed-cinematic-lullabies-5.ogg | Lullabies For The End Of The World #5 — HoliznaCC0 (Lullabies For The End Of The World) | cinematic | CC0 1.0 | download | 2,467,631 | 4,661,901 | 791,655 | 1e043912806930f3bb8199bb56f189370e9029f2e87a44379215e1746e365de4 |
| bed-cinematic-dangerous-voyage.ogg | Dangerous Voyage — HoliznaCC0 (Background Music) | cinematic | CC0 1.0 | download | 425,761 | 5,340,961 | 906,703 | a51813d01700ecfd30cfc6bfa59a15d1b32ead4777a402ee9149dbc4591af39b |

Upstream files (each track page says "<title> by <artist> is licensed under a CC0 1.0 Universal License"):

| Id | Page | Upstream file | Bytes | SHA-256 |
|---|---|---|---|---|
| calm-spring-on-the-horizon | https://freemusicarchive.org/music/holiznacc0/background-music/spring-on-the-horizon/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/XaPEssVQ1Ks8r4GzowzzHsP5xfIi2FcDxVmEM3Bn.mp3 | 3,673,165 | 3776c85ecae4f6052c4fe4645bef02f51de35ba7257380bca3e0707853d1aa6e |
| calm-drifting-piano | https://freemusicarchive.org/music/holiznacc0/background-music/drifting-piano/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/uGFgbWaUKc0LLRnbLShVKZ7yhiK5nsxczsKgpcvW.mp3 | 4,420,963 | 5d1d80af901c244bcedb618b5350b83874167258ba4fa17da83a2a005a26f95e |
| calm-old-key | https://freemusicarchive.org/music/Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_MINIMAL_AMBIENT_BOUNCE_-_03_Old_Key/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/music/Music_for_Video/Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_03_-_Old_Key.mp3 | 6,393,217 | 5b11999f705881ce23ea39577c4af38aa404b1f38cf89cdd47eb6e4a2109406b |
| upbeat-sweet-sun | https://freemusicarchive.org/music/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_POSITIVE_ATTITUDE__-_04_Sweet_Sun/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/music/no_curator/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_04_-_Sweet_Sun.mp3 | 4,843,926 | 0e78c97159d005e5727fb8c406c1613047f17bfe74450d37e941dafbfe0975fa |
| upbeat-go-to-the-picnic | https://freemusicarchive.org/music/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_POSITIVE_ATTITUDE__-_01_Go_to_the_Picnic/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/music/no_curator/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_01_-_Go_to_the_Picnic.mp3 | 7,544,987 | dbeaad7bb137f39f5d3e7ee5c83b2ac53f4963cc92f3d3fe6321c490e1760cf1 |
| corporate-one-cool-minute | https://freemusicarchive.org/music/Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_MINIMAL_AMBIENT_BOUNCE_-_02_One_Cool_Minute/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/music/Music_for_Video/Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_02_-_One_Cool_Minute.mp3 | 7,799,650 | 8778d1e095ab7c6793d10ce9bbe1d9783c9ec6d558f11302ced2202b2c039a0c |
| corporate-work | https://freemusicarchive.org/music/Loyalty_Freak_Music/MELODIES_WITH_A_BEAT/Loyalty_Freak_Music_-_MELODIES_WITH_A_BEAT_-_13_Work/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/music/Music_for_Video/Loyalty_Freak_Music/MELODIES_WITH_A_BEAT/Loyalty_Freak_Music_-_13_-_Work.mp3 | 5,862,743 | b54cd1808040093efb07b59a81f706fe8f8b0f10dce99b67d7aa9ba95287c7bd |
| lofi-coexistenz | https://freemusicarchive.org/music/Loyalty_Freak_Music/TO_CHILL_AND_STAY_AWAKE/Loyalty_Freak_Music_-_TO_CHILL_AND_STAY_AWAKE_-_01_Coexistenz/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/music/Music_for_Video/Loyalty_Freak_Music/TO_CHILL_AND_STAY_AWAKE/Loyalty_Freak_Music_-_01_-_Coexistenz.mp3 | 6,307,619 | a30737e60dd04961b645312d9a33683b8cc7b2d591ed22892ef552dd1750c9f0 |
| lofi-find-your-peace | https://freemusicarchive.org/music/holiznacc0/be-happy-with-who-you-are/find-your-peace/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/XfRQmzUkddJ0aYUKbbbssERfuqtZ4kFD4f7tDbpm.mp3 | 5,574,925 | d204810823d2910111e8eb9a5dce7fd4c659701cc3b9c350ff44a0f9c9a58e99 |
| lofi-walking-away | https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/walking-away-lofi-peaceful-motivating/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/WOtcP3GhbgTD8CuC6sEgpQOEXMyNeXYbTNmHjgN6.mp3 | 6,243,043 | fd8a618a4076b76f02f69414d6beb4ad7ddf3b8c26164085bd6dc1a9fd2f7610 |
| cinematic-lullabies-5 | https://freemusicarchive.org/music/holiznacc0/lullabies-for-the-end-of-the-world/lullabies-for-the-end-of-the-world-5/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/QQ7qGFBa7XvQ4zoITcak0W3PPq4CIDuJpXDtb8BB.mp3 | 5,799,523 | d92076e65945f9703f99c45741cf09118c1a5d8bec54e1a1245f513f9f3134ed |
| cinematic-dangerous-voyage | https://freemusicarchive.org/music/holiznacc0/background-music/dangerous-voyage/ | https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/Tvb0DDm30Pc0zqEJB3UAJscCXysMFzWj5iZn81Um.mp3 | 7,193,485 | 858da24c505574b60694f05ef70564555a18a05307cc7671c0efc642bf6036ff |

## Sound effects

48 kHz mono Ogg Opus 48 kb/s, the loudest 400 ms at −20 LUFS unless the true peak would pass −1 dBTP. Peak: the time from the start to the loudest moment.

| File | Title | Source (CC0) | Page | Archive › member | Member bytes | Member SHA-256 | Seconds | Peak | Bytes | SHA-256 |
|---|---|---|---|---|---|---|---|---|---|---|
| sfx-whoosh-in.ogg | Whoosh | qubodup, "Swish - bamboo stick weapon swhoshes", swosh-03 | https://opengameart.org/content/swish-bamboo-stick-weapon-swhoshes | swoshes.7z › swosh-03.flac | 96,738 | 2111003e4c61b8f3589f926f549ffc36094319da7b99238624c7d64e91bddc09 | 0.576 | 0.075 | 3,458 | bde6d61de9201969f3561c616429ed7aa057e6c8613e75097b45c39d64f972d3 |
| sfx-whoosh-out.ogg | Whoosh out | qubodup, "Swish - bamboo stick weapon swhoshes", swosh-13 | https://opengameart.org/content/swish-bamboo-stick-weapon-swhoshes | swoshes.7z › swosh-13.flac | 94,634 | a22c0da4eff26f4b6171721c830f291a0ad9fe5383f23d5f4530020e995dc4de | 0.508 | 0.116 | 3,097 | c3da0bb1903022d67b3b30576bf37642d88f56349d524b3e9f9015807a53f2e5 |
| sfx-whoosh-soft.ogg | Soft whoosh | qubodup, "Swish - bamboo stick weapon swhoshes", swosh-16 | https://opengameart.org/content/swish-bamboo-stick-weapon-swhoshes | swoshes.7z › swosh-16.flac | 72,696 | 0e882f9cef2ca536fae1efa9fadcfc5f8f1fc6a1dafc55d8c2ee62a95cd71b16 | 0.437 | 0.073 | 2,660 | aabe29faa2d7b97bba18ef996cc6277c21bbab1caa6a9e59adc7cfc4b6115b37 |
| sfx-swish-quick.ogg | Quick swish | artisticdude, "Swishes Sound Pack", swish-9 | https://opengameart.org/content/swishes-sound-pack | swishes.zip › swishes/swish-9.wav | 52,906 | 123883f006ce55feecbff11eea5f87c4493df4399989983037144570a23723c1 | 0.154 | 0.059 | 1,225 | e7db3980af2cc7ae0bb825308d2e6b24cfa6688deb270743ec51ed6bc926bad8 |
| sfx-pop.ogg | Pop | cogitollc, "Pop sounds", pop1 | https://opengameart.org/content/pop-sounds | pop1.ogg (the file itself) | — | — | 0.207 | 0.036 | 1,529 | ee9a0cf65eadaec808893b0298300d81c361fc93719574a4a211822512501989 |
| sfx-pop-soft.ogg | Soft pop | cogitollc, "Pop sounds", pop3 | https://opengameart.org/content/pop-sounds | pop3.ogg (the file itself) | — | — | 0.125 | 0.045 | 1,029 | 87ac42d5cec619a1c64aae190ff1a661758d7cba599f1fb6ec7709fa191b369d |
| sfx-pop-bubble.ogg | Bubble pop | wubitog, "3 Pop Sounds", pop1 | https://opengameart.org/content/3-pop-sounds | 3pops.zip › 3pops/pop1.ogg | 11,616 | e8ef22564c704a6f6217e03885cba51ebd7761360e59fc8e247b2f4f97bc4e0e | 0.236 | 0.01 | 1,674 | 35d1d3a5cd0cbe77f944046a08d7dcd714d95c5f13779f812246175e5f5b9e2a |
| sfx-click.ogg | Click | Kenney, Interface Sounds, click_001 | https://opengameart.org/content/interface-sounds | kenney_interfaceSounds.zip › Audio/click_001.ogg | 4,876 | ccfb7fa0cccdd9faec0eb16033c732b1e308d139d80f799161495d58f7adcdb9 | 0.097 | 0.006 | 677 | 35e9534ae74230cf8429b247a71d076b569b4fa534de5194040b53b761345034 |
| sfx-tick.ogg | Tick | Kenney, Interface Sounds, tick_002 | https://opengameart.org/content/interface-sounds | kenney_interfaceSounds.zip › Audio/tick_002.ogg | 4,514 | 869442f54214be902ec7437f79e400dc91c1bfd90d18a6dd2d5b7e41ffbf457b | 0.02 | 0.005 | 419 | 8cd79049b0d67b6e2618437187167d7df8066f5f0394749a3be524c35db756d1 |
| sfx-bell.ogg | Bell | PWL, "Bell dings/chimes", bell_ding2 | https://opengameart.org/content/bell-dingschimes | bell_ding2.wav (the file itself) | — | — | 1.352 | 0.03 | 8,079 | d5ff17af12ccfb5b2f430f5a901cb9f97c3290d1cb468a7820025003ef0ac92a |
| sfx-chime.ogg | Chime | Kenney, Interface Sounds, confirmation_001 | https://opengameart.org/content/interface-sounds | kenney_interfaceSounds.zip › Audio/confirmation_001.ogg | 8,968 | 063564703b6094d70718a3e787a55cc9141611e4ecd6b6637f8828f79b4a8c3a | 0.29 | 0.006 | 2,760 | 63b071e3416ab3b468f60c99c694204ccfbd6407a82cd1a0d155021bcee7cf45 |
| sfx-success.ogg | Success | qubodup, "6 user interface ding clicks", dingCling-positive | https://opengameart.org/content/6-user-interface-ding-clicks | dingclicks.7z › dingClicks/dingCling-positive.ogg | 10,666 | 63387ecb70bbf54c79cab26b69a590776c0fd1663b5a562eae836121dafc1e14 | 0.294 | 0.103 | 3,149 | bca70e74bbb0c4cef50d7245561dadfff4b92d3879eda045b96b2dc25503937f |
| sfx-rise.ogg | Rise | Kenney, Interface Sounds, maximize_004 | https://opengameart.org/content/interface-sounds | kenney_interfaceSounds.zip › Audio/maximize_004.ogg | 17,723 | 59c7a24b204be24d2a44a86d1e4d18c2cf51fa0446967a14b2590e8fb3afaf34 | 0.402 | 0.354 | 3,351 | 10e6dfcdbcfa43bc7768abd8f8641df99c8fbe14001cd305b16337a3585f5bd2 |
| sfx-fall.ogg | Fall | Kenney, Interface Sounds, minimize_004 | https://opengameart.org/content/interface-sounds | kenney_interfaceSounds.zip › Audio/minimize_004.ogg | 17,099 | fcfe6fbb03a728e90b907f34d2ec7bf3ea1857397c3e47ee01990c1be059e4f6 | 0.401 | 0.048 | 2,938 | c3f95cdb4742b9ed66d940adc41159a1d9aad606ca79da7f5f72346d24e1e579 |
| sfx-bubble-in.ogg | Bubble | Kenney, Interface Sounds, question_001 | https://opengameart.org/content/interface-sounds | kenney_interfaceSounds.zip › Audio/question_001.ogg | 11,700 | abb8f9e4eb2071491b0b15f84ee302386b1847609310c1b000ae174639a6cc5a | 0.487 | 0.166 | 3,279 | 0344d7ae95ca0933fa82016c7765676a023e9904daca805155c8db51f6a8c9ee |
| sfx-drop.ogg | Drop | Kenney, Interface Sounds, drop_002 | https://opengameart.org/content/interface-sounds | kenney_interfaceSounds.zip › Audio/drop_002.ogg | 6,411 | 4ac4d1cef7e936965cbf795852ca2020300b9e2ba7daa59f2bf4f1f7bf416218 | 0.188 | 0.006 | 1,864 | f8ee6eaaa4db24f2e4c9b0d0e4aa2911d053b79d7f402c13283e99e0e03a8450 |

Upstream files:

| File | URL | Bytes | SHA-256 | Page and licence |
|---|---|---|---|---|
| kenney_interfaceSounds.zip | https://opengameart.org/sites/default/files/kenney_interfaceSounds.zip | 834,536 | f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232 | https://opengameart.org/content/interface-sounds: CC0; kenney.nl/assets/interface-sounds: "public domain licensed (CC0)… Attribution is not required"; the zip's License.txt says CC0 |
| swoshes.7z | https://opengameart.org/sites/default/files/swoshes.7z | 4,858,146 | 2d55b26f918a4d8042e2c97a4db81392757195f5aaac9039f5ec2c557b6f11f2 | https://opengameart.org/content/swish-bamboo-stick-weapon-swhoshes: CC0, attribution "[optional]" |
| dingclicks.7z | https://opengameart.org/sites/default/files/dingclicks.7z | 43,474 | d73c088f6c2950db351c894ec74a6a0c9d02a497d8747e5409f8f3af64fc7a6c | https://opengameart.org/content/6-user-interface-ding-clicks: CC0; info.txt "Public Domain Dedication or CC0" |
| swishes.zip | https://opengameart.org/sites/default/files/swishes.zip | 385,150 | 7980215241b739a787dcf26f660ce510bb237900968789395a86911619795693 | https://opengameart.org/content/swishes-sound-pack: CC0 |
| pop1.ogg | https://opengameart.org/sites/default/files/pop1.ogg | 6,607 | a00ec6f278e2237d1b95dd0a53dfd2398ea44a7497794b38ab4b28602573d763 | https://opengameart.org/content/pop-sounds: CC0 |
| pop3.ogg | https://opengameart.org/sites/default/files/pop3.ogg | 5,638 | 3b9a801da20f92d720ff2c0076914228086107ec6792411494bf25ee6f8eb3ed | https://opengameart.org/content/pop-sounds: CC0 |
| 3pops.zip | https://opengameart.org/sites/default/files/3pops.zip | 90,641 | b54c299913b6502e5d07ba62bcc6726f13498ee848d49f25fc4390e0b6103a82 | https://opengameart.org/content/3-pop-sounds: CC0, "No Attribution Required" |
| bell_ding2.wav | https://opengameart.org/sites/default/files/bell_ding2.wav | 254,020 | e4a764a1e0a6284f5a5ec80caf3d44c76d3ff8db17ddab8b42abb6b143e83529 | https://opengameart.org/content/bell-dingschimes: CC0, "Releasing as public domain" |

## The artists' own pages

A bed is allowed only when its own page says CC0 1.0, its tags say nothing else, and the artist's own site or biography agrees with CC0 (§10.1). The page text is kept in `scripts/sound-library/evidence/` (not shipped), pinned by its SHA-256.

| Artist | Page | Fetched | What it says | Evidence file | SHA-256 |
|---|---|---|---|---|---|
| HoliznaCC0 | https://freemusicarchive.org/music/holiznacc0/ | 2026-11-06 | "which is giving out truly unique and creative music for free as public domain" | holiznacc0.txt | 895a58e133235e9bac6b7a5467a7acc8a21fc850a00acbc760fcd275dbaeb2ca |
| Loyalty Freak Music | https://loyaltyfreakmusic.com/faq/ | 2026-11-06 | "98 % of my work is under Creative Commons 0, so you can remix, use it in a commercial way and don’t even need to credit me to use it." | loyalty-freak-music.txt | 707d011a5cf3ebcd6fafac83eec81566b3cce9adab36944451733b7dc14bfdd6 |

Rejected:

- John Bartmann: https://www.johnbartmann.com/faq (2026-11-06): "Creative Commons CC-BY 4.0 or public domain. Do credit me"; evidence john-bartmann.txt, SHA-256 5a79f91b8ee8203823e7cefef8c1aa75440924230f85d13e92cd28a4fd22bd95.

## Tools

- Encoder: ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/  Copyright (c) 2000-2024 the FFmpeg developers, the ffmpeg-static binary (node_modules/ffmpeg-static/ffmpeg), SHA-256 e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99, with its built-in libopus.
- Archives: libarchive (through Python ctypes), libarchive 3.7.2 (/usr/lib/x86_64-linux-gnu/libarchive.so.13.7.2), SHA-256 2d8605282b26359a0994017373bff09fc7c9a6ed9ab7e1a4fd980b8ffcf1cd40.
- Last run: 2026-11-07, on linux x64, Node v22.22.0. Prepared in that run: calm-spring-on-the-horizon, calm-drifting-piano, calm-old-key, upbeat-sweet-sun, upbeat-go-to-the-picnic, corporate-one-cool-minute, corporate-work, lofi-coexistenz, lofi-find-your-peace, lofi-walking-away, cinematic-lullabies-5, cinematic-dangerous-voyage, whoosh-in, whoosh-out, whoosh-soft, swish-quick, pop, pop-soft, pop-bubble, click, tick, bell, chime, success, rise, fall, bubble-in, drop.
