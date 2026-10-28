# Music tracks (`MUSIC_DIR`)

The studio resolves a Timeline's `music.track` key to a file here (e.g.
`"corporate-lofi"` → `corporate-lofi.mp3`). See `src/sound/music.ts`.

**Audio files are git-ignored** — drop **royalty-free / licensed audio you own**
here. They are intentionally not committed (binaries + licensing).

`corporate-lofi.mp3` in this folder is a **synthesized placeholder bed**
(generated locally with ffmpeg from sine tones — no third-party rights) used for
dogfooding. Replace it with a properly licensed track before publishing anything.

Regenerate the placeholder bed (a soft Cmaj7 pad) any time:

```bash
ffmpeg -y \
 -f lavfi -i "sine=frequency=65.41:duration=40" -f lavfi -i "sine=frequency=130.81:duration=40" \
 -f lavfi -i "sine=frequency=164.81:duration=40" -f lavfi -i "sine=frequency=196.00:duration=40" \
 -f lavfi -i "sine=frequency=246.94:duration=40" \
 -filter_complex "[0]volume=0.9[a0];[1]volume=0.8[a1];[2]volume=0.6[a2];[3]volume=0.55[a3];[4]volume=0.4[a4];[a0][a1][a2][a3][a4]amix=inputs=5:normalize=1,tremolo=f=0.18:d=0.6,lowpass=f=850,aecho=0.8:0.7:90:0.35,volume=2.2,afade=t=in:st=0:d=2.5,afade=t=out:st=36.5:d=3.5[a]" \
 -map "[a]" -ar 44100 -ac 2 -b:a 192k corporate-lofi.mp3
```

Supported extensions: `.mp3 .m4a .wav .aac .ogg`.
