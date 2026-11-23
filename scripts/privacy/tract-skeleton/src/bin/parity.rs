//! Runs one ONNX graph with tract on raw little-endian f32 inputs written by the Python scorer
//! (scripts/privacy/tract_parity.py) and writes tract's outputs next to them, so the scorer can
//! compare them with ONNX Runtime's. Single thread (tract's default executor).
//!
//!   parity <model.onnx> <concrete|symbolic> <out_dir> <input.f32:1x3x48x320> [more inputs] [--repeat N]
//!
//! concrete: one plan per distinct input shape, declared before optimising, with the file's
//!   value_info ignored (PaddlePaddle's files name the batch DynamicDimension.0 in every
//!   intermediate shape, which tract cannot unify with a declared 1 otherwise).
//! declared: the same, keeping value_info (fails on these files; kept to show the error).
//! subst: one plan per shape, the file's symbols substituted by the shape's values (set_symbols).
//! symbolic: one plan for every shape, the file's own symbolic input dims.
//! symbolic-n1: one plan for every shape, the batch symbol set to 1, the others left symbolic.
use std::path::Path;
use std::time::Instant;
use tract_onnx::prelude::*;

fn read_f32(p: &str) -> Vec<f32> {
    let b = std::fs::read(p).unwrap_or_else(|e| panic!("read {p}: {e}"));
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn peak_rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM")).map(|l| l.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0)))
        .unwrap_or(0)
}

fn main() -> TractResult<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut repeat = 1usize;
    if let Some(i) = args.iter().position(|a| a == "--repeat") {
        repeat = args[i + 1].parse().unwrap();
        args.drain(i..i + 2);
    }
    let (model_path, mode, out_dir) = (args[0].clone(), args[1].clone(), args[2].clone());
    let inputs: Vec<(String, Vec<usize>)> = args[3..]
        .iter()
        .map(|a| {
            let (p, s) = a.rsplit_once(':').expect("input:shape");
            (p.to_string(), s.split('x').map(|d| d.parse().unwrap()).collect())
        })
        .collect();

    let t0 = Instant::now();
    let model = tract_onnx::onnx().with_ignore_value_info(mode == "concrete").model_for_path(&model_path)?;
    // The input's dims as the file declares them, e.g. ["DynamicDimension.0", "3", "48", "DynamicDimension.1"].
    let declared: Vec<String> = format!("{:?}", model.input_fact(0)?).split(',').map(|s| s.trim().to_string()).collect();
    let subst = |m: &mut InferenceModel, shape: &[usize], only_batch: bool| -> TractResult<()> {
        let mut subs = std::collections::HashMap::new();
        for (i, d) in declared.iter().enumerate().take(shape.len()) {
            if d.starts_with("DynamicDimension") && (!only_batch || i == 0) {
                subs.insert(m.sym(d), TDim::Val(shape[i] as i64));
            }
        }
        m.set_symbols(&subs)?;
        if !only_batch {
            m.set_input_fact(0, f32::fact(shape.to_vec()).into())?;
        }
        Ok(())
    };
    let parse_ms = t0.elapsed().as_secs_f64() * 1e3;
    eprintln!("{{\"event\":\"parsed\",\"ms\":{parse_ms:.1},\"inputFact\":\"{:?}\"}}", model.input_fact(0)?);

    let mut plans: Vec<(Vec<usize>, Arc<TypedRunnableModel>)> = vec![];
    let mut optimise_ms = 0.0;
    let one_plan = mode == "symbolic" || mode == "symbolic-n1";
    if one_plan {
        let t = Instant::now();
        let mut m = model.clone();
        if mode == "symbolic-n1" {
            subst(&mut m, &[1], true)?;
        }
        let typed = m.into_optimized()?;
        let plan = typed.into_runnable()?;
        optimise_ms += t.elapsed().as_secs_f64() * 1e3;
        plans.push((vec![], plan));
    }
    for (path, shape) in &inputs {
        let plan = if one_plan {
            plans[0].1.clone()
        } else if let Some((_, p)) = plans.iter().find(|(s, _)| s == shape) {
            p.clone()
        } else {
            let t = Instant::now();
            let p = if mode == "subst" {
                let mut m = model.clone();
                subst(&mut m, shape, false)?;
                m.into_optimized()?.into_runnable()?
            } else {
                model.clone().with_input_fact(0, f32::fact(shape.clone()).into())?.into_optimized()?.into_runnable()?
            };
            optimise_ms += t.elapsed().as_secs_f64() * 1e3;
            plans.push((shape.clone(), p.clone()));
            p
        };
        let data = read_f32(path);
        let input = Tensor::from_shape(shape, &data)?;
        let mut times = vec![];
        let mut out = None;
        for _ in 0..repeat.max(1) {
            let t = Instant::now();
            let r = plan.run(tvec!(input.clone().into_tvalue()))?;
            times.push(t.elapsed().as_secs_f64() * 1e3);
            out = Some(r);
        }
        let out = out.unwrap();
        let view = out[0].to_plain_array_view::<f32>()?;
        let shape_out: Vec<usize> = view.shape().to_vec();
        let mut bytes = Vec::with_capacity(view.len() * 4);
        for v in view.iter() {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let name = Path::new(path).file_name().unwrap().to_string_lossy().to_string();
        let out_path = format!("{out_dir}/{name}.{mode}.tract.f32");
        std::fs::write(&out_path, bytes)?;
        println!(
            "{{\"input\":\"{name}\",\"shapeIn\":{:?},\"shapeOut\":{:?},\"ms\":{:?},\"out\":\"{out_path}\"}}",
            shape, shape_out, times.iter().map(|t| (t * 10.0).round() / 10.0).collect::<Vec<_>>()
        );
    }
    println!("{{\"parseMs\":{parse_ms:.1},\"optimiseMs\":{optimise_ms:.1},\"plans\":{},\"peakRssKb\":{}}}", plans.len(), peak_rss_kb());
    Ok(())
}
