//! The picture size of an MP4 (Flown's `screen.mp4`) from its header, so a recording that is too
//! large is refused before ffmpeg starts (docs/design/auto-blur.md §5.5, §10.3; R3). Reads box
//! headers only: the `tkhd` and `stsd` of each video track. A file that is not an MP4 gives None,
//! and its size is checked at its first frame instead.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

const MAX_MOOV: u64 = 64 << 20;

fn be32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]]))
}

/// The child boxes of `b`: (type, payload).
fn boxes(b: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = vec![];
    let mut at = 0usize;
    while at + 8 <= b.len() {
        let size = be32(b, at).unwrap_or(0) as usize;
        let kind = [b[at + 4], b[at + 5], b[at + 6], b[at + 7]];
        let (head, size) = if size == 1 {
            let big = b.get(at + 8..at + 16).map(|s| u64::from_be_bytes(s.try_into().unwrap_or([0; 8]))).unwrap_or(0);
            (16usize, big as usize)
        } else if size == 0 {
            (8, b.len() - at)
        } else {
            (8, size)
        };
        if size < head || at + size > b.len() {
            break;
        }
        out.push((kind, &b[at + head..at + size]));
        at += size;
    }
    out
}

fn child<'a>(b: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(b).into_iter().find(|(k, _)| k == kind).map(|(_, p)| p)
}

/// The largest width and height any video track of `moov` declares.
fn video_size(moov: &[u8]) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for (kind, trak) in boxes(moov) {
        if &kind != b"trak" {
            continue;
        }
        let mdia = child(trak, b"mdia");
        let handler = mdia.and_then(|m| child(m, b"hdlr")).and_then(|h| h.get(8..12));
        if handler != Some(b"vide") {
            continue;
        }
        let mut dims = vec![];
        if let Some(tkhd) = child(trak, b"tkhd") {
            let off = if tkhd.first() == Some(&1) { 88 } else { 76 };
            if let (Some(w), Some(h)) = (be32(tkhd, off), be32(tkhd, off + 4)) {
                dims.push(((w >> 16) as usize, (h >> 16) as usize));
            }
        }
        let stsd = mdia.and_then(|m| child(m, b"minf")).and_then(|m| child(m, b"stbl")).and_then(|s| child(s, b"stsd"));
        if let Some(stsd) = stsd {
            // Full box header (4) and entry count (4), then sample entries: a visual entry's
            // width and height sit 24 bytes into its payload.
            for (_, entry) in boxes(stsd.get(8..).unwrap_or(&[])) {
                if let (Some(w), Some(h)) = (be16(entry, 24), be16(entry, 26)) {
                    dims.push((w as usize, h as usize));
                }
            }
        }
        for d in dims {
            best = Some(best.map_or(d, |b| (b.0.max(d.0), b.1.max(d.1))));
        }
    }
    best
}

/// The picture size of the MP4 at `path`, or None when it is not one this can read.
pub fn size(path: &str) -> Option<(usize, usize)> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut at = 0u64;
    while at + 8 <= len {
        f.seek(SeekFrom::Start(at)).ok()?;
        let mut head = [0u8; 16];
        f.read_exact(&mut head[..8]).ok()?;
        let mut size = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as u64;
        let mut header = 8u64;
        if size == 1 {
            f.read_exact(&mut head[8..16]).ok()?;
            size = u64::from_be_bytes(head[8..16].try_into().ok()?);
            header = 16;
        } else if size == 0 {
            size = len - at;
        }
        if size < header {
            return None;
        }
        if &head[4..8] == b"moov" {
            let n = size - header;
            if n > MAX_MOOV {
                return None;
            }
            let mut moov = vec![0u8; n as usize];
            f.read_exact(&mut moov).ok()?;
            return video_size(&moov);
        }
        at += size;
    }
    None
}

/// A minimal MP4 header declaring a `w` × `h` video track (tests).
#[cfg(test)]
pub fn header_only(w: u32, h: u32) -> Vec<u8> {
    fn bx(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(payload);
        v
    }
    let mut tkhd = vec![0u8; 84];
    tkhd[76..80].copy_from_slice(&(w << 16).to_be_bytes());
    tkhd[80..84].copy_from_slice(&(h << 16).to_be_bytes());
    let mut hdlr = vec![0u8; 24];
    hdlr[8..12].copy_from_slice(b"vide");
    let mdia = bx(b"mdia", &bx(b"hdlr", &hdlr));
    let trak = bx(b"trak", &[bx(b"tkhd", &tkhd), mdia].concat());
    [bx(b"ftyp", b"isom\0\0\0\0isom"), bx(b"moov", &trak)].concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_size_from_the_header() {
        let dir = std::env::temp_dir().join(format!("ssw-ocr-mp4-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("big.mp4");
        std::fs::write(&p, header_only(7681, 4320)).unwrap();
        assert_eq!(size(p.to_str().unwrap()), Some((7681, 4320)));
        std::fs::write(&p, b"not an mp4 at all").unwrap();
        assert_eq!(size(p.to_str().unwrap()), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
