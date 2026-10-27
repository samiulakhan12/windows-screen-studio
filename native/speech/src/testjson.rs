//! A small JSON reader for the tests (the recorded run and the lines the helper prints), so the
//! crate needs no JSON dependency.

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(kv) => kv.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn idx(&self, i: usize) -> Option<&Json> {
        match self {
            Json::Arr(a) => a.get(i),
            _ => None,
        }
    }
    pub fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(a) => a,
            _ => &[],
        }
    }
    pub fn f(&self) -> f64 {
        match self {
            Json::Num(n) => *n,
            _ => f64::NAN,
        }
    }
    pub fn s(&self) -> &str {
        match self {
            Json::Str(s) => s,
            _ => "",
        }
    }
    pub fn keys(&self) -> Vec<&str> {
        let mut k: Vec<&str> = match self {
            Json::Obj(kv) => kv.iter().map(|(k, _)| k.as_str()).collect(),
            _ => vec![],
        };
        k.sort();
        k
    }
}

pub fn parse(s: &str) -> Result<Json, String> {
    let b = s.as_bytes();
    let mut p = 0;
    let v = value(b, &mut p)?;
    ws(b, &mut p);
    if p != b.len() {
        return Err(format!("trailing data at {p}"));
    }
    Ok(v)
}

fn ws(b: &[u8], p: &mut usize) {
    while *p < b.len() && matches!(b[*p], b' ' | b'\n' | b'\r' | b'\t') {
        *p += 1;
    }
}

fn value(b: &[u8], p: &mut usize) -> Result<Json, String> {
    ws(b, p);
    match b.get(*p) {
        Some(b'{') => {
            *p += 1;
            let mut kv = Vec::new();
            ws(b, p);
            if b.get(*p) == Some(&b'}') {
                *p += 1;
                return Ok(Json::Obj(kv));
            }
            loop {
                ws(b, p);
                let k = match value(b, p)? {
                    Json::Str(s) => s,
                    _ => return Err("key".into()),
                };
                ws(b, p);
                if b.get(*p) != Some(&b':') {
                    return Err(format!("colon at {p}"));
                }
                *p += 1;
                kv.push((k, value(b, p)?));
                ws(b, p);
                match b.get(*p) {
                    Some(b',') => *p += 1,
                    Some(b'}') => {
                        *p += 1;
                        return Ok(Json::Obj(kv));
                    }
                    _ => return Err(format!("object at {p}")),
                }
            }
        }
        Some(b'[') => {
            *p += 1;
            let mut a = Vec::new();
            ws(b, p);
            if b.get(*p) == Some(&b']') {
                *p += 1;
                return Ok(Json::Arr(a));
            }
            loop {
                a.push(value(b, p)?);
                ws(b, p);
                match b.get(*p) {
                    Some(b',') => *p += 1,
                    Some(b']') => {
                        *p += 1;
                        return Ok(Json::Arr(a));
                    }
                    _ => return Err(format!("array at {p}")),
                }
            }
        }
        Some(b'"') => {
            *p += 1;
            let mut out: Vec<u16> = Vec::new();
            let mut s = String::new();
            loop {
                let c = *b.get(*p).ok_or("unterminated string")?;
                *p += 1;
                match c {
                    b'"' => {
                        if !out.is_empty() {
                            s.push_str(&String::from_utf16(&out).map_err(|e| e.to_string())?);
                        }
                        return Ok(Json::Str(s));
                    }
                    b'\\' => {
                        let e = *b.get(*p).ok_or("escape")?;
                        *p += 1;
                        let ch = match e {
                            b'"' => '"',
                            b'\\' => '\\',
                            b'/' => '/',
                            b'n' => '\n',
                            b'r' => '\r',
                            b't' => '\t',
                            b'b' => '\u{8}',
                            b'f' => '\u{c}',
                            b'u' => {
                                let h =
                                    std::str::from_utf8(b.get(*p..*p + 4).ok_or("\\u")?).map_err(|e| e.to_string())?;
                                *p += 4;
                                out.push(u16::from_str_radix(h, 16).map_err(|e| e.to_string())?);
                                continue;
                            }
                            _ => return Err("bad escape".into()),
                        };
                        if !out.is_empty() {
                            s.push_str(&String::from_utf16(&out).map_err(|e| e.to_string())?);
                            out.clear();
                        }
                        s.push(ch);
                    }
                    c if c < 0x20 => return Err("raw control character in string".into()),
                    _ => {
                        if !out.is_empty() {
                            s.push_str(&String::from_utf16(&out).map_err(|e| e.to_string())?);
                            out.clear();
                        }
                        // Copy the whole UTF-8 sequence.
                        let start = *p - 1;
                        let len = match c {
                            0x00..=0x7f => 1,
                            0xc0..=0xdf => 2,
                            0xe0..=0xef => 3,
                            _ => 4,
                        };
                        let seq = b.get(start..start + len).ok_or("utf-8")?;
                        s.push_str(std::str::from_utf8(seq).map_err(|e| e.to_string())?);
                        *p = start + len;
                    }
                }
            }
        }
        Some(b't') if b[*p..].starts_with(b"true") => {
            *p += 4;
            Ok(Json::Bool(true))
        }
        Some(b'f') if b[*p..].starts_with(b"false") => {
            *p += 5;
            Ok(Json::Bool(false))
        }
        Some(b'n') if b[*p..].starts_with(b"null") => {
            *p += 4;
            Ok(Json::Null)
        }
        Some(_) => {
            let start = *p;
            while *p < b.len() && matches!(b[*p], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                *p += 1;
            }
            let t = std::str::from_utf8(&b[start..*p]).map_err(|e| e.to_string())?;
            t.parse::<f64>().map(Json::Num).map_err(|_| format!("number {t:?} at {start}"))
        }
        None => Err("end of input".into()),
    }
}
