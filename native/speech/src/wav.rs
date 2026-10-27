//! Audio input: a WAV file of 16 kHz mono PCM s16 or float32 (anything else is error `audio`),
//! or raw little-endian f32 on stdin (the speech detector, fed by ffmpeg).

use std::io::Read;

use crate::protocol::{Code, Failure};

pub const SAMPLE_RATE: usize = 16_000;

fn audio(msg: impl Into<String>) -> Failure {
    Failure::new(Code::Audio, msg)
}

fn samples(n: usize) -> Result<Vec<f32>, Failure> {
    let mut v = Vec::new();
    v.try_reserve_exact(n).map_err(|_| Failure::new(Code::Memory, format!("no memory for {n} samples")))?;
    Ok(v)
}

/// The samples of a 16 kHz mono WAV (PCM 16-bit or IEEE float 32-bit, WAVE_FORMAT_EXTENSIBLE
/// included). A streamed WAV whose data size is 0 or too large is read to the end of the file.
pub fn parse_wav(b: &[u8]) -> Result<Vec<f32>, Failure> {
    let u16le = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
    let u32le = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err(audio("not a WAV file"));
    }
    let mut fmt: Option<(u16, u16, u32, u16)> = None;
    let mut pos = 12;
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let size = u32le(pos + 4) as usize;
        let body = pos + 8;
        if id == b"fmt " {
            if size < 16 || body + 16 > b.len() {
                return Err(audio("WAV fmt chunk is too short"));
            }
            let mut tag = u16le(body);
            if tag == 0xFFFE {
                if size < 26 || body + 26 > b.len() {
                    return Err(audio("WAV extensible fmt chunk is too short"));
                }
                tag = u16le(body + 24); // the sub-format GUID's first two bytes
            }
            fmt = Some((tag, u16le(body + 2), u32le(body + 4), u16le(body + 14)));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = fmt.ok_or_else(|| audio("WAV data before fmt"))?;
            if rate as usize != SAMPLE_RATE {
                return Err(audio(format!("the WAV must be 16000 Hz, not {rate}")));
            }
            if channels != 1 {
                return Err(audio(format!("the WAV must be mono, not {channels} channels")));
            }
            let end = if size == 0 || body.saturating_add(size) > b.len() { b.len() } else { body + size };
            let data = &b[body..end];
            return match (tag, bits) {
                (1, 16) => {
                    let mut v = samples(data.len() / 2)?;
                    v.extend(data.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0));
                    Ok(v)
                }
                (3, 32) => {
                    let mut v = samples(data.len() / 4)?;
                    v.extend(data.chunks_exact(4).map(|s| f32::from_le_bytes([s[0], s[1], s[2], s[3]])));
                    Ok(v)
                }
                _ => Err(audio(format!("unsupported WAV format {tag}/{bits}-bit (use PCM 16-bit or float 32-bit)"))),
            };
        }
        pos = body.saturating_add(size).saturating_add(size & 1);
    }
    Err(audio("the WAV has no data chunk"))
}

pub fn read_wav(path: &std::path::Path) -> Result<Vec<f32>, Failure> {
    let bytes = std::fs::read(path).map_err(|e| audio(format!("cannot read the audio: {e}")))?;
    parse_wav(&bytes)
}

/// Reads f32le samples from `r` until `want` samples are buffered or the input ends; returns
/// false at the end of the input. A trailing partial sample is dropped.
pub fn fill_f32le(r: &mut impl Read, buf: &mut Vec<f32>, want: usize, carry: &mut Vec<u8>) -> Result<bool, Failure> {
    let mut chunk = vec![0u8; 1 << 16];
    while buf.len() < want {
        let n = match r.read(&mut chunk) {
            Ok(0) => return Ok(false),
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(audio(format!("cannot read the audio from stdin: {e}"))),
        };
        carry.extend_from_slice(&chunk[..n]);
        let whole = carry.len() / 4 * 4;
        buf.try_reserve(whole / 4).map_err(|_| Failure::new(Code::Memory, "no memory for the audio"))?;
        buf.extend(carry[..whole].chunks_exact(4).map(|s| {
            let v = f32::from_le_bytes([s[0], s[1], s[2], s[3]]);
            if v.is_finite() {
                v
            } else {
                0.0
            }
        }));
        carry.drain(..whole);
    }
    Ok(true)
}

#[cfg(test)]
pub fn wav_bytes(rate: u32, channels: u16, tag: u16, bits: u16, data: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&tag.to_le_bytes());
    b.extend_from_slice(&channels.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * channels as u32 * bits as u32 / 8).to_le_bytes());
    b.extend_from_slice(&(channels * bits / 8).to_le_bytes());
    b.extend_from_slice(&bits.to_le_bytes());
    b.extend_from_slice(b"LIST");
    b.extend_from_slice(&3u32.to_le_bytes());
    b.extend_from_slice(b"abc\0"); // an odd-sized chunk with its pad byte
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(data.len() as u32).to_le_bytes());
    b.extend_from_slice(data);
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_s16_and_f32() {
        let s16: Vec<u8> = [0i16, 16384, -32768].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(parse_wav(&wav_bytes(16000, 1, 1, 16, &s16)).unwrap(), vec![0.0, 0.5, -1.0]);
        let f32b: Vec<u8> = [0.25f32, -0.75].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(parse_wav(&wav_bytes(16000, 1, 3, 32, &f32b)).unwrap(), vec![0.25, -0.75]);
    }

    #[test]
    fn other_rates_channels_and_formats_are_audio_errors() {
        let d = vec![0u8; 8];
        for b in [
            wav_bytes(44100, 1, 1, 16, &d),
            wav_bytes(8000, 1, 1, 16, &d),
            wav_bytes(16000, 2, 1, 16, &d),
            wav_bytes(16000, 1, 1, 24, &d),
            wav_bytes(16000, 1, 3, 64, &d),
            b"RIFF0000WAVE".to_vec(),
            b"not a wav".to_vec(),
            vec![],
        ] {
            assert_eq!(parse_wav(&b).unwrap_err().code, Code::Audio);
        }
    }

    #[test]
    fn a_streamed_data_size_reads_to_the_end() {
        let s16: Vec<u8> = [100i16, 200].iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut b = wav_bytes(16000, 1, 1, 16, &s16);
        let n = b.len();
        b[n - 8..n - 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        assert_eq!(parse_wav(&b).unwrap().len(), 2);
    }

    #[test]
    fn stdin_f32le_is_read_in_pieces() {
        let bytes: Vec<u8> = (0..10).flat_map(|i| (i as f32).to_le_bytes()).chain([1u8, 2]).collect();
        let mut r: &[u8] = &bytes;
        let (mut buf, mut carry) = (Vec::new(), Vec::new());
        assert!(!fill_f32le(&mut r, &mut buf, 100, &mut carry).unwrap());
        assert_eq!(buf, (0..10).map(|i| i as f32).collect::<Vec<_>>());
    }
}
