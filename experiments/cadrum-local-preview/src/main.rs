use cadrum::{Solid, Tessellation};
use std::cmp::Ordering;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

fn main() {
    init_occt();
}

fn init_occt() {
    cadrum::__anchor_wasi_stub();
    extern "C" {
        fn __wasm_call_ctors();
    }
    unsafe { __wasm_call_ctors() };
}

fn box_score(solid: &Solid) -> f64 {
    let [lo, hi] = solid.bounding_box();
    let d = hi - lo;
    d.x * d.x + d.y * d.y + d.z * d.z
}

#[wasm_bindgen]
pub struct LocalStepSession {
    parts: Vec<Option<Solid>>,
    order: Vec<usize>,
    cursor: usize,
    bounds: [f64; 6],
}

#[wasm_bindgen]
impl LocalStepSession {
    #[wasm_bindgen(constructor)]
    pub fn new(step: &[u8]) -> Result<LocalStepSession, JsValue> {
        let mut reader = Cursor::new(step);
        let solids = Solid::read_step(&mut reader)
            .map_err(|e| JsValue::from_str(&format!("read_step: {e:?}")))?;
        if solids.is_empty() {
            return Err(JsValue::from_str("read_step: no solid found"));
        }

        let mut bounds = [f64::INFINITY, f64::INFINITY, f64::INFINITY,
                          f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        let mut ranked: Vec<(usize, f64)> = Vec::with_capacity(solids.len());
        for (index, solid) in solids.iter().enumerate() {
            let [lo, hi] = solid.bounding_box();
            bounds[0] = bounds[0].min(lo.x);
            bounds[1] = bounds[1].min(lo.y);
            bounds[2] = bounds[2].min(lo.z);
            bounds[3] = bounds[3].max(hi.x);
            bounds[4] = bounds[4].max(hi.y);
            bounds[5] = bounds[5].max(hi.z);
            ranked.push((index, box_score(solid)));
        }
        ranked.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));

        Ok(LocalStepSession {
            parts: solids.into_iter().map(Some).collect(),
            order: ranked.into_iter().map(|(index, _)| index).collect(),
            cursor: 0,
            bounds,
        })
    }

    pub fn part_count(&self) -> u32 {
        self.order.len() as u32
    }

    pub fn converted_count(&self) -> u32 {
        self.cursor as u32
    }

    pub fn model_bounds(&self) -> Vec<f64> {
        self.bounds.to_vec()
    }

    pub fn next_part_glb(&mut self, relative_linear: f64, angular: f64) -> Result<Vec<u8>, JsValue> {
        if self.cursor >= self.order.len() {
            return Ok(Vec::new());
        }

        let part_index = self.order[self.cursor];
        let solid = self.parts[part_index]
            .take()
            .ok_or_else(|| JsValue::from_str("part was already converted"))?;
        self.cursor += 1;

        let options = Tessellation {
            deflection_linear: relative_linear.clamp(0.002, 0.25),
            deflection_angular: angular.clamp(0.2, 2.5),
            relative_linear: true,
        };
        let mesh = Solid::mesh_surfaces(std::iter::once(&solid), options)
            .map_err(|e| JsValue::from_str(&format!("mesh part {part_index}: {e:?}")))?;

        let mut glb = Vec::new();
        mesh.write_gltf_binary(&mut glb)
            .map_err(|e| JsValue::from_str(&format!("gltf part {part_index}: {e:?}")))?;
        Ok(glb)
    }
}
