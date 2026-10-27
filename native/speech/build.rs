// Windows (MinGW) link fixes for the vendored whisper.cpp: ggml-cpu reads the registry (advapi32),
// and everything C++ (libstdc++, libgcc, winpthreads) is linked statically so the .exe needs only
// system DLLs.
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    println!("cargo:rerun-if-changed=build.rs");
    // Which build this is, for the `ready` line and the CPUID check at the start of main:
    // SSW_SPEECH_BUILD when set (scripts/build-native.mjs sets it), else derived from the ggml
    // flags the build uses (a cross build forces AVX2 on for the standard build).
    println!("cargo:rerun-if-env-changed=SSW_SPEECH_BUILD");
    println!("cargo:rerun-if-env-changed=GGML_AVX2");
    let build = std::env::var("SSW_SPEECH_BUILD").unwrap_or_else(|_| {
        if os != "windows" {
            "host".into()
        } else if std::env::var("GGML_AVX2").map(|v| v == "ON").unwrap_or(false) {
            "standard".into()
        } else {
            "compatible".into()
        }
    });
    assert!(
        ["standard", "compatible", "host"].contains(&build.as_str()),
        "SSW_SPEECH_BUILD must be standard, compatible or host"
    );
    println!("cargo:rustc-env=SSW_SPEECH_BUILD={build}");
    if os != "windows" {
        return;
    }
    // After the static libraries (a link-lib here would come before them on the command line).
    println!("cargo:rustc-link-arg=-ladvapi32");
    if env != "gnu" {
        return;
    }
    println!("cargo:rustc-link-arg=-static");
    println!("cargo:rustc-link-arg=-static-libgcc");
    println!("cargo:rustc-link-arg=-static-libstdc++");
    // whisper-rs-sys asks for `dylib=stdc++`; a search directory holding only the static archive
    // makes that -lstdc++ resolve to libstdc++.a instead of the libstdc++-6.dll import library.
    let cxx = std::env::var("CXX_x86_64_pc_windows_gnu").unwrap_or_else(|_| "x86_64-w64-mingw32-g++".into());
    let out = Command::new(&cxx).arg("-print-file-name=libstdc++.a").output().expect("run the MinGW C++ compiler");
    let lib = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string());
    assert!(lib.is_absolute() && lib.exists(), "static libstdc++.a not found via {cxx}");
    let dir = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("static-cxx");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(&lib, dir.join("libstdc++.a")).unwrap();
    println!("cargo:rustc-link-search=native={}", dir.display());
}
